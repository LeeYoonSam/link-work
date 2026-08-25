import { describe, it, expect } from 'vitest'
import {
  estimateVadProgress,
  vadSegmentsToRegions,
  coalesceRegions,
  sliceSampleRange,
  mapSegmentsToAbsolute,
  findWavDataRange
} from './vad-segmenter'

// 테스트용 최소 WAV 버퍼를 조립한다(renderer의 encodeWav16과 동일한 44바이트 PCM 헤더).
function buildWav(opts: {
  sampleRate?: number
  channels?: number
  bitsPerSample?: number
  dataBytes?: number
}): Buffer {
  const sampleRate = opts.sampleRate ?? 16000
  const channels = opts.channels ?? 1
  const bitsPerSample = opts.bitsPerSample ?? 16
  const dataBytes = opts.dataBytes ?? 8
  const blockAlign = (channels * bitsPerSample) / 8
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * blockAlign, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(bitsPerSample, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  return buf
}

describe('vadSegmentsToRegions', () => {
  it('cs 단위 t0/t1을 ×10 하여 ms 구간으로 변환한다', () => {
    // t0=25cs, t1=130cs → 250ms, 1300ms
    const regions = vadSegmentsToRegions([{ t0: 25, t1: 130 }], 10000)
    expect(regions).toEqual([{ startMs: 250, endMs: 1300 }])
  })

  it('간격이 mergeGapMs 이하인 인접 구간을 병합한다', () => {
    // 100~200cs(1000~2000ms)과 220~300cs(2200~3000ms): 간격 200ms ≤ 300ms → 병합
    const regions = vadSegmentsToRegions([{ t0: 100, t1: 200 }, { t0: 220, t1: 300 }], 100000)
    expect(regions).toEqual([{ startMs: 1000, endMs: 3000 }])
  })

  it('간격이 mergeGapMs를 초과하면 병합하지 않는다', () => {
    // 1000~2000ms과 2400~3200ms: 간격 400ms > 300ms → 분리 유지
    const regions = vadSegmentsToRegions([{ t0: 100, t1: 200 }, { t0: 240, t1: 320 }], 100000)
    expect(regions).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 2400, endMs: 3200 }
    ])
  })

  it('오디오 길이를 넘는 구간을 audioMs로 클램프하고 빈 구간을 버린다', () => {
    // 끝이 audioMs(5000ms=500cs) 초과 → 5000으로 클램프. 두 번째는 클램프 후 start==end라 제거.
    const regions = vadSegmentsToRegions([{ t0: 400, t1: 700 }, { t0: 600, t1: 800 }], 5000)
    expect(regions).toEqual([{ startMs: 4000, endMs: 5000 }])
  })

  it('minRegionMs 미만 구간을 필터링한다', () => {
    // 1000~1100ms(100ms) 구간은 minRegionMs=200 미만 → 제거
    const regions = vadSegmentsToRegions([{ t0: 100, t1: 110 }], 100000, { minRegionMs: 200 })
    expect(regions).toEqual([])
  })
})

