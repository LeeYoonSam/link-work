import { describe, it, expect } from 'vitest'
import { assignMarksToTopics } from './assignMarksToTopics'

const mk = (id: number, at_ms: number): { id: number; at_ms: number } => ({ id, at_ms })

describe('assignMarksToTopics', () => {
  it('메모를 [start_i, start_{i+1}) 구간의 주제에 배정하고 at_ms 순으로 둔다', () => {
    const topics = [{ start_ms: 1000 }, { start_ms: 5000 }, { start_ms: 9000 }]
    const r = assignMarksToTopics(topics, [mk(1, 9500), mk(2, 4999), mk(3, 5000), mk(4, 1000), mk(5, 3000)])
    expect(r.unassigned).toEqual([])
    expect(r.byTopic.get(0)?.map((m) => m.id)).toEqual([4, 5, 2])
    expect(r.byTopic.get(1)?.map((m) => m.id)).toEqual([3])
    expect(r.byTopic.get(2)?.map((m) => m.id)).toEqual([1])
  })

  it('첫 주제 이전 메모는 0번 주제에 둔다', () => {
    const r = assignMarksToTopics([{ start_ms: 60000 }, { start_ms: 120000 }], [mk(1, 500)])
    expect(r.byTopic.get(0)?.map((m) => m.id)).toEqual([1])
    expect(r.unassigned).toEqual([])
  })

  it('start_ms가 하나라도 null이면 전부 배정하지 않는다(입력 순서 유지)', () => {
    const marks = [mk(1, 9000), mk(2, 100)]
    const r = assignMarksToTopics([{ start_ms: 0 }, { start_ms: null }], marks)
    expect(r.byTopic.size).toBe(0)
    expect(r.unassigned.map((m) => m.id)).toEqual([1, 2])
  })

  it('주제 시각이 내림차순이면 전부 배정하지 않는다', () => {
    const r = assignMarksToTopics([{ start_ms: 5000 }, { start_ms: 1000 }], [mk(1, 2000)])
    expect(r.byTopic.size).toBe(0)
    expect(r.unassigned.map((m) => m.id)).toEqual([1])
  })

  it('같은 시작 시각은 허용한다(뒤 주제가 그 구간을 갖는다)', () => {
    const r = assignMarksToTopics([{ start_ms: 1000 }, { start_ms: 1000 }], [mk(1, 1500)])
    expect(r.unassigned).toEqual([])
    expect(r.byTopic.get(1)?.map((m) => m.id)).toEqual([1])
  })

  it('주제가 없으면 전부 배정하지 않는다', () => {
    const r = assignMarksToTopics([], [mk(1, 0), mk(2, 10)])
    expect(r.byTopic.size).toBe(0)
    expect(r.unassigned.map((m) => m.id)).toEqual([1, 2])
  })
})
