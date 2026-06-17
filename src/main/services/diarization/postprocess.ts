/**
 * 화자분리 후처리 — 과분할(over-segmentation) 감소
 *
 * Turn 리스트만으로 동작하는 기법(임베딩 불필요):
 *   1. smoothTurns      — 짧은 turn 제거 + 연속 동일화자 병합 + 짧은 이질 turn 제거
 *   2. absorbMinority   — 발화비율/시간 극소 화자를 주요 화자에 흡수
 *
 * 참고:
 *   - median filter window 1.28s (pyannote 계열 시스템)
 *   - minority threshold <2% / <60s (diarization review literature)
 *   - short turn guard 200ms (multiple diarization papers)
 */

import type { DiarTurn } from '../meeting-types'

// ─── 1. Smoothing ────────────────────────────────────────────────────────────

export interface SmoothOptions {
  /** 이 미만 duration turn 제거 (ms). 기본 200ms */
  minTurnMs?: number
  /** 앞뒤 동일화자 사이에 낀 이질 turn이 이 미만이면 제거 (ms). 기본 600ms */
  sandwichMs?: number
  /** 같은 화자의 인접 turn 사이 갭이 이 이하면 병합 (ms). 기본 500ms */
  gapFillMs?: number
}

/**
 * 3단계 smoothing:
 *  1) duration < minTurnMs 인 turn 제거
 *  2) 연속 동일화자 turn 병합 (갭 ≤ gapFillMs)
 *  3) 앞뒤 동일화자 사이에 낀 짧은 이질 turn 제거 (sandwich filter)
 */
export function smoothTurns(turns: DiarTurn[], opts: SmoothOptions = {}): DiarTurn[] {
  const { minTurnMs = 200, sandwichMs = 600, gapFillMs = 500 } = opts

  if (turns.length === 0) return []

  // Step 1: 너무 짧은 turn 제거
  let result: DiarTurn[] = turns
    .map((t) => ({ ...t }))
    .filter((t) => t.end_ms - t.start_ms >= minTurnMs)

  if (result.length === 0) return []

  // Step 2: 같은 화자 인접 turn 반복 병합 (갭 ≤ gapFillMs)
  let changed = true
  while (changed) {
    changed = false
    const merged: DiarTurn[] = []
    for (const turn of result) {
      const last = merged[merged.length - 1]
      if (
        last &&
        last.speaker_key === turn.speaker_key &&
        turn.start_ms - last.end_ms <= gapFillMs
      ) {
        last.end_ms = Math.max(last.end_ms, turn.end_ms)
        changed = true
      } else {
        merged.push({ ...turn })
      }
    }
    result = merged
  }

  // Step 3: sandwich filter — 앞뒤 동일화자 사이에 낀 짧은 이질 turn 제거
  // 제거된 이질 turn의 구간은 앞 turn이 뒷 turn 끝까지 흡수
  changed = true
  while (changed) {
    changed = false
    const filtered: DiarTurn[] = []
    let i = 0
    while (i < result.length) {
      const prev = filtered[filtered.length - 1]
      const curr = result[i]
      const next = result[i + 1]

      if (
        prev &&
        next &&
        prev.speaker_key === next.speaker_key &&
        curr.speaker_key !== prev.speaker_key &&
        curr.end_ms - curr.start_ms < sandwichMs
      ) {
        // 이질 turn 제거 + next도 소비해 prev에 흡수
        filtered[filtered.length - 1] = {
          ...prev,
          end_ms: next.end_ms
        }
        i += 2
        changed = true
      } else {
        filtered.push({ ...curr })
        i++
      }
    }
    result = filtered
  }

  return result
}

// ─── 2. Minority Absorption ───────────────────────────────────────────────────

export interface AbsorbOptions {
  /**
   * 전체 발화 시간 대비 이 비율 미만인 화자는 소수 화자 후보.
   * 기본 0.02 (2%). 발표형(1인 지배) 회의는 0.04~0.05 권장.
   */
  minRatio?: number
  /**
   * 누적 발화 시간이 이 미만인 화자는 소수 화자 후보 (ms). 기본 60_000 (60초).
   * 짧은 회의에서 과소분할을 막기 위해 실제 적용 시 회의 전체 길이의
   * absoluteFraction 비율과 비교해 더 작은 값으로 자동 축소된다.
   */
  minDurationMs?: number
  /**
   * 절대시간 하한을 회의 전체 길이에 적응시킬 때 쓰는 비율. 기본 0.05 (5%).
   * 예: 3분 회의에서 minDurationMs가 60초여도 실효 하한은 9초로 낮아져,
   * 30~50초씩 말한 정상 참석자가 통째로 흡수되는 사고를 막는다.
   */
  absoluteFraction?: number
}

