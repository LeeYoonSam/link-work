// 창 임베딩 화자분리 본체 — 워커(worker.ts)·청크 조정(chunk-runner.ts)·실측 CLI(cli.ts)가 함께 쓴다. electron 을 import 하지 않는다.
// 1) STT 세그먼트 위에 짧은 창(≤ WINDOW_MAX_SEC)을 깔고 2) 창마다 화자 임베딩을 뽑아
// 3) 이웃 평균 → 4~7) 클러스터링 → 8) turn 생성 → 9) 화자별 목소리(centroid) 산출.
// sherpa 의 통합 화자분리(pyannote 분할 + 클러스터링) 기능은 쓰지 않는다(긴 입력에서 배포 Electron 이 죽는다).
import { readFileSync } from 'fs'
import type { DiarTurn } from '../meeting-types'
import { planWindows, HOP_SEC, VOICE_EMBEDDING_MODEL, type PlannedWindow } from './window-plan'
import { clusterEmbeddings, l2normalize, smoothNeighbors } from './clustering'
import { buildTurns } from './turn-build'
import { decodeWavPcm16, readWavInfo, sliceFloat32, type PcmAudio } from './wav-pcm'

/** 모델이 요구하는 샘플레이트. */
export const REQUIRED_SAMPLE_RATE = 16000

function sampleRateMismatch(sr: number): Error {
  return new Error(`샘플레이트 불일치 (모델 ${REQUIRED_SAMPLE_RATE}Hz, 오디오 ${sr}Hz). 16kHz mono WAV가 필요합니다.`)
}

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

/** 창 계획 — 오디오를 디코드해 STT 세그먼트 위에 창을 깐다. 샘플레이트가 다르면 throw. */
export function planDiarizationWindows(req: Pick<EmbeddingDiarizeRequest, 'audioPath' | 'segments'>): {
  audio: PcmAudio
  wins: PlannedWindow[]
} {
  const audio = decodeWavPcm16(readFileSync(req.audioPath))
  if (audio.sampleRate !== REQUIRED_SAMPLE_RATE) throw sampleRateMismatch(audio.sampleRate)
  return { audio, wins: planWindows(req.segments, audio.pcm.length / audio.sampleRate) }
}

/**
 * 창 계획 — WAV 헤더만 읽어(본문 디코드 없이) planDiarizationWindows 와 같은 창을 깐다.
 * 앱 경로(chunk-runner)가 main 에서 녹음 전체를 메모리에 올리지 않으려고 쓴다.
 */
export function planWindowsFromWav(
  audioPath: string,
  segments: ReadonlyArray<{ start_ms: number; end_ms: number }>
): PlannedWindow[] {
  const info = readWavInfo(audioPath)
  if (info.sampleRate !== REQUIRED_SAMPLE_RATE) throw sampleRateMismatch(info.sampleRate)
  return planWindows(segments, info.samples / info.sampleRate)
}

/**
 * 창들이 덮는 샘플 범위 [a, b) — extractWindowEmbeddings 의 창 경계(floor(s*sr), min(total, ceil(e*sr)))와 같은 규칙.
 * 워커가 이 범위만 읽으면 창 슬라이스가 전체 디코드와 같다.
 */
export function windowSampleRange(wins: ReadonlyArray<PlannedWindow>, sr: number, total: number): [number, number] {
  if (wins.length === 0) return [0, 0]
  let a = Infinity
  let b = 0
  for (const w of wins) {
    a = Math.min(a, Math.floor(w.s * sr))
    b = Math.max(b, Math.ceil(w.e * sr))
  }
  b = Math.min(total, b)
  a = Math.max(0, Math.min(a, b))
  return [a, b]
}

/**
 * 창 [from, to) 의 L2 정규화 임베딩을 뽑는다. sherpa-onnx-node 1.13.3 은 창(스트림)마다 네이티브 메모리를
 * 돌려주지 않아(GC·이벤트 루프 양보로도 회수되지 않음) 창 수에 비례해 RSS 가 는다. 앱은 창 DIAR_CHUNK_WINDOWS개마다
 * 워커를 새로 띄운다(chunk-runner.ts). 실측 CLI 는 --chunk 로 구간을 자식 프로세스에 나눠 맡긴다.
 * audio 는 전체 디코드이거나 창 범위만 읽은 것(offset·totalSamples)이다. 창 끝은 파일 전체 샘플 수로 자른다.
 */
export function extractWindowEmbeddings(
  sherpa: SherpaEmbeddingApi,
  req: Pick<EmbeddingDiarizeRequest, 'embModel' | 'numThreads'>,
  audio: PcmAudio,
  wins: PlannedWindow[],
  from = 0,
  to = wins.length,
  onProgress?: DiarizeProgress
): { embeddings: Float32Array[]; maxWindowSec: number } {
  const sr = audio.sampleRate
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: req.embModel, numThreads: req.numThreads ?? 2 })
  const embeddings: Float32Array[] = []
  let maxWindowSec = 0
  const n = to - from
  const step = Math.max(1, Math.floor(n / 100))
  for (let i = from; i < to; i++) {
    const a = Math.floor(wins[i].s * sr)
    const b = Math.min(audio.totalSamples ?? audio.pcm.length, Math.ceil(wins[i].e * sr))
    const samples = sliceFloat32(audio, a, b)
    maxWindowSec = Math.max(maxWindowSec, samples.length / sr)
    const stream = extractor.createStream()
    stream.acceptWaveform({ samples, sampleRate: sr })
    stream.inputFinished()
    // enableExternalBuffer=false: electron V8 은 external ArrayBuffer 를 거부하므로 복사본을 받는다.
    embeddings.push(l2normalize(extractor.compute(stream, false)))
    const k = i - from
    if (onProgress && (k % step === 0 || k === n - 1)) onProgress((k + 1) / n)
  }
  return { embeddings, maxWindowSec }
}

/** 창 임베딩(창 순서대로 전부)에서 클러스터링 → turn → 화자 목소리를 만든다. */
export function diarizeFromEmbeddings(
  req: Pick<EmbeddingDiarizeRequest, 'numSpeakers' | 'maxSpeakers'>,
  wins: PlannedWindow[],
  raw: Float32Array[],
  maxWindowSec: number
): EmbeddingDiarizeResult {
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

/** 빈 결과(창이 하나도 없을 때). */
export function emptyDiarizeResult(): EmbeddingDiarizeResult {
  return {
    turns: [],
    voices: [],
    info: { rawClusters: 0, speakers: 0, windows: 0, maxWindowSec: 0, model: VOICE_EMBEDDING_MODEL }
  }
}

export function runEmbeddingDiarization(
  sherpa: SherpaEmbeddingApi,
  req: EmbeddingDiarizeRequest,
  onProgress?: DiarizeProgress
): EmbeddingDiarizeResult {
  const { audio, wins } = planDiarizationWindows(req)
  if (wins.length === 0) return emptyDiarizeResult()
  const { embeddings, maxWindowSec } = extractWindowEmbeddings(sherpa, req, audio, wins, 0, wins.length, onProgress)
  return diarizeFromEmbeddings(req, wins, embeddings, maxWindowSec)
}
