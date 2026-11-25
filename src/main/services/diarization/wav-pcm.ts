// WAV(PCM16 mono) 디코더 — 순수 함수.
// 배포 Electron 에서 sherpa.readWave 로 큰 파일을 읽는 것을 피하려고 JS 로 직접 읽는다.

export interface PcmAudio {
  sampleRate: number
  /** 16비트 정수 샘플(복사본) */
  pcm: Int16Array
}

/**
 * RIFF/WAVE 버퍼를 해석한다. PCM(포맷 1, 또는 PCM 서브포맷의 EXTENSIBLE) 16비트 mono 만 받는다.
 * 헤더가 잘못됐거나 형식이 다르면 한국어 메시지로 throw 한다.
 * data 청크 크기가 파일보다 크면(녹음 중 종료 등) 파일 끝까지 읽는다.
 */
export function decodeWavPcm16(buf: Uint8Array): PcmAudio {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tag = (o: number): string => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3])
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('WAV 파일 헤더가 올바르지 않습니다.')
  }
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined
  let o = 12
  while (o + 8 <= buf.byteLength) {
    const id = tag(o)
    const size = view.getUint32(o + 4, true)
    const body = o + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.byteLength) throw new Error('WAV fmt 청크가 올바르지 않습니다.')
      let format = view.getUint16(body, true)
      // WAVE_FORMAT_EXTENSIBLE: 서브포맷 GUID 앞 2바이트가 실제 포맷
      if (format === 0xfffe && size >= 40 && body + 26 <= buf.byteLength) format = view.getUint16(body + 24, true)
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true)
      }
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV fmt 청크가 data 청크보다 앞에 없습니다.')
      if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1) {
        throw new Error(
          `16비트 PCM mono WAV만 지원합니다 (format ${fmt.format}, ${fmt.bits}bit, ${fmt.channels}ch).`
        )
      }
      const end = Math.min(buf.byteLength, body + size)
      const n = Math.max(0, (end - body) >> 1)
      const pcm = new Int16Array(n)
      for (let i = 0; i < n; i++) pcm[i] = view.getInt16(body + i * 2, true)
      return { sampleRate: fmt.sampleRate, pcm }
    }
    o = body + size + (size % 2)
  }
  throw new Error('WAV data 청크가 없습니다.')
}

/** [start, end) 샘플 구간을 -1..1 Float32 로 바꾼다(범위는 잘라낸다). */
export function sliceFloat32(audio: PcmAudio, start: number, end: number): Float32Array {
  const a = Math.max(0, Math.min(audio.pcm.length, start))
  const b = Math.max(a, Math.min(audio.pcm.length, end))
  const out = new Float32Array(b - a)
  for (let i = a; i < b; i++) out[i - a] = audio.pcm[i] / 32768
  return out
}
