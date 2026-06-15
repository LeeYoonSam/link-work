// Gap VAD 폴백 어댑터 — STT segment 간 공백을 침묵 구간으로 추정.
// 네이티브 VAD 없이도 cuts를 생성할 수 있게 한다.
import type { VadAdapter, VadRegion, SttSegment } from '../meeting-types'

const DEFAULT_MIN_SILENCE_MS = 500

export class GapAdapter implements VadAdapter {
  readonly name = 'gap'

  private segments: SttSegment[] = []

  /**
   * pipeline에서 STT 결과를 넘겨 gap 계산에 사용.
   * detectSilence 호출 전에 setSegments()로 세팅해야 함.
   */
  setSegments(segments: SttSegment[]): void {
    this.segments = segments
  }

  async isAvailable(): Promise<boolean> {
    return true
  }

  async detectSilence(
    _audioPath: string,
    opts?: { minSilenceMs?: number }
  ): Promise<VadRegion[]> {
    const minMs = opts?.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS
    const sorted = [...this.segments].sort((a, b) => a.start_ms - b.start_ms)

    const regions: VadRegion[] = []
    for (let i = 0; i < sorted.length - 1; i++) {
      const gapStart = sorted[i].end_ms
      const gapEnd = sorted[i + 1].start_ms
      if (gapEnd - gapStart >= minMs) {
        regions.push({ start_ms: gapStart, end_ms: gapEnd, kind: 'silence' })
      }
    }
    return regions
  }
}
