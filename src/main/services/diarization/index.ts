// 화자분리 오케스트레이션 — 폴백 체인
// mic+system: 채널 기반 분리(모델 불필요)를 우선 시도 → 2화자 미만/실패면 sherpa 임베딩 분리 → none(단일).
// mic 단독: sherpa 임베딩 다화자 분리 → none.
// 과거엔 mic+system이면 channel만 단독 시도(early return)라, 채널 에너지가 없으면(.channels.json 부재)
// 곧장 단일 화자로 붕괴했다. 이제는 어떤 경우에도 sherpa로 폴백해 다화자 분리를 보장한다.
import type { DiarTurn, SttSegment } from '../meeting-types'
import { SherpaAdapter } from './sherpa-adapter'
import { ChannelAdapter } from './channel-adapter'
import { combineTwoStage } from './two-stage'

export type { DiarizationAdapter } from '../meeting-types'
export type { DiarTurn } from '../meeting-types'
export { ChannelAdapter } from './channel-adapter'

export interface DiarizeOptions {
  source: string
  segments: SttSegment[]
  numSpeakers?: number
  // sherpa 폴백 직전에 모델을 보장(다운로드)하는 콜백. 실패해도 무시하고 none으로 폴백한다.
  ensureModels?: () => Promise<void>
  // 취소 신호. sherpa 화자분리로 전달되며, abort 시 폴백 체인을 계속 타지 않고 AbortError를 전파한다.
  signal?: AbortSignal
}

// 취소를 나타내는 에러. name='AbortError'로 파이프라인이 취소로 분류한다.
function abortError(): Error {
  const e = new Error('화자분리가 취소되었습니다.')
  e.name = 'AbortError'
  return e
}

/**
 * 화자분리를 폴백 체인으로 수행한다.
 * 1) mic+system이고 채널 에너지로 2화자 이상 분리되면 channel 결과 사용 (모델 불필요).
 * 2) 그 외/실패/단일화자 결과면 sherpa 임베딩 기반 다화자 분리 (모델 필요 → ensureModels).
 * 3) 모두 실패하면 빈 배열(merge 단계에서 단일 화자 spk_0로 귀속).
 */
export async function diarizeWithFallback(
  audioPath: string,
  opts: DiarizeOptions
): Promise<{ turns: DiarTurn[]; adapter: string }> {
  if (opts.signal?.aborted) throw abortError()
  // numSpeakers는 파이프라인에서 meetings.expected_speakers를 그대로 전달한다.
  const expected = opts.numSpeakers

  // 0. 2-스테이지 재정합 (mic+system 이고 참석 인원 3명 이상일 때만).
  //    1:1 통화가 대부분인 기본 케이스(2명 이하·미지정)엔 sherpa 비용을 지우지 않는다.
  //    채널 기반 mic 확정 + 전체 mono sherpa 클러스터를 시간축에서 재정합해
  //    system(상대편) 안의 여러 명을 분리한다.
  if (opts.source === 'mic+system' && expected !== undefined && expected >= 3) {
    const twoStage = await tryTwoStage(audioPath, opts, expected)
    if (twoStage) return twoStage
    // 재정합 불가(채널 에너지 없음 등) → 아래 기존 폴백 체인으로.
  }

  // 1. 채널 기반 분리 (mic+system 전용, 모델 불필요)
  if (opts.source === 'mic+system') {
    try {
      const turns = await new ChannelAdapter().diarize(audioPath, {
        source: opts.source,
        segments: opts.segments
        // 채널 어댑터에는 취소 신호를 전달하지 않는다(의도적). diarize가 channels.json
        // 읽기 + 세그먼트 루프라 수 ms에 끝나 중단할 장시간 작업이 없고, 실제 취소
        // 대상인 sherpa 워커에는 아래에서 signal을 전달한다. 진입/단계별 abort 체크가
        // 이미 경계를 커버한다.
      })
      // channel-adapter는 실제로 2화자 이상 구분될 때만 turns를 반환한다.
      if (turns.length > 0) return { turns, adapter: 'channel' }
    } catch {
      // 취소는 sherpa 폴백으로 삼키지 않고 그대로 전파한다.
      if (opts.signal?.aborted) throw abortError()
      // 채널 분리 실패 → sherpa로 폴백
    }
  }

  // 2. sherpa 임베딩 기반 다화자 분리 (모델 필요)
  try {
    await opts.ensureModels?.()
  } catch {
    // 모델 다운로드 실패 → sherpa.isAvailable()이 false면 아래에서 none으로
  }
  const sherpa = new SherpaAdapter()
  if (await sherpa.isAvailable()) {
    try {
      const turns = await sherpa.diarize(audioPath, {
        source: opts.source,
        segments: opts.segments,
        numSpeakers: opts.numSpeakers,
        signal: opts.signal
      })
      if (turns.length > 0) return { turns, adapter: 'sherpa' }
    } catch {
      // 취소는 none 폴백으로 삼키지 않고 그대로 전파한다.
      if (opts.signal?.aborted) throw abortError()
      // sherpa 실패 → none
    }
  }

  // 3. 단일 화자 폴백
  return { turns: [], adapter: 'none' }
}

