// Whisper 모델 다운로드 매니저 (docs/MEETING_RECORDING.md §9)
// 모델은 앱에 번들하지 않고 userData/models/에 최초 1회 다운로드한다.
import { app, net } from 'electron'
import { createWriteStream, existsSync } from 'fs'
import { mkdir, rename, unlink, stat } from 'fs/promises'
import { join } from 'path'

export interface WhisperModelInfo {
  id: string
  file: string
  url: string
  // 진행률 표시용 근사 크기 (서버가 content-length를 안 줄 때 fallback)
  approxBytes: number
}

// 한국어 sweet spot: large-v3-turbo q5_0 (약 574MB, large-v3급 정확도 + ~5x 속도)
export const DEFAULT_MODEL: WhisperModelInfo = {
  id: 'large-v3-turbo-q5_0',
  file: 'ggml-large-v3-turbo-q5_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  approxBytes: 574 * 1024 * 1024
}

export function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

export function modelPath(model: WhisperModelInfo = DEFAULT_MODEL): string {
  return join(modelsDir(), model.file)
}

export function isModelReady(model: WhisperModelInfo = DEFAULT_MODEL): boolean {
  return existsSync(modelPath(model))
}

export type ModelProgress = (info: {
  ratio: number
  downloadedBytes: number
  totalBytes: number
}) => void

let inflight: Promise<string> | null = null

/**
 * 모델이 없으면 다운로드하고 최종 경로를 반환한다. 이미 있으면 즉시 반환.
 * 동시 호출은 하나의 다운로드로 합친다(inflight). 부분 파일은 .part로 받고 완료 시 rename(원자성).
 */
export async function ensureModel(
  onProgress?: ModelProgress,
  model: WhisperModelInfo = DEFAULT_MODEL
): Promise<string> {
  const finalPath = modelPath(model)
  if (existsSync(finalPath)) return finalPath
  if (inflight) return inflight

  inflight = (async () => {
    await mkdir(modelsDir(), { recursive: true })
    const tmpPath = `${finalPath}.part`

    const res = await net.fetch(model.url)
    if (!res.ok || !res.body) {
      throw new Error(`모델 다운로드 실패 (HTTP ${res.status}). 네트워크를 확인해 주세요.`)
    }
    const total = Number(res.headers.get('content-length')) || model.approxBytes

    const fileStream = createWriteStream(tmpPath)
    const reader = res.body.getReader()
    let downloaded = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          downloaded += value.length
          if (!fileStream.write(Buffer.from(value))) {
            // 백프레셔: 버퍼가 비워질 때까지 대기
            await new Promise<void>((resolve) => fileStream.once('drain', () => resolve()))
          }
          onProgress?.({ ratio: total ? downloaded / total : 0, downloadedBytes: downloaded, totalBytes: total })
        }
      }
      await new Promise<void>((resolve, reject) =>
        fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()))
      )
      // 다운로드 무결성 최소 점검: 받은 크기가 비정상적으로 작으면 실패 처리
      const finalSize = (await stat(tmpPath)).size
      if (finalSize < 1024 * 1024) {
        throw new Error('다운로드된 모델 파일이 손상되었습니다.')
      }
      await rename(tmpPath, finalPath)
      return finalPath
    } catch (err) {
      fileStream.destroy()
      try {
        await unlink(tmpPath)
      } catch {
        // 부분 파일 정리 실패는 무시
      }
      throw err
    }
  })()

  try {
    return await inflight
  } finally {
    inflight = null
  }
}
