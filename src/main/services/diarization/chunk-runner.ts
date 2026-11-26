// 화자분리 청크 조정 — 앱 경로(sherpa-adapter.ts)와 메모리 실측 probe(mem-probe.ts)가 쓴다. electron 을 import 하지 않는다.
// sherpa-onnx-node 1.13.3 은 창(스트림)마다 네이티브 메모리를 돌려주지 않아 워커 하나의 RSS 가 창 수에 비례한다
// (CAM++ 약 3MB/창). 그래서 창 chunkWindows(기본 DIAR_CHUNK_WINDOWS)개마다 embed 워커를 새로 띄우고, 다 모은 임베딩을
// 마지막 cluster 워커 하나에서 클러스터링한다. 워커는 한 번에 하나만 산다(직렬) — 최대 메모리를 청크 크기로 묶는다.
// 창 계획은 WAV 헤더만 읽어 main 에 녹음 전체를 올리지 않는다. 임베딩 함수·창 계획·클러스터링이 단일 프로세스 경로와
// 같아 결과도 같다(number[] 전송은 Float32 → double → Float32 왕복이라 정확하다).
import {
  emptyDiarizeResult,
  planWindowsFromWav,
  type EmbeddingDiarizeResult
} from './embedding-diarizer'
import { readWavInfo } from './wav-pcm'
import type { PlannedWindow } from './window-plan'
import type { DiarWorkerRequest, DiarWorkerResponse } from './worker'

/** embed 워커 하나가 맡는 창 수. 약 3MB/창 × 300 ≈ 0.9GB + 런타임·모델 약 0.2GB. */
export const DIAR_CHUNK_WINDOWS = 300

/** 임베딩 단계가 차지하는 진행률 몫. 나머지는 클러스터링. */
const EMBED_SHARE = 0.95

export interface DiarWorkerChild {
  postMessage(msg: DiarWorkerRequest): void
  on(event: 'message', l: (msg: DiarWorkerResponse) => void): unknown
  on(event: 'exit', l: (code: number) => void): unknown
  kill(): unknown
}

export interface ChunkedDiarizeOptions {
  audioPath: string
  embModel: string
  segments: { start_ms: number; end_ms: number }[]
  numSpeakers?: number
  maxSpeakers?: number
  numThreads?: number
  fork: () => DiarWorkerChild
  /** 기본 DIAR_CHUNK_WINDOWS, 0 이하면 창 전체를 한 청크로 */
  chunkWindows?: number
  /** 전체 기한(모든 워커 합계). 0 이하면 기한 없음. */
  timeoutMs: number
  signal?: AbortSignal
  onProgress?: (ratio: number) => void
}

export interface ChunkedDiarizeResult extends EmbeddingDiarizeResult {
  /** 띄운 embed 워커 수 */
  chunks: number
  /** 모든 워커가 보고한 최대 RSS(MB) 중 최대 */
  peakWorkerRssMb: number
}

/** 창 [0, total) 을 size 개씩 나눈 [a, b) 목록. size ≤ 0 이면 한 청크. */
export function planChunks(total: number, size: number): Array<[number, number]> {
  if (total <= 0) return []
  if (!(size > 0)) return [[0, total]]
  const out: Array<[number, number]> = []
  for (let a = 0; a < total; a += size) out.push([a, Math.min(total, a + size)])
  return out
}

function abortError(): Error {
  const e = new Error('화자분리가 취소되었습니다.')
  e.name = 'AbortError'
  return e
}

