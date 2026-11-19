// 재처리 시 화자 속성 승계 + 빠른 재적용의 수동 보정 보존 — 순수 함수 모음.
// merge 트랜잭션은 speakers/segments를 지우고 다시 넣으므로, 이 모듈이 옛 행과 새 결과를
// 시간 겹침으로 대조해 무엇을 이어받을지 계획한다. DB 쓰기는 meeting-pipeline.ts가 한다.
// SSOT: docs/MEETING_RECORDING.md §5 (화자 속성 승계), §13
import { resolveSpeakerMeta } from './speaker-assign'

/** 재처리 직전 DB의 meeting_speakers 행 */
export interface OldSpeakerRow {
  id: number
  speaker_key: string
  label: string
  display_name: string | null
  color: string
  sort_order: number
}

/** 재처리 직전 DB의 meeting_segments 행(필요한 컬럼만) */
export interface OldSegmentRow {
  start_ms: number
  end_ms: number
  speaker_id: number | null
  speaker_corrected?: number
}

/** 새로 귀속한 결과(세그먼트 시간 + 새 speaker_key) */
export interface TimedKey {
  start_ms: number
  end_ms: number
  speaker_key: string
}

/** 새 화자 키가 옛 화자에게서 이어받을 속성 */
export interface CarriedSpeakerMeta {
  oldSpeakerId: number
  display_name: string | null
  color: string
  /** 사용자가 바꾼 라벨일 때만 채운다(기본 라벨이면 새 키의 기본 라벨을 쓴다) */
  label?: string
}

/** merge가 INSERT할 화자 행 계획 */
export interface PlannedSpeaker {
  speaker_key: string
  label: string
  display_name: string | null
  color: string
  sort_order: number
}

/** 세그먼트별 화자 연결 계획. speakerIndex는 PlannedSpeaker 배열의 인덱스(null=화자 없음) */
export interface PlannedSegmentSpeaker {
  speakerIndex: number | null
  speakerCorrected: boolean
}

/** 세그먼트에 대응하는 수동 화자 지정(null이면 수동 지정 없음 — 자동 귀속) */
export type CorrectedSpeaker = { oldSpeakerId: number | null } | null

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

/**
 * 시간 구간 목록을 시작 시각 순으로 정렬하고 누적 최대 끝 시각을 함께 둔 색인.
 * 주어진 구간과 겹칠 수 있는 항목만 훑어 대조 비용을 줄인다(겹치는 항목이 있어도 정확).
 */
class IntervalIndex<T extends { start_ms: number; end_ms: number }> {
  private readonly items: T[]
  private readonly prefixMaxEnd: number[]

  constructor(items: T[]) {
    this.items = [...items].sort((a, b) => a.start_ms - b.start_ms)
    this.prefixMaxEnd = []
    let maxEnd = -Infinity
    for (const it of this.items) {
      maxEnd = Math.max(maxEnd, it.end_ms)
      this.prefixMaxEnd.push(maxEnd)
    }
  }

  /** [start, end]와 겹치거나 맞닿는 후보를 차례로 돌려준다 */
  forEachCandidate(start: number, end: number, fn: (item: T) => void): void {
    // prefixMaxEnd는 비감소 — 끝 시각이 start 이상인 항목이 처음 나오는 위치를 이분 탐색
    let lo = 0
    let hi = this.items.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.prefixMaxEnd[mid] < start) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < this.items.length && this.items[i].start_ms <= end; i++) {
      fn(this.items[i])
    }
  }
}

/** 사용자가 라벨을 바꿨는지 — 그 행의 키·순서로 만든 기본 라벨과 다르면 사용자가 바꾼 것 */
export function isCustomLabel(speaker: OldSpeakerRow): boolean {
  return speaker.label !== resolveSpeakerMeta(speaker.speaker_key, speaker.sort_order).label
}

/**
 * (a) 화자 속성 승계 계획.
 * 새 화자 키마다 시간 겹침이 가장 큰 옛 화자를 찾고, 그 겹침이 새 화자 발화 시간의
 * 과반(>50%)이면 승계 후보로 삼는다. 한 옛 화자는 겹침이 가장 큰 새 화자 한 명에게만
 * 승계한다(나머지 후보는 기본값). 겹침이 같으면 새 화자 등장 순서가 앞선 쪽.
 * 승계 항목: display_name, color, 사용자가 바꾼 label.
 *
 * @returns 새 speaker_key → 승계 속성 (승계 대상이 없는 키는 없음)
 */
