// silero VAD 발화 구간 검출 — whisper-adapter와 무음 컷편집(audio-compaction)이 공유한다.
//
// 파일 전체를 한 번에 검출한다(detectSpeechFile). 한때 구간 분할 + 병렬 실행을 썼지만,
// 청크 경계마다 silero의 LSTM 상태가 끊겨 경계 근처 발화를 놓쳤고(98분 기준 약 4초),
// 컷편집은 되돌릴 수 없어 그 손실이 곧 "발화가 잘린 녹음"이 된다. 아래 nThreads를 고치고 나면
// 전체 검출도 98분에 26초(224배속)면 끝나므로, 경계 오차 0과 단순한 코드를 택했다.
//
// ⚠️ 안전 규약(임의로 바꾸지 말 것)
//  1. useGpu:false — silero VAD는 Metal 스케줄러에서 ggml_abort로 앱을 즉사시킨 이력이 있다
//     (크래시 리포트 2026-07-23: whisper_vad_init_with_params → ggml_backend_sched_alloc_graph).
//  2. nThreads는 반드시 명시한다. 아래 VAD_THREADS 주석의 실측 참고 — 기본값을 쓰면 사실상 멈춘다.
//  3. .vad-crash-guard 센티널 — 네이티브 abort는 JS try/catch로 못 잡으므로, 컨텍스트 생성 직전
//     파일을 남기고 검출이 무사히 반환하면 지운다. 남아 있으면 직전 실행이 VAD 도중 죽었다는 뜻이다.
//  4. 취소는 throw(AbortError), 그 외 실패는 null 반환 → 호출측이 전체 전사로 폴백한다.
import { existsSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { ensureModel, VAD_MODEL, modelsDir } from './model-manager'
import {
  estimateVadProgress,
  vadSegmentsToRegions,
  type Region,
  type WavDataRange
} from './vad-segmenter'

// VadSegment의 t0/t1은 센티초(cs)다 — vadSegmentsToRegions가 ×10 변환한다.
interface VadSegmentCs {
  t0: number
  t1: number
}
interface VadDetectOptions {
  threshold?: number
  minSpeechDurationMs?: number
  minSilenceDurationMs?: number
  maxSpeechDurationS?: number
  speechPadMs?: number
  samplesOverlap?: number
}
interface WhisperVadContextLike {
  detectSpeechFile(filePath: string, options?: VadDetectOptions): Promise<VadSegmentCs[]>
  release(): Promise<void>
}
interface WhisperVadModuleLike {
  initWhisperVad(options: {
    filePath: string
    useGpu?: boolean
    nThreads?: number
  }): Promise<WhisperVadContextLike>
}

// silero VAD 검출 파라미터.
const VAD_PARAMS: VadDetectOptions = {
  threshold: 0.5,
  minSpeechDurationMs: 250,
  minSilenceDurationMs: 300,
  speechPadMs: 150
}

// ⚠️ 1은 성능상의 취향이 아니라 버그 회피다.
// silero는 0.88MB짜리 초소형 그래프라 프레임(157프레임/5초)마다 스레드를 동기화하는 비용이
// 연산을 압도한다. M2 Pro(12코어) 5초 오디오 실측:
//   nThreads=1 → 33ms, 2 → 43ms, 4 → 229ms, 미지정(=hardware_concurrency=12) → 60초에도 미완료(CPU 482%)
// initWhisperVad는 nThreads를 안 주면 hardware_concurrency를 쓰므로, 예전에 "무음 정리 0%에서
// 수 분간 멈춘 것처럼 보임"의 직접 원인이 이 기본값이었다(97.5분 파일 ~9분 → 26초).
const VAD_THREADS = 1

// 진행률 추정용 배속. 실측 224배속(M2 Pro, nThreads=1) 바로 아래로 잡는다.
// 더 낮게 잡으면 바가 상한(0.95)에 일찍 닿아 거기서 오래 머무른다.
const VAD_REALTIME_FACTOR = 200

// 진행률 티커 주기.
const PROGRESS_TICK_MS = 1000

let mod: WhisperVadModuleLike | null = null
let loadFailed = false

async function loadVadModule(): Promise<WhisperVadModuleLike | null> {
  if (mod) return mod
  if (loadFailed) return null
  try {
    // @ts-ignore optional native module — 설치 여부와 무관하게 런타임 동적 로드, 타입은 위에서 로컬 정의
    const loaded = (await import('@fugood/whisper.node')) as WhisperVadModuleLike
    mod = loaded
    return mod
  } catch {
    loadFailed = true
    return null
  }
}

function abortError(): Error {
  const e = new Error('전사가 취소되었습니다.')
  e.name = 'AbortError'
  return e
}

// ── VAD 크래시 가드 센티널 ──
// 네이티브 abort는 JS로 못 잡으므로, VAD 진입 직전 이 파일을 남기고 검출을 통과하면 지운다.
// 다음 실행 때 파일이 남아 있으면 = 직전 실행이 VAD 도중 죽었다 → 그 1회만 VAD를 건너뛰어
// 크래시 루프 대신 품질 저하(전체 전사)로 강등한다. 영구 비활성화가 아니라 1회 스킵이다.
function vadCrashGuardPath(): string {
  return join(modelsDir(), '.vad-crash-guard')
}

export function writeVadCrashGuard(): void {
  try {
    // 네이티브 abort 직전 확실히 디스크에 남도록 동기 기록(타임스탬프).
    writeFileSync(vadCrashGuardPath(), new Date().toISOString())
  } catch {
    // 센티널 기록 실패는 무시 — 가드가 없을 뿐 정상 경로엔 영향 없다.
  }
}

export function clearVadCrashGuard(): void {
  try {
    unlinkSync(vadCrashGuardPath())
  } catch {
    // 이미 없거나 삭제 실패 — 무시.
  }
}

/**
 * 센티널을 지우지 않고 존재 여부만 본다.
 * 컷편집 단계가 "이번엔 VAD를 건너뛸지"를 판단할 때 쓴다. 소비(삭제)는 transcribe가 1회만
 * 수행해야 하므로 여기서는 절대 지우지 않는다.
 */
export function isVadCrashGuardSet(): boolean {
  return existsSync(vadCrashGuardPath())
}

/**
 * 센티널을 소비한다(존재 여부 반환 + 삭제). 한 번의 처리에서 단 한 번만 호출해야 한다
 * — 현재 호출 지점은 WhisperAdapter.transcribe 진입부 하나뿐이다.
 */
export function consumeVadCrashGuard(): boolean {
  const existed = isVadCrashGuardSet()
  if (existed) clearVadCrashGuard()
  return existed
}

export interface VadDetectResult {
  // 절대시간 발화 구간(ms). vadSegmentsToRegions까지만 적용된 상태로, 전사 청크로 뭉치는
  // coalesceRegions는 호출측(whisper-adapter)이 필요할 때 적용한다.
  regions: Region[]
  // data 바이트 수로 계산한 오디오 길이(ms).
  audioMs: number
}

export interface VadDetectOpts {
  signal?: AbortSignal
  onMessage?: (m: string) => void
  // 0~1. 네이티브가 중간 진행을 알려주지 않으므로 경과 시간 기반 추정치다(estimateVadProgress).
  onProgress?: (p: number) => void
}

/**
 * VAD 모델로 발화 구간을 검출한다.
 * 모델 다운로드/초기화/검출 중 어떤 실패든 null을 반환해 호출측이 폴백하게 한다.
 * 취소만 AbortError로 전파한다(취소가 정상 결과로 오인되면 안 된다).
 *
 * ⚠️ 취소는 네이티브 호출 앞뒤에서만 확인할 수 있다. detectSpeechFile은 중단 수단이 없어
 *    호출 도중 취소가 들어와도 그 검출이 끝날 때까지는 못 멈춘다(98분 기준 최대 ~26초).
 */
export async function detectSpeechRegions(
  audioPath: string,
  dataRange: WavDataRange,
  opts: VadDetectOpts = {}
): Promise<VadDetectResult | null> {
  try {
    if (opts.signal?.aborted) throw abortError()

    const whisper = await loadVadModule()
    if (!whisper) return null

    opts.onMessage?.('발화 구간 검출 준비 중…')
    const vadModelPath = await ensureModel(
      (info) => {
        opts.onMessage?.(`VAD 모델 다운로드 중 ${Math.round(info.ratio * 100)}%`)
      },
      VAD_MODEL,
      opts.signal
    )

    if (opts.signal?.aborted) throw abortError()

    // data 바이트 수로 오디오 길이(ms)를 구한다: dataBytes / byteRate * 1000.
    const byteRate = (dataRange.sampleRate * dataRange.channels * dataRange.bitsPerSample) / 8
    const audioMs = Math.round((dataRange.dataBytes / byteRate) * 1000)
    const expectedSec = Math.max(1, Math.ceil(audioMs / VAD_REALTIME_FACTOR / 1000))
    opts.onMessage?.(`발화 구간 검출 중… (약 ${expectedSec}초 예상)`)

    // 센티널 기록 지점: 아래 initWhisperVad/detectSpeechFile이 catch 불가한 abort로 죽을 수 있다.
    writeVadCrashGuard()
    const vadCtx = await whisper.initWhisperVad({
      filePath: vadModelPath,
      useGpu: false,
      nThreads: VAD_THREADS
    })

    // 네이티브 호출은 중간 진행을 알려주지 않는다. 경과 시간으로 추정치를 흘려보내
    // UI가 "0%에서 멈춤"으로 보이지 않게 한다. 타이머는 어떤 경로로 빠져나가도 반드시 정리한다.
    const startedAt = Date.now()
    const ticker = setInterval(() => {
      opts.onProgress?.(estimateVadProgress(Date.now() - startedAt, audioMs, VAD_REALTIME_FACTOR))
    }, PROGRESS_TICK_MS)

    let segments: VadSegmentCs[]
    try {
      segments = await vadCtx.detectSpeechFile(audioPath, VAD_PARAMS)
    } finally {
      clearInterval(ticker)
      await vadCtx.release().catch(() => {})
    }

    // 검출이 무사히 반환했다 = 네이티브 위험 구간을 벗어났다 → 센티널 제거.
    // (취소로 이어지는 경우에도 프로세스는 살아 있으므로 여기서 지운다.)
    clearVadCrashGuard()
    if (opts.signal?.aborted) throw abortError()

    opts.onProgress?.(1)
    return { regions: vadSegmentsToRegions(segments, audioMs), audioMs }
  } catch {
    // 취소는 폴백으로 삼키지 않고 그대로 전파한다.
    if (opts.signal?.aborted) throw abortError()
    return null
  }
}
