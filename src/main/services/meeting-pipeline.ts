// 회의 녹음 파이프라인: STT → VAD → Diarization → merge → DB 저장
// SSOT: docs/MEETING_RECORDING.md §5
import { app } from 'electron'
import { join } from 'path'
import { getDatabase } from '../db/database'
import type { SendStream, SttSegment, DiarTurn } from './meeting-types'
import { getSttAdapter } from './stt/index'
import { GapAdapter } from './vad/gap-adapter'
import { getVadAdapter } from './vad/index'
import { diarizeWithFallback } from './diarization/index'
import { ensureDiarizationModels } from './diarization/model-manager'
import { cleanSegments } from './transcript-cleaner'
import { wavDurationMs } from './wav-util'
import { postprocessTurns } from './diarization/postprocess'

// 화자 색상 팔레트 (순환) — 수동 화자 추가(recording.ipc)에서도 사용
export const SPEAKER_COLORS = [
  '#4F8EF7',
  '#F7844F',
  '#4FBF7A',
  '#C84FF7',
  '#F7C84F',
  '#4FF7F0',
  '#F74F6F',
  '#A0A0A0'
]

interface MeetingRow {
  id: number
  title: string
  audio_path: string | null
  audio_mime: string
  duration_ms: number
  language: string
  source: string
  status: string
  expected_speakers: number | null
}

/**
 * segment와 turn의 겹침 ms를 계산
 */
function overlapMs(
  segStart: number,
  segEnd: number,
  turnStart: number,
  turnEnd: number
): number {
  return Math.max(0, Math.min(segEnd, turnEnd) - Math.max(segStart, turnStart))
}

/**
 * STT segment를 가장 많이 겹치는 diar turn의 speaker_key에 귀속.
 * turns가 비어 있으면 기본 키('spk_0') 반환.
 */
function assignSpeaker(seg: SttSegment, turns: DiarTurn[]): string {
  if (turns.length === 0) return 'spk_0'

  let bestKey = 'spk_0'
  let bestOverlap = -1

  for (const turn of turns) {
    const ov = overlapMs(seg.start_ms, seg.end_ms, turn.start_ms, turn.end_ms)
    if (ov > bestOverlap) {
      bestOverlap = ov
      bestKey = turn.speaker_key
    }
  }
  return bestKey
}

/**
 * speaker_key → 라벨/색상/sort_order 결정.
 * mic → '나', system → '상대', spk_N → '화자 N+1'
 */
function resolveSpeakerMeta(
  speakerKey: string,
  index: number
): { label: string; color: string } {
  if (speakerKey === 'mic') {
    return { label: '나', color: SPEAKER_COLORS[0] }
  }
  if (speakerKey === 'system') {
    return { label: '상대', color: SPEAKER_COLORS[1] }
  }
  return {
    label: `화자 ${index + 1}`,
    color: SPEAKER_COLORS[index % SPEAKER_COLORS.length]
  }
}

