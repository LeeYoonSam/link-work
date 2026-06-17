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

interface WorkerResult {
  ok: boolean
  segments?: SherpaSegment[]
  error?: string
}

// 워커 스크립트 경로 — main 빌드 산출물과 같은 디렉터리(out/main/)에 위치
function workerPath(): string {
  return join(__dirname, 'diarization-worker.js')
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

  async isAvailable(): Promise<boolean> {
    // 네이티브 모듈 + segmentation/embedding 모델이 모두 있어야 동작
    return isSherpaInstalled() && areDiarizationModelsReady()
  }

  async diarize(
    audioPath: string,
    opts: { minSpeakers?: number; maxSpeakers?: number; numSpeakers?: number; source?: string; segments?: SttSegment[] }
  ): Promise<DiarTurn[]> {
    const segModel = segmentationModelPath()
    const embModel = embeddingModelPath()
    if (!existsSync(segModel) || !existsSync(embModel)) {
      throw new Error('화자분리 모델이 준비되지 않았습니다.')
    }

    const segments = await runDiarizationWorker(workerPath(), {
      audioPath,
      segModel,
      embModel,
      numSpeakers: opts.numSpeakers,
      maxSpeakers: opts.maxSpeakers
    })

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
 */
function runDiarizationWorker(
  path: string,
  req: { audioPath: string; segModel: string; embModel: string; numSpeakers?: number; maxSpeakers?: number }
): Promise<SherpaSegment[]> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path)
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        // 이미 종료됐으면 무시
      }
      fn()
    }

    child.on('message', (msg: WorkerResult) => {
      if (msg?.ok && msg.segments) {
        const segs = msg.segments
        finish(() => resolve(segs))
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