/**
 * 2-스테이지 재정합을 시도한다 (mic+system, 참석 인원 3명 이상 전용).
 *  1) channel-adapter로 STT segment별 mic/system turn 확보.
 *     실패·단일 채널(채널 에너지 없음)이면 null → 호출측이 기존 sherpa 폴백으로.
 *  2) 전체 파일을 sherpa로 numSpeakers=참석 인원 클러스터링.
 *     sherpa 불가/실패면 채널 2화자 결과를 그대로 반환(무해).
 *  3) combineTwoStage로 시간축 재정합. sys_N 키가 생기면 상대 분리 성공 → 'two-stage',
 *     아니면(2화자 이하로 폴백) 'channel'.
 *
 * adapter='two-stage'는 파이프라인이 postprocess의 소수화자 흡수(absorbMinority)를
 * 건너뛰도록 하는 판별자다. 흡수를 켜면 짧게 말한 상대 화자가 통째로 흡수돼 분리가
 * 무의미해지기 때문이다.
 */
async function tryTwoStage(
  audioPath: string,
  opts: DiarizeOptions,
  expected: number
): Promise<{ turns: DiarTurn[]; adapter: string } | null> {
  // 1. 채널 기반 mic/system turn (모델 불필요).
  let channelTurns: DiarTurn[]
  try {
    channelTurns = await new ChannelAdapter().diarize(audioPath, {
      source: opts.source,
      segments: opts.segments
      // 채널 어댑터에는 취소 신호 미전달(의도적): 수 ms 작업이라 중단 이득이 없다.
      // 실제 취소 대상은 sherpa 워커이며 그쪽에만 signal을 전달한다.
    })
  } catch {
    // 취소는 그대로 전파하고, 그 외 실패는 null(→ 기존 sherpa 폴백)로 처리한다.
    if (opts.signal?.aborted) throw abortError()
    return null
  }
  // 채널 에너지가 없거나 단일 채널이면 빈 배열 → 기존 sherpa 폴백에 맡긴다.
  if (channelTurns.length === 0) return null

  // 2. 전체 파일 sherpa 클러스터링 (numSpeakers = 참석 인원).
  try {
    await opts.ensureModels?.()
  } catch {
    // 모델 준비 실패 → sherpa.isAvailable()이 false면 아래에서 채널 결과로.
  }
  const sherpa = new SherpaAdapter()
  if (!(await sherpa.isAvailable())) {
    // sherpa 불가 → 재정합 불가. 채널 2화자 결과 그대로.
    return { turns: channelTurns, adapter: 'channel' }
  }
  let sherpaTurns: DiarTurn[]
  try {
    sherpaTurns = await sherpa.diarize(audioPath, {
      source: opts.source,
      segments: opts.segments,
      numSpeakers: expected,
      signal: opts.signal
    })
  } catch {
    // 취소는 채널 결과 폴백으로 삼키지 않고 그대로 전파한다.
    if (opts.signal?.aborted) throw abortError()
    return { turns: channelTurns, adapter: 'channel' }
  }

  // 3. 시간축 재정합. 2화자 이하로 나오면 combineTwoStage가 channelTurns를 그대로 반환한다.
  const combined = combineTwoStage(channelTurns, sherpaTurns)
  const split = combined.some((t) => t.speaker_key.startsWith('sys_'))
  return { turns: combined, adapter: split ? 'two-stage' : 'channel' }
}
