// 화자분리 워커 — utilityProcess 에서 실행한다. 한 워커는 요청 하나만 처리하고 조정자(chunk-runner.ts)가 kill 한다.
// - embed: 창 구간(최대 DIAR_CHUNK_WINDOWS개)의 L2 임베딩을 뽑는다. sherpa-onnx-node 가 창마다 네이티브 메모리를
//   돌려주지 않으므로 워커를 청크마다 새로 띄워 최대 메모리를 청크 크기로 묶는다. 오디오는 그 창들이 덮는 샘플만 읽는다.
// - cluster: 모은 임베딩으로 클러스터링 → turn → 목소리를 만든다. sherpa 를 로드하지 않는다.
//   AHC 는 동기 CPU 작업이라 main 에서 돌리면 UI 가 멈추므로 별도 워커에서 한다.
// 본체는 embedding-diarizer.ts 이고 여기서는 모듈 로드와 메시지 왕복만 한다.
// main 빌드에 별도 엔트리로 포함된다 (electron.vite.config rollupOptions.input).
import {
  diarizeFromEmbeddings,
  extractWindowEmbeddings,
  windowSampleRange,
  REQUIRED_SAMPLE_RATE,
  type EmbeddingDiarizeResult,
  type SherpaEmbeddingApi
} from './embedding-diarizer'
import type { PlannedWindow } from './window-plan'
import { readWavPcm16Range } from './wav-pcm'

export type DiarWorkerRequest =
  | {
      op: 'embed'
      audioPath: string
      embModel: string
      wins: PlannedWindow[]
      /** 파일 전체 샘플 수(창 끝 경계를 전체 디코드와 같게 자르는 데 쓴다) */
      totalSamples: number
      numThreads?: number
    }
  | {
      op: 'cluster'
      wins: PlannedWindow[]
      embeddings: number[][]
      maxWindowSec: number
      numSpeakers?: number
      maxSpeakers?: number
    }

export type DiarWorkerResponse =
  | { type: 'progress'; done: number }
  | { type: 'embedded'; embeddings: number[][]; maxWindowSec: number; peakRssMb: number }
  | { type: 'clustered'; result: EmbeddingDiarizeResult; peakRssMb: number }
  | { type: 'error'; error: string }

// utilityProcess 워커에서 electron 이 주입하는 parentPort (필요한 부분만 로컬 정의)
interface ParentPortLike {
  on(event: 'message', listener: (e: { data: DiarWorkerRequest }) => void): void
  postMessage(message: DiarWorkerResponse): void
}
const parentPort = (process as unknown as { parentPort: ParentPortLike }).parentPort

let peak = 0
function samplePeak(): void {
  peak = Math.max(peak, process.memoryUsage().rss)
}
function peakRssMb(): number {
  samplePeak()
  return Math.round(peak / 1048576)
}

async function loadSherpa(): Promise<SherpaEmbeddingApi> {
  // sherpa-onnx-node 는 external(번들 제외) — 런타임 동적 로드. CJS 모듈이라 default 로 노출될 수 있다.
  // @ts-ignore optional native module — 타입은 SherpaEmbeddingApi 로 로컬 정의
  const mod = (await import('sherpa-onnx-node')) as unknown as { default?: SherpaEmbeddingApi } & SherpaEmbeddingApi
  return mod.default ?? mod
}

async function handle(req: DiarWorkerRequest): Promise<DiarWorkerResponse> {
  samplePeak()
  if (req.op === 'embed') {
    const [a, b] = windowSampleRange(req.wins, REQUIRED_SAMPLE_RATE, req.totalSamples)
    const audio = readWavPcm16Range(req.audioPath, a, b)
    if (audio.sampleRate !== REQUIRED_SAMPLE_RATE) {
      return { type: 'error', error: `샘플레이트 불일치 (모델 ${REQUIRED_SAMPLE_RATE}Hz, 오디오 ${audio.sampleRate}Hz).` }
    }
    const sherpa = await loadSherpa()
    const n = req.wins.length
    const r = extractWindowEmbeddings(
      sherpa,
      { embModel: req.embModel, numThreads: req.numThreads },
      audio,
      req.wins,
      0,
      n,
      (ratio) => {
        samplePeak()
        parentPort.postMessage({ type: 'progress', done: Math.round(ratio * n) })
      }
    )
    const embeddings = r.embeddings.map((e) => Array.from(e))
    return { type: 'embedded', embeddings, maxWindowSec: r.maxWindowSec, peakRssMb: peakRssMb() }
  }
  if (req.op === 'cluster') {
    const result = diarizeFromEmbeddings(
      { numSpeakers: req.numSpeakers, maxSpeakers: req.maxSpeakers },
      req.wins,
      req.embeddings.map((e) => Float32Array.from(e)),
      req.maxWindowSec
    )
    return { type: 'clustered', result, peakRssMb: peakRssMb() }
  }
  return { type: 'error', error: `알 수 없는 화자분리 워커 요청입니다: ${(req as { op?: unknown }).op}` }
}

parentPort.on('message', async (e: { data: DiarWorkerRequest }) => {
  try {
    parentPort.postMessage(await handle(e.data))
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  }
})