export function planSpeakerCarryover(
  oldSegments: OldSegmentRow[],
  oldSpeakers: OldSpeakerRow[],
  newAssignments: TimedKey[]
): Map<string, CarriedSpeakerMeta> {
  const result = new Map<string, CarriedSpeakerMeta>()
  if (oldSegments.length === 0 || oldSpeakers.length === 0 || newAssignments.length === 0) {
    return result
  }

  const speakerById = new Map(oldSpeakers.map((s) => [s.id, s]))
  const index = new IntervalIndex(
    oldSegments.filter(
      (s) => s.speaker_id !== null && speakerById.has(s.speaker_id) && s.end_ms > s.start_ms
    )
  )

  // 새 키별 총 발화 시간, (새 키, 옛 화자)별 겹침 시간
  const totalByKey = new Map<string, number>()
  const overlapByKey = new Map<string, Map<number, number>>()
  const keyOrder: string[] = []

  for (const a of newAssignments) {
    if (!totalByKey.has(a.speaker_key)) {
      totalByKey.set(a.speaker_key, 0)
      overlapByKey.set(a.speaker_key, new Map())
      keyOrder.push(a.speaker_key)
    }
    const dur = Math.max(0, a.end_ms - a.start_ms)
    totalByKey.set(a.speaker_key, (totalByKey.get(a.speaker_key) ?? 0) + dur)
    if (dur === 0) continue
    const perOld = overlapByKey.get(a.speaker_key)!
    index.forEachCandidate(a.start_ms, a.end_ms, (old) => {
      const ov = overlap(a.start_ms, a.end_ms, old.start_ms, old.end_ms)
      if (ov > 0) perOld.set(old.speaker_id!, (perOld.get(old.speaker_id!) ?? 0) + ov)
    })
  }

  // 새 키별 최다 겹침 옛 화자(과반 조건 충족 시) → 후보
  const candidates: { key: string; oldId: number; ov: number; order: number }[] = []
  keyOrder.forEach((key, order) => {
    const total = totalByKey.get(key) ?? 0
    if (total <= 0) return
    let bestId: number | null = null
    let bestOv = 0
    for (const [oldId, ov] of overlapByKey.get(key)!) {
      if (ov > bestOv) {
        bestOv = ov
        bestId = oldId
      }
    }
    if (bestId !== null && bestOv * 2 > total) {
      candidates.push({ key, oldId: bestId, ov: bestOv, order })
    }
  })

  // 한 옛 화자는 겹침이 가장 큰 새 화자 한 명에게만
  candidates.sort((a, b) => b.ov - a.ov || a.order - b.order)
  const usedOld = new Set<number>()
  for (const c of candidates) {
    if (usedOld.has(c.oldId)) continue
    usedOld.add(c.oldId)
    const old = speakerById.get(c.oldId)!
    result.set(c.key, {
      oldSpeakerId: old.id,
      display_name: old.display_name,
      color: old.color,
      ...(isCustomLabel(old) ? { label: old.label } : {})
    })
  }
  return result
}

/**
 * (b) 빠른 재적용 — 정제 후 세그먼트마다 대응하는 옛 세그먼트의 수동 화자 지정을 찾는다.
 * 정제(cleanSegments)가 세그먼트를 병합·삭제하므로 시간으로 대응시킨다: 새 세그먼트와
 * 겹침이 가장 큰 옛 세그먼트가 새 세그먼트 길이의 과반을 차지하면 대응으로 본다(길이 0인
 * 새 세그먼트는 그 시각을 포함하는 첫 옛 세그먼트). 대응한 옛 세그먼트가
 * speaker_corrected=1이면 그 옛 speaker_id를 돌려준다. 대응이 없으면 null(보정 정보 버림).
 */
