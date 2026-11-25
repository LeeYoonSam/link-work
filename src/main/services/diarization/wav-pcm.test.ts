import { describe, it, expect } from 'vitest'
import { decodeWavPcm16, sliceFloat32 } from './wav-pcm'

function wav(opts: {
  format?: number
  channels?: number
  sampleRate?: number
  bits?: number
  samples?: number[]
  extraChunk?: boolean
  dataSizeOverride?: number
}): Uint8Array {
  const { format = 1, channels = 1, sampleRate = 16000, bits = 16, samples = [0, 16384, -32768, 32767] } = opts
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2))
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'ascii')
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(format, 8)
  fmt.writeUInt16LE(channels, 10)
  fmt.writeUInt32LE(sampleRate, 12)
  fmt.writeUInt32LE((sampleRate * channels * bits) / 8, 16)
  fmt.writeUInt16LE((channels * bits) / 8, 20)
  fmt.writeUInt16LE(bits, 22)
  const extra = Buffer.alloc(opts.extraChunk ? 12 : 0)
  if (opts.extraChunk) {
    extra.write('LIST', 0, 'ascii')
    extra.writeUInt32LE(3, 4) // 홀수 크기 → 패딩 1바이트
  }
  const dh = Buffer.alloc(8)
  dh.write('data', 0, 'ascii')
  dh.writeUInt32LE(opts.dataSizeOverride ?? data.length, 4)
  const body = Buffer.concat([fmt, extra, dh, data])
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(4 + body.length, 4)
  head.write('WAVE', 8, 'ascii')
  return new Uint8Array(Buffer.concat([head, body]))
}

describe('decodeWavPcm16', () => {
  it('PCM16 mono 헤더를 읽고 샘플을 복사한다', () => {
    const a = decodeWavPcm16(wav({}))
    expect(a.sampleRate).toBe(16000)
    expect(Array.from(a.pcm)).toEqual([0, 16384, -32768, 32767])
    expect(Array.from(sliceFloat32(a, 1, 3))).toEqual([0.5, -1])
    expect(sliceFloat32(a, -5, 99)).toHaveLength(4)
  })

  it('중간의 다른 청크(홀수 크기 패딩 포함)를 건너뛴다', () => {
    const a = decodeWavPcm16(wav({ extraChunk: true }))
    expect(Array.from(a.pcm)).toEqual([0, 16384, -32768, 32767])
  })

  it('data 크기가 파일보다 크면 파일 끝까지 읽는다', () => {
    const a = decodeWavPcm16(wav({ dataSizeOverride: 0xffffffff }))
    expect(a.pcm).toHaveLength(4)
  })

  it('비PCM16·스테레오·잘못된 헤더는 오류', () => {
    expect(() => decodeWavPcm16(wav({ format: 3, bits: 32 }))).toThrow(/16비트 PCM mono/)
    expect(() => decodeWavPcm16(wav({ bits: 8 }))).toThrow(/16비트 PCM mono/)
    expect(() => decodeWavPcm16(wav({ channels: 2 }))).toThrow(/16비트 PCM mono/)
    expect(() => decodeWavPcm16(new Uint8Array(Buffer.from('RIFX0000WAVE')))).toThrow(/헤더/)
    expect(() => decodeWavPcm16(new Uint8Array(4))).toThrow(/헤더/)
    const noData = wav({}).subarray(0, 36)
    expect(() => decodeWavPcm16(noData)).toThrow(/data 청크/)
  })
})