export async function runChunkedDiarization(opts: ChunkedDiarizeOptions): Promise<ChunkedDiarizeResult> {
  const { signal } = opts
  if (signal?.aborted) throw abortError()

  const wins = planWindowsFromWav(opts.audioPath, opts.segments)
  if (wins.length === 0) return { ...emptyDiarizeResult(), chunks: 0, peakWorkerRssMb: 0 }
  const info = readWavInfo(opts.audioPath)
  const total = wins.length
  const chunks = planChunks(total, opts.chunkWindows ?? DIAR_CHUNK_WINDOWS)

  // 전체 기한·취소는 현재 단계(하나의 워커)를 끊는다. 끊긴 뒤에는 더 fork 하지 않는다.
  let failure: Error | undefined
  let interrupt: ((err: Error) => void) | undefined
  const stop = (err: Error): void => {
    if (failure) return
    failure = err
    interrupt?.(err)
  }
  const onAbort = (): void => stop(abortError())
  signal?.addEventListener('abort', onAbort)
  const timer =
    opts.timeoutMs > 0 ? setTimeout(() => stop(new Error('화자분리가 시간 초과되었습니다')), opts.timeoutMs) : undefined

  let lastRatio = 0
  const report = (r: number): void => {
    const v = Math.min(1, Math.max(lastRatio, r))
    if (v === lastRatio && r !== 1) return
    lastRatio = v
    opts.onProgress?.(v)
  }

  let peakWorkerRssMb = 0

  /** 워커 하나를 띄워 요청 하나를 보내고 최종 응답을 받는다. 어떤 경로로 끝나든 kill 한다. */
  const runOne = <T extends DiarWorkerResponse['type']>(
    req: DiarWorkerRequest,
    expect: T,
    label: string,
    onProg?: (done: number) => void
  ): Promise<Extract<DiarWorkerResponse, { type: T }>> =>
    new Promise((resolve, reject) => {
      if (failure) {
        reject(failure)
        return
      }
      const child = opts.fork()
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        interrupt = undefined
        try {
          child.kill()
        } catch {
          // 이미 종료됐으면 무시
        }
        fn()
      }
      interrupt = (err) => finish(() => reject(err))
      child.on('message', (msg: DiarWorkerResponse) => {
        if (settled || !msg) return
        if (msg.type === 'progress') {
          onProg?.(msg.done)
          return
        }
        if (msg.type === expect) {
          finish(() => resolve(msg as Extract<DiarWorkerResponse, { type: T }>))
          return
        }
        const error = msg.type === 'error' ? msg.error : `화자분리 워커 응답이 올바르지 않습니다 (${msg.type})`
        finish(() => reject(new Error(error || '화자분리 워커가 실패했습니다.')))
      })
      child.on('exit', (code: number) => {
        finish(() => reject(new Error(`화자분리 워커가 비정상 종료했습니다 (code ${code}, 창 ${label})`)))
      })
      try {
        child.postMessage(req)
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))))
      }
    })

  try {
    const embeddings: number[][] = []
    let maxWindowSec = 0
    for (const [a, b] of chunks) {
      if (failure) throw failure
      const slice: PlannedWindow[] = wins.slice(a, b)
      const res = await runOne(
        {
          op: 'embed',
          audioPath: opts.audioPath,
          embModel: opts.embModel,
          wins: slice,
          totalSamples: info.samples,
          numThreads: opts.numThreads
        },
        'embedded',
        `${a}:${b}`,
        (done) => report((EMBED_SHARE * (a + Math.min(done, b - a))) / total)
      )
      if (!Array.isArray(res.embeddings) || res.embeddings.length !== b - a) {
        throw new Error(`창 ${a}:${b} 임베딩 수 불일치 (${Array.isArray(res.embeddings) ? res.embeddings.length : 'none'})`)
      }
      for (const e of res.embeddings) embeddings.push(e)
      maxWindowSec = Math.max(maxWindowSec, res.maxWindowSec)
      peakWorkerRssMb = Math.max(peakWorkerRssMb, res.peakRssMb || 0)
      report((EMBED_SHARE * b) / total)
    }
    if (failure) throw failure
    const clustered = await runOne(
      {
        op: 'cluster',
        wins,
        embeddings,
        maxWindowSec,
        numSpeakers: opts.numSpeakers,
        maxSpeakers: opts.maxSpeakers
      },
      'clustered',
      'cluster'
    )
    peakWorkerRssMb = Math.max(peakWorkerRssMb, clustered.peakRssMb || 0)
    report(1)
    return { ...clustered.result, chunks: chunks.length, peakWorkerRssMb }
  } catch (err) {
    // 취소·기한이 먼저 났다면 그 오류를 우선한다(워커 kill 로 뒤따르는 exit 오류 대신).
    if (failure) throw failure
    throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (timer) clearTimeout(timer)
    interrupt = undefined
  }
}