interface SpeakerStats {
  key: string
  totalMs: number
  turnCount: number
}

function computeStats(turns: DiarTurn[]): SpeakerStats[] {
  const map = new Map<string, SpeakerStats>()
  for (const t of turns) {
    const dur = t.end_ms - t.start_ms
    const s = map.get(t.speaker_key)
    if (s) {
      s.totalMs += dur
      s.turnCount++
    } else {
      map.set(t.speaker_key, { key: t.speaker_key, totalMs: dur, turnCount: 1 })
    }
  }
  return [...map.values()]
}

/**
 * 발화비율이 작고(minRatio 미만) 동시에 누적시간도 짧은(적응형 하한 미만) 화자를
 * 가장 발화량이 많은 주요 화자에게 귀속한다.
 *
 * 과거에는 "비율 OR 시간" 중 하나만 충족해도 흡수했으나, 그러면 3분짜리 균형
 * 회의(예: 50% / 28% / 22%)에서 모든 화자가 60초 미만이라 통째로 1명으로
 * 뭉개지는 과소분할이 발생했다. 두 조건을 AND로 묶고, 절대시간 하한을 회의
 * 길이에 비례해 축소함으로써 과분할 잔재(짧고 비중 낮은 조각)만 정확히 흡수한다.
 *
 * 주요 화자가 한 명도 없으면 흡수하지 않는다.
 */
export function absorbMinority(turns: DiarTurn[], opts: AbsorbOptions = {}): DiarTurn[] {
  if (turns.length === 0) return []

  const { minRatio = 0.02, minDurationMs = 60_000, absoluteFraction = 0.05 } = opts

  const stats = computeStats(turns)
  const totalMs = stats.reduce((s, sp) => s + sp.totalMs, 0)
  if (totalMs === 0) return turns

  // 절대시간 하한을 회의 전체 길이에 적응시킨다 (짧은 회의 과소분할 방지).
  const adaptiveMinMs = Math.min(minDurationMs, totalMs * absoluteFraction)

  // 소수 화자: 비율도 작고(AND) 절대시간도 짧은 화자만.
  const isMinor = (sp: SpeakerStats): boolean =>
    sp.totalMs / totalMs < minRatio && sp.totalMs < adaptiveMinMs

  const minorSpeakers = stats.filter(isMinor)
  const major = stats.filter((sp) => !isMinor(sp))

  // 주요 화자가 없거나 흡수할 소수 화자가 없으면 그대로 둔다.
  if (major.length === 0 || minorSpeakers.length === 0) return turns

  // 주요 화자 중 발화량 최다에게 흡수
  const dominant = major.reduce((a, b) => (a.totalMs > b.totalMs ? a : b))
  const minor = new Set(minorSpeakers.map((sp) => sp.key))

  return turns.map((t) =>
    minor.has(t.speaker_key) ? { ...t, speaker_key: dominant.key } : t
  )
}

// ─── 3. 통합 후처리 ───────────────────────────────────────────────────────────

export interface PostprocessOptions {
  smooth?: SmoothOptions | false
  absorb?: AbsorbOptions | false
}

/**
 * smoothTurns → absorbMinority 순서로 적용.
 * false를 넘기면 해당 단계를 건너뜀.
 */
export function postprocessTurns(
  turns: DiarTurn[],
  opts: PostprocessOptions = {}
): DiarTurn[] {
  let result = turns

  if (opts.smooth !== false) {
    result = smoothTurns(result, opts.smooth ?? {})
  }

  if (opts.absorb !== false) {
    result = absorbMinority(result, opts.absorb ?? {})
  }

  // 마지막: 한 번 더 연속 동일화자 병합 (absorb 후 생긴 연속 동일화자 정리)
  if (opts.smooth !== false) {
    result = smoothTurns(result, {
      ...(opts.smooth ?? {}),
      // 2차 패스는 sandwich만 끄고 병합만
      sandwichMs: 0
    })
  }

  return result
}
