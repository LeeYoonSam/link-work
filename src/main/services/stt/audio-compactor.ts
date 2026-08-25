// 무음 컷편집(compaction) 순수 함수 모듈 — 파일 I/O·네이티브 모듈을 import하지 않는다(단위 테스트 대상).
//
// 왜 필요한가 — 회의 녹음은 발화보다 침묵이 긴 경우가 많다. 침묵을 처리 전에 잘라내면
//  (1) whisper 전사 청크(28초 창)에 발화가 더 촘촘히 담겨 호출 수가 줄고,
//  (2) sherpa 화자분리 입력 길이가 줄며,
//  (3) 파일 크기와 재생 시간이 줄어 재생 중 침묵 스킵이 필요 없어진다.
//
// 설계 원칙 — 디지털 무음(0 샘플)을 삽입하지 않는다. 제거 대상 침묵도 앞뒤로 실제 오디오
// (룸톤)를 keepGapMs만큼 남긴다. 완전한 0 구간은 VAD·화자분리·whisper 모두에게 부자연스러운
// 신호라 오히려 인식 품질을 해친다.
import type { Region, WavDataRange } from './vad-segmenter'

export type { Region }

export interface CompactionPlanOptions {
  // 발화 구간 앞뒤로 남길 여유. 자음 파열·어미 잘림을 막는다.
  padMs?: number
  // 이 길이 미만의 침묵은 손대지 않는다(자연스러운 쉼은 그대로 둔다).
  // faster-whisper VAD의 min_silence 기본값(2000ms)에 맞췄다.
  minRemovableGapMs?: number
  // 제거 대상 침묵을 이 길이로 줄인다. 앞 절반은 직전 발화 끝 뒤, 뒤 절반은 다음 발화 시작
  // 앞의 "실제 오디오"를 남긴다(룸톤 유지 → 경계에서 딸깍 소리·부자연스러운 절단 방지).
  // 화자분리(pyannote 계열)가 발화 경계를 잡으려면 대체 갭이 0.5초 이상이어야 한다.
  keepGapMs?: number
  // 파일 맨 앞/맨 뒤 침묵은 이 길이만 남긴다.
  edgeMs?: number
  // 절감 비율이 이 값 미만이면 applied=false (재작성 비용·위험 대비 이득이 없다).
  minSavingsRatio?: number
  // 접합부 페이드 길이(compactPcm16에서만 사용). 잘라낸 자리에서 파형이 튀면 클릭 잡음이 생기고,
  // 리서치상 이 클릭이 갭 길이보다 인식·화자분리에 더 해롭다. 0이면 페이드를 끈다.
  fadeMs?: number
}

// 파라미터 기본값 — 리서치 결과에 따라 조정되는 유일한 지점.
export const DEFAULT_COMPACTION_OPTIONS: Required<CompactionPlanOptions> = {
  padMs: 200,
  minRemovableGapMs: 2000,
  keepGapMs: 600,
  edgeMs: 300,
  minSavingsRatio: 0.03,
  fadeMs: 8
}

export interface CompactionPlan {
  // 원본 타임라인 기준으로 남길 구간. 정렬·비중첩·병합됨.
  keep: Region[]
  // 원본 타임라인 기준 제거 구간.
  removed: Region[]
  originalMs: number
  // = Σ keep 길이
  compactedMs: number
  applied: boolean
}

function clampMs(ms: number, audioMs: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.min(audioMs, Math.round(ms)))
}

/**
 * 입력 발화 구간을 방어적으로 정규화한다: [0, audioMs] 클램프 → 빈 구간 제거 → 정렬 → 중첩 병합.
 */
function normalizeRegions(regions: Region[], audioMs: number): Region[] {
  const clamped: Region[] = []
  for (const r of regions ?? []) {
    const startMs = clampMs(r.startMs, audioMs)
    const endMs = clampMs(r.endMs, audioMs)
    if (endMs > startMs) clamped.push({ startMs, endMs })
  }
  clamped.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)

  const merged: Region[] = []
  for (const r of clamped) {
    const last = merged[merged.length - 1]
    if (last && r.startMs <= last.endMs) {
      if (r.endMs > last.endMs) last.endMs = r.endMs
    } else {
      merged.push({ ...r })
    }
  }
  return merged
}

/**
 * 발화 구간과 오디오 길이로 컷편집 계획을 세운다.
 *
 * - 각 발화 구간을 padMs만큼 확장하고 겹치면 병합한다.
 * - 확장된 구간 사이 침묵이 minRemovableGapMs 이상이면, 앞뒤로 keepGapMs/2씩 실제 오디오를
 *   남기고 그 사이를 제거한다.
 * - 파일 맨 앞/맨 뒤 침묵은 edgeMs만 남긴다.
 * - speech가 비어 있으면(무음 파일) 손대지 않는다 — applied=false.
 */
