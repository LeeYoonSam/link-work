// Whisper 네이티브 어댑터 (@fugood/whisper.node — optionalDependency, whisper.rn 호환 API)
// 미설치 환경에서 isAvailable()=false → 폴백으로 자동 전환.
// 입력은 16kHz mono WAV 여야 한다 (renderer가 webm→wav 변환 후 저장).
import type { SttAdapter, SttSegment } from '../meeting-types'
import { ensureModel } from './model-manager'

// 모듈 미설치 환경에서도 typecheck가 통과하도록 필요한 형태만 로컬 정의한다.
interface WhisperContextLike {
  transcribeFile(
    filePath: string,
    options?: {
      language?: string
      maxContext?: number
      temperature?: number
      temperatureInc?: number
      onProgress?: (progress: number) => void
    }
  ): { stop: () => Promise<void>; promise: Promise<WhisperTranscribeResult> }
  release(): Promise<void>
}
interface WhisperTranscribeResult {
  result: string
  segments: Array<{ text: string; t0: number; t1: number }>
}
interface WhisperModuleLike {
  initWhisper(options: { filePath: string; useGpu?: boolean }): Promise<WhisperContextLike>
  // 플랫폼 네이티브 바이너리 로드 (가용성 정밀 판정용)
  loadWhisperModule(variant?: string): Promise<unknown>
}

let mod: WhisperModuleLike | null = null
let loadFailed = false

async function loadWhisper(): Promise<WhisperModuleLike | null> {
  if (mod) return mod
  if (loadFailed) return null
  try {
    // @ts-ignore optional native module — 설치 여부와 무관하게 런타임 동적 로드, 타입은 위에서 로컬 정의
    const loaded = (await import('@fugood/whisper.node')) as WhisperModuleLike
    mod = loaded
    return mod
  } catch {
    loadFailed = true
    return null
  }
}

export class WhisperAdapter implements SttAdapter {
  readonly name = 'whisper'

  async isAvailable(): Promise<boolean> {
    const whisper = await loadWhisper()
    if (!whisper) return false
    try {
      // JS 래퍼만 있고 플랫폼 .node 바이너리가 없으면 transcribe가 실패하므로
      // 네이티브 모듈 로드까지 확인해야 manual 폴백이 올바르게 동작한다.
      await whisper.loadWhisperModule()
      return true
    } catch {
      return false
    }
  }

  async transcribe(
    audioPath: string,
    opts: {
      language: string
      onProgress?: (p: number) => void
      onMessage?: (m: string) => void
    }
  ): Promise<SttSegment[]> {
    const whisper = await loadWhisper()
    if (!whisper) throw new Error('whisper.node 미설치')

    // 모델 확보 — 최초 1회 다운로드(약 574MB). 진행률을 UI 메시지로 노출.
    opts.onMessage?.('Whisper 모델 준비 중…')
    const modelPath = await ensureModel((info) => {
      opts.onMessage?.(`Whisper 모델 다운로드 중 ${Math.round(info.ratio * 100)}%`)
    })

    opts.onMessage?.('음성 인식 중…')
    const ctx = await whisper.initWhisper({ filePath: modelPath, useGpu: true })
    try {
      const { promise } = ctx.transcribeFile(audioPath, {
        language: opts.language,
        // maxContext:0 → 직전 텍스트를 컨텍스트로 쓰지 않아 무음 구간 반복 환각을 억제.
        // temperature 0 + fallback(0.2)으로 결정적 디코딩.
        maxContext: 0,
        temperature: 0,
        temperatureInc: 0.2,
        // whisper onProgress: 0~100 → 0~1
        onProgress: (p) => opts.onProgress?.(Math.max(0, Math.min(1, p / 100)))
      })
      const result = await promise
      // @fugood/whisper.node(whisper.rn 호환)의 t0/t1은 이미 ms 단위다(centiseconds 아님).
      // 원본 절대 시간을 그대로 보존한다.
      return result.segments
        .map((s) => ({
          start_ms: Math.round(s.t0),
          end_ms: Math.round(s.t1),
          text: s.text.trim()
        }))
        .filter((s) => s.text.length > 0)
    } finally {
      await ctx.release()
    }
  }
}
