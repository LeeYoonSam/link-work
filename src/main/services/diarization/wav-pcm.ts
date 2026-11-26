// WAV(PCM16 mono) 디코더 — 순수 함수 + 파일 일부만 읽는 헬퍼.
// 배포 Electron 에서 sherpa.readWave 로 큰 파일을 읽는 것을 피하려고 JS 로 직접 읽는다.
// 청크 탐색 규칙은 locateWavData 하나로, 전체 디코드(decodeWavPcm16)와 부분 읽기(readWavInfo·readWavPcm16Range)가 함께 쓴다.
import { closeSync, fstatSync, openSync, readSync } from 'fs'

export interface PcmAudio {
  sampleRate: number
  /** 16비트 정수 샘플(복사본) */
  pcm: Int16Array
  /** pcm[0] 의 절대 샘플 위치(파일 전체 기준). 기본 0. */
  offset?: number
  /** 파일 전체 샘플 수. 기본 pcm.length. */
  totalSamples?: number
}

/** WAV data 청크 위치. samples 는 파일 끝으로 자른 샘플 수다. */
export interface WavDataLocation {
  sampleRate: number
  /** data 본문 시작 바이트 */
  dataOffset: number
  samples: number
}

/**
 * RIFF/WAVE 청크를 탐색해 data 본문 위치를 찾는다. PCM(포맷 1, 또는 PCM 서브포맷의 EXTENSIBLE) 16비트 mono 만 받는다.
 * read(offset, len) 는 파일의 [offset, offset+len) 바이트를 돌려준다(파일 끝이면 짧게).
 * 헤더가 잘못됐거나 형식이 다르면 한국어 메시지로 throw 한다.
 * data 청크 크기가 파일보다 크면(녹음 중 종료 등) 파일 끝까지로 본다.
 */
export function locateWavData(read: (offset: number, len: number) => Uint8Array, byteLength: number): WavDataLocation {
  const tagOf = (b: Uint8Array, o: number): string => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])
  const dv = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength)
  const head = byteLength >= 12 ? read(0, 12) : new Uint8Array(0)
  if (byteLength < 12 || head.byteLength < 12 || tagOf(head, 0) !== 'RIFF' || tagOf(head, 8) !== 'WAVE') {
    throw new Error('WAV 파일 헤더가 올바르지 않습니다.')
  }
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined
  let o = 12
  while (o + 8 <= byteLength) {
    const ch = read(o, 8)
    const id = tagOf(ch, 0)
    const size = dv(ch).getUint32(4, true)
    const body = o + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > byteLength) throw new Error('WAV fmt 청크가 올바르지 않습니다.')
      const fb = read(body, Math.min(40, size, byteLength - body))
      const v = dv(fb)
      let format = v.getUint16(0, true)
      // WAVE_FORMAT_EXTENSIBLE: 서브포맷 GUID 앞 2바이트가 실제 포맷
      if (format === 0xfffe && size >= 40 && body + 26 <= byteLength) format = v.getUint16(24, true)
      fmt = {
        format,
        channels: v.getUint16(2, true),
        sampleRate: v.getUint32(4, true),
        bits: v.getUint16(14, true)
      }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV fmt 청크가 data 청크보다 앞에 없습니다.')
      if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1) {
        throw new Error(`16비트 PCM mono WAV만 지원합니다 (format ${fmt.format}, ${fmt.bits}bit, ${fmt.channels}ch).`)
      }
      const end = Math.min(byteLength, body + size)
      return { sampleRate: fmt.sampleRate, dataOffset: body, samples: Math.max(0, (end - body) >> 1) }
    }
    o = body + size + (size % 2)
  }
  throw new Error('WAV data 청크가 없습니다.')
}

/**
 * RIFF/WAVE 버퍼를 해석한다. PCM(포맷 1, 또는 PCM 서브포맷의 EXTENSIBLE) 16비트 mono 만 받는다.
 * 헤더가 잘못됐거나 형식이 다르면 한국어 메시지로 throw 한다.
 * data 청크 크기가 파일보다 크면(녹음 중 종료 등) 파일 끝까지 읽는다.
 */
export function decodeWavPcm16(buf: Uint8Array): PcmAudio {
  const loc = locateWavData((off, len) => buf.subarray(off, Math.min(buf.byteLength, off + len)), buf.byteLength)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const n = loc.samples
  const pcm = new Int16Array(n)
  for (let i = 0; i < n; i++) pcm[i] = view.getInt16(loc.dataOffset + i * 2, true)
  return { sampleRate: loc.sampleRate, pcm }
}

function withFile<T>(path: string, fn: (read: (offset: number, len: number) => Uint8Array, size: number) => T): T {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const read = (offset: number, len: number): Uint8Array => {
      const n = Math.max(0, Math.min(len, size - offset))
      const b = Buffer.alloc(n)
      let got = 0
      while (got < n) {
        const r = readSync(fd, b, got, n - got, offset + got)
        if (r <= 0) break
        got += r
      }
      return new Uint8Array(b.buffer, b.byteOffset, got)
    }
    return fn(read, size)
  } finally {
    closeSync(fd)
  }
}

/** WAV 헤더만 읽어 샘플레이트·샘플 수·data 위치를 구한다(본문은 읽지 않는다). */
export function readWavInfo(path: string): WavDataLocation {
  return withFile(path, (read, size) => locateWavData(read, size))
}

/**
 * WAV 의 [start, end) 샘플만 읽는다(0..samples 로 자른다). offset=start, totalSamples=파일 전체 샘플 수.
 * 결과의 sliceFloat32 는 절대 샘플 인덱스로 부른다.
 */
export function readWavPcm16Range(path: string, start: number, end: number): PcmAudio {
  return withFile(path, (read, size) => {
    const loc = locateWavData(read, size)
    const a = Math.max(0, Math.min(loc.samples, Math.floor(start)))
    const b = Math.max(a, Math.min(loc.samples, Math.ceil(end)))
    const bytes = read(loc.dataOffset + a * 2, (b - a) * 2)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const n = bytes.byteLength >> 1
    const pcm = new Int16Array(n)
    for (let i = 0; i < n; i++) pcm[i] = view.getInt16(i * 2, true)
    return { sampleRate: loc.sampleRate, pcm, offset: a, totalSamples: loc.samples }
  })
}

/**
 * [start, end) 샘플 구간(절대 인덱스)을 -1..1 Float32 로 바꾼다.
 * 범위는 [offset, offset + pcm.length) 로 잘라낸다(offset 기본 0).
 */
export function sliceFloat32(audio: PcmAudio, start: number, end: number): Float32Array {
  const off = audio.offset ?? 0
  const len = audio.pcm.length
  const a = Math.max(0, Math.min(len, start - off))
  const b = Math.max(a, Math.min(len, end - off))
  const out = new Float32Array(b - a)
  for (let i = a; i < b; i++) out[i - a] = audio.pcm[i] / 32768
  return out
}
