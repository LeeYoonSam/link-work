// 화자분리 워커 — utilityProcess에서 실행한다.
// sherpa-onnx의 OfflineSpeakerDiarization.process()는 동기 CPU 작업이라 메인 프로세스에서
// 직접 돌리면 회의 길이만큼 UI가 멈춘다. 별도 프로세스로 분리해 메인 이벤트 루프를 보호한다.
// main 빌드에 별도 엔트리로 포함된다 (electron.vite.config rollupOptions.input).
import { planCentroidMerge } from './embedding-merge'

interface DiarRequest {
  audioPath: string
  segModel: string
  embModel: string
  numSpeakers?: number // 정확한 화자 수 (알면 numClusters에 직접 사용)
  maxSpeakers?: number // 하위 호환
  mergeEmbedding?: boolean // 임베딩 centroid 병합 사용 여부(실험적). 기본 false
  mergeThreshold?: number // 임베딩 centroid 병합 코사인 임계값. 미지정 시 0.55
}

interface SherpaSegment {
  start: number // seconds
  end: number // seconds
  speaker: number // 0-based speaker index
}

// utilityProcess 워커에서 electron이 주입하는 parentPort (필요한 부분만 로컬 정의)
interface ParentPortLike {
  on(event: 'message', listener: (e: { data: DiarRequest }) => void): void
  postMessage(message: unknown): void
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

    const config = {
      segmentation: { pyannote: { model: req.segModel }, numThreads: 2 },
      embedding: { model: req.embModel, numThreads: 2 },
      // threshold 0.85: 공식 예제 0.90 기준. 높을수록 화자 수 감소(과분할 억제).
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

    // 임베딩 centroid 병합은 기본 비활성화(req.mergeEmbedding === true 일 때만 실험적 사용).
    // threshold 기반 union-find가 실제 CAM++ 임베딩에서 single-linkage chaining으로
    // 전 화자를 1명으로 과병합하는 문제가 있어 기본 경로에서 제외한다.
    // 화자 수 정밀도는 numSpeakers(=sherpa numClusters) 지정으로 확보한다.
    let finalSegments = segments
    if (req.mergeEmbedding) {
      try {
        finalSegments = refineByEmbedding(sherpa, segments, wave.samples, wave.sampleRate, req)
      } catch {
        finalSegments = segments
      }
    }

    parentPort.postMessage({ ok: true, segments: finalSegments })
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
})

// ── 임베딩 기반 화자 병합 (자동 모드 전용) ──────────────────────────────────────
const MERGE_THRESHOLD = 0.55 // centroid 코사인 유사도 병합 임계값
const REP_MAX_SEC = 24 // 화자당 임베딩 산출에 쓸 최대 누적 오디오 길이(초)
const REP_MIN_SEC = 0.4 // 누적 오디오가 이 미만이면 centroid 신뢰 불가 → 병합 후보 제외

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
 * 화자 수를 명시 지정하지 않은 자동 클러스터링 결과에 대해, 각 화자 클러스터의
 * 대표 오디오로 centroid 임베딩을 추출하고 코사인 유사도가 높은 화자끼리 병합한다.
 *
 * 화자 수를 지정한 경우(numSpeakers/maxSpeakers)는 sherpa 클러스터링이 이미 그 수로
 * 정확히 묶었으므로 추가 병합하지 않는다.
 */
function refineByEmbedding(
  sherpa: SherpaApi,
  segments: SherpaSegment[],
  samples: Float32Array,
  sampleRate: number,
  req: DiarRequest
): SherpaSegment[] {
  const explicit =
    (req.numSpeakers && req.numSpeakers > 0) || (req.maxSpeakers && req.maxSpeakers > 0)
  if (explicit) return segments

  const speakers = [...new Set(segments.map((s) => s.speaker))]
  if (speakers.length <= 1) return segments

  const extractor = new sherpa.SpeakerEmbeddingExtractor({
    model: req.embModel,
    numThreads: 2
  })

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

  const mergeMap = planCentroidMerge(speakers, centroids, {
    threshold: req.mergeThreshold ?? MERGE_THRESHOLD
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
