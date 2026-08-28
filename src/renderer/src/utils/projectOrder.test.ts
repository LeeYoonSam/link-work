import { describe, expect, it } from 'vitest'
import {
  ACTIVE_STATUSES,
  compareProjects,
  priorityRankOf,
  PRIORITY_RANK,
  STATUS_RANK,
  type OrderableProject
} from './projectOrder'

function project(p: Partial<OrderableProject> & { name?: string }): OrderableProject & {
  name: string
} {
  return {
    name: p.name ?? 'p',
    priority: p.priority ?? null,
    sort_order: p.sort_order ?? 0,
    status: p.status ?? 'development',
    created_at: p.created_at ?? '2026-01-01 00:00:00'
  }
}

function orderedNames(list: ReturnType<typeof project>[]): string[] {
  return [...list].sort(compareProjects).map((p) => p.name)
}

describe('priorityRankOf', () => {
  it('지정된 레벨은 now < next < later 순으로 매긴다', () => {
    expect(priorityRankOf(project({ priority: 'now' }))).toBe(PRIORITY_RANK.now)
    expect(priorityRankOf(project({ priority: 'next' }))).toBe(PRIORITY_RANK.next)
    expect(priorityRankOf(project({ priority: 'later' }))).toBe(PRIORITY_RANK.later)
    expect(PRIORITY_RANK.now).toBeLessThan(PRIORITY_RANK.next)
    expect(PRIORITY_RANK.next).toBeLessThan(PRIORITY_RANK.later)
  })

  it('null과 undefined는 지정된 어떤 레벨보다 뒤로 간다', () => {
    expect(priorityRankOf(project({ priority: null }))).toBe(3)
    expect(priorityRankOf({ status: 'development', created_at: '2026-01-01' })).toBe(3)
    expect(priorityRankOf(project({ priority: null }))).toBeGreaterThan(PRIORITY_RANK.later)
  })
})

describe('compareProjects', () => {
  it('우선순위 그룹이 상태보다 먼저다 — later여도 미지정 개발중보다 앞선다', () => {
    const list = [
      project({ name: '미지정-개발중', priority: null, status: 'development' }),
      project({ name: 'later-예정', priority: 'later', status: 'scheduled' }),
      project({ name: 'now-예정', priority: 'now', status: 'scheduled' }),
      project({ name: 'next-배포', priority: 'next', status: 'deploy' })
    ]
    expect(orderedNames(list)).toEqual(['now-예정', 'next-배포', 'later-예정', '미지정-개발중'])
  })

  it('같은 레벨 안에서는 sort_order가 상태보다 우선한다', () => {
    const list = [
      project({ name: 'b', priority: 'now', sort_order: 2, status: 'development' }),
      project({ name: 'a', priority: 'now', sort_order: 0, status: 'cancelled' }),
      project({ name: 'c', priority: 'now', sort_order: 1, status: 'qa' })
    ]
    expect(orderedNames(list)).toEqual(['a', 'c', 'b'])
  })

  it('우선순위 미지정 그룹은 sort_order를 무시하고 상태 순으로 정렬한다', () => {
    const list = [
      project({ name: '취소', priority: null, sort_order: 0, status: 'cancelled' }),
      project({ name: '개발', priority: null, sort_order: 99, status: 'development' }),
      project({ name: 'QA', priority: null, sort_order: 50, status: 'qa' })
    ]
    expect(orderedNames(list)).toEqual(['개발', 'QA', '취소'])
  })

  it('상태 순위는 development → qa → qa_pending → deploy_pending → deploy → scheduled → on_hold → completed → cancelled', () => {
    const statuses = [
      'development',
      'qa',
      'qa_pending',
      'deploy_pending',
      'deploy',
      'scheduled',
      'on_hold',
      'completed',
      'cancelled'
    ]
    const shuffled = [...statuses].reverse().map((s) => project({ name: s, status: s }))
    expect(orderedNames(shuffled)).toEqual(statuses)
  })

  it('모르는 상태는 알려진 상태 뒤로 밀린다', () => {
    const list = [
      project({ name: '알수없음', status: 'archived_someday' }),
      project({ name: '취소', status: 'cancelled' })
    ]
    expect(orderedNames(list)).toEqual(['취소', '알수없음'])
  })

  it('sort_order와 상태가 같으면 최근 생성 순(created_at desc)으로 나눈다', () => {
    const list = [
      project({ name: '오래됨', status: 'qa', created_at: '2026-01-01 00:00:00' }),
      project({ name: '최근', status: 'qa', created_at: '2026-06-01 00:00:00' }),
      project({ name: '중간', status: 'qa', created_at: '2026-03-01 00:00:00' })
    ]
    expect(orderedNames(list)).toEqual(['최근', '중간', '오래됨'])
  })

  it('sort_order·priority가 빠진 구버전 행도 상태 순으로 처리한다', () => {
    const list: (OrderableProject & { name: string })[] = [
      { name: '예정', status: 'scheduled', created_at: '2026-01-01' },
      { name: '개발', status: 'development', created_at: '2026-01-01' }
    ]
    expect([...list].sort(compareProjects).map((p) => p.name)).toEqual(['개발', '예정'])
  })
})

describe('on_hold (중단)', () => {
  it('진행 중인 상태 뒤, completed·cancelled 앞에 놓인다', () => {
    expect(STATUS_RANK.on_hold).toBeGreaterThan(STATUS_RANK.scheduled)
    expect(STATUS_RANK.on_hold).toBeLessThan(STATUS_RANK.completed)
    expect(STATUS_RANK.on_hold).toBeLessThan(STATUS_RANK.cancelled)
  })

  it('가장 늦은 액티브 상태보다 뒤로 정렬된다', () => {
    const list = [
      project({ name: '중단', status: 'on_hold' }),
      project({ name: '완료', status: 'completed' }),
      project({ name: '예정', status: 'scheduled' })
    ]
    expect(orderedNames(list)).toEqual(['예정', '중단', '완료'])
  })

  it('우선순위가 붙어 있으면 중단이어도 그 그룹 안에 남는다', () => {
    // 중단해도 우선순위 자체는 지워지지 않는다 — 상태는 그룹 안에서만 순서를 가른다.
    const list = [
      project({ name: 'now-중단', priority: 'now', status: 'on_hold' }),
      project({ name: '미지정-개발', priority: null, status: 'development' })
    ]
    expect(orderedNames(list)).toEqual(['now-중단', '미지정-개발'])
  })
})

describe('ACTIVE_STATUSES', () => {
  it('완료·취소·중단을 뺀 나머지 상태를 모두 담는다', () => {
    expect([...ACTIVE_STATUSES].sort()).toEqual(
      Object.keys(STATUS_RANK)
        .filter((s) => s !== 'completed' && s !== 'cancelled' && s !== 'on_hold')
        .sort()
    )
  })

  it('on_hold를 포함하지 않는다 — 중단 프로젝트는 대시보드·트레이에서 빠진다', () => {
    expect([...ACTIVE_STATUSES]).not.toContain('on_hold')
  })
})
