// 채널 기반 화자분리 어댑터 (모델 불필요)
// 녹음 시 mic=L / system=R 스테레오로 분리 저장하고, renderer가 추출한 L/R 에너지
// envelope({id}.channels.json)를 이용해 STT segment를 '나(mic)' / '상대(system)'에 귀속한다.
// SSOT: docs/MEETING_RECORDING.md — "마이크=L / 시스템=R … 모델 없이도 2화자 확보"
import { readFile } from 'fs/promises'
import type { DiarizationAdapter, DiarTurn, SttSegment, ChannelEnergy } from '../meeting-types'

// 두 채널 평균 에너지가 모두 이 값 미만이면 침묵으로 보고 직전 화자를 유지한다.
const SILENCE_RMS = 1e-4

export class ChannelAdapter implements DiarizationAdapter {
  readonly name = 'channel'

  async isAvailable(): Promise<boolean> {
    // 채널 분리는 항상 가능 (소프트웨어 로직만)
    return true
  }

  /**
   * mic+system 스테레오 녹음에서 STT segment별 L/R 에너지를 비교해 화자 turn을 만든다.
   * - source가 mic+system이 아니거나, 채널 에너지/세그먼트가 없으면 빈 배열 → 단일 화자 폴백.
   */
  async diarize(
    audioPath: string,
    opts: { minSpeakers?: number; maxSpeakers?: number; source?: string; segments?: SttSegment[] }
  ): Promise<DiarTurn[]> {
    if (opts.source !== 'mic+system') return []

    const segments = opts.segments ?? []
    if (segments.length === 0) return []

    const energy = await loadChannelEnergy(audioPath)
    if (!energy || energy.left.length === 0) return []

    const { hopMs, left, right } = energy
    const frameCount = Math.min(left.length, right.length)

    const turns: DiarTurn[] = []
    let lastKey = 'mic'

    for (const seg of segments) {
      const fStart = Math.max(0, Math.floor(seg.start_ms / hopMs))
      const fEnd = Math.min(frameCount, Math.max(fStart + 1, Math.ceil(seg.end_ms / hopMs)))

      let sumL = 0
      let sumR = 0
      let count = 0
      for (let f = fStart; f < fEnd; f++) {
        sumL += left[f]
        sumR += right[f]
        count++
      }

      let key: string
      if (count === 0) {
        key = lastKey
      } else {
        const avgL = sumL / count
        const avgR = sumR / count
        if (Math.max(avgL, avgR) < SILENCE_RMS) {
          key = lastKey // 침묵 구간 — 직전 화자 유지
        } else {
          key = avgL >= avgR ? 'mic' : 'system'
        }
      }

      turns.push({ start_ms: seg.start_ms, end_ms: seg.end_ms, speaker_key: key })
      lastKey = key
    }

    // 결과가 한 화자(전부 mic 또는 전부 system)뿐이면 채널 분리가 무의미하다.
    // 빈 배열을 반환해 상위 오케스트레이션이 sherpa 임베딩 분리로 폴백하도록 한다.
    if (new Set(turns.map((t) => t.speaker_key)).size < 2) return []

    return turns
  }
}

/**
 * audioPath와 같은 위치의 {base}.channels.json을 읽어 채널 에너지 envelope를 복원한다.
 * 파일이 없거나 파싱 실패 시 null.
 */
async function loadChannelEnergy(audioPath: string): Promise<ChannelEnergy | null> {
  const energyPath = audioPath.replace(/\.[^./\\]+$/, '.channels.json')
  try {
    const raw = await readFile(energyPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ChannelEnergy>
    if (
      typeof parsed.hopMs === 'number' &&
      Array.isArray(parsed.left) &&
      Array.isArray(parsed.right)
    ) {
      return { hopMs: parsed.hopMs, left: parsed.left, right: parsed.right }
    }
    return null
  } catch {
    return null
  }
}
