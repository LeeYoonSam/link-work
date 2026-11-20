// 화자 귀속·후처리 옵션·화자 메타 — 파이프라인(meeting-pipeline.ts)에서 분리한 순수 함수 모음.
// SSOT: docs/MEETING_RECORDING.md §5 (merge 귀속 규칙, 후처리 옵션 분기)
import type { DiarTurn } from './meeting-types'
import type { PostprocessOptions } from './diarization/postprocess'

// 화자 색상 팔레트 (순환) — 수동 화자 추가(recording.ipc)에서도 사용(meeting-pipeline이 재수출)
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

/** 두 구간의 겹침 ms (겹치지 않으면 0) */
function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

/** 두 구간 사이 간격 ms (겹치거나 맞닿으면 0) */
function gapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, bStart - aEnd, aStart - bEnd)
}

/**
 * STT 세그먼트를 화자분리 turn의 speaker_key에 귀속한다.
 *  - 겹침이 가장 큰 turn의 화자. 겹침이 같으면 배열에서 먼저 나온 turn.
 *  - 어떤 turn과도 겹치지 않으면(겹침 0) 시간상 가장 가까운 turn(구간 사이 간격 최소)의 화자.
 *    간격이 같으면 먼저 나온 turn.
 *  - turns가 비어 있으면 기본 키 'spk_0'.
 * turns 정렬 여부와 무관하게 정확하다(전수 비교).
 */
export function assignSpeaker(
  seg: { start_ms: number; end_ms: number },
  turns: DiarTurn[]
): string {
  if (turns.length === 0) return 'spk_0'

  let bestOverlapKey: string | null = null
  let bestOverlap = 0
  let nearestKey = turns[0].speaker_key
  let nearestGap = Infinity

  for (const turn of turns) {
    const ov = overlapMs(seg.start_ms, seg.end_ms, turn.start_ms, turn.end_ms)
    if (ov > bestOverlap) {
      bestOverlap = ov
      bestOverlapKey = turn.speaker_key
    }
    if (bestOverlapKey === null) {
      const gap = gapMs(seg.start_ms, seg.end_ms, turn.start_ms, turn.end_ms)
      if (gap < nearestGap) {
        nearestGap = gap
        nearestKey = turn.speaker_key
      }
    }
  }
  return bestOverlapKey ?? nearestKey
}

/**
 * 화자분리 결과 후처리(postprocessTurns) 옵션을 결정한다.
 *  - adapter가 'channel'/'two-stage': 채널 에너지로 확정한 짧은 발화를 지우지 않도록
 *    smoothing은 같은 화자 병합만(minTurnMs 0, sandwichMs 0), 소수 화자 흡수 끔.
 *  - 그 외(sherpa 자동 추정 등): sandwichMs 300(같은 화자 사이에 낀 "네" 같은 짧은 응답 보존),
 *    소수 화자 흡수 유지.
 *  - 사용자가 참석 인원을 지정했으면(expectedSpeakers > 0) 어떤 adapter든 흡수 끔 —
 *    지정한 인원이 흡수로 줄어드는 현상 방지.
 */
export function resolvePostprocessOptions(input: {
  adapter: string
  expectedSpeakers?: number | null
}): PostprocessOptions {
  const channelBased = input.adapter === 'channel' || input.adapter === 'two-stage'
  const userSpecified = (input.expectedSpeakers ?? 0) > 0

  const smooth = channelBased
    ? { minTurnMs: 0, sandwichMs: 0, gapFillMs: 500 }
    : { minTurnMs: 200, sandwichMs: 300, gapFillMs: 500 }

  const absorb: PostprocessOptions['absorb'] =
    channelBased || userSpecified ? false : { minRatio: 0.02, minDurationMs: 60_000 }

  return { smooth, absorb }
}

/**
 * speaker_key → 기본 라벨/색상.
 * mic → '나', system → '상대', sys_N → '상대 N+1'(2-스테이지 분리), 그 외 → '화자 index+1'
 */
export function resolveSpeakerMeta(
  speakerKey: string,
  index: number
): { label: string; color: string } {
  if (speakerKey === 'mic') {
    return { label: '나', color: SPEAKER_COLORS[0] }
  }
  if (speakerKey === 'system') {
    return { label: '상대', color: SPEAKER_COLORS[1] }
  }
  // 2-스테이지 재정합: 'sys_N' → '상대 1', '상대 2' … (system 안에서 분리된 상대편들).
  // 색상은 mic('나')=팔레트[0] 다음부터 순환시켜 상대 1이 기존 '상대'(팔레트[1])와 일치.
  const sysMatch = /^sys_(\d+)$/.exec(speakerKey)
  if (sysMatch) {
    const n = Number(sysMatch[1])
    return {
      label: `상대 ${n + 1}`,
      color: SPEAKER_COLORS[(n + 1) % SPEAKER_COLORS.length]
    }
  }
  return {
    label: `화자 ${index + 1}`,
    color: SPEAKER_COLORS[index % SPEAKER_COLORS.length]
  }
}
