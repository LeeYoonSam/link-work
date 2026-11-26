import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { decodeWavPcm16, locateWavData, readWavInfo, readWavPcm16Range, sliceFloat32 } from './wav-pcm'

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

describe('readWavInfo · readWavPcm16Range', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wav-range-test-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const samples = Array.from({ length: 1000 }, (_, i) => ((i * 37) % 65536) - 32768)
  const cases: Array<[string, Parameters<typeof wav>[0]]> = [
    ['표준 44바이트 헤더', { samples }],
    ['fmt 와 data 사이 LIST 청크', { samples, extraChunk: true }],
    ['data 크기가 파일보다 큰 잘린 파일', { samples, dataSizeOverride: 0xffffffff }]
  ]
  for (const [name, o] of cases) {
    it(name, () => {
      const bytes = wav(o)
      const p = join(dir, `${name.length}-${o.extraChunk ? 1 : 0}-${o.dataSizeOverride ? 1 : 0}.wav`)
      writeFileSync(p, bytes)
      const full = decodeWavPcm16(bytes)
      const info = readWavInfo(p)
      expect(info.samples).toBe(full.pcm.length)
      expect(info.sampleRate).toBe(full.sampleRate)
      for (const [a, b] of [
        [0, 1000],
        [123, 456],
        [990, 2000],
        [-5, 10]
      ]) {
        const r = readWavPcm16Range(p, a, b)
        const lo = Math.max(0, a)
        const hi = Math.min(1000, b)
        expect(r.offset).toBe(lo)
        expect(r.totalSamples).toBe(1000)
        expect(Array.from(r.pcm)).toEqual(Array.from(full.pcm.subarray(lo, hi)))
      }
      // 같은 창: range 오디오(절대 인덱스)와 전체 오디오 슬라이스가 같다
      const r = readWavPcm16Range(p, 200, 700)
      expect(Array.from(sliceFloat32(r, 250, 640))).toEqual(Array.from(sliceFloat32(full, 250, 640)))
      // 범위 밖은 range 가 덮는 곳까지만
      expect(sliceFloat32(r, 100, 300)).toHaveLength(100)
    })
  }

  it('locateWavData 는 decodeWavPcm16 과 같은 오류를 낸다', () => {
    const bad = wav({ channels: 2 })
    expect(() => locateWavData((o, l) => bad.subarray(o, o + l), bad.byteLength)).toThrow(/16비트 PCM mono/)
  })
})
