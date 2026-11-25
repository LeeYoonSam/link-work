// 창 임베딩 화자분리 본체 — 워커(worker.ts)와 실측 CLI(cli.ts)가 함께 쓴다. electron 을 import 하지 않는다.
// 1) STT 세그먼트 위에 짧은 창(≤ WINDOW_MAX_SEC)을 깔고 2) 창마다 화자 임베딩을 뽑아
// 3) 이웃 평균 → 4~7) 클러스터링 → 8) turn 생성 → 9) 화자별 목소리(centroid) 산출.
// sherpa 의 통합 화자분리(pyannote 분할 + 클러스터링) 기능은 쓰지 않는다(긴 입력에서 배포 Electron 이 죽는다).
import { readFileSync } from 'fs'
import type { DiarTurn } from '../meeting-types'
import { planWindows, HOP_SEC, VOICE_EMBEDDING_MODEL } from './window-plan'
import { clusterEmbeddings, l2normalize, smoothNeighbors } from './clustering'
import { buildTurns } from './turn-build'
import { decodeWavPcm16, sliceFloat32 } from './wav-pcm'

/** 모델이 요구하는 샘플레이트. */
const REQUIRED_SAMPLE_RATE = 16000

// sherpa-onnx-node 런타임 중 임베딩 추출에 필요한 부분만 로컬 정의
export interface SherpaStream {
  acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void
  inputFinished(): void
}
export interface SherpaEmbeddingApi {
  SpeakerEmbeddingExtractor: new (config: { model: string; numThreads?: number }) => {
    dim: number
    createStream(): SherpaStream
    compute(stream: SherpaStream, enableExternalBuffer?: boolean): Float32Array
  }
}

export interface EmbeddingDiarizeRequest {
  audioPath: string
  embModel: string
  /** STT 세그먼트(ms). 이 구간 위에만 창을 깐다. */
  segments: { start_ms: number; end_ms: number }[]
  /** 지정 화자 수(>0). 미지정이면 자동 추정. */
  numSpeakers?: number
  /** 자동 모드 화자 수 상한. */
  maxSpeakers?: number
  numThreads?: number
}

/** 화자별 목소리 — 클러스터 centroid(L2) 와 누적 발화 ms. 전송용이라 number[]. */
export interface EmbeddingVoice {
  speaker_key: string
  embedding: number[]
  speech_ms: number
}

export interface EmbeddingDiarizeInfo {
  /** 덴드로그램 컷 직후 클러스터 수 */
  rawClusters: number
  /** 최종 화자 수(후처리 전) */
  speakers: number
  windows: number
  /** 가장 긴 네이티브 입력(초) */
  maxWindowSec: number
  model: string
}

export interface EmbeddingDiarizeResult {
  turns: DiarTurn[]
  voices: EmbeddingVoice[]
  info: EmbeddingDiarizeInfo
}

/** 진행률(0~1). 임베딩 추출이 대부분의 시간을 차지하므로 창 단위로 알린다. */
export type DiarizeProgress = (ratio: number) => void

export function runEmbeddingDiarization(
  sherpa: SherpaEmbeddingApi,
  req: EmbeddingDiarizeRequest,
  onProgress?: DiarizeProgress
): EmbeddingDiarizeResult {
  const audio = decodeWavPcm16(readFileSync(req.audioPath))
  if (audio.sampleRate !== REQUIRED_SAMPLE_RATE) {
    throw new Error(`샘플레이트 불일치 (모델 ${REQUIRED_SAMPLE_RATE}Hz, 오디오 ${audio.sampleRate}Hz). 16kHz mono WAV가 필요합니다.`)
  }
  const sr = audio.sampleRate
  const wins = planWindows(req.segments, audio.pcm.length / sr)
  const empty: EmbeddingDiarizeResult = {
    turns: [],
    voices: [],
    info: { rawClusters: 0, speakers: 0, windows: 0, maxWindowSec: 0, model: VOICE_EMBEDDING_MODEL }
  }
  if (wins.length === 0) return empty

  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: req.embModel, numThreads: req.numThreads ?? 2 })
  const raw: Float32Array[] = []
  let maxWindowSec = 0
  const step = Math.max(1, Math.floor(wins.length / 100))
  for (let i = 0; i < wins.length; i++) {
    const a = Math.floor(wins[i].s * sr)
    const b = Math.min(audio.pcm.length, Math.ceil(wins[i].e * sr))
    const samples = sliceFloat32(audio, a, b)
    maxWindowSec = Math.max(maxWindowSec, samples.length / sr)
    const stream = extractor.createStream()
    stream.acceptWaveform({ samples, sampleRate: sr })
    stream.inputFinished()
    // enableExternalBuffer=false: electron V8 은 external ArrayBuffer 를 거부하므로 복사본을 받는다.
    raw.push(l2normalize(extractor.compute(stream, false)))
    if (onProgress && (i % step === 0 || i === wins.length - 1)) onProgress((i + 1) / wins.length)
  }

  const X = smoothNeighbors(
    raw,
    wins.map((w) => w.si)
  )
  const weights = wins.map(() => HOP_SEC)
  const r = clusterEmbeddings(X, weights, { numSpeakers: req.numSpeakers, maxSpeakers: req.maxSpeakers })
  const turns = buildTurns(wins, r.labels)

  const speechMs = new Map<string, number>()
  for (const t of turns) speechMs.set(t.speaker_key, (speechMs.get(t.speaker_key) ?? 0) + (t.end_ms - t.start_ms))
  const voices: EmbeddingVoice[] = r.centroids.map((c, k) => ({
    speaker_key: `spk_${k}`,
    embedding: Array.from(c.c),
    speech_ms: speechMs.get(`spk_${k}`) ?? 0
  }))

  return {
    turns,
    voices,
    info: {
      rawClusters: r.rawClusters,
      speakers: r.centroids.length,
      windows: wins.length,
      maxWindowSec,
      model: VOICE_EMBEDDING_MODEL
    }
  }
}
