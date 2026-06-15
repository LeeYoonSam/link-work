// 화자분리 어댑터 팩토리
// 우선순위: sherpa-onnx(네이티브) → channel(mic+system 소스) → none(단일 화자)
import type { DiarizationAdapter } from '../meeting-types'
import { SherpaAdapter } from './sherpa-adapter'
import { ChannelAdapter } from './channel-adapter'
import { NoneAdapter } from './none-adapter'

export type { DiarizationAdapter }
export type { DiarTurn } from '../meeting-types'
export { ChannelAdapter } from './channel-adapter'

export async function getDiarizationAdapter(source?: string): Promise<DiarizationAdapter> {
  // 1. sherpa-onnx 네이티브 시도
  const sherpa = new SherpaAdapter()
  if (await sherpa.isAvailable()) {
    return sherpa
  }

  // 2. mic+system 소스인 경우 채널 분리 어댑터
  if (source === 'mic+system') {
    return new ChannelAdapter()
  }

  // 3. 단일 화자 폴백
  return new NoneAdapter()
}
