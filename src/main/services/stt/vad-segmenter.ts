// VAD 선분할 순수 함수 모듈 — 네이티브 모듈을 import하지 않는다(단위 테스트 대상).
// 무음·잡음 구간에서 Whisper가 문장을 지어내는 환각을 억제하기 위해, VAD가 검출한
// 발화 구간만 잘라 구간별로 전사하고 절대시간으로 복원한다. 여기서는 그 구간 계산과
// WAV data 청크 파싱 같은 순수 로직만 담고, 실제 검출/전사는 whisper-adapter가 한다.
import type { SttSegment } from '../meeting-types'

export interface Region {
  startMs: number
  endMs: number
}

export interface VadSegmentsToRegionsOptions {
  // 간격이 이 값 이하인 인접 구간은 하나로 병합한다(과분할로 문맥이 끊기는 것 방지).
  mergeGapMs?: number
  // 병합 후 길이가 이 값 미만인 구간은 버린다.
  minRegionMs?: number
}

// ⚠️ 단위 주의: VAD 세그먼트(VadSegment)의 t0/t1은 센티초(cs)다.
// whisper.cpp의 whisper_vad_segments_get_segment_t0가 cs를 반환하고 바인딩이 무변환
// 통과하므로 ×10 해야 ms가 된다. (반면 전사 세그먼트 t0/t1은 네이티브가 이미 ×10 하여
// ms로 오므로 mapSegmentsToAbsolute 쪽에서는 별도 변환이 없다.)
const CS_TO_MS = 10

/**
 * VAD 발화 세그먼트(cs 단위)를 절대시간 발화 구간(ms)으로 변환한다.
 * cs→ms(×10) 변환 → [0, audioMs] 클램프 및 빈 구간 제거 → 간격 ≤ mergeGapMs 인접 병합
 * → 최소 길이 필터 순으로 처리한다.
 *
 * 여기서 나오는 것은 "발화 구간"일 뿐, 전사에 넘기는 단위가 아니다. 이 결과는 반드시
 * coalesceRegions로 한 번 더 뭉쳐 "전사 청크"로 만든 뒤 전사한다(이유는 coalesceRegions 참고).
 */
export function vadSegmentsToRegions(
  segments: Array<{ t0: number; t1: number }>,
  audioMs: number,
  opts: VadSegmentsToRegionsOptions = {}
): Region[] {
  const mergeGapMs = opts.mergeGapMs ?? 300
  const minRegionMs = opts.minRegionMs ?? 0

  // cs→ms 변환 후 오디오 길이로 클램프하고, 길이가 0 이하인 구간은 버린다.
  const clamped: Region[] = []
  for (const s of segments) {
    const startMs = Math.max(0, Math.min(audioMs, Math.round(s.t0 * CS_TO_MS)))
    const endMs = Math.max(0, Math.min(audioMs, Math.round(s.t1 * CS_TO_MS)))
    if (endMs > startMs) clamped.push({ startMs, endMs })
  }

  // 병합 전 정렬(입력이 이미 정렬돼 있더라도 방어적으로).
  clamped.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)

  const merged: Region[] = []
  for (const r of clamped) {
    const last = merged[merged.length - 1]
    if (last && r.startMs - last.endMs <= mergeGapMs) {
      if (r.endMs > last.endMs) last.endMs = r.endMs
    } else {
      merged.push({ ...r })
    }
  }

  return merged.filter((r) => r.endMs - r.startMs >= minRegionMs)
}

export interface CoalesceRegionsOptions {
  // 인접 구간 사이 간격이 이 값 이하이면 그 침묵째 이어 붙여 한 청크로 만든다.
  // 대화의 자연스러운 쉼(보통 0.5~2초)까지 한 청크에 담아 짧은 조각 남발을 막는다.
  joinGapMs?: number
  // 이어 붙인 청크의 "타임라인 길이"(첫 구간 시작~마지막 구간 끝, 내부 침묵 포함)가 이 값을
  // 넘게 되면 거기서 청크를 끊는다. whisper 내부 30초 창 하한 아래로 여유를 둔 값(기본 28초).
  maxChunkMs?: number
}

