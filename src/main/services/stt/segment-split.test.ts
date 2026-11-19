import { describe, it, expect } from 'vitest'
import { hasBrokenText, sanitizeSegmentTimes } from './segment-split'
import type { SttSegment } from '../meeting-types'

describe('hasBrokenText', () => {
  it('U+FFFD가 든 세그먼트가 하나라도 있으면 true', () => {
    expect(
      hasBrokenText([
        { text: '정상 문장입니다' },
        { text: '깨진 글�' }
      ])
    ).toBe(true)
  })

  it('모든 세그먼트가 정상이면 false', () => {
    expect(hasBrokenText([{ text: '안녕하세요' }, { text: '네' }])).toBe(false)
  })

  it('빈 배열이면 false', () => {
    expect(hasBrokenText([])).toBe(false)
  })
})

describe('sanitizeSegmentTimes', () => {
  it('음수 타임스탬프를 0으로 보정한다', () => {
    const out = sanitizeSegmentTimes([{ start_ms: -50, end_ms: -10, text: 'a' }])
    expect(out[0]).toEqual({ start_ms: 0, end_ms: 0, text: 'a' })
  })

  it('end < start면 end를 start로 맞춘다', () => {
    const out = sanitizeSegmentTimes([{ start_ms: 1000, end_ms: 500, text: 'a' }])
    expect(out[0].start_ms).toBe(1000)
    expect(out[0].end_ms).toBe(1000)
  })

  it('start 오름차순으로 정렬하고 동률은 원래 순서를 유지한다', () => {
    const segs: SttSegment[] = [
      { start_ms: 2000, end_ms: 3000, text: 'c' },
      { start_ms: 1000, end_ms: 1500, text: 'a' },
      { start_ms: 1000, end_ms: 1800, text: 'b' }
    ]
    const out = sanitizeSegmentTimes(segs)
    expect(out.map((s) => s.text)).toEqual(['a', 'b', 'c'])
    for (let i = 1; i < out.length; i++) {
      expect(out[i].start_ms).toBeGreaterThanOrEqual(out[i - 1].start_ms)
    }
  })

  it('maxMs가 주어지면 상한으로 클램프한다', () => {
    const out = sanitizeSegmentTimes([{ start_ms: 27000, end_ms: 29500, text: 'a' }], 28000)
    expect(out[0]).toEqual({ start_ms: 27000, end_ms: 28000, text: 'a' })
  })

  it('유한하지 않은 값은 직전 세그먼트 끝/자기 start로 대체한다', () => {
    const out = sanitizeSegmentTimes([
      { start_ms: 0, end_ms: 1200, text: 'a' },
      { start_ms: NaN, end_ms: Infinity, text: 'b' }
    ])
    expect(out[1]).toEqual({ start_ms: 1200, end_ms: 1200, text: 'b' })
  })

  it('입력 배열과 원소를 변형하지 않는다', () => {
    const segs: SttSegment[] = [
      { start_ms: 2000, end_ms: 1000, text: 'b' },
      { start_ms: -1, end_ms: 10, text: 'a' }
    ]
    const snapshot = JSON.parse(JSON.stringify(segs))
    sanitizeSegmentTimes(segs)
    expect(segs).toEqual(snapshot)
  })
})
