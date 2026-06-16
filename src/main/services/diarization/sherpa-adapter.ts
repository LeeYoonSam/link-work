// Sherpa-ONNX 화자분리 어댑터 (sherpa-onnx — optionalDependency)
// 미설치 환경에서 isAvailable()=false 반환, 폴백으로 자동 전환됨.
import type { DiarizationAdapter, DiarTurn } from '../meeting-types'

interface SherpaSegment {
  start: number   // seconds
  end: number     // seconds
  speaker: number // speaker index (0-based)
}

interface SherpaModule {
  OfflineSpeakerDiarization: new (config: {
    segmentation: { pyannote: { model: string } }
    clustering: { numClusters: number }
  }) => {
    process(wavPath: string): Promise<{ segments: SherpaSegment[] }>
  }
}

let sherpaModule: SherpaModule | null = null

async function loadSherpa(): Promise<SherpaModule | null> {
  if (sherpaModule) return sherpaModule
  try {
    // @ts-expect-error optional native module
    const mod = await import('sherpa-onnx')
    sherpaModule = mod as SherpaModule
    return sherpaModule
  } catch {
    return null
  }
}

export class SherpaAdapter implements DiarizationAdapter {
  readonly name = 'sherpa-onnx'

  async isAvailable(): Promise<boolean> {
    const mod = await loadSherpa()
    if (!mod) return false
    // 네이티브 모듈만 있고 segmentation 모델이 없으면 diarize가 실패하므로,
    // 모델 파일 존재까지 확인해야 폴백(channel/none)이 올바르게 동작한다.
    try {
      const { app } = await import('electron')
      const { join } = await import('path')
      const { existsSync } = await import('fs')
      const modelPath = join(app.getPath('userData'), 'models', 'sherpa-segmentation.onnx')
      return existsSync(modelPath)
    } catch {
      return false
    }
  }

  async diarize(
    audioPath: string,
    opts: { minSpeakers?: number; maxSpeakers?: number }
  ): Promise<DiarTurn[]> {
    const mod = await loadSherpa()
    if (!mod) throw new Error('sherpa-onnx 미설치')

    const { app } = await import('electron')
    const { join } = await import('path')
    const modelPath = join(app.getPath('userData'), 'models', 'sherpa-segmentation.onnx')

    const numClusters = opts.maxSpeakers ?? 2

    const diarizer = new mod.OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: modelPath } },
      clustering: { numClusters }
    })

    const result = await diarizer.process(audioPath)

    return result.segments.map((seg) => ({
      start_ms: Math.round(seg.start * 1000),
      end_ms: Math.round(seg.end * 1000),
      speaker_key: `spk_${seg.speaker}`
    }))
  }
}
