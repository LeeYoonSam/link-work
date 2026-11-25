import { describe, it, expect } from 'vitest'
import { planWindows, WINDOW_MAX_SEC, WINDOW_SEC, HOP_SEC } from './window-plan'

const seg = (s: number, e: number): { start_ms: number; end_ms: number } => ({ start_ms: s * 1000, end_ms: e * 1000 })

describe('planWindows', () => {
  it('모든 창 길이가 2.25초 이하다', () => {
    const wins = planWindows([seg(0, 1), seg(1, 3.2), seg(3.2, 13.7), seg(20, 80.3)], 100)
    expect(wins.length).toBeGreaterThan(0)
    for (const w of wins) expect(w.e - w.s).toBeLessThanOrEqual(WINDOW_MAX_SEC + 1e-9)
    expect(WINDOW_MAX_SEC).toBe(2.25)
  })

  it('0.5초 미만 세그먼트는 제외하고, 2.25초 이하는 통째로 창 1개', () => {
    const wins = planWindows([seg(0, 0.49), seg(1, 1.5), seg(2, 4.25)], 100)
    expect(wins).toEqual([
      { s: 1, e: 1.5, si: 1 },
      { s: 2, e: 4.25, si: 2 }
    ])
  })

  it('긴 세그먼트는 1.5초 창·0.75초 hop, 마지막 창은 끝에 맞춘다', () => {
    const wins = planWindows([seg(10, 14)], 100)
    expect(wins.map((w) => [w.s, w.e])).toEqual([
      [10, 11.5],
      [10.75, 12.25],
      [11.5, 13],
      [12.25, 13.75],
      [12.5, 14]
    ])
    for (const w of wins) expect(w.e - w.s).toBeCloseTo(WINDOW_SEC)
    expect(wins[1].s - wins[0].s).toBeCloseTo(HOP_SEC)
  })

  it('오디오 길이로 끝을 자르고, 잘려서 짧아지면 제외한다', () => {
    expect(planWindows([seg(9, 12)], 10)).toEqual([{ s: 9, e: 10, si: 0 }])
    expect(planWindows([seg(9.8, 12)], 10)).toEqual([])
  })

  it('같은 세그먼트의 창은 연속하고 세그먼트는 시작 순으로 처리한다', () => {
    const wins = planWindows([seg(20, 24), seg(0, 4)], 100)
    expect(wins[0].si).toBe(1)
    const sis = wins.map((w) => w.si)
    expect(sis).toEqual([...sis].sort((a, b) => b - a))
  })
})