export function matchCorrectedSpeakers(
  oldSegments: OldSegmentRow[],
  newSegments: { start_ms: number; end_ms: number }[]
): CorrectedSpeaker[] {
  if (oldSegments.length === 0) return newSegments.map(() => null)
  const index = new IntervalIndex(oldSegments)

  return newSegments.map((seg) => {
    const dur = seg.end_ms - seg.start_ms
    let best: OldSegmentRow | null = null
    let bestOv = 0
    index.forEachCandidate(seg.start_ms, seg.end_ms, (old) => {
      if (dur <= 0) {
        if (best === null && old.start_ms <= seg.start_ms && seg.start_ms <= old.end_ms) {
          best = old
        }
        return
      }
      const ov = overlap(seg.start_ms, seg.end_ms, old.start_ms, old.end_ms)
      if (ov > bestOv) {
        bestOv = ov
        best = old
      }
    })
    const matched = best as OldSegmentRow | null
    if (!matched) return null
    if (dur > 0 && bestOv * 2 <= dur) return null
    if (matched.speaker_corrected !== 1) return null
    return { oldSpeakerId: matched.speaker_id }
  })
}

/**
 * merge가 INSERT할 화자 행과 세그먼트별 화자 연결을 계획한다.
 *  1) 새 화자 키(등장 순)마다 행 — 승계 속성이 있으면 덮고, 없으면 resolveSpeakerMeta 기본값.
 *  2) 수동 화자 지정(corrections[i])이 있는 세그먼트는 자동 귀속을 무시하고 그 옛 화자를 유지:
 *     옛 화자가 승계로 새 화자에 매핑됐으면 그 새 화자 행, 아니면 옛 행을 별도 화자 행으로
 *     다시 만든다(speaker_key·label·display_name·color 보존). speaker_corrected=true.
 *     옛 화자가 '화자 없음'(null)이면 null 그대로 유지. 옛 화자 행을 찾을 수 없으면 자동 귀속.
 */
export function planSpeakerRows(input: {
  speakerKeyOrder: string[]
  segmentKeys: string[]
  carry: Map<string, CarriedSpeakerMeta>
  corrections?: CorrectedSpeaker[]
  oldSpeakers?: OldSpeakerRow[]
}): { speakers: PlannedSpeaker[]; segments: PlannedSegmentSpeaker[] } {
  const speakers: PlannedSpeaker[] = []
  const indexByKey = new Map<string, number>()

  input.speakerKeyOrder.forEach((key, i) => {
    const meta = resolveSpeakerMeta(key, i)
    const carried = input.carry.get(key)
    indexByKey.set(key, speakers.length)
    speakers.push({
      speaker_key: key,
      label: carried?.label ?? meta.label,
      display_name: carried?.display_name ?? null,
      color: carried?.color ?? meta.color,
      sort_order: speakers.length
    })
  })

  // 승계로 새 화자에 매핑된 옛 화자 → 그 새 화자 행 인덱스
  const indexByOldId = new Map<number, number>()
  for (const [key, carried] of input.carry) {
    const idx = indexByKey.get(key)
    if (idx !== undefined) indexByOldId.set(carried.oldSpeakerId, idx)
  }
  const oldById = new Map((input.oldSpeakers ?? []).map((s) => [s.id, s]))

  const segments = input.segmentKeys.map((key, i): PlannedSegmentSpeaker => {
    const corr = input.corrections?.[i] ?? null
    if (corr) {
      if (corr.oldSpeakerId === null) return { speakerIndex: null, speakerCorrected: true }
      const mapped = indexByOldId.get(corr.oldSpeakerId)
      if (mapped !== undefined) return { speakerIndex: mapped, speakerCorrected: true }
      const old = oldById.get(corr.oldSpeakerId)
      if (old) {
        const idx = speakers.length
        speakers.push({
          speaker_key: old.speaker_key,
          label: old.label,
          display_name: old.display_name,
          color: old.color,
          sort_order: idx
        })
        indexByOldId.set(old.id, idx)
        return { speakerIndex: idx, speakerCorrected: true }
      }
      // 옛 화자 행이 사라졌으면 보정 정보를 버리고 자동 귀속
    }
    return { speakerIndex: indexByKey.get(key) ?? null, speakerCorrected: false }
  })

  return { speakers, segments }
}

/**
 * 시간 순으로 두 세그먼트 목록을 합친다(정제를 건너뛴 수동 수정 세그먼트를 다시 끼워 넣을 때).
 * start_ms → end_ms 순, 같으면 원래 순서(free 먼저) 유지.
 */
export function mergeByTime<T extends { start_ms: number; end_ms: number }>(a: T[], b: T[]): T[] {
  return [...a, ...b]
    .map((s, i) => ({ s, i }))
    .sort((x, y) => x.s.start_ms - y.s.start_ms || x.s.end_ms - y.s.end_ms || x.i - y.i)
    .map((x) => x.s)
}
