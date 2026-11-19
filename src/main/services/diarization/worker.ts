// 화자분리 워커 — utilityProcess에서 실행한다.
// sherpa-onnx의 OfflineSpeakerDiarization.process()는 동기 CPU 작업이라 메인 프로세스에서
// 직접 돌리면 회의 길이만큼 UI가 멈춘다. 별도 프로세스로 분리해 메인 이벤트 루프를 보호한다.
// main 빌드에 별도 엔트리로 포함된다 (electron.vite.config rollupOptions.input).
import { planIterativeCentroidMerge } from './embedding-merge'

interface DiarRequest {
  audioPath: string
  segModel: string
  embModel: string
  numSpeakers?: number // 정확한 화자 수 (알면 numClusters에 직접 사용)
  maxSpeakers?: number // 하위 호환
}

interface SherpaSegment {
  start: number // seconds
  end: number // seconds
  speaker: number // 0-based speaker index
}

/** centroid 정제 결과 요약. 워커 응답의 info로 메인에 전달된다. */
export interface DiarWorkerInfo {
  speakersBefore: number
  speakersAfter: number
  refined: boolean // centroid 정제를 실제로 수행해 적용했는지 (지정 모드·실패·생략이면 false)
}

/** 워커 응답 형태: 성공 { ok: true, segments, info? } / 실패 { ok: false, error } */
export type DiarWorkerResponse =
  | { ok: true; segments: SherpaSegment[]; info?: DiarWorkerInfo }
  | { ok: false; error: string }

// utilityProcess 워커에서 electron이 주입하는 parentPort (필요한 부분만 로컬 정의)
interface ParentPortLike {
  on(event: 'message', listener: (e: { data: DiarRequest }) => void): void
  postMessage(message: DiarWorkerResponse): void
}
const parentPort = (process as unknown as { parentPort: ParentPortLike }).parentPort

