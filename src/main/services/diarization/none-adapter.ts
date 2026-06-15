// 단일 화자 폴백 어댑터 — 화자 분리 없이 모든 발화를 spk_0으로 귀속.
import type { DiarizationAdapter, DiarTurn } from '../meeting-types'

export class NoneAdapter implements DiarizationAdapter {
  readonly name = 'none'

  async isAvailable(): Promise<boolean> {
    return true
  }

  async diarize(
    _audioPath: string,
    _opts: { minSpeakers?: number; maxSpeakers?: number }
  ): Promise<DiarTurn[]> {
    // 빈 배열 반환 → pipeline merge 단계에서 모든 segment가 단일 화자로 처리됨
    return []
  }
}
