// Silero VAD 네이티브 어댑터 — optionalDependency
// 미설치 환경에서 isAvailable()=false 반환, gap-adapter로 폴백됨.
import type { VadAdapter, VadRegion } from '../meeting-types'

interface SileroSegment {
  start: number  // seconds
  end: number    // seconds
  type: 'speech' | 'silence'
}

interface SileroModule {
  SileroVad: new () => {
    detect(wavPath: string, opts?: { minSilenceMs?: number }): Promise<{ segments: SileroSegment[] }>
  }
}

let sileroModule: SileroModule | null = null

async function loadSilero(): Promise<SileroModule | null> {
  if (sileroModule) return sileroModule
  try {
    // @ts-expect-error optional native module
    const mod = await import('silero-vad-node')
    sileroModule = mod as SileroModule
    return sileroModule
  } catch {
    return null
  }
}

export class SileroAdapter implements VadAdapter {
  readonly name = 'silero'

  async isAvailable(): Promise<boolean> {
    const mod = await loadSilero()
    return mod !== null
  }

  async detectSilence(
    audioPath: string,
    opts?: { minSilenceMs?: number }
  ): Promise<VadRegion[]> {
    const mod = await loadSilero()
    if (!mod) throw new Error('silero-vad-node 미설치')

    const vad = new mod.SileroVad()
    const result = await vad.detect(audioPath, { minSilenceMs: opts?.minSilenceMs ?? 500 })

    return result.segments
      .filter((s) => s.type === 'silence')
      .map((s) => ({
        start_ms: Math.round(s.start * 1000),
        end_ms: Math.round(s.end * 1000),
        kind: 'silence' as const
      }))
  }
}
