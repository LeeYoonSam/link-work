// Sherpa-ONNX 화자분리 어댑터 (sherpa-onnx-node — optionalDependency, 네이티브 addon)
// mic-only 단일 채널 녹음에서 음성 임베딩 기반으로 N명 화자를 분리한다.
// process()가 동기 블로킹이라 utilityProcess 워커에서 실행한다 (worker.ts).
import { utilityProcess, app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import type { DiarizationAdapter, DiarTurn, SttSegment } from '../meeting-types'
import { areDiarizationModelsReady, segmentationModelPath, embeddingModelPath } from './model-manager'

interface SherpaSegment {
  start: number // seconds
  end: number // seconds
  speaker: number
}

/** 워커가 알려주는 centroid 정제 결과 요약 (worker.ts DiarWorkerInfo와 동일 형태). */
interface SherpaDiarizationInfo {
  speakersBefore: number
  speakersAfter: number
  refined: boolean
}

interface WorkerResult {
  ok: boolean
  segments?: SherpaSegment[]
  info?: SherpaDiarizationInfo
  error?: string
}

/** 워커 결과(세그먼트 + 정제 요약). */
interface WorkerOutput {
  segments: SherpaSegment[]
  info?: SherpaDiarizationInfo
}

// 워커 타임아웃 기본값: 30분. 긴 회의도 이 안에 끝나며, 넘으면 워커가 멈춘 것으로 본다.
const DEFAULT_WORKER_TIMEOUT_MS = 30 * 60 * 1000

/** sherpa를 쓸 수 없는 이유. null이면 사용 가능. */
type SherpaUnavailableReason = 'not-installed' | 'models-missing'

// 워커 스크립트 경로 — main 빌드 산출물과 같은 디렉터리(out/main/)에 위치
function workerPath(): string {
  return join(__dirname, 'diarization-worker.js')
}

// 취소를 나타내는 에러. name='AbortError'로 호출측이 취소를 식별한다.
function abortError(): Error {
  const e = new Error('화자분리가 취소되었습니다.')
  e.name = 'AbortError'
  return e
}

// sherpa-onnx-node 모듈이 설치돼 있는지(로드까지는 워커에서) require.resolve로 가볍게 확인
function isSherpaInstalled(): boolean {
  try {
    const require = createRequire(join(app.getAppPath(), 'package.json'))
    require.resolve('sherpa-onnx-node')
    return true
  } catch {
    return false
  }
}

export class SherpaAdapter implements DiarizationAdapter {
  readonly name = 'sherpa-onnx'
  /**
   * 마지막 diarize() 호출의 워커 정제 요약. DiarizationAdapter 인터페이스를 바꾸지 않고
   * 호출자(diarizeWithFallback)가 화자 수 변화를 알 수 있게 노출한다. 호출 시작 시 초기화된다.
   */
  lastInfo: SherpaDiarizationInfo | undefined
  private readonly timeoutMs: number

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS
  }

  async isAvailable(): Promise<boolean> {
    // 네이티브 모듈 + segmentation/embedding 모델이 모두 있어야 동작
    return (await this.unavailableReason()) === null
  }

  /** 사용 불가 이유(미설치/모델 없음). 사용 가능하면 null. */
  async unavailableReason(): Promise<SherpaUnavailableReason | null> {
    if (!isSherpaInstalled()) return 'not-installed'
    if (!areDiarizationModelsReady()) return 'models-missing'
    return null
  }

  async diarize(
    audioPath: string,
    opts: {
      minSpeakers?: number
      maxSpeakers?: number
      numSpeakers?: number
      source?: string
      segments?: SttSegment[]
      signal?: AbortSignal
    }
  ): Promise<DiarTurn[]> {
    this.lastInfo = undefined
    if (opts.signal?.aborted) throw abortError()
    const segModel = segmentationModelPath()
    const embModel = embeddingModelPath()
    if (!existsSync(segModel) || !existsSync(embModel)) {
      throw new Error('화자분리 모델이 준비되지 않았습니다.')
    }

    const { segments, info } = await runDiarizationWorker(
      workerPath(),
      {
        audioPath,
        segModel,
        embModel,
        numSpeakers: opts.numSpeakers,
        maxSpeakers: opts.maxSpeakers
      },
      opts.signal,
      this.timeoutMs
    )
    this.lastInfo = info

    return segments.map((s) => ({
      start_ms: Math.round(s.start * 1000),
      end_ms: Math.round(s.end * 1000),
      speaker_key: `spk_${s.speaker}`
    }))
  }
}

/**
 * 화자분리 워커를 fork해 한 번의 작업을 수행하고 결과를 받는다.
 * 워커는 작업 후 종료한다(단발성). 비정상 종료/타임아웃은 reject.
 * 타임아웃(timeoutMs) 초과 시 워커를 kill하고 "화자분리가 시간 초과되었습니다"로 reject한다.
 */
function runDiarizationWorker(
  path: string,
  req: { audioPath: string; segModel: string; embModel: string; numSpeakers?: number; maxSpeakers?: number },
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<WorkerOutput> {
  return new Promise((resolve, reject) => {
    // 시작 시점에 이미 취소됐으면 fork 자체를 생략한다.
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const child = utilityProcess.fork(path)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      // 정상 종료·에러·취소·타임아웃 어느 경로로 끝나든 취소 리스너와 타이머를 해제한다.
      signal?.removeEventListener('abort', onAbort)
      if (timer) clearTimeout(timer)
      try {
        child.kill()
      } catch {
        // 이미 종료됐으면 무시
      }
      fn()
    }

    // 취소 시 워커를 즉시 kill하고 AbortError로 reject한다.
    const onAbort = (): void => finish(() => reject(abortError()))
    signal?.addEventListener('abort', onAbort)

    // 타임아웃: 워커가 멈추거나 비정상적으로 오래 걸리면 kill하고 reject한다(finish가 kill 수행).
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => finish(() => reject(new Error('화자분리가 시간 초과되었습니다'))),
        timeoutMs
      )
    }

    child.on('message', (msg: WorkerResult) => {
      if (msg?.ok && msg.segments) {
        const out: WorkerOutput = { segments: msg.segments, info: msg.info }
        finish(() => resolve(out))
      } else {
        finish(() => reject(new Error(msg?.error || '화자분리 워커가 실패했습니다.')))
      }
    })

    child.on('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`화자분리 워커가 비정상 종료했습니다 (code ${code}).`)))
    })

    child.postMessage(req)
  })
}
