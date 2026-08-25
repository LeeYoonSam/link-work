// Whisper 네이티브 어댑터 (@fugood/whisper.node — optionalDependency, whisper.rn 호환 API)
// 미설치 환경에서 isAvailable()=false → 폴백으로 자동 전환.
// 입력은 16kHz mono WAV 여야 한다 (renderer가 webm→wav 변환 후 저장).
//
// VAD 선분할: 무음·잡음 구간에서 Whisper가 문장을 지어내는 환각을 억제하기 위해,
// VAD 모델로 발화 구간만 검출해 구간별 raw PCM을 잘라 전사하고 절대시간으로 복원한다.
// 검출 자체는 stt/vad-detect.ts가 담당하며(무음 컷편집 단계와 공유), opts.speechRegionsMs로
// 이미 검출된 구간을 받으면 VAD를 생략한다. VAD 실패나 WAV 포맷 불일치 시에는 전체 파일 전사로 폴백한다.
import { readFile } from 'fs/promises'
import type { SttAdapter, SttSegment } from '../meeting-types'
import { ensureModel } from './model-manager'
import { detectSpeechRegions, consumeVadCrashGuard } from './vad-detect'
import {
  coalesceRegions,
  sliceSampleRange,
  mapSegmentsToAbsolute,
  findWavDataRange,
  type Region,
  type WavDataRange
} from './vad-segmenter'

// 모듈 미설치 환경에서도 typecheck가 통과하도록 필요한 형태만 로컬 정의한다.
interface WhisperTranscribeOptions {
  language?: string
  maxContext?: number
  temperature?: number
  temperatureInc?: number
  beamSize?: number
  // whisper initial_prompt (native의 prompt 키). 도메인 컨텍스트를 디코딩에 주입.
  prompt?: string
  onProgress?: (progress: number) => void
}
interface WhisperTranscribeResult {
  result: string
  // 전사 세그먼트 t0/t1은 네이티브가 이미 ×10 하여 ms 단위로 온다(VAD 세그먼트의 cs와 다름).
  segments: Array<{ text: string; t0: number; t1: number }>
}
interface WhisperContextLike {
  transcribeFile(
    filePath: string,
    options?: WhisperTranscribeOptions
  ): { stop: () => Promise<void>; promise: Promise<WhisperTranscribeResult> }
  // ArrayBuffer를 WAV 헤더 없는 raw 16-bit PCM(16kHz mono)으로 해석해 전사한다.
  transcribeData(
    audioData: ArrayBuffer,
    options?: WhisperTranscribeOptions
  ): { stop: () => Promise<void>; promise: Promise<WhisperTranscribeResult> }
  release(): Promise<void>
}
interface WhisperModuleLike {
  initWhisper(options: { filePath: string; useGpu?: boolean }): Promise<WhisperContextLike>
  // 플랫폼 네이티브 바이너리 로드 (가용성 정밀 판정용)
  loadWhisperModule(variant?: string): Promise<unknown>
}

type TranscribeOpts = {
  language: string
  prompt?: string
  onProgress?: (p: number) => void
  onMessage?: (m: string) => void
  // 취소 신호. abort 시 진행 중인 네이티브 전사를 stop()으로 중단하고 AbortError를 throw한다.
  signal?: AbortSignal
  // 이미 검출된 발화 구간(ms, 이 오디오 파일의 타임라인 기준). 무음 컷편집 단계가 VAD를 먼저
  // 돌리므로 그 결과를 넘겨받아 여기서는 VAD를 생략한다(한 처리에서 VAD 2회 실행 방지).
  speechRegionsMs?: Region[]
}

let mod: WhisperModuleLike | null = null
let loadFailed = false

