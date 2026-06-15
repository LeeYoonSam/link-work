// STT 어댑터 팩토리
// 우선순위: whisper(네이티브) → manual(폴백)
import type { SttAdapter } from '../meeting-types'
import { WhisperAdapter } from './whisper-adapter'
import { ManualAdapter } from './manual-adapter'

export type { SttAdapter }
export type { SttSegment } from '../meeting-types'

let cached: SttAdapter | null = null

export async function getSttAdapter(): Promise<SttAdapter> {
  if (cached) return cached

  const whisper = new WhisperAdapter()
  if (await whisper.isAvailable()) {
    cached = whisper
    return cached
  }

  cached = new ManualAdapter()
  return cached
}