export function planCompaction(
  speech: Region[],
  audioMs: number,
  opts: CompactionPlanOptions = {}
): CompactionPlan {
  const o = { ...DEFAULT_COMPACTION_OPTIONS, ...opts }
  const originalMs = Math.max(0, Math.round(audioMs) || 0)

  const speechRegions = normalizeRegions(speech, originalMs)
  if (originalMs <= 0 || speechRegions.length === 0) {
    // 무음 파일이거나 길이를 알 수 없음 → 원본 그대로 둔다.
    const keep = originalMs > 0 ? [{ startMs: 0, endMs: originalMs }] : []
    return { keep, removed: [], originalMs, compactedMs: originalMs, applied: false }
  }

  // 발화 구간을 패딩만큼 확장 후 재병합(패딩으로 겹치는 구간을 합친다).
  const padded = normalizeRegions(
    speechRegions.map((r) => ({ startMs: r.startMs - o.padMs, endMs: r.endMs + o.padMs })),
    originalMs
  )

  // 제거 구간을 먼저 구하고, keep은 [0, originalMs]에서의 여집합으로 만든다.
  const removed: Region[] = []
  const half = Math.round(o.keepGapMs / 2)

  // 맨 앞 침묵: edgeMs만 남긴다.
  const leadKeepFrom = padded[0].startMs - o.edgeMs
  if (leadKeepFrom > 0) removed.push({ startMs: 0, endMs: leadKeepFrom })

  // 구간 사이 침묵.
  for (let i = 0; i < padded.length - 1; i++) {
    const gapStart = padded[i].endMs
    const gapEnd = padded[i + 1].startMs
    if (gapEnd - gapStart < o.minRemovableGapMs) continue
    const removeStart = gapStart + half
    const removeEnd = gapEnd - half
    if (removeEnd > removeStart) removed.push({ startMs: removeStart, endMs: removeEnd })
  }

  // 맨 뒤 침묵: edgeMs만 남긴다.
  const tailKeepTo = padded[padded.length - 1].endMs + o.edgeMs
  if (tailKeepTo < originalMs) removed.push({ startMs: tailKeepTo, endMs: originalMs })

  const keep: Region[] = []
  let cursor = 0
  for (const r of removed) {
    if (r.startMs > cursor) keep.push({ startMs: cursor, endMs: r.startMs })
    cursor = Math.max(cursor, r.endMs)
  }
  if (cursor < originalMs) keep.push({ startMs: cursor, endMs: originalMs })

  const compactedMs = keep.reduce((a, r) => a + (r.endMs - r.startMs), 0)
  const applied = removed.length > 0 && compactedMs <= originalMs * (1 - o.minSavingsRatio)

  return { keep, removed, originalMs, compactedMs, applied }
}

/**
 * 접합부 페이드를 출력 버퍼에 직접 적용한다(입력 WAV 버퍼는 건드리지 않는다).
 * fade-in은 첫 샘플 gain 0에서 시작해 fadeSamples번째 샘플에서 원본값이 되고,
 * fade-out은 그 거울상이라 마지막 샘플의 gain이 0이다.
 */
function applyFade(
  out: Buffer,
  startByte: number,
  endByte: number,
  fadeSamples: number,
  opts: { fadeIn: boolean; fadeOut: boolean }
): void {
  const frames = (endByte - startByte) / 2
  // 페이드 두 번이 겹칠 만큼 짧은 구간은 통째로 뭉개지므로 건너뛴다.
  if (fadeSamples <= 0 || frames < fadeSamples * 2) return

  const scale = (frameIndex: number, gain: number): void => {
    const offset = startByte + frameIndex * 2
    const v = Math.round(out.readInt16LE(offset) * gain)
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), offset)
  }

  for (let i = 0; i < fadeSamples; i++) {
    const gain = i / fadeSamples
    if (opts.fadeIn) scale(i, gain)
    if (opts.fadeOut) scale(frames - 1 - i, gain)
  }
}

/**
 * WAV(16kHz mono 16-bit PCM) 버퍼에서 keep 구간의 샘플만 이어붙인 새 WAV 버퍼를 만든다.
 * 헤더는 renderer의 encodeWav16과 동일한 표준 44바이트 PCM 헤더다.
 *
 * 바이트 오프셋은 항상 (샘플 인덱스 × blockAlign)으로 계산하므로 샘플 경계에 정렬된다.
 * 16kHz에서 1ms = 16샘플이라 정수 ms 경계는 손실 없이 샘플로 환산된다.
 *
 * 원본에서 떨어져 있던 두 구간이 맞붙는 접합부에는 fadeMs 길이의 선형 페이드를 건다.
 * 파형이 튀면 클릭 잡음이 되고 그게 남은 갭 길이보다 인식·화자분리에 더 해롭다.
 * 파일 맨 앞/맨 뒤(원래부터 파일 경계였던 곳)에는 걸지 않는다.
 */
