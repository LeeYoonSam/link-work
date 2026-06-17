// 화자분리(sherpa-onnx) 모델 다운로드 매니저.
// segmentation(pyannote) + embedding(3D-Speaker) 두 모델을 userData/models/에 받는다.
// 모델은 앱에 번들하지 않고 최초 1회만 다운로드한다 (stt/model-manager.ts 패턴).
import { app, net } from 'electron'
import { createWriteStream, existsSync } from 'fs'
import { mkdir, rename, unlink, stat } from 'fs/promises'
import { join } from 'path'

export interface DiarModelInfo {
  file: string
  url: string
  approxBytes: number
}

// segmentation: pyannote segmentation 3.0 (huggingface raw .onnx — tar.bz2 압축해제 회피)
export const SEGMENTATION_MODEL: DiarModelInfo = {
  file: 'sherpa-segmentation.onnx',
  url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx',
  approxBytes: 5_992_913
}

// embedding: 3D-Speaker CAM++ (중·영 혼합 학습, 다국어 회의에 무난, 28MB)
export const EMBEDDING_MODEL: DiarModelInfo = {
  file: 'sherpa-embedding.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
  approxBytes: 28_281_164
}

function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

export function segmentationModelPath(): string {
  return join(modelsDir(), SEGMENTATION_MODEL.file)
}

export function embeddingModelPath(): string {
  return join(modelsDir(), EMBEDDING_MODEL.file)
}

export function areDiarizationModelsReady(): boolean {
  return existsSync(segmentationModelPath()) && existsSync(embeddingModelPath())
}

export type DiarModelProgress = (info: { ratio: number; label: string }) => void

async function downloadModel(
  model: DiarModelInfo,
  onProgress?: (ratio: number) => void
): Promise<string> {
  const finalPath = join(modelsDir(), model.file)
  if (existsSync(finalPath)) return finalPath

  await mkdir(modelsDir(), { recursive: true })
  const tmpPath = `${finalPath}.part`

  const res = await net.fetch(model.url)
  if (!res.ok || !res.body) {
    throw new Error(`화자분리 모델 다운로드 실패 (HTTP ${res.status}). 네트워크를 확인해 주세요.`)
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
          await new Promise<void>((resolve) => fileStream.once('drain', () => resolve()))
        }
        onProgress?.(total ? downloaded / total : 0)
      }
    }
    await new Promise<void>((resolve, reject) =>
      fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()))
    )
    // 무결성 최소 점검: 받은 크기가 비정상적으로 작으면 손상으로 간주
    const finalSize = (await stat(tmpPath)).size
    if (finalSize < 100 * 1024) {
      throw new Error('다운로드된 화자분리 모델 파일이 손상되었습니다.')
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
}

let inflight: Promise<void> | null = null

/**
 * 두 모델(segmentation, embedding)을 순차 다운로드한다. 이미 있으면 즉시 반환.
 * 동시 호출은 하나의 작업으로 합친다(inflight).
 */
export async function ensureDiarizationModels(onProgress?: DiarModelProgress): Promise<void> {
  if (areDiarizationModelsReady()) return
  if (inflight) return inflight

  inflight = (async () => {
    await downloadModel(SEGMENTATION_MODEL, (r) =>
      onProgress?.({ ratio: r, label: '화자 분리 모델 다운로드 (1/2)' })
    )
    await downloadModel(EMBEDDING_MODEL, (r) =>
      onProgress?.({ ratio: r, label: '화자 임베딩 모델 다운로드 (2/2)' })
    )
  })()

  try {
    await inflight
  } finally {
    inflight = null
  }
}