async function loadWhisper(): Promise<WhisperModuleLike | null> {
  if (mod) return mod
  if (loadFailed) return null
  try {
    // @ts-ignore optional native module — 설치 여부와 무관하게 런타임 동적 로드, 타입은 위에서 로컬 정의
    const loaded = (await import('@fugood/whisper.node')) as WhisperModuleLike
    mod = loaded
    return mod
  } catch {
    loadFailed = true
    return null
  }
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

// 취소를 나타내는 에러. name='AbortError'로 파이프라인이 정상 결과가 아닌 취소로 분류한다.
function abortError(): Error {
  const e = new Error('전사가 취소되었습니다.')
  e.name = 'AbortError'
  return e
}

// VAD 선분할 결과를 전사 청크로 뭉치는 파라미터.
// 발화 구간을 그대로 전사하면 자연스러운 쉼마다 쪼개져 초소형 구간이 폭발한다(호출 수백 회
// → 전체 전사보다 수 배 느림 + 문맥 상실로 품질 저하). 그래서 인접 구간을 침묵째 전사 청크로
// 뭉쳐 넘긴다(간격 2초 이하 병합, 청크 타임라인 28초에서 절단 — coalesceRegions 참고).
const COALESCE_OPTIONS = { joinGapMs: 2000, maxChunkMs: 28000 }

// 어댑터가 직접 VAD를 돌리는 경로에서 VAD에 배분하는 진행률 몫.
// (컷편집 단계가 VAD를 이미 돌려 speechRegionsMs를 넘겨준 경로에는 적용하지 않는다 —
//  그쪽은 compact 단계가 자기 진행률을 따로 보고하므로 전사는 0→1을 그대로 쓴다.)
const VAD_PROGRESS_SHARE = 0.08

export class WhisperAdapter implements SttAdapter {
  readonly name = 'whisper'

  async isAvailable(): Promise<boolean> {
    const whisper = await loadWhisper()
    if (!whisper) return false
    try {
      // JS 래퍼만 있고 플랫폼 .node 바이너리가 없으면 transcribe가 실패하므로
      // 네이티브 모듈 로드까지 확인해야 manual 폴백이 올바르게 동작한다.
      await whisper.loadWhisperModule()
      return true
    } catch {
      return false
    }
  }

  async transcribe(audioPath: string, opts: TranscribeOpts): Promise<SttSegment[]> {
    const whisper = await loadWhisper()
    if (!whisper) throw new Error('whisper.node 미설치')
    if (opts.signal?.aborted) throw abortError()

    // 직전 실행이 VAD 도중 네이티브 abort로 죽었으면 .vad-crash-guard 센티널이 남아 있다.
    // 이 경우 이번 1회는 VAD를 건너뛰어 크래시 루프를 피한다(센티널은 소비 시 지워지므로 다음엔 재시도).
    // ⚠️ 센티널 소비는 한 처리에서 여기 한 곳뿐이다. 컷편집 단계는 isVadCrashGuardSet()으로
    //    보기만 하고 지우지 않으므로, 컷편집이 VAD를 건너뛴 실행에서도 이 스킵이 유효하다.
    const skipVadAfterCrash = consumeVadCrashGuard()

    // 본 모델 확보 — 최초 1회 다운로드(약 874MB). 진행률을 UI 메시지로 노출.
    opts.onMessage?.('Whisper 모델 준비 중…')
    const modelPath = await ensureModel(
      (info) => {
        opts.onMessage?.(`Whisper 모델 다운로드 중 ${Math.round(info.ratio * 100)}%`)
      },
      undefined,
      opts.signal
    )

    // WAV data 청크를 1회 읽어 확보(raw PCM 슬라이스용). 16k/mono/16bit가 아니면 null → 폴백.
    const wavBuf = await readFile(audioPath)
    const dataRange = findWavDataRange(wavBuf)

    opts.onMessage?.('음성 인식 중…')
    const ctx = await whisper.initWhisper({ filePath: modelPath, useGpu: true })
    try {
      // 컷편집 단계에서 이미 검출된 발화 구간이 있으면 VAD를 다시 돌리지 않는다.
      // dataRange가 없으면(포맷 불일치) 애초에 raw 슬라이스가 불가하므로 폴백.
      let regions: Region[] | null = null
      // 이 호출에서 VAD를 직접 돌렸는지 — 진행률 구간 배분에 쓴다.
      let ranVad = false
      if (opts.speechRegionsMs) {
        regions = dataRange ? coalesceRegions(opts.speechRegionsMs, COALESCE_OPTIONS) : null
      } else if (skipVadAfterCrash) {
        // 직전 실행이 VAD 도중 비정상 종료 → 이번엔 발화 구간 검출을 생략하고 전체 전사로 강등한다.
        opts.onMessage?.('이전 실행에서 VAD가 비정상 종료되어 이번에는 발화 구간 검출 없이 전사합니다.')
        return await this.transcribeWholeFile(ctx, audioPath, opts)
      } else if (dataRange) {
        ranVad = true
        const detected = await detectSpeechRegions(audioPath, dataRange, {
          ...opts,
          onProgress: (p) => opts.onProgress?.(clamp01(p) * VAD_PROGRESS_SHARE)
        })
        regions = detected ? coalesceRegions(detected.regions, COALESCE_OPTIONS) : null
      }

      // VAD를 직접 돌린 경우 전사 진행률을 그 뒤 구간(0.08~1)으로 밀어 단조 증가를 유지한다.
      const scoped: TranscribeOpts = ranVad
        ? {
            ...opts,
            onProgress: (p) =>
              opts.onProgress?.(VAD_PROGRESS_SHARE + (1 - VAD_PROGRESS_SHARE) * clamp01(p))
          }
        : opts

      if (!dataRange || regions === null) {
        // VAD 모델/초기화/검출 실패 또는 WAV 포맷 불일치 → 기존 전체 파일 전사 경로.
        return await this.transcribeWholeFile(ctx, audioPath, scoped)
      }
      if (regions.length === 0) {
        // VAD가 발화 0건 → 진짜 무음. 지어내지 않는 게 목적이므로 빈 배열.
        opts.onProgress?.(1)
        return []
      }
      return await this.transcribeRegions(ctx, wavBuf, dataRange, regions, scoped)
    } finally {
      await ctx.release()
    }
  }

  // 본 모델·구간 전사에 공통으로 쓰는 디코딩 옵션.
  private buildTranscribeOptions(opts: TranscribeOpts): WhisperTranscribeOptions {
    return {
      language: opts.language,
      // maxContext:0 → 직전 텍스트를 컨텍스트로 쓰지 않아 무음 구간 반복 환각을 억제.
      // temperature 0 + fallback(0.2)으로 결정적 디코딩.
      maxContext: 0,
      temperature: 0,
      temperatureInc: 0.2,
      // beamSize 5 빔서치 — greedy 대비 한국어 정확도가 개선된다(속도는 소폭 희생).
      beamSize: 5,
      // prompt(=initial_prompt)는 있을 때만 전달. undefined 키가 native에 새지 않도록 조건부 spread.
      ...(opts.prompt ? { prompt: opts.prompt } : {})
    }
  }

  // 전사 결과 세그먼트(ms 단위) → SttSegment. 빈 텍스트는 버린다.
  private toSttSegments(result: WhisperTranscribeResult): SttSegment[] {
    return result.segments
      .map((s) => ({
        start_ms: Math.round(s.t0),
        end_ms: Math.round(s.t1),
        text: s.text.trim()
      }))
      .filter((s) => s.text.length > 0)
  }

  /**
   * 전사 청크(coalesceRegions가 뭉친 연속 타임라인 슬라이스)별 raw PCM을 잘라 순차 전사하고,
   * 청크 시작 오프셋 하나로 절대시간을 복원해 이어붙인다. 청크는 연속 슬라이스라 내부 침묵까지
   * 포함하므로 오프셋 단일 가산으로 타임스탬프가 정확히 맞는다.
   * 진행률은 (완료된 청크 누적 타임라인 / 전체 청크 타임라인)으로 0~1 보고한다.
   */
  private async transcribeRegions(
    ctx: WhisperContextLike,
    wavBuf: Buffer,
    dataRange: WavDataRange,
    regions: Region[],
    opts: TranscribeOpts
  ): Promise<SttSegment[]> {
    const totalSpeechMs = regions.reduce((a, r) => a + (r.endMs - r.startMs), 0) || 1
    const baseOptions = this.buildTranscribeOptions(opts)
    const out: SttSegment[] = []
    let doneMs = 0

    for (const region of regions) {
      // 각 구간 시작 시 취소 확인 — 진행 중인 구간이 없을 때 즉시 중단한다.
      if (opts.signal?.aborted) throw abortError()
      const regionMs = region.endMs - region.startMs
      const { startSample, endSample } = sliceSampleRange(region.startMs, region.endMs, dataRange.sampleRate)
      // 샘플 인덱스 → data 청크 내 바이트(16-bit=샘플×2). data 경계로 클램프해 오버런을 막는다.
      const startByte = Math.min(startSample * 2, dataRange.dataBytes)
      const endByte = Math.min(endSample * 2, dataRange.dataBytes)
      if (endByte <= startByte) {
        doneMs += regionMs
        opts.onProgress?.(clamp01(doneMs / totalSpeechMs))
        continue
      }

      // Buffer.subarray는 동일 메모리를 가리키므로, 그 구간만 새 ArrayBuffer로 복사한다.
      // (Buffer.buffer는 ArrayBuffer|SharedArrayBuffer 유니온이라 복사로 타입도 확정한다.)
      const pcm = wavBuf.subarray(dataRange.dataOffset + startByte, dataRange.dataOffset + endByte)
      const slice = new ArrayBuffer(pcm.byteLength)
      new Uint8Array(slice).set(pcm)

      const base = doneMs
      const call = ctx.transcribeData(slice, {
        ...baseOptions,
        // 구간 내부 진행률(0~100)을 전체 발화시간 기준으로 환산해 매끄럽게 보고.
        onProgress: (p) => opts.onProgress?.(clamp01((base + regionMs * (p / 100)) / totalSpeechMs))
      })
      const result = await this.runNativeWithAbort(call, opts.signal)
      // 슬라이스 상대 ms → region 시작 ms를 더해 절대시간 복원.
      out.push(...mapSegmentsToAbsolute(this.toSttSegments(result), region.startMs))

      doneMs += regionMs
      opts.onProgress?.(clamp01(doneMs / totalSpeechMs))
    }

    return out
  }

  /**
   * VAD 폴백 경로: 오디오 전체를 한 번에 전사한다.
   */
  private async transcribeWholeFile(
    ctx: WhisperContextLike,
    audioPath: string,
    opts: TranscribeOpts
  ): Promise<SttSegment[]> {
    if (opts.signal?.aborted) throw abortError()
    const call = ctx.transcribeFile(audioPath, {
      ...this.buildTranscribeOptions(opts),
      // whisper onProgress: 0~100 → 0~1
      onProgress: (p) => opts.onProgress?.(clamp01(p / 100))
    })
    const result = await this.runNativeWithAbort(call, opts.signal)
    return this.toSttSegments(result)
  }

  /**
   * 네이티브 전사 호출({ stop, promise })을 취소 신호와 함께 실행한다.
   * abort 시 stop()으로 네이티브 디코딩을 중단시키고, promise가 부분 결과로 resolve되더라도
   * 정상 결과로 오인하지 않도록 AbortError를 throw한다. 리스너는 호출 종료 시 반드시 해제한다.
   */
  private async runNativeWithAbort<T>(
    call: { stop: () => Promise<void>; promise: Promise<T> },
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) {
      // 시작 직후 이미 취소 상태 — 네이티브 중단을 요청하고(부분 결과는 버림) throw.
      void call.stop().catch(() => {})
      throw abortError()
    }
    const onAbort = (): void => {
      // 진행 중인 전사에 네이티브 중단을 요청한다. stop 후 promise는 부분 결과로 resolve될 수 있다.
      void call.stop().catch(() => {})
    }
    signal?.addEventListener('abort', onAbort)
    try {
      const result = await call.promise
      // stop() 이후 부분 결과가 정상처럼 resolve되어도 취소 상태면 결과로 반환하지 않고 throw.
      if (signal?.aborted) throw abortError()
      return result
    } catch (err) {
      // 취소 도중 발생한 어떤 오류든 AbortError로 통일해 파이프라인이 취소로 분류하게 한다.
      if (signal?.aborted) throw abortError()
      throw err
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
