// 무음 컷편집 I/O 오케스트레이션 — VAD 검출 → 계획 → WAV 재작성 → 사이드카 기록.
// 알고리즘 자체는 stt/audio-compactor.ts(순수 함수)에 있고, 여기서는 파일 시스템만 다룬다.
//
// 사용자 확정 사항: 컷편집된 파일을 그 녹음의 파일로 그대로 사용한다(원본 별도 보관 없음).
// 그래서 쓰기는 반드시 원자적이어야 한다 — .tmp에 쓰고 헤더·길이를 검증한 뒤에만 rename한다.
// 어떤 실패든 원본을 남긴 채 applied:false로 돌아간다(취소만 예외로 전파).
import { readFile, writeFile, rename, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import type { ChannelEnergy } from './meeting-types'
import { findWavDataRange } from './stt/vad-segmenter'
import { detectSpeechRegions, isVadCrashGuardSet } from './stt/vad-detect'
import {
  planCompaction,
  compactPcm16,
  remapChannelEnergy,
  speechRegionsToCompacted,
  DEFAULT_COMPACTION_OPTIONS,
  type Region
} from './stt/audio-compactor'
import { wavDurationMs } from './wav-util'

// 재작성한 WAV의 실제 길이가 계획과 이만큼 이상 어긋나면 실패로 보고 원본을 유지한다.
const DURATION_TOLERANCE_MS = 50

// 컷편집 단계 진행률 배분. VAD가 압도적으로 오래 걸리므로 대부분을 VAD에 준다.
const VAD_PROGRESS_SHARE = 0.85
const WRITE_DONE_PROGRESS = 0.95

export interface CompactionResult {
  applied: boolean
  originalMs: number
  compactedMs: number
  removedMs: number
  // 발화 구간. applied면 컷편집 타임라인 기준, 아니면 원본 타임라인 기준.
  // STT가 VAD를 다시 돌리지 않도록 그대로 넘긴다. VAD 자체가 실패했으면 null.
  speechRegions: Region[] | null
  // applied일 때만 채워진다(원본 타임라인 기준 유지 구간).
  keep: Region[] | null
}

function sidecarPath(audioPath: string, suffix: string): string {
  return audioPath.replace(/\.[^./\\]+$/, suffix)
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function noop(): CompactionResult {
  return { applied: false, originalMs: 0, compactedMs: 0, removedMs: 0, speechRegions: null, keep: null }
}

/**
 * 임시 파일에 쓰고 rename으로 교체한다. 실패 시 임시 파일을 지우고 throw한다.
 */
async function atomicWrite(targetPath: string, data: Buffer | string): Promise<void> {
  const tmp = `${targetPath}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, targetPath)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

/**
 * `<id>.channels.json`(채널 에너지 envelope)을 컷편집 타임라인으로 다시 쓴다.
 * 없거나 실패해도 무해하다 — 화자분리가 채널 분리 대신 sherpa로 폴백할 뿐이다.
 */
async function remapChannelsSidecar(audioPath: string, keep: Region[]): Promise<void> {
  const path = sidecarPath(audioPath, '.channels.json')
  if (!existsSync(path)) return
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<ChannelEnergy>
    if (
      typeof parsed.hopMs !== 'number' ||
      !Array.isArray(parsed.left) ||
      !Array.isArray(parsed.right)
    ) {
      return
    }
    const remapped = remapChannelEnergy(
      { hopMs: parsed.hopMs, left: parsed.left, right: parsed.right },
      keep
    )
    await atomicWrite(path, JSON.stringify(remapped))
  } catch {
    // envelope 재매핑 실패는 비치명적 — 오래된 envelope를 남겨두면 오히려 잘못 귀속되므로 지운다.
    await unlink(path).catch(() => {})
  }
}

/**
 * 무엇을 잘라냈는지 `<id>.compaction.json`에 남긴다. 원본 오디오는 보관하지 않지만
 * 이 기록이 있으면 나중에 원본 타임라인으로 되돌려 해석할 수 있다.
 */
async function writeCompactionSidecar(
  audioPath: string,
  info: { originalMs: number; compactedMs: number; removed: Region[] }
): Promise<void> {
  try {
    await atomicWrite(
      sidecarPath(audioPath, '.compaction.json'),
      JSON.stringify({
        version: 1,
        originalMs: info.originalMs,
        compactedMs: info.compactedMs,
        removed: info.removed,
        params: DEFAULT_COMPACTION_OPTIONS,
        compactedAt: new Date().toISOString()
      })
    )
  } catch {
    // 사이드카 기록 실패는 비치명적.
  }
}

/**
 * 녹음 WAV에서 긴 침묵을 잘라내고 파일을 제자리에서 교체한다.
 *
 * 반환값의 speechRegions는 STT에 그대로 넘겨 VAD 중복 실행을 막는 용도다.
 * 취소(AbortError)만 전파하고, 그 밖의 어떤 실패도 applied:false로 흡수한다.
 */
export async function compactRecording(
  audioPath: string,
  opts: {
    signal?: AbortSignal
    onMessage?: (m: string) => void
    onProgress?: (p: number) => void
  } = {}
): Promise<CompactionResult> {
  // 어느 경로로 끝나든 진행률을 1로 마감해 UI가 중간에 멈춰 보이지 않게 한다.
  const done = <T>(result: T): T => {
    opts.onProgress?.(1)
    return result
  }

  try {
    if (opts.signal?.aborted) throw abortSignalError()
    opts.onProgress?.(0)

    const buf = await readFile(audioPath)
    const dataRange = findWavDataRange(buf)
    if (!dataRange) {
      // 16k/mono/16bit WAV가 아니면(webm 폴백 저장 등) 샘플 단위 재작성이 불가하다.
      const ms = wavDurationMs(audioPath) ?? 0
      return done({ ...noop(), originalMs: ms, compactedMs: ms })
    }

    const byteRate = (dataRange.sampleRate * dataRange.channels * dataRange.bitsPerSample) / 8
    const audioMs = Math.round((dataRange.dataBytes / byteRate) * 1000)

    if (isVadCrashGuardSet()) {
      // 직전 실행이 VAD 도중 네이티브 abort로 죽었다 → 이번엔 VAD를 건드리지 않는다.
      // (센티널 소비는 WhisperAdapter.transcribe가 한 번만 하므로 여기서는 지우지 않는다.)
      return done({ ...noop(), originalMs: audioMs, compactedMs: audioMs })
    }

    const detected = await detectSpeechRegions(audioPath, dataRange, {
      ...opts,
      onProgress: (p) => opts.onProgress?.(p * VAD_PROGRESS_SHARE)
    })
    if (!detected) {
      // VAD 실패 → 무엇이 발화인지 모르므로 자르지 않는다. STT도 자체 폴백을 타게 한다.
      return done({ ...noop(), originalMs: audioMs, compactedMs: audioMs })
    }
    if (opts.signal?.aborted) throw abortSignalError()
    opts.onProgress?.(VAD_PROGRESS_SHARE)

    const plan = planCompaction(detected.regions, audioMs)
    if (!plan.applied) {
      return done({
        applied: false,
        originalMs: plan.originalMs,
        compactedMs: plan.originalMs,
        removedMs: 0,
        // 원본 타임라인 기준 발화 구간 — 파일을 안 건드렸으므로 그대로 유효하다.
        speechRegions: detected.regions,
        keep: null
      })
    }
    opts.onMessage?.('무음 구간 잘라내는 중…')

    const compacted = compactPcm16(buf, dataRange, plan.keep)

    // 검증 후 교체: 임시 파일이 정상 WAV이고 길이가 계획과 맞을 때만 rename한다.
    const tmp = `${audioPath}.tmp`
    try {
      await writeFile(tmp, compacted)
      const verifyMs = wavDurationMs(tmp)
      if (
        !findWavDataRange(await readFile(tmp)) ||
        verifyMs === null ||
        Math.abs(verifyMs - plan.compactedMs) > DURATION_TOLERANCE_MS
      ) {
        throw new Error('컷편집 결과 검증 실패')
      }
      await rename(tmp, audioPath)
    } catch (err) {
      await unlink(tmp).catch(() => {})
      if (isAbort(err) || opts.signal?.aborted) throw err
      // 원본은 그대로 남았다 — 컷편집만 포기하고 원본 타임라인 발화 구간으로 계속한다.
      return done({
        applied: false,
        originalMs: plan.originalMs,
        compactedMs: plan.originalMs,
        removedMs: 0,
        speechRegions: detected.regions,
        keep: null
      })
    }
    opts.onProgress?.(WRITE_DONE_PROGRESS)

    // 여기부터는 오디오 교체가 끝났으므로 실패해도 applied:true를 유지한다.
    await remapChannelsSidecar(audioPath, plan.keep)
    await writeCompactionSidecar(audioPath, {
      originalMs: plan.originalMs,
      compactedMs: plan.compactedMs,
      removed: plan.removed
    })

    return done({
      applied: true,
      originalMs: plan.originalMs,
      compactedMs: plan.compactedMs,
      removedMs: plan.originalMs - plan.compactedMs,
      speechRegions: speechRegionsToCompacted(detected.regions, plan.keep),
      keep: plan.keep
    })
  } catch (err) {
    // 취소는 파이프라인이 restoreAfterCancel을 타도록 그대로 전파한다.
    if (isAbort(err) || opts.signal?.aborted) throw err
    return done(noop())
  }
}

function abortSignalError(): Error {
  const e = new Error('처리가 취소되었습니다.')
  e.name = 'AbortError'
  return e
}
