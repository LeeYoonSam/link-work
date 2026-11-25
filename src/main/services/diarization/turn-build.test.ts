import { describe, it, expect } from 'vitest'
import { buildTurns } from './turn-build'

describe('buildTurns', () => {
  it('겹친 창은 겹침 중점을 경계로 나누고, 붙은 같은 화자는 합친다', () => {
    const wins = [
      { s: 0, e: 1.5 },
      { s: 0.75, e: 2.25 },
      { s: 1.5, e: 3 },
      { s: 2.25, e: 3.75 }
    ]
    expect(buildTurns(wins, [0, 0, 1, 1])).toEqual([
      { start_ms: 0, end_ms: 1875, speaker_key: 'spk_0' },
      { start_ms: 1875, end_ms: 3750, speaker_key: 'spk_1' }
    ])
  })

  it('떨어진 같은 화자 turn 은 합치지 않는다', () => {
    const wins = [
      { s: 0, e: 1 },
      { s: 2, e: 3 }
    ]
    expect(buildTurns(wins, [0, 0])).toEqual([
      { start_ms: 0, end_ms: 1000, speaker_key: 'spk_0' },
      { start_ms: 2000, end_ms: 3000, speaker_key: 'spk_0' }
    ])
  })

  it('입력 순서와 무관하게 시작 순으로 처리하고, 비면 빈 배열', () => {
    const wins = [
      { s: 2, e: 3 },
      { s: 0, e: 1 }
    ]
    expect(buildTurns(wins, [1, 0]).map((t) => t.speaker_key)).toEqual(['spk_0', 'spk_1'])
    expect(buildTurns([], [])).toEqual([])
  })

  it('A-B-A 교대도 경계가 겹치지 않는다', () => {
    const wins = [
      { s: 0, e: 1.5 },
      { s: 0.75, e: 2.25 },
      { s: 1.5, e: 3 }
    ]
    const t = buildTurns(wins, [0, 1, 0])
    expect(t.map((x) => x.speaker_key)).toEqual(['spk_0', 'spk_1', 'spk_0'])
    for (let i = 1; i < t.length; i++) expect(t[i].start_ms).toBe(t[i - 1].end_ms)
    expect(t[1]).toEqual({ start_ms: 1125, end_ms: 1875, speaker_key: 'spk_1' })
  })
})
