import { describe, it, expect } from 'vitest'
import {
  planCompaction,
  compactPcm16,
  remapChannelEnergy,
  mapMsToCompacted,
  speechRegionsToCompacted,
  DEFAULT_COMPACTION_OPTIONS
} from './audio-compactor'
import { findWavDataRange, type Region } from './vad-segmenter'

const SR = 16000

/**
 * 테스트용 합성 WAV(16kHz mono 16-bit). 샘플 값 = 인덱스(부호 있는 16비트로 랩)라
 * 슬라이스가 원본의 어느 위치에서 잘렸는지 값만 보고 검증할 수 있다.
 */
function makeWav(durationMs: number): { buf: Buffer; sampleAt: (i: number) => number } {
  const numSamples = Math.round((durationMs / 1000) * SR)
  const buf = Buffer.alloc(44 + numSamples * 2)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + numSamples * 2, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(numSamples * 2, 40)

  const sampleAt = (i: number): number => ((i % 30000) - 15000)
  for (let i = 0; i < numSamples; i++) buf.writeInt16LE(sampleAt(i), 44 + i * 2)
  return { buf, sampleAt }
}

describe('planCompaction', () => {
  it('(a) minRemovableGapMs 미만의 침묵은 손대지 않는다', () => {
    // 두 발화 사이 침묵 1000ms → 패딩(200×2) 적용 후 600ms 로 기본 임계(2000ms)에 못 미친다.
    const plan = planCompaction(
      [
        { startMs: 0, endMs: 2000 },
        { startMs: 3000, endMs: 5000 }
      ],
      5000
    )
    expect(plan.removed).toEqual([])
    expect(plan.keep).toEqual([{ startMs: 0, endMs: 5000 }])
    expect(plan.compactedMs).toBe(5000)
    expect(plan.applied).toBe(false)
  })

  it('(a-2) 제거 임계는 패딩 적용 후의 침묵 길이로 판정한다', () => {
    // 패딩 후 1800ms(임계 미만)는 그대로 두고, 2100ms(임계 이상)는 자른다.
    const under = planCompaction(
      [
        { startMs: 0, endMs: 2000 },
        { startMs: 4200, endMs: 6000 }
      ],
      6000
    )
    expect(under.removed).toEqual([])

    const over = planCompaction(
      [
        { startMs: 0, endMs: 2000 },
        { startMs: 4500, endMs: 6000 }
      ],
      6000
    )
    expect(over.removed).toEqual([{ startMs: 2500, endMs: 4000 }])
  })

  it('(b) 긴 침묵은 keepGapMs로 줄고 앞뒤 절반은 실제 오디오가 남는다', () => {
    const plan = planCompaction(
      [
        { startMs: 1000, endMs: 3000 },
        { startMs: 13000, endMs: 15000 }
      ],
      16000
    )
    // padded = [800,3200], [12800,15200]
    // 맨 앞 침묵은 edgeMs(300)만 남기고, 맨 뒤도 동일. 가운데 9600ms 침묵은 앞뒤 300ms씩 남긴다.
    expect(plan.keep).toEqual([
      { startMs: 500, endMs: 3500 },
      { startMs: 12500, endMs: 15500 }
    ])
    expect(plan.removed).toEqual([
      { startMs: 0, endMs: 500 },
      { startMs: 3500, endMs: 12500 },
      { startMs: 15500, endMs: 16000 }
    ])

    // 남은 침묵의 앞 절반(3200~3500)과 뒤 절반(12500~12800)은 모두 원본의 실제 오디오 구간이다.
    const half = DEFAULT_COMPACTION_OPTIONS.keepGapMs / 2
    expect(plan.keep[0].endMs - 3200).toBe(half)
    expect(12800 - plan.keep[1].startMs).toBe(half)

    // 화자분리가 발화 경계를 잡을 수 있도록 대체 갭은 0.5초 이상이어야 한다.
    expect(DEFAULT_COMPACTION_OPTIONS.keepGapMs).toBeGreaterThanOrEqual(500)

    expect(plan.compactedMs).toBe(3000 + 3000)
    expect(plan.applied).toBe(true)
  })

  it('(c) 패딩은 [0, audioMs] 경계로 클램프된다', () => {
    const plan = planCompaction(
      [
        { startMs: 50, endMs: 1000 },
        { startMs: 9500, endMs: 9990 }
      ],
      10000
    )
    expect(plan.keep[0].startMs).toBe(0)
    expect(plan.keep[plan.keep.length - 1].endMs).toBe(10000)
    expect(plan.keep).toEqual([
      { startMs: 0, endMs: 1500 },
      { startMs: 9000, endMs: 10000 }
    ])
    expect(plan.applied).toBe(true)
  })

  it('(d) 절감이 minSavingsRatio 미만이면 applied=false', () => {
    // 100초 중 발화가 98초 → 제거 가능한 건 꼬리 1.5초뿐(1.5% 절감).
    const plan = planCompaction([{ startMs: 0, endMs: 98000 }], 100000)
    expect(plan.removed.length).toBeGreaterThan(0)
    expect(plan.compactedMs).toBe(98500)
    expect(plan.applied).toBe(false)
  })

  it('(h) 발화 구간이 없으면(무음 파일) 손대지 않는다', () => {
    const plan = planCompaction([], 60000)
    expect(plan.applied).toBe(false)
    expect(plan.removed).toEqual([])
    expect(plan.keep).toEqual([{ startMs: 0, endMs: 60000 }])
    expect(plan.compactedMs).toBe(60000)
  })

  it('정렬되지 않거나 겹치는 입력도 방어적으로 정규화한다', () => {
    const plan = planCompaction(
      [
        { startMs: 13000, endMs: 15000 },
        { startMs: 1000, endMs: 3000 },
        { startMs: 2500, endMs: 2800 }
      ],
      16000
    )
    expect(plan.keep).toEqual([
      { startMs: 500, endMs: 3500 },
      { startMs: 12500, endMs: 15500 }
    ])
  })
})

