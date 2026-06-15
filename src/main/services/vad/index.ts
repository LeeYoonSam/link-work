// VAD 어댑터 팩토리
// 우선순위: silero(네이티브) → gap(STT segment 공백 기반 폴백)
import type { VadAdapter } from '../meeting-types'
import { SileroAdapter } from './silero-adapter'
import { GapAdapter } from './gap-adapter'

export type { VadAdapter }
export type { VadRegion } from '../meeting-types'
export { GapAdapter } from './gap-adapter'

export async function getVadAdapter(): Promise<VadAdapter> {
  const silero = new SileroAdapter()
  if (await silero.isAvailable()) {
    return silero
  }
  return new GapAdapter()
}
