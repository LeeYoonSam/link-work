// 채널 기반 화자분리 폴백 어댑터
// mic=L / system=R 스테레오 분리 저장 규약을 이용해 모델 없이 2화자 확보.
// STT segment 경계를 재활용해 turn을 만든다 (STT 없을 경우 duration 전체를 각 채널로).
import type { DiarizationAdapter, DiarTurn } from '../meeting-types'

export class ChannelAdapter implements DiarizationAdapter {
  readonly name = 'channel'

  async isAvailable(): Promise<boolean> {
    // 채널 분리는 항상 가능 (소프트웨어 로직만)
    return true
  }

  /**
   * mic+system 스테레오 소스에서 L/R 채널 에너지를 비교해 화자 turn을 추정.
   * ffmpeg 없는 MVP 단계에서는 duration 전체를 mic/system 두 블록으로 단순 분할.
   * (에너지 분석 구현은 후속 — 여기선 안전한 더미 분할)
   */
  async diarize(
    _audioPath: string,
    _opts: { minSpeakers?: number; maxSpeakers?: number; source?: string }
  ): Promise<DiarTurn[]> {
    // duration을 알 수 없으므로 빈 배열 반환.
    // pipeline의 merge 단계에서 speaker_key 없는 segment는 'spk_0'으로 귀속됨.
    // 실제 채널 에너지 분석은 ffmpeg/sox 연동 후속 단계에서 구현.
    return []
  }

  /**
   * STT segment 목록이 있을 때 사용하는 채널 분할 헬퍼.
   * 단순히 mic 발화 추정(홀수 segment) / system(짝수)로 교번 분할.
   * 정확한 채널 에너지 분석 전 임시 휴리스틱.
   */
  static buildFromSegments(
    segments: Array<{ start_ms: number; end_ms: number }>,
    source: string
  ): DiarTurn[] {
    if (source !== 'mic+system') {
      // 단일 소스: 모두 mic
      return segments.map((s) => ({
        start_ms: s.start_ms,
        end_ms: s.end_ms,
        speaker_key: 'mic'
      }))
    }
    // mic+system: segment 인덱스 기반 교번 분할 (임시 휴리스틱)
    return segments.map((s, i) => ({
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      speaker_key: i % 2 === 0 ? 'mic' : 'system'
    }))
  }
}
