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
  // 1. mic+system 소스는 채널 기반 분리를 우선 (모델 불필요, 정확한 2화자 분리)
  //    sherpa-onnx 모듈이 설치돼 있어도 segmentation 모델이 없으면 실패하므로,
  //    물리적으로 채널이 분리된 mic+system에서는 채널 어댑터가 항상 더 안정적이다.
  if (source === 'mic+system') {
    return new ChannelAdapter()
  }

  // 2. 그 외(mic 단일 소스 등)는 sherpa-onnx 다자 분리 시도 (모델 존재 시에만 available)
  const sherpa = new SherpaAdapter()
  if (await sherpa.isAvailable()) {
    return sherpa
  }

  // 3. 단일 화자 폴백
  return new NoneAdapter()
}
