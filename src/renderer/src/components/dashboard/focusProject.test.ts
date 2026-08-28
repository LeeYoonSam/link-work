import { describe, it, expect } from 'vitest'
import { selectFocus, sortActiveProjects } from './focusProject'
import type { ProjectPriority } from '../../types'

// 대시보드가 "지금 할 일"로 무엇을 내세우는지의 규칙 검증.
// 화면은 후보를 나열하지 않으므로, 1등을 잘못 고르면 사용자는 틀린 일을 한다.

interface Fixture {
  name: string
  priority?: ProjectPriority | null
  sort_order?: number
  status: string
  created_at: string
}

const p = (name: string, status: string, priority: ProjectPriority | null, extra: Partial<Fixture> = {}): Fixture => ({
  name,
  status,
  priority,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  ...extra
})

describe('sortActiveProjects', () => {
  it('완료·취소 프로젝트를 빼고 우선순위 순으로 정렬한다', () => {
    const sorted = sortActiveProjects([
      p('완료된 것', 'completed', 'now'),
      p('취소된 것', 'cancelled', 'now'),
      p('나중', 'qa', 'later'),
      p('지금', 'scheduled', 'now'),
      p('다음', 'development', 'next')
    ])
    expect(sorted.map((x) => x.name)).toEqual(['지금', '다음', '나중'])
  })

  it('중단(on_hold)은 우선순위가 있어도 대시보드 목록에서 빠진다', () => {
    const sorted = sortActiveProjects([
      p('중단됨', 'on_hold', 'now'),
      p('중단됐지만 미지정', 'on_hold', null),
      p('진행 중', 'development', 'later')
    ])
    expect(sorted.map((x) => x.name)).toEqual(['진행 중'])
  })

  it('우선순위가 같으면 수동 순서(sort_order)를 따른다', () => {
    const sorted = sortActiveProjects([
      p('B', 'development', 'now', { sort_order: 1 }),
      p('A', 'qa', 'now', { sort_order: 0 })
    ])
    expect(sorted.map((x) => x.name)).toEqual(['A', 'B'])
  })
})

describe('selectFocus', () => {
  it('우선순위가 지정된 것 중 1등을 고르고 다음 2개만 뒤따르게 한다', () => {
    const { focus, upNext } = selectFocus([
      p('미지정', 'development', null),
      p('4순위', 'qa', 'later', { sort_order: 1 }),
      p('3순위', 'qa', 'later', { sort_order: 0 }),
      p('2순위', 'development', 'next'),
      p('1순위', 'scheduled', 'now')
    ])
    expect(focus?.name).toBe('1순위')
    expect(upNext.map((x) => x.name)).toEqual(['2순위', '3순위'])
  })

  it('상태가 앞서도 우선순위가 이긴다 — 개발 중이라고 1등이 되지 않는다', () => {
    const { focus } = selectFocus([
      p('개발 중이지만 나중', 'development', 'later'),
      p('예정이지만 지금', 'scheduled', 'now')
    ])
    expect(focus?.name).toBe('예정이지만 지금')
  })

  it('우선순위가 전부 미지정이면 아무것도 내세우지 않는다', () => {
    const { focus, upNext } = selectFocus([
      p('A', 'development', null),
      p('B', 'qa', null)
    ])
    expect(focus).toBeNull()
    expect(upNext).toEqual([])
  })

  it('진행 중 프로젝트가 없으면 focus는 null이다', () => {
    expect(selectFocus([]).focus).toBeNull()
  })

  it('개발 중인데 우선순위가 비어 있는 건수를 센다', () => {
    const { unprioritizedDevCount } = selectFocus([
      p('A', 'development', null),
      p('B', 'development', null),
      p('C', 'development', 'now'),
      // 개발 중이 아닌 미지정은 경고 대상이 아니다 — 우선순위 필수는 개발 중에만 걸린다
      p('D', 'scheduled', null)
    ])
    expect(unprioritizedDevCount).toBe(2)
  })

  it('진행 중이 아닌 상태는 애초에 입력에 없다 — 파이프라인 전체로 확인', () => {
    // selectFocus는 "진행 중 목록"을 받는 계약이라 상태를 스스로 거르지 않는다.
    // 대시보드가 실제로 쓰는 조합(sortActiveProjects → selectFocus)으로 검증한다.
    const { focus, upNext, unprioritizedDevCount } = selectFocus(
      sortActiveProjects([
        p('중단됨', 'on_hold', 'now'),
        p('완료됨', 'completed', 'now'),
        p('진행 중', 'development', 'later')
      ])
    )
    expect(focus?.name).toBe('진행 중')
    expect(upNext).toEqual([])
    expect(unprioritizedDevCount).toBe(0)
  })

  it('입력 배열을 변형하지 않는다', () => {
    const input = [p('B', 'qa', 'later'), p('A', 'development', 'now')]
    const before = input.map((x) => x.name)
    selectFocus(input)
    expect(input.map((x) => x.name)).toEqual(before)
  })
})