/**
 * VAD가 검출한 발화 구간(speech region)들을 "전사 청크"로 뭉친다.
 *
 * 왜 필요한가 — 과거엔 vadSegmentsToRegions가 간격 ≤300ms만 병합한 발화 구간을 그대로 전사에 넘겼다.
 * 그 결과 대화의 자연스러운 쉼(0.5~2초)마다 구간이 쪼개져 62분 면접이 수백 개의 2~4초 초소형 구간이 됐다.
 * whisper는 어떤 입력이든 내부 30초 창으로 패딩해 인코딩하므로, 2초짜리 구간 하나도 30초어치 연산을 쓴다.
 * 구간이 수백 개면 호출도 수백 번 = 전체 파일 1회 전사보다 오히려 수 배 느려졌다(성능 회귀의 직접 원인).
 * 게다가 짧은 조각을 앞뒤 문맥 없이 따로 전사하면 인식 품질도 떨어진다(문맥 상실 → 품질 회귀).
 *
 * 그래서 여기서 인접 구간을 침묵째 이어 붙여 청크를 키운다:
 *  - 간격이 joinGapMs(기본 2초) 이하면 그 사이 침묵을 포함해 "연속 타임라인 슬라이스"로 병합한다.
 *    연속 슬라이스이므로 전사 결과의 절대시간 복원은 청크 시작 오프셋 하나만 더하면 된다(mapSegmentsToAbsolute).
 *  - 병합했을 때 청크 타임라인 길이가 maxChunkMs(기본 28초)를 넘으면 거기서 끊는다(30초 창 하한 아래 여유).
 *  - 2초를 넘는 긴 침묵은 항상 청크 경계다 = 환각의 원인이던 긴 무음은 전사에서 여전히 배제된다.
 *  - 단일 구간이 이미 maxChunkMs를 넘으면 쪼개지 않고 그 구간 하나를 단독 청크로 둔다
 *    (합치기만 제한한다. 구간 자체의 상한은 VAD의 maxSpeechDurationS가 이미 건다).
 *
 * 입력 regions는 시작 오름차순 정렬을 가정한다(vadSegmentsToRegions가 정렬해 반환).
 */
export function coalesceRegions(regions: Region[], opts: CoalesceRegionsOptions = {}): Region[] {
  const joinGapMs = opts.joinGapMs ?? 2000
  const maxChunkMs = opts.maxChunkMs ?? 28000

  const chunks: Region[] = []
  for (const r of regions) {
    const last = chunks[chunks.length - 1]
    // 직전 청크에 이어 붙이려면 (1) 간격이 joinGapMs 이하이고 (2) 이어 붙인 뒤 타임라인 길이가
    // maxChunkMs 이하여야 한다. 둘 중 하나라도 어기면 새 청크를 시작한다.
    // 단일 구간이 이미 maxChunkMs를 넘어도 여기서 새 청크로 그대로 담긴다(쪼개지 않음).
    if (last && r.startMs - last.endMs <= joinGapMs && r.endMs - last.startMs <= maxChunkMs) {
      last.endMs = r.endMs
    } else {
      chunks.push({ ...r })
    }
  }
  return chunks
}

/**
 * 발화 구간(ms)을 PCM 샘플 인덱스 범위로 변환한다. 손실을 피하려 시작은 내림, 끝은 올림한다.
 */
export function sliceSampleRange(
  startMs: number,
  endMs: number,
  sampleRate = 16000
): { startSample: number; endSample: number } {
  const startSample = Math.max(0, Math.floor((startMs / 1000) * sampleRate))
  const endSample = Math.max(startSample, Math.ceil((endMs / 1000) * sampleRate))
  return { startSample, endSample }
}

/**
 * 구간 전사 결과(구간 시작 기준 상대 ms)에 region 시작 ms를 더해 절대시간으로 복원한다.
 * 전사 세그먼트 t0/t1은 이미 ms이므로 여기서는 단위 변환 없이 오프셋만 더한다.
 */
export function mapSegmentsToAbsolute(segments: SttSegment[], regionStartMs: number): SttSegment[] {
  return segments.map((s) => ({
    ...s,
    start_ms: s.start_ms + regionStartMs,
    end_ms: s.end_ms + regionStartMs
  }))
}

export interface WavDataRange {
  // 'data' 청크 본문이 시작하는 바이트 오프셋
  dataOffset: number
  // 'data' 청크 본문 바이트 수(파일이 잘렸으면 버퍼 경계로 보정)
  dataBytes: number
  sampleRate: number
  channels: number
  bitsPerSample: number
}

/**
 * WAV(PCM) 버퍼에서 'data' 청크 범위와 포맷을 찾는다. 44바이트 고정 헤더를 가정하지 않고
 * RIFF 청크를 순회해 'fmt '와 'data'를 스캔한다.
 * 16kHz / mono / 16-bit PCM이 아니면 null을 반환한다(→ 호출측이 전체 파일 전사로 폴백).
 */
export function findWavDataRange(buf: Buffer): WavDataRange | null {
  if (buf.length < 12) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null
  }

  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null =
    null
  let dataOffset = -1
  let dataBytes = 0

  // RIFF 청크 순회: 각 청크는 [id(4) size(4LE) body(size)] 이고 홀수 크기는 1바이트 패딩된다.
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8

    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14)
      }
    } else if (id === 'data' && dataOffset < 0) {
      dataOffset = body
      // 선언 크기가 실제 버퍼를 넘으면(잘린 파일) 버퍼 경계로 클램프한다.
      dataBytes = Math.min(size, buf.length - body)
    }

    offset = body + size + (size & 1)
  }

  if (!fmt || dataOffset < 0 || dataBytes <= 0) return null
  // PCM(1) / 16kHz / mono / 16-bit 만 raw 슬라이스 전사가 가능. 그 외는 폴백을 유도.
  if (fmt.audioFormat !== 1 || fmt.sampleRate !== 16000 || fmt.channels !== 1 || fmt.bitsPerSample !== 16) {
    return null
  }

  return {
    dataOffset,
    dataBytes,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample
  }
}
