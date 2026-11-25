import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runEmbeddingDiarization, type SherpaEmbeddingApi, type SherpaStream } from './embedding-diarizer'
import { VOICE_EMBEDDING_MODEL, WINDOW_MAX_SEC } from './window-plan'

const SR = 16000
const dir = mkdtempSync(join(tmpdir(), 'diar-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function writeWav(path: string, pcm: Int16Array, sampleRate = SR): void {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
}

/** 가짜 추출기: 창의 평균 샘플 부호로 화자 방향을 정한다(양수 → e0, 음수 → e1). 입력 길이를 기록한다. */
function fakeSherpa(lengths: number[]): SherpaEmbeddingApi {
  class Stream implements SherpaStream {
    samples: Float32Array = new Float32Array(0)
    acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void {
      this.samples = o.samples
    }
    inputFinished(): void {}
  }
  class Extractor {
    dim = 8
    createStream(): Stream {
      return new Stream()
    }
    compute(stream: SherpaStream): Float32Array {
      const s = (stream as Stream).samples
      lengths.push(s.length)
      let m = 0
      for (const x of s) m += x
      const v = new Float32Array(8)
      v[m >= 0 ? 0 : 1] = 1
      v[2] = 0.1
      return v
    }
  }
  return { SpeakerEmbeddingExtractor: Extractor as unknown as SherpaEmbeddingApi['SpeakerEmbeddingExtractor'] }
}

describe('runEmbeddingDiarization', () => {
  // 0~30초: 화자 A(+), 30~60초: 화자 B(-)
  const pcm = new Int16Array(60 * SR)
  for (let i = 0; i < pcm.length; i++) pcm[i] = i < 30 * SR ? 1000 : -1000
  const audioPath = join(dir, 'two.wav')
  writeWav(audioPath, pcm)
  const segments = [
    { start_ms: 0, end_ms: 14000 },
    { start_ms: 14000, end_ms: 29000 },
    { start_ms: 30000, end_ms: 45000 },
    { start_ms: 45000, end_ms: 60000 },
    { start_ms: 59800, end_ms: 60100 } // 0.5초 미만 → 제외
  ]

  it('창 입력은 2.25초 이하이고 두 화자 turn·목소리를 낸다', () => {
    const lengths: number[] = []
    const r = runEmbeddingDiarization(fakeSherpa(lengths), { audioPath, embModel: 'x', segments })
    expect(lengths.length).toBe(r.info.windows)
    for (const n of lengths) expect(n / SR).toBeLessThanOrEqual(WINDOW_MAX_SEC)
    expect(r.info.maxWindowSec).toBeLessThanOrEqual(WINDOW_MAX_SEC)
    expect(r.info.speakers).toBe(2)
    expect(r.info.model).toBe(VOICE_EMBEDDING_MODEL)
    expect(r.turns.map((t) => t.speaker_key)).toEqual(['spk_0', 'spk_1'])
    expect(r.turns[0]).toMatchObject({ start_ms: 0, end_ms: 29000 })
    expect(r.turns[1]).toMatchObject({ start_ms: 30000, end_ms: 60000 })
    expect(r.voices.map((v) => v.speaker_key)).toEqual(['spk_0', 'spk_1'])
    expect(r.voices[0].speech_ms).toBe(29000)
    expect(r.voices[0].embedding).toHaveLength(8)
    expect(Math.hypot(...r.voices[0].embedding)).toBeCloseTo(1)
  })

  it('지정 화자 수를 따른다', () => {
    const r = runEmbeddingDiarization(fakeSherpa([]), { audioPath, embModel: 'x', segments, numSpeakers: 1 })
    expect(r.info.speakers).toBe(1)
    expect(new Set(r.turns.map((t) => t.speaker_key))).toEqual(new Set(['spk_0']))
  })

  it('세그먼트가 없으면 빈 결과', () => {
    const r = runEmbeddingDiarization(fakeSherpa([]), { audioPath, embModel: 'x', segments: [] })
    expect(r.turns).toEqual([])
    expect(r.voices).toEqual([])
  })

  it('16kHz 가 아니면 오류', () => {
    const p = join(dir, '8k.wav')
    writeWav(p, new Int16Array(8000), 8000)
    expect(() => runEmbeddingDiarization(fakeSherpa([]), { audioPath: p, embModel: 'x', segments })).toThrow(/16kHz/)
  })
})