describe('compactPcm16', () => {
  it('(e) 표준 44바이트 헤더와 Σkeep 길이를 가진 WAV를 만든다', () => {
    const { buf, sampleAt } = makeWav(2000)
    const range = findWavDataRange(buf)
    expect(range).not.toBeNull()

    const keep: Region[] = [
      { startMs: 0, endMs: 500 },
      { startMs: 1500, endMs: 2000 }
    ]
    const out = compactPcm16(buf, range!, keep)

    const outRange = findWavDataRange(out)
    expect(outRange).not.toBeNull()
    expect(outRange!.dataOffset).toBe(44)
    expect(outRange!.sampleRate).toBe(SR)
    expect(outRange!.channels).toBe(1)
    expect(outRange!.bitsPerSample).toBe(16)

    // Σkeep = 1000ms = 16000샘플 = 32000바이트
    const expectedSamples = 16000
    expect(outRange!.dataBytes).toBe(expectedSamples * 2)
    expect(out.length).toBe(44 + expectedSamples * 2)
    expect(out.readUInt32LE(4)).toBe(36 + expectedSamples * 2)
    expect(out.readUInt32LE(28)).toBe(SR * 2) // byteRate

    // 이어붙인 샘플이 원본의 keep 구간에서 그대로 온 값인지 확인(디지털 무음 삽입 없음).
    // 접합부 128샘플(fadeMs 8ms)은 페이드가 걸리므로 그 바깥에서 확인한다.
    expect(out.readInt16LE(44)).toBe(sampleAt(0)) // 파일 맨 앞 — 페이드 없음
    expect(out.readInt16LE(44 + 7871 * 2)).toBe(sampleAt(7871)) // fade-out 직전
    expect(out.readInt16LE(44 + 8128 * 2)).toBe(sampleAt(24128)) // fade-in 종료 후(1500ms = 24000샘플)
    expect(out.readInt16LE(44 + 15999 * 2)).toBe(sampleAt(31999)) // 파일 맨 뒤 — 페이드 없음
  })

  it('접합부에 선형 페이드를 걸어 클릭 잡음을 막는다', () => {
    const { buf, sampleAt } = makeWav(2000)
    const range = findWavDataRange(buf)!
    const keep: Region[] = [
      { startMs: 0, endMs: 500 },
      { startMs: 1500, endMs: 2000 }
    ]
    const out = compactPcm16(buf, range, keep)

    const fadeSamples = Math.round((DEFAULT_COMPACTION_OPTIONS.fadeMs / 1000) * SR)
    expect(fadeSamples).toBe(128)

    // 접합부 양쪽 끝 샘플은 gain 0 — 파형이 튀지 않고 0에서 만난다.
    expect(out.readInt16LE(44 + 7999 * 2)).toBe(0)
    expect(out.readInt16LE(44 + 8000 * 2)).toBe(0)

    // 중간 지점은 선형 감쇠(gain = i / fadeSamples).
    const half = fadeSamples / 2
    expect(out.readInt16LE(44 + (7999 - half) * 2)).toBe(Math.round(sampleAt(7999 - half) * 0.5))
    expect(out.readInt16LE(44 + (8000 + half) * 2)).toBe(Math.round(sampleAt(24000 + half) * 0.5))

    // fadeSamples를 지나면 원본값 그대로.
    expect(out.readInt16LE(44 + (7999 - fadeSamples) * 2)).toBe(sampleAt(7999 - fadeSamples))
    expect(out.readInt16LE(44 + (8000 + fadeSamples) * 2)).toBe(sampleAt(24000 + fadeSamples))

    // 입력 버퍼는 그대로여야 한다(subarray로 공유하던 메모리를 건드리지 않는다).
    expect(buf.readInt16LE(44 + 7999 * 2)).toBe(sampleAt(7999))
  })

  it('fadeMs=0이면 페이드를 걸지 않는다', () => {
    const { buf, sampleAt } = makeWav(2000)
    const range = findWavDataRange(buf)!
    const out = compactPcm16(
      buf,
      range,
      [
        { startMs: 0, endMs: 500 },
        { startMs: 1500, endMs: 2000 }
      ],
      { fadeMs: 0 }
    )
    expect(out.readInt16LE(44 + 7999 * 2)).toBe(sampleAt(7999))
    expect(out.readInt16LE(44 + 8000 * 2)).toBe(sampleAt(24000))
  })

  it('페이드 두 번이 겹칠 만큼 짧은 구간은 페이드를 건너뛴다', () => {
    // 10ms = 160샘플 < fadeSamples(128) × 2 → 통째로 뭉개지므로 그대로 둔다.
    const { buf, sampleAt } = makeWav(2000)
    const range = findWavDataRange(buf)!
    const out = compactPcm16(buf, range, [
      { startMs: 0, endMs: 10 },
      { startMs: 1500, endMs: 1510 }
    ])
    expect(out.readInt16LE(44 + 159 * 2)).toBe(sampleAt(159))
    expect(out.readInt16LE(44 + 160 * 2)).toBe(sampleAt(24000))
  })

  it('planCompaction 결과를 그대로 넣으면 compactedMs와 길이가 일치한다', () => {
    const { buf } = makeWav(16000)
    const range = findWavDataRange(buf)!
    const plan = planCompaction(
      [
        { startMs: 1000, endMs: 3000 },
        { startMs: 13000, endMs: 15000 }
      ],
      16000
    )
    const out = compactPcm16(buf, range, plan.keep)
    const outRange = findWavDataRange(out)!
    const durationMs = Math.round((outRange.dataBytes / (SR * 2)) * 1000)
    expect(durationMs).toBe(plan.compactedMs)
  })
})

