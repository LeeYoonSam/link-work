// Manual STT 폴백 어댑터 — 네이티브 엔진 미설치 시 사용.
// 빈 배열을 반환하고, pipeline에서 안내 segment를 생성한다.
import type { SttAdapter, SttSegment } from '../meeting-types'

export class ManualAdapter implements SttAdapter {
  readonly name = 'manual'

  async isAvailable(): Promise<boolean> {
    return true // 폴백이므로 항상 가용
  }

  async transcribe(
    _audioPath: string,
    _opts: { language: string; onProgress?: (p: number) => void }
  ): Promise<SttSegment[]> {
    // 빈 결과 반환 — pipeline이 안내 segment를 삽입
    return []
  }
}
