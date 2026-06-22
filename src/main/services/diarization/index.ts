// 화자분리 오케스트레이션 — 폴백 체인
// mic+system: 채널 기반 분리(모델 불필요)를 우선 시도 → 2화자 미만/실패면 sherpa 임베딩 분리 → none(단일).
// mic 단독: sherpa 임베딩 다화자 분리 → none.
// 과거엔 mic+system이면 channel만 단독 시도(early return)라, 채널 에너지가 없으면(.channels.json 부재)
// 곧장 단일 화자로 붕괴했다. 이제는 어떤 경우에도 sherpa로 폴백해 다화자 분리를 보장한다.
import type { DiarTurn, SttSegment } from '../meeting-types'
import { SherpaAdapter } from './sherpa-adapter'
import { ChannelAdapter } from './channel-adapter'

export type { DiarizationAdapter } from '../meeting-types'
export type { DiarTurn } from '../meeting-types'
export { ChannelAdapter } from './channel-adapter'

export interface DiarizeOptions {
  source: string
  segments: SttSegment[]
  numSpeakers?: number
  // sherpa 폴백 직전에 모델을 보장(다운로드)하는 콜백. 실패해도 무시하고 none으로 폴백한다.
  ensureModels?: () => Promise<void>
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
  // 1. 채널 기반 분리 (mic+system 전용, 모델 불필요)
  if (opts.source === 'mic+system') {
    try {
      const turns = await new ChannelAdapter().diarize(audioPath, {
        source: opts.source,
        segments: opts.segments
      })
      // channel-adapter는 실제로 2화자 이상 구분될 때만 turns를 반환한다.
      if (turns.length > 0) return { turns, adapter: 'channel' }
    } catch {
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
        numSpeakers: opts.numSpeakers
      })
      if (turns.length > 0) return { turns, adapter: 'sherpa' }
    } catch {
      // sherpa 실패 → none
    }
  }

  // 3. 단일 화자 폴백
  return { turns: [], adapter: 'none' }
}