describe('remapChannelEnergy', () => {
  it('(f) hop 중심시각이 keep 안인 프레임만 순서대로 남긴다', () => {
    const hopMs = 100
    const left = Array.from({ length: 20 }, (_, i) => i / 100)
    const right = Array.from({ length: 20 }, (_, i) => (20 - i) / 100)
    const keep: Region[] = [
      { startMs: 0, endMs: 500 },
      { startMs: 1500, endMs: 2000 }
    ]

    const out = remapChannelEnergy({ hopMs, left, right }, keep)
    const keepMs = keep.reduce((a, r) => a + (r.endMs - r.startMs), 0)

    expect(out.hopMs).toBe(hopMs)
    expect(out.left).toHaveLength(keepMs / hopMs)
    expect(out.right).toHaveLength(keepMs / hopMs)
    // 프레임 0~4(중심 50~450)와 15~19(중심 1550~1950)가 남는다.
    expect(out.left).toEqual([0, 1, 2, 3, 4, 15, 16, 17, 18, 19].map((i) => i / 100))
    expect(out.right).toEqual([0, 1, 2, 3, 4, 15, 16, 17, 18, 19].map((i) => (20 - i) / 100))
  })

  it('길이가 다른 L/R은 짧은 쪽에 맞춘다', () => {
    const out = remapChannelEnergy(
      { hopMs: 100, left: [0.1, 0.2, 0.3], right: [0.4] },
      [{ startMs: 0, endMs: 1000 }]
    )
    expect(out.left).toEqual([0.1])
    expect(out.right).toEqual([0.4])
  })
})

describe('mapMsToCompacted / speechRegionsToCompacted', () => {
  const keep: Region[] = [
    { startMs: 500, endMs: 3500 },
    { startMs: 12500, endMs: 15500 }
  ]

  it('(g) 제거 구간 안의 시각은 직전 keep 끝으로 접히고, 매핑은 단조 증가한다', () => {
    expect(mapMsToCompacted(0, keep)).toBe(0) // 잘려나간 파일 앞머리
    expect(mapMsToCompacted(500, keep)).toBe(0)
    expect(mapMsToCompacted(1000, keep)).toBe(500)
    expect(mapMsToCompacted(3500, keep)).toBe(3000)
    expect(mapMsToCompacted(8000, keep)).toBe(3000) // 제거 구간 내부
    expect(mapMsToCompacted(12500, keep)).toBe(3000)
    expect(mapMsToCompacted(13500, keep)).toBe(4000)
    expect(mapMsToCompacted(15500, keep)).toBe(6000)
    expect(mapMsToCompacted(99999, keep)).toBe(6000) // 파일 끝 이후는 전체 길이로 클램프

    let prev = -1
    for (let ms = 0; ms <= 16000; ms += 137) {
      const v = mapMsToCompacted(ms, keep)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('발화 구간을 컷편집 타임라인으로 옮긴다', () => {
    const out = speechRegionsToCompacted(
      [
        { startMs: 1000, endMs: 3000 },
        { startMs: 13000, endMs: 15000 }
      ],
      keep
    )
    expect(out).toEqual([
      { startMs: 500, endMs: 2500 },
      { startMs: 3500, endMs: 5500 }
    ])
  })

  it('컷편집으로 통째로 사라진 구간은 버린다', () => {
    const out = speechRegionsToCompacted([{ startMs: 5000, endMs: 6000 }], keep)
    expect(out).toEqual([])
  })
})
