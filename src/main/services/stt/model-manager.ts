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

// 한국어 기본 모델: large-v3-turbo q8_0 (약 874MB).
// 더 낮은 비트로 양자화한 모델은 영어 전용에서만 권장되고 한국어는 CER이 눈에 띄게 나빠진다.
// q8_0은 fp16급 품질을 유지하면서 크기만 절반이라 ggml 공식이 비영어권에 권고한다.
export const DEFAULT_MODEL: WhisperModelInfo = {
  id: 'large-v3-turbo-q8_0',
  file: 'ggml-large-v3-turbo-q8_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin',
  approxBytes: 874 * 1024 * 1024
}

// VAD(발화 구간 검출) 모델: silero v5.1.2 ggml (약 865KB).
// 무음·잡음 구간을 전사 전에 제거해 Whisper의 환각을 억제하는 선분할에 쓴다.
// URL은 HEAD로 검증됨(HTTP 200, content-length 885098). 본 모델과 달리 1MB 미만이므로
// ensureModel의 무결성 하한이 approxBytes 기반으로 동작해야 오탐되지 않는다.
export const VAD_MODEL: WhisperModelInfo = {
  id: 'silero-v5.1.2',
  file: 'ggml-silero-v5.1.2.bin',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
  approxBytes: 885098
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

// 모델 file 키별 진행 중 다운로드. 서로 다른 모델(본 모델·VAD 모델)을 동시에 요청해도
// 섞이지 않도록 단일 변수가 아닌 Map으로 관리한다.
const inflight = new Map<string, Promise<string>>()

// 취소를 나타내는 에러. name='AbortError'로 호출측이 취소를 식별한다.
function abortError(): Error {
  const e = new Error('모델 다운로드가 취소되었습니다.')
  e.name = 'AbortError'
  return e
}

/**
 * 모델이 없으면 다운로드하고 최종 경로를 반환한다. 이미 있으면 즉시 반환.
 * 같은 모델의 동시 호출은 하나의 다운로드로 합친다(inflight). 부분 파일은 .part로 받고 완료 시 rename(원자성).
 *
 * signal(취소): read 루프 각 반복에서 aborted를 확인해 reader를 닫고 AbortError를 throw한다.
 * 주의 — 다운로드는 inflight로 공유되므로 signal은 태스크를 만든 최초 호출자의 것만 배선된다.
 * 같은 모델을 기다리는 다른 호출자의 취소는 반영되지 않고, 반대로 최초 호출자가 취소하면 공유
 * 대기자 전부의 다운로드가 중단된다. 현재 앱은 회의를 1건씩 처리하므로 이 제약을 허용한다.
 */
export async function ensureModel(
  onProgress?: ModelProgress,
  model: WhisperModelInfo = DEFAULT_MODEL,
  signal?: AbortSignal
): Promise<string> {
  const finalPath = modelPath(model)
  if (existsSync(finalPath)) return finalPath
  const pending = inflight.get(model.file)
  if (pending) return pending

  const task = (async () => {
    await mkdir(modelsDir(), { recursive: true })
    const tmpPath = `${finalPath}.part`

    if (signal?.aborted) throw abortError()
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
        if (signal?.aborted) {
          // 취소 — reader를 닫고 throw. 아래 catch가 fileStream 파기와 .part 파일 정리를 담당한다.
          await reader.cancel().catch(() => {})
          throw abortError()
        }
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
      // 다운로드 무결성 최소 점검: 받은 크기가 비정상적으로 작으면(에러 페이지 등) 실패 처리.
      // 하한은 모델 크기에 비례시킨다 — VAD 모델처럼 1MB 미만인 모델을 오탐하지 않도록,
      // approxBytes의 절반과 1MB 중 작은 값을 기준으로 삼는다.
      const finalSize = (await stat(tmpPath)).size
      const minValidBytes = Math.min(1024 * 1024, Math.floor(model.approxBytes * 0.5))
      if (finalSize < minValidBytes) {
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

  inflight.set(model.file, task)
  try {
    return await task
  } finally {
    inflight.delete(model.file)
  }
}
