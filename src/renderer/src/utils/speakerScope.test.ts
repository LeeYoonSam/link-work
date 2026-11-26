import { describe, expect, it } from 'vitest'
import { planReassignIds, SCOPE_LABELS } from './speakerScope'

const segs = [
  { id: 1, start_ms: 0, sort_order: 0, speaker_id: 1 },
  { id: 2, start_ms: 1000, sort_order: 1, speaker_id: 2 },
  { id: 3, start_ms: 2000, sort_order: 2, speaker_id: 1 },
  { id: 4, start_ms: 3000, sort_order: 3, speaker_id: null },
  { id: 5, start_ms: 4000, sort_order: 4, speaker_id: 1 },
  { id: 6, start_ms: 5000, sort_order: 5, speaker_id: null }
]

describe('planReassignIds', () => {
  it('one 은 그 세그먼트만', () => {
    expect(planReassignIds(segs, 3, 'one')).toEqual([3])
  })

  it('forward 는 같은 화자의 기준과 그 뒤', () => {
    expect(planReassignIds(segs, 3, 'forward')).toEqual([3, 5])
  })

  it('all 은 같은 화자 전부', () => {
    expect(planReassignIds(segs, 3, 'all')).toEqual([1, 3, 5])
  })

  it('null 화자끼리도 같은 화자로 본다', () => {
    expect(planReassignIds(segs, 4, 'forward')).toEqual([4, 6])
    expect(planReassignIds(segs, 6, 'all')).toEqual([4, 6])
  })

  it('같은 start_ms 는 sort_order 순, 입력 순서와 무관', () => {
    const tie = [
      { id: 10, start_ms: 0, sort_order: 2, speaker_id: 1 },
      { id: 11, start_ms: 0, sort_order: 0, speaker_id: 1 },
      { id: 12, start_ms: 0, sort_order: 1, speaker_id: 1 }
    ]
    expect(planReassignIds(tie, 12, 'forward')).toEqual([12, 10])
    expect(planReassignIds(tie, 12, 'all')).toEqual([11, 12, 10])
  })

  it('없는 id 면 []', () => {
    expect(planReassignIds(segs, 99, 'one')).toEqual([])
    expect(planReassignIds(segs, 99, 'all')).toEqual([])
  })

  it('범위 이름', () => {
    expect(SCOPE_LABELS).toEqual({
      one: '이 구간만',
      forward: '이 구간부터',
      all: '전체'
    })
  })
})
