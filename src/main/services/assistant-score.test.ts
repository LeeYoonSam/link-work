import { describe, expect, it } from 'vitest'
import { compareCandidates, rankCandidates, scoreCandidate } from './assistant-score'
import { cand, deepFreeze, TODAY } from './__fixtures__/assistant/factories'

const due = (d: string | null): number => scoreCandidate(cand({ id: 'todo:1', dueDate: d }), TODAY)

describe('scoreCandidate §5.1', () => {
  it('마감 구간 점수', () => {
    expect(due('2026-11-01')).toBe(105) // 1일 지남
    expect(due('2026-10-20')).toBe(135) // 13일 지남 → 7일 상한
    expect(due(TODAY)).toBe(90)
    expect(due('2026-11-03')).toBe(70)
    expect(due('2026-11-04')).toBe(50)
    expect(due('2026-11-05')).toBe(50)
    expect(due('2026-11-06')).toBe(30)
    expect(due('2026-11-09')).toBe(30)
    expect(due('2026-11-10')).toBe(0)
    expect(due(null)).toBe(0)
    expect(due('잘못된')).toBe(0)
  })

  it('월 경계도 일 수로 센다', () => {
    expect(scoreCandidate(cand({ id: 'todo:1', dueDate: '2026-12-01' }), '2026-11-30')).toBe(70)
  })

  it('진행 중·우선순위·액션아이템 가산', () => {
    expect(scoreCandidate(cand({ id: 'task:1', inProgress: true }), TODAY)).toBe(25)
    expect(scoreCandidate(cand({ id: 'task:1', priority: 'high' }), TODAY)).toBe(20)
    expect(scoreCandidate(cand({ id: 'task:1', priority: 'medium' }), TODAY)).toBe(10)
    expect(scoreCandidate(cand({ id: 'task:1', priority: 'low' }), TODAY)).toBe(0)
    expect(scoreCandidate(cand({ id: 'action_item:1:0', priority: 'medium' }), TODAY)).toBe(15)
  })

  it('lastTouchedAt 이 14일 이상 전이면 −5', () => {
    expect(scoreCandidate(cand({ id: 'task:1', lastTouchedAt: '2026-10-19 23:59:59' }), TODAY)).toBe(-5)
    expect(scoreCandidate(cand({ id: 'task:1', lastTouchedAt: '2026-10-20 00:00:00' }), TODAY)).toBe(0)
  })

  it('합산', () => {
    const c = cand({ id: 'jira:P-1', dueDate: TODAY, inProgress: true, priority: 'high' })
    expect(scoreCandidate(c, TODAY)).toBe(135)
  })
})

describe('compareCandidates·rankCandidates', () => {
  it('점수 → 마감 → 출처 → id 순서', () => {
    const list = [
      cand({ id: 'todo:9', priority: 'high' }), // 20
      cand({ id: 'task:2', priority: 'high' }), // 20, 출처 task 가 todo 보다 앞
      cand({ id: 'jira:B', priority: 'high', dueDate: '2026-11-30' }), // 20, 마감 있음이 앞
      cand({ id: 'todo:1', dueDate: TODAY }), // 90
      cand({ id: 'task:1', priority: 'high' }) // 20, id 순
    ]
    expect(rankCandidates(list, TODAY).map((r) => r.candidate.id)).toEqual([
      'todo:1',
      'jira:B',
      'task:1',
      'task:2',
      'todo:9'
    ])
  })

  it('compareCandidates 는 점수가 높으면 음수', () => {
    const a = { candidate: cand({ id: 'todo:1' }), score: 50 }
    const b = { candidate: cand({ id: 'todo:2' }), score: 10 }
    expect(compareCandidates(a, b)).toBeLessThan(0)
    expect(compareCandidates(b, a)).toBeGreaterThan(0)
  })

  it('A14: 입력 배열을 바꾸지 않고 같은 입력에 같은 결과를 낸다', () => {
    const list = deepFreeze([
      cand({ id: 'todo:3', priority: 'low' }),
      cand({ id: 'todo:1', dueDate: TODAY }),
      cand({ id: 'todo:2', priority: 'high' })
    ])
    const before = JSON.stringify(list)
    const r1 = rankCandidates(list, TODAY)
    const r2 = rankCandidates(list, TODAY)
    expect(r1).toEqual(r2)
    expect(r1).not.toBe(list)
    expect(JSON.stringify(list)).toBe(before)
  })
})