describe('coalesceRegions', () => {
  it('0.5~2s 간격 구간들을 침묵 포함 한 청크로 합친다', () => {
    // 간격 500ms, 2000ms 모두 joinGapMs(2000) 이하 → 침묵째 하나로. 청크 경계는 [첫 시작, 마지막 끝].
    const regions = [
      { startMs: 0, endMs: 1000 },
      { startMs: 1500, endMs: 2500 }, // 간격 500ms
      { startMs: 4500, endMs: 5500 } // 간격 2000ms (경계값, 병합됨)
    ]
    expect(coalesceRegions(regions)).toEqual([{ startMs: 0, endMs: 5500 }])
  })

  it('2s를 초과하는 간격은 청크 경계로 둔다', () => {
    // 간격 2001ms > joinGapMs(2000) → 병합하지 않음. 긴 무음은 전사에서 배제된다.
    const regions = [
      { startMs: 0, endMs: 1000 },
      { startMs: 3001, endMs: 4000 }
    ]
    expect(coalesceRegions(regions)).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 3001, endMs: 4000 }
    ])
  })

  it('타임라인 길이가 28s를 넘게 되면 그 지점에서 청크를 끊는다', () => {
    // 10s 발화 + 1s 침묵 반복. 두 구간(타임라인 21s)까진 병합, 세 번째를 더하면 32s > 28s라 끊는다.
    const regions = [
      { startMs: 0, endMs: 10000 },
      { startMs: 11000, endMs: 21000 }, // 병합 → [0, 21000]
      { startMs: 22000, endMs: 32000 } // 더하면 32000 > 28000 → 새 청크
    ]
    expect(coalesceRegions(regions)).toEqual([
      { startMs: 0, endMs: 21000 },
      { startMs: 22000, endMs: 32000 }
    ])
  })

  it('28s를 초과하는 단일 구간은 쪼개지 않고 단독 청크로 유지한다', () => {
    // 단일 30s 구간은 그대로. 뒤 구간은 병합 시 32s > 28s라 새 청크가 된다(오버사이즈 구간이 홀로 남음).
    const regions = [
      { startMs: 0, endMs: 30000 },
      { startMs: 31000, endMs: 32000 }
    ]
    expect(coalesceRegions(regions)).toEqual([
      { startMs: 0, endMs: 30000 },
      { startMs: 31000, endMs: 32000 }
    ])
    // 뒤따르는 구간이 없어도 30s 구간은 절단 없이 그대로 유지된다.
    expect(coalesceRegions([{ startMs: 0, endMs: 30000 }])).toEqual([{ startMs: 0, endMs: 30000 }])
  })

  it('청크는 연속 타임라인 슬라이스라 시작 오프셋 하나로 절대시간을 복원한다', () => {
    // [5000,6000]과 [6500,7000]을 뭉치면 청크는 [5000,7000](내부 500ms 침묵 포함).
    const chunks = coalesceRegions([
      { startMs: 5000, endMs: 6000 },
      { startMs: 6500, endMs: 7000 }
    ])
    expect(chunks).toEqual([{ startMs: 5000, endMs: 7000 }])
    // 슬라이스가 청크 시작(5000ms)부터 시작하므로, 전사 상대 ms에 청크 startMs만 더하면 절대시간이 맞는다.
    // 상대 [1500,2000]은 절대 [6500,7000] (두 번째 발화)로 정확히 복원된다.
    const chunk = chunks[0]
    expect(mapSegmentsToAbsolute([{ start_ms: 1500, end_ms: 2000, text: '두번째' }], chunk.startMs)).toEqual([
      { start_ms: 6500, end_ms: 7000, text: '두번째' }
    ])
  })

  it('60분(10s 발화+1s 침묵 반복) 시나리오에서 청크 수가 폭발하지 않는다', () => {
    // 호출 수 폭발 방지가 목적이므로, 청크 수 ≤ 총시간/20s 임을 고정한다.
    const totalMs = 60 * 60 * 1000
    const regions: Array<{ startMs: number; endMs: number }> = []
    for (let t = 0; t + 10000 <= totalMs; t += 11000) {
      regions.push({ startMs: t, endMs: t + 10000 })
    }
    const chunks = coalesceRegions(regions)
    // 발화 구간(=과거 전사 단위)은 수백 개지만, 청크로 뭉치면 절반 이하로 줄어든다.
    expect(regions.length).toBeGreaterThan(300)
    expect(chunks.length).toBeLessThanOrEqual(Math.ceil(totalMs / 20000))
    expect(chunks.length).toBeLessThan(regions.length)
    // 모든 청크 타임라인은 28s 상한을 넘지 않는다(단일 구간 오버사이즈 케이스 없음).
    for (const c of chunks) expect(c.endMs - c.startMs).toBeLessThanOrEqual(28000)
  })
})

describe('sliceSampleRange', () => {
  it('ms를 샘플 인덱스로 변환한다(시작 내림, 끝 올림)', () => {
    // 1000ms @16k = 16000, 2000ms = 32000
    expect(sliceSampleRange(1000, 2000)).toEqual({ startSample: 16000, endSample: 32000 })
  })

  it('반올림 손실을 피하려 끝 샘플을 올림한다', () => {
    // 1ms @16k = 16 샘플, 하지만 소수 발생 케이스에서 끝은 ceil
    const { startSample, endSample } = sliceSampleRange(0, 1)
    expect(startSample).toBe(0)
    expect(endSample).toBe(16)
  })
})

describe('mapSegmentsToAbsolute', () => {
  it('구간 상대 ms에 region 시작 ms를 더해 절대시간으로 복원한다', () => {
    const rel = [
      { start_ms: 0, end_ms: 500, text: '안녕하세요' },
      { start_ms: 500, end_ms: 900, text: '반갑습니다' }
    ]
    expect(mapSegmentsToAbsolute(rel, 10000)).toEqual([
      { start_ms: 10000, end_ms: 10500, text: '안녕하세요' },
      { start_ms: 10500, end_ms: 10900, text: '반갑습니다' }
    ])
  })
})