export function compactPcm16(
  wav: Buffer,
  dataRange: WavDataRange,
  keep: Region[],
  opts: { fadeMs?: number } = {}
): Buffer {
  const fadeMs = opts.fadeMs ?? DEFAULT_COMPACTION_OPTIONS.fadeMs
  const blockAlign = (dataRange.channels * dataRange.bitsPerSample) / 8
  // data 청크가 샘플 중간에서 잘려 있으면(손상 파일) 마지막 불완전 샘플은 버린다.
  const usableBytes = dataRange.dataBytes - (dataRange.dataBytes % blockAlign)

  const toByte = (ms: number): number => {
    const sample = Math.max(0, Math.round((ms / 1000) * dataRange.sampleRate))
    return Math.min(sample * blockAlign, usableBytes)
  }

  const slices: Buffer[] = []
  // 출력 버퍼 안에서 각 조각이 차지하는 범위 + 그 조각의 원본 구간(접합 여부 판정용).
  const spans: Array<{ startByte: number; endByte: number; region: Region }> = []
  let dataBytes = 0
  for (const r of keep) {
    const startByte = toByte(r.startMs)
    const endByte = toByte(r.endMs)
    if (endByte <= startByte) continue
    slices.push(wav.subarray(dataRange.dataOffset + startByte, dataRange.dataOffset + endByte))
    spans.push({ startByte: dataBytes, endByte: dataBytes + (endByte - startByte), region: r })
    dataBytes += endByte - startByte
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt 청크 크기(PCM)
  header.writeUInt16LE(1, 20) // audioFormat = PCM
  header.writeUInt16LE(dataRange.channels, 22)
  header.writeUInt32LE(dataRange.sampleRate, 24)
  header.writeUInt32LE(dataRange.sampleRate * blockAlign, 28) // byteRate
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(dataRange.bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)

  // Buffer.concat은 새 메모리에 복사하므로, 아래 페이드는 입력 wav를 건드리지 않는다.
  const out = Buffer.concat([header, ...slices], 44 + dataBytes)

  const fadeSamples = Math.max(0, Math.round((fadeMs / 1000) * dataRange.sampleRate))
  if (fadeSamples > 0) {
    for (let i = 0; i < spans.length; i++) {
      // 원본에서 이미 맞붙어 있던 구간끼리는 불연속이 없으므로 페이드가 필요 없다.
      const fadeIn = i > 0 && spans[i - 1].region.endMs < spans[i].region.startMs
      const fadeOut = i < spans.length - 1 && spans[i].region.endMs < spans[i + 1].region.startMs
      if (!fadeIn && !fadeOut) continue
      applyFade(out, 44 + spans[i].startByte, 44 + spans[i].endByte, fadeSamples, {
        fadeIn,
        fadeOut
      })
    }
  }

  return out
}

/**
 * 채널 에너지 envelope(hop 프레임 배열)를 컷편집 타임라인으로 재매핑한다.
 * hop 프레임 f의 중심시각 (f+0.5)*hopMs 가 keep 안이면 유지하고, 순서대로 이어붙인다.
 */
export function remapChannelEnergy(
  env: { hopMs: number; left: number[]; right: number[] },
  keep: Region[]
): { hopMs: number; left: number[]; right: number[] } {
  const hopMs = env.hopMs > 0 ? env.hopMs : 100
  const frameCount = Math.min(env.left.length, env.right.length)
  const left: number[] = []
  const right: number[] = []

  // keep은 정렬·비중첩이므로 프레임을 훑으며 포인터 하나로 판정한다.
  let k = 0
  for (let f = 0; f < frameCount; f++) {
    const center = (f + 0.5) * hopMs
    while (k < keep.length && center >= keep[k].endMs) k++
    if (k >= keep.length) break
    if (center >= keep[k].startMs) {
      left.push(env.left[f])
      right.push(env.right[f])
    }
  }

  return { hopMs, left, right }
}

/**
 * 원본 타임라인의 시각(ms)을 컷편집 타임라인의 시각으로 매핑한다(단조 증가).
 * 제거된 구간 안의 시각은 그 구간 직전 keep의 끝(= 컷편집 타임라인에서 이어붙는 지점)으로 접힌다.
 */
export function mapMsToCompacted(ms: number, keep: Region[]): number {
  const target = Math.max(0, Math.round(ms) || 0)
  let acc = 0
  for (const r of keep) {
    if (target >= r.endMs) {
      acc += r.endMs - r.startMs
      continue
    }
    // r 안이면 상대 위치를, r 이전(= 제거 구간 또는 파일 앞머리)이면 직전까지의 누적을 반환.
    return target > r.startMs ? acc + (target - r.startMs) : acc
  }
  return acc
}

/**
 * 발화 구간 목록을 컷편집 타임라인 기준으로 옮긴다. 길이가 0이 된 구간은 버린다.
 */
export function speechRegionsToCompacted(speech: Region[], keep: Region[]): Region[] {
  const out: Region[] = []
  for (const r of speech) {
    const startMs = mapMsToCompacted(r.startMs, keep)
    const endMs = mapMsToCompacted(r.endMs, keep)
    if (endMs > startMs) out.push({ startMs, endMs })
  }
  return out
}