parentPort.on('message', async (e: { data: DiarRequest }) => {
  const req = e.data
  try {
    // sherpa-onnx-node는 external(번들 제외) — 런타임 동적 로드. CJS 모듈이라 default로 노출될 수 있다.
    // @ts-ignore optional native module — 타입은 아래 SherpaApi로 로컬 정의
    const mod = (await import('sherpa-onnx-node')) as unknown as {
      default?: SherpaApi
    } & SherpaApi
    const sherpa: SherpaApi = mod.default ?? mod

    const explicit = isExplicitCount(req)
    const config = {
      segmentation: { pyannote: { model: req.segModel }, numThreads: 2 },
      embedding: { model: req.embModel, numThreads: 2 },
      // threshold: sherpa FastClustering은 (1 - cosine) 거리의 complete linkage AHC이고,
      //   threshold는 그 덴드로그램을 자르는 높이다. 클수록 클러스터(화자) 수가 줄어든다.
      //   공식 기본값은 0.5. 0.85는 과분할을 덜기 위해 높여 둔 값이며, complete linkage 특성상
      //   짧은 조각의 이상치 임베딩 때문에 한 사람이 여러 클러스터로 쪼개지는 문제는 남는다.
      //   그 병합은 아래 centroid 정제(refineByCentroid)가 맡는다.
      // minDurationOn 0.3: 공식 기본값 복원. 짧은 노이즈 조각 출력 제거.
      // minDurationOff 2.0: 2초 이내 침묵은 같은 화자 발화로 병합. 긴 녹음 과분할 대응.
      clustering:
        req.numSpeakers && req.numSpeakers > 0
          ? { numClusters: req.numSpeakers }
          : req.maxSpeakers && req.maxSpeakers > 0
            ? { numClusters: req.maxSpeakers }
            : { numClusters: -1, threshold: 0.85 },
      minDurationOn: 0.3,
      minDurationOff: 2.0
    }

    const sd = new sherpa.OfflineSpeakerDiarization(config)
    // enableExternalBuffer=false: electron V8은 external ArrayBuffer를 거부하므로 복사본을 받는다.
    const wave = sherpa.readWave(req.audioPath, false)
    if (sd.sampleRate !== wave.sampleRate) {
      throw new Error(
        `샘플레이트 불일치 (모델 ${sd.sampleRate}Hz, 오디오 ${wave.sampleRate}Hz). 16kHz mono WAV가 필요합니다.`
      )
    }

    const segments: SherpaSegment[] = sd.process(wave.samples)
    const speakersBefore = countSpeakers(segments)

    // 참석 인원을 지정한 모드는 사용자가 정한 화자 수를 지키기 위해 병합하지 않는다.
    // 자동 추정 모드는 centroid 정제를 기본 수행하고, 실패하면 원래 결과로 폴백한다.
    let finalSegments = segments
    let refined = false
    if (!explicit) {
      try {
        finalSegments = refineByCentroid(sherpa, segments, wave.samples, wave.sampleRate, req.embModel)
        refined = true
      } catch {
        finalSegments = segments
      }
    }

    parentPort.postMessage({
      ok: true,
      segments: finalSegments,
      info: { speakersBefore, speakersAfter: countSpeakers(finalSegments), refined }
    })
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
})

// ── centroid 정제 (자동 추정 모드 전용) ──────────────────────────────────────────
// 3D-Speaker 공식 화자분리 파이프라인(같은 CAM++ 모델)의 후처리를 따른다.
// 병합 코사인 임계: 3D-Speaker merge_by_cos(mer_cos) 기본값 0.8.
const MERGE_COS_THRESHOLD = 0.8
// 화자 수 상한(안전장치): threshold 병합·소수 재할당 뒤에도 이보다 많으면 가장 유사한 쌍부터 더 병합한다.
// 보수적 추정치(일반 회의 참석 인원 상한). 소수 재할당보다 먼저 적용하면 조각 클러스터가 자리를
// 차지한 채 주요 화자끼리 강제 병합돼(실측: 23분 회의가 2명으로 붕괴) 반드시 마지막 단계로 둔다.
const MAX_AUTO_SPEAKERS = 10
// 소수 클러스터 기준(누적 발화 초) = max(MINOR_SPEAKER_SEC, 전체 발화 초 × MINOR_SPEAKER_RATIO).
// - 하한 4초: 3D-Speaker min_cluster_size 4(1.5초 임베딩 창 4개 분량)를 누적 발화 시간으로 근사.
// - 비율 1%: 실측(실제 녹음 3건, threshold 0.85 자동)에서 sherpa 원시 화자 수가 23분 회의 37명,
//   20분 회의 23명, 60분 면접 30명이었고, 4초 기준만으로는 비중 1% 미만(5~15초) 조각 화자가
//   회의당 3~8명 남았다(결과 12명/6명/9명). 기존 후처리(postprocess absorbMinority)가 이미 2% 미만을
//   최다 화자에 흡수하고 있으므로, 1% 미만을 "가장 가까운 화자"로 보내는 것은 그보다 보수적이다.
// 이 기준 미만인 화자는 가장 가까운 주요 화자로(centroid가 없으면 최다 화자로) 재할당한다.
const MINOR_SPEAKER_SEC = 4
const MINOR_SPEAKER_RATIO = 0.01
const REP_MAX_SEC = 24 // 화자당 임베딩 산출에 쓸 최대 누적 오디오 길이(초)
const REP_MIN_SEC = 0.4 // 누적 오디오가 이 미만이면 centroid 신뢰 불가 → centroid 없음(소수면 최다 화자로 재할당)

function isExplicitCount(req: DiarRequest): boolean {
  return Boolean((req.numSpeakers && req.numSpeakers > 0) || (req.maxSpeakers && req.maxSpeakers > 0))
}

function countSpeakers(segments: SherpaSegment[]): number {
  return new Set(segments.map((s) => s.speaker)).size
}

function concatFloat32(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0]
  let total = 0
  for (const p of parts) total += p.length
  const out = new Float32Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/**
 * 자동 클러스터링 결과의 각 화자 대표 오디오로 centroid 임베딩을 추출하고,
 * planIterativeCentroidMerge(반복 병합 + 화자 수 상한 + 소수 재할당)로 화자 id를 재매핑한다.
 * 병합 판단 로직은 순수 함수(embedding-merge.ts)에 있고, 여기서는 추출만 한다.
 */
function refineByCentroid(
  sherpa: SherpaApi,
  segments: SherpaSegment[],
  samples: Float32Array,
  sampleRate: number,
  embModel: string
): SherpaSegment[] {
  const speakers = [...new Set(segments.map((s) => s.speaker))]
  if (speakers.length <= 1) return segments

  // 화자별 누적 발화 초 (병합 centroid 가중치·소수 판정용)
  const weights = new Map<number, number>()
  for (const s of segments) weights.set(s.speaker, (weights.get(s.speaker) ?? 0) + Math.max(0, s.end - s.start))
  let totalSec = 0
  for (const w of weights.values()) totalSec += w

  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: embModel, numThreads: 2 })

  const centroids = new Map<number, Float32Array>()
  for (const spk of speakers) {
    // 대표 오디오: 해당 화자의 segment를 길이 내림차순으로 모아 최대 REP_MAX_SEC까지.
    const segs = segments
      .filter((s) => s.speaker === spk)
      .sort((a, b) => b.end - b.start - (a.end - a.start))

    const parts: Float32Array[] = []
    let totalSamples = 0
    for (const sg of segs) {
      const a = Math.max(0, Math.floor(sg.start * sampleRate))
      const b = Math.min(samples.length, Math.ceil(sg.end * sampleRate))
      if (b <= a) continue
      parts.push(samples.subarray(a, b))
      totalSamples += b - a
      if (totalSamples >= REP_MAX_SEC * sampleRate) break
    }
    if (totalSamples < REP_MIN_SEC * sampleRate) continue

    const stream = extractor.createStream()
    stream.acceptWaveform({ samples: concatFloat32(parts), sampleRate })
    stream.inputFinished()
    // enableExternalBuffer=false: electron V8 호환
    centroids.set(spk, extractor.compute(stream, false))
  }

  if (centroids.size < 2) return segments

  const mergeMap = planIterativeCentroidMerge(speakers, centroids, weights, {
    threshold: MERGE_COS_THRESHOLD,
    maxSpeakers: MAX_AUTO_SPEAKERS,
    minorWeight: Math.max(MINOR_SPEAKER_SEC, totalSec * MINOR_SPEAKER_RATIO)
  })

  return segments.map((s) => ({ ...s, speaker: mergeMap.get(s.speaker) ?? s.speaker }))
}

// sherpa-onnx-node 런타임 형태 (필요한 부분만 로컬 정의)
interface SherpaOnlineStream {
  acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void
  inputFinished(): void
}
interface SherpaApi {
  readWave(
    path: string,
    enableExternalBuffer?: boolean
  ): { samples: Float32Array; sampleRate: number }
  OfflineSpeakerDiarization: new (config: unknown) => {
    sampleRate: number
    process(samples: Float32Array): SherpaSegment[]
  }
  SpeakerEmbeddingExtractor: new (config: {
    model: string
    numThreads?: number
  }) => {
    dim: number
    createStream(): SherpaOnlineStream
    compute(stream: SherpaOnlineStream, enableExternalBuffer?: boolean): Float32Array
  }
}