describe('findWavDataRange', () => {
  it('표준 16k/mono/16bit WAV의 data 청크 범위를 찾는다', () => {
    const buf = buildWav({ dataBytes: 64 })
    expect(findWavDataRange(buf)).toEqual({
      dataOffset: 44,
      dataBytes: 64,
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16
    })
  })

  it('data 선언 크기가 버퍼를 넘으면 버퍼 경계로 보정한다', () => {
    const buf = buildWav({ dataBytes: 32 })
    // data 청크 선언을 실제보다 크게 위조
    buf.writeUInt32LE(9999, 40)
    const range = findWavDataRange(buf)
    expect(range?.dataOffset).toBe(44)
    expect(range?.dataBytes).toBe(buf.length - 44)
  })

  it('16kHz가 아니면 null을 반환한다', () => {
    expect(findWavDataRange(buildWav({ sampleRate: 44100 }))).toBeNull()
  })

  it('mono가 아니면 null을 반환한다', () => {
    expect(findWavDataRange(buildWav({ channels: 2 }))).toBeNull()
  })

  it('16-bit가 아니면 null을 반환한다', () => {
    expect(findWavDataRange(buildWav({ bitsPerSample: 8 }))).toBeNull()
  })

  it('RIFF/WAVE 매직이 없으면 null을 반환한다', () => {
    expect(findWavDataRange(Buffer.alloc(44))).toBeNull()
  })
})

describe('estimateVadProgress', () => {
  // 기본 200배속 기준이므로 60초 오디오의 예상 소요는 300ms.
  const AUDIO_MS = 60_000

  it('경과 시간을 예상 소요(길이/배속)로 나눈 값을 돌려준다', () => {
    expect(estimateVadProgress(0, AUDIO_MS)).toBe(0)
    expect(estimateVadProgress(75, AUDIO_MS)).toBeCloseTo(0.25, 5)
    expect(estimateVadProgress(150, AUDIO_MS)).toBeCloseTo(0.5, 5)
  })

  it('0.95를 넘지 않는다 — 다 찬 바가 멈춘 것처럼 보이지 않게 한다', () => {
    expect(estimateVadProgress(300, AUDIO_MS)).toBe(0.95)
    expect(estimateVadProgress(10_000_000, AUDIO_MS)).toBe(0.95)
  })

  it('단조 증가한다', () => {
    let prev = -1
    for (let ms = 0; ms <= 1000; ms += 37) {
      const v = estimateVadProgress(ms, AUDIO_MS)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('오디오 길이를 모르면(0 이하) 0을 돌려준다', () => {
    expect(estimateVadProgress(5000, 0)).toBe(0)
    expect(estimateVadProgress(5000, -1)).toBe(0)
  })

  it('배속이 0 이하면 0을 돌려준다(0으로 나눠 즉시 95%가 되는 것 방지)', () => {
    expect(estimateVadProgress(5000, AUDIO_MS, 0)).toBe(0)
    expect(estimateVadProgress(5000, AUDIO_MS, -10)).toBe(0)
  })

  it('배속을 바꾸면 그만큼 느리게/빠르게 찬다', () => {
    // 400배속이면 예상 소요가 절반이므로 같은 경과에서 두 배로 찬다.
    expect(estimateVadProgress(75, AUDIO_MS, 400)).toBeCloseTo(0.5, 5)
    expect(estimateVadProgress(75, AUDIO_MS, 100)).toBeCloseTo(0.125, 5)
  })

  it('경과가 음수여도 음수 진행률을 내지 않는다', () => {
    expect(estimateVadProgress(-100, AUDIO_MS)).toBe(0)
  })

  it('98분 녹음이면 기본 배속에서 약 29초를 예상한다', () => {
    // 98 × 60000 / 200 = 29,400ms 예상. 실측(224배속)이 26초였으니 그보다 조금 넉넉하다.
    const audioMs = 98 * 60_000
    expect(estimateVadProgress(15_000, audioMs)).toBeCloseTo(0.5102, 3)
    // 예상 소요에 근접하면 상한(0.95)에 걸린다.
    expect(estimateVadProgress(29_000, audioMs)).toBe(0.95)
  })
})