export async function runMeetingPipeline(
  meetingId: number,
  send: SendStream,
  opts?: { skipTranscribe?: boolean }
): Promise<{ success: boolean; error?: string; transcribed?: boolean }> {
  const db = getDatabase()

  // ── 1. meetings 행 로드 ──
  const meeting = db
    .prepare('SELECT * FROM meetings WHERE id = ?')
    .get(meetingId) as MeetingRow | undefined

  if (!meeting) {
    const err = '회의를 찾을 수 없습니다.'
    send({ meetingId, phase: 'error', error: err })
    return { success: false, error: err }
  }

  if (!meeting.audio_path) {
    const err = '오디오 파일이 없습니다. 먼저 녹음을 완료해 주세요.'
    db.prepare(
      "UPDATE meetings SET status = 'failed', error = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(err, meetingId)
    send({ meetingId, phase: 'error', error: err })
    return { success: false, error: err }
  }

  const audioPath = join(app.getPath('userData'), 'recordings', meeting.audio_path)

  try {
    // ── 2. STT 전사 (또는 기존 전사 재사용) ──
    send({
      meetingId,
      phase: 'transcribe',
      progress: 0,
      message: opts?.skipTranscribe ? '기존 전사 재사용 중…' : '음성 인식 중…'
    })

    let rawSegments: SttSegment[] = []
    let sttName = 'whisper'

    // 빠른 재적용: 재전사 없이 기존 meeting_segments를 재사용 (정제/화자분리만 다시 수행)
    if (opts?.skipTranscribe) {
      const existing = db
        .prepare(
          'SELECT start_ms, end_ms, text FROM meeting_segments WHERE meeting_id = ? ORDER BY start_ms, sort_order'
        )
        .all(meetingId) as { start_ms: number; end_ms: number; text: string }[]
      rawSegments = existing
        .map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, text: s.text }))
        .filter((s) => s.text && s.text.trim())

      // 박제 차단: 기존 세그먼트의 끝시각이 실제 WAV 길이를 크게 초과하면(과거 ×10 오염 등)
      // 재사용을 포기하고 아래에서 전체 재전사로 폴백한다. 빠른 재적용이 오염 데이터를
      // 그대로 영속화하던 문제를 방지한다.
      const wavMs0 = wavDurationMs(audioPath)
      if (wavMs0 && rawSegments.length > 0) {
        const maxEnd = Math.max(...rawSegments.map((s) => s.end_ms))
        if (maxEnd > wavMs0 * 1.5) {
          send({
            meetingId,
            phase: 'transcribe',
            message: '기존 전사가 오디오 길이와 어긋나 전체 재전사로 전환합니다.'
          })
          rawSegments = []
        }
      }
    }

    // 일반 모드이거나, 빠른 재적용인데 기존 전사가 없으면 STT 실행
    if (rawSegments.length === 0) {
      const sttAdapter = await getSttAdapter()
      sttName = sttAdapter.name
      rawSegments = await sttAdapter.transcribe(audioPath, {
        language: meeting.language || 'ko',
        onProgress: (p) => {
          send({ meetingId, phase: 'transcribe', progress: p })
        },
        onMessage: (m) => {
          send({ meetingId, phase: 'transcribe', message: m })
        }
      })
    }

    // 환각/반복/filler 후처리 정제 (manual 폴백/빈 결과는 변화 없음)
    const beforeClean = rawSegments.length
    rawSegments = cleanSegments(rawSegments)
    if (beforeClean !== rawSegments.length) {
      send({
        meetingId,
        phase: 'transcribe',
        message: `정제 완료 (${beforeClean} → ${rawSegments.length} segment)`
      })
    }

    // 타임스탬프 방어: 실제 WAV 길이(ground truth)를 넘는 비정상 타임스탬프를 클램프한다.
    // (과거 회귀로 STT 타임스탬프가 ×10로 부풀려져 타임라인이 실제 오디오보다 길게
    //  표시되고 재생 시킹이 깨지던 사례 방지.) 정상 데이터에는 영향 없음(no-op).
    const audioMs = wavDurationMs(audioPath)
    if (audioMs && audioMs > 0) {
      rawSegments = rawSegments
        .map((s) => {
          const start = Math.min(Math.max(0, s.start_ms), audioMs)
          const end = Math.min(Math.max(start, s.end_ms), audioMs)
          return { ...s, start_ms: start, end_ms: end }
        })
        .filter((s) => s.end_ms > s.start_ms)
    }

    // manual 어댑터(엔진 미설치) 또는 결과 없음 → 안내 segment 삽입
    const isManualFallback = sttName === 'manual' || rawSegments.length === 0

    if (isManualFallback && sttName === 'manual') {
      rawSegments = [
        {
          start_ms: 0,
          end_ms: Math.max(meeting.duration_ms, 1000),
          text: '전사 엔진(Whisper)이 설치되지 않았습니다. 설치 후 재처리하거나 텍스트를 직접 입력해 주세요.',
          confidence: undefined
        }
      ]
    }

    send({ meetingId, phase: 'transcribe', progress: 1, message: `${rawSegments.length}개 segment 완료` })

    // ── 3. VAD 침묵 검출 ──
    send({ meetingId, phase: 'vad', progress: 0, message: '침묵 구간 감지 중…' })

    const vadAdapter = await getVadAdapter()

    // gap 어댑터라면 STT 세그먼트를 주입
    if (vadAdapter instanceof GapAdapter) {
      vadAdapter.setSegments(rawSegments)
    }

    let silenceRegions: Awaited<ReturnType<typeof vadAdapter.detectSilence>> = []
    try {
      silenceRegions = await vadAdapter.detectSilence(audioPath, { minSilenceMs: 500 })
    } catch {
      // VAD 실패 시 cuts 없이 계속
      silenceRegions = []
    }

    send({ meetingId, phase: 'vad', progress: 1, message: `${silenceRegions.length}개 침묵 구간` })

    // ── 4. 화자 분리 (폴백 체인: channel → sherpa → none) ──
    send({ meetingId, phase: 'diarize', progress: 0, message: '화자 분리 중…' })

    // 참석 인원(expected_speakers)을 지정하면 sherpa가 정확히 그 수로 클러스터링(numClusters).
    // 미지정 시 threshold(0.85) 자동 추정 + postprocessTurns 후처리(smoothing + 소수화자 흡수)로 보정.
    // mic+system은 채널 분리를 우선하되, 채널 에너지가 없거나 단일 화자로만 나오면 sherpa로 폴백한다.
    // sherpa 모델은 폴백 직전(ensureModels 콜백)에만 다운로드한다.
    let turns: DiarTurn[] = []
    try {
      const result = await diarizeWithFallback(audioPath, {
        source: meeting.source,
        segments: rawSegments,
        numSpeakers:
          meeting.expected_speakers && meeting.expected_speakers > 0
            ? meeting.expected_speakers
            : undefined,
        ensureModels: () =>
          ensureDiarizationModels(({ ratio, label }) =>
            send({ meetingId, phase: 'diarize', progress: ratio, message: label })
          )
      })
      turns = result.turns
    } catch {
      turns = []
    }

    // 후처리: smoothing + 소수 화자 흡수로 과분할 감소
    if (turns.length > 0) {
      const beforeCount = new Set(turns.map((t) => t.speaker_key)).size
      turns = postprocessTurns(turns, {
        smooth: { minTurnMs: 200, sandwichMs: 600, gapFillMs: 500 },
        absorb: { minRatio: 0.02, minDurationMs: 60_000 }
      })
      const afterCount = new Set(turns.map((t) => t.speaker_key)).size
      if (beforeCount !== afterCount) {
        send({
          meetingId,
          phase: 'diarize',
          message: `화자 후처리: ${beforeCount}명 → ${afterCount}명`
        })
      }
    }

    // turns가 비어 있으면 merge 단계에서 전체가 spk_0(단일 화자)으로 귀속된다.
    send({ meetingId, phase: 'diarize', progress: 1, message: `${new Set(turns.map((t) => t.speaker_key)).size}명 화자 감지` })

    // ── 5. merge: speaker_key별 speakers 생성 + segments 귀속 ──
    send({ meetingId, phase: 'merge', progress: 0, message: '세그먼트 병합 중…' })

    // speaker_key 순서 결정 (등장 순)
    const speakerKeyOrder: string[] = []
    const speakerKeySet = new Set<string>()

    // turns에서 등장 순 수집
    for (const turn of turns) {
      if (!speakerKeySet.has(turn.speaker_key)) {
        speakerKeyOrder.push(turn.speaker_key)
        speakerKeySet.add(turn.speaker_key)
      }
    }

    // segment 귀속 결과에서 추가 key 수집 (turns 없는 경우 spk_0)
    const segmentAssignments = rawSegments.map((seg) => assignSpeaker(seg, turns))
    for (const key of segmentAssignments) {
      if (!speakerKeySet.has(key)) {
        speakerKeyOrder.push(key)
        speakerKeySet.add(key)
      }
    }

    // DB 트랜잭션으로 저장
    const tx = db.transaction(() => {
      // 기존 데이터 정리 (재처리 시)
      db.prepare('DELETE FROM meeting_speakers WHERE meeting_id = ?').run(meetingId)
      db.prepare('DELETE FROM meeting_segments WHERE meeting_id = ?').run(meetingId)
      db.prepare('DELETE FROM meeting_cuts WHERE meeting_id = ?').run(meetingId)

      // meeting_speakers INSERT
      const speakerIdMap = new Map<string, number>()
      speakerKeyOrder.forEach((key, index) => {
        const { label, color } = resolveSpeakerMeta(key, index)
        const result = db
          .prepare(
            `INSERT INTO meeting_speakers
               (meeting_id, speaker_key, label, color, sort_order)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(meetingId, key, label, color, index)
        speakerIdMap.set(key, Number(result.lastInsertRowid))
      })

      // meeting_segments INSERT
      rawSegments.forEach((seg, i) => {
        const key = segmentAssignments[i]
        const speakerId = speakerIdMap.get(key) ?? null
        db.prepare(
          `INSERT INTO meeting_segments
             (meeting_id, start_ms, end_ms, speaker_id, text, confidence, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          meetingId,
          seg.start_ms,
          seg.end_ms,
          speakerId,
          seg.text,
          seg.confidence ?? null,
          i
        )
      })

      // meeting_cuts INSERT (침묵 구간)
      for (const region of silenceRegions) {
        db.prepare(
          `INSERT INTO meeting_cuts
             (meeting_id, type, start_ms, end_ms, enabled, auto)
           VALUES (?, 'silence', ?, ?, 1, 1)`
        ).run(meetingId, region.start_ms, region.end_ms)
      }

      // duration 결정: WAV 파일 헤더(ground truth) > STT 마지막 발화 끝 > 기존 duration_ms.
      // 과거 회귀로 duration_ms가 부풀려진(예: 10배) 데이터를 재처리 시 자동 교정한다.
      // (기존엔 Math.max로 잘못된 큰 값을 그대로 영속화하는 버그가 있었다.)
      const wavMs = wavDurationMs(audioPath)
      const lastSegEnd =
        rawSegments.length > 0 ? Math.max(...rawSegments.map((s) => s.end_ms)) : 0
      const duration = wavMs ?? (lastSegEnd > 0 ? lastSegEnd : meeting.duration_ms)

      db.prepare(
        `UPDATE meetings
         SET status = 'transcribed', duration_ms = ?, error = NULL,
             updated_at = datetime('now','localtime')
         WHERE id = ?`
      ).run(duration, meetingId)
    })

    tx()

    send({ meetingId, phase: 'merge', progress: 1 })
    send({ meetingId, phase: 'done', progress: 1, message: '처리 완료' })

    // transcribed=false면 폴백(엔진 미설치/빈 전사) → 호출측이 자동 요약을 건너뛴다
    return { success: true, transcribed: !isManualFallback }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.prepare(
      "UPDATE meetings SET status = 'failed', error = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(message, meetingId)
    send({ meetingId, phase: 'error', error: message })
    return { success: false, error: message }
  }
}
