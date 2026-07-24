import { describe, it, expect } from 'vitest'
import { buildTaskTree, countLeafProgress } from './taskTree'
import type { Task } from '../types'

function task(overrides: Partial<Task>): Task {
  return {
    id: 1,
    project_id: 1,
    parent_task_id: null,
    name: 't',
    start_date: null,
    end_date: null,
    status: 'pending',
    sort_order: 0,
    created_at: '',
    ...overrides
  }
}

describe('buildTaskTree', () => {
  it('빈 목록은 빈 트리', () => {
    expect(buildTaskTree([])).toEqual([])
  })

  it('평면 목록(하위 없음)은 sort_order 순 최상위로', () => {
    const tasks = [
      task({ id: 1, sort_order: 2, name: 'b' }),
      task({ id: 2, sort_order: 1, name: 'a' }),
      task({ id: 3, sort_order: 3, name: 'c' })
    ]
    const tree = buildTaskTree(tasks)
    expect(tree.map((n) => n.task.name)).toEqual(['a', 'b', 'c'])
    expect(tree.every((n) => n.children.length === 0)).toBe(true)
  })

  it('계층: 상위 아래 하위를 sort_order 순으로 배치', () => {
    const tasks = [
      task({ id: 10, sort_order: 1, name: 'parent' }),
      task({ id: 11, parent_task_id: 10, sort_order: 2, name: 'child-b' }),
      task({ id: 12, parent_task_id: 10, sort_order: 1, name: 'child-a' })
    ]
    const tree = buildTaskTree(tasks)
    expect(tree).toHaveLength(1)
    expect(tree[0].task.name).toBe('parent')
    expect(tree[0].children.map((c) => c.name)).toEqual(['child-a', 'child-b'])
  })

  it('여러 상위와 하위가 각 상위 아래로 그룹화된다', () => {
    const tasks = [
      task({ id: 1, sort_order: 1, name: 'P1' }),
      task({ id: 2, sort_order: 2, name: 'P2' }),
      task({ id: 3, parent_task_id: 2, sort_order: 1, name: 'P2-c1' }),
      task({ id: 4, parent_task_id: 1, sort_order: 1, name: 'P1-c1' })
    ]
    const tree = buildTaskTree(tasks)
    expect(tree.map((n) => n.task.name)).toEqual(['P1', 'P2'])
    expect(tree[0].children.map((c) => c.name)).toEqual(['P1-c1'])
    expect(tree[1].children.map((c) => c.name)).toEqual(['P2-c1'])
  })

  it('고아(부모 id가 목록에 없음)는 최상위로 취급해 유실되지 않는다', () => {
    const tasks = [
      task({ id: 1, sort_order: 1, name: 'root' }),
      task({ id: 2, parent_task_id: 999, sort_order: 2, name: 'orphan' })
    ]
    const tree = buildTaskTree(tasks)
    expect(tree.map((n) => n.task.name)).toEqual(['root', 'orphan'])
    expect(tree.find((n) => n.task.name === 'orphan')?.children).toEqual([])
  })
})

describe('countLeafProgress', () => {
  it('빈 목록은 0/0', () => {
    expect(countLeafProgress([])).toEqual({ done: 0, total: 0 })
  })

  it('평면 목록은 전부 leaf로 집계', () => {
    const tasks = [
      task({ id: 1, status: 'done' }),
      task({ id: 2, status: 'in_progress' }),
      task({ id: 3, status: 'done' })
    ]
    expect(countLeafProgress(tasks)).toEqual({ done: 2, total: 3 })
  })

  it('하위를 가진 상위는 집계에서 제외하고 leaf만 센다', () => {
    const tasks = [
      // 상위(done 이지만 하위 보유 → 제외)
      task({ id: 1, status: 'done', name: 'parent' }),
      task({ id: 2, parent_task_id: 1, status: 'done', name: 'c1' }),
      task({ id: 3, parent_task_id: 1, status: 'pending', name: 'c2' }),
      // 하위 없는 최상위 leaf
      task({ id: 4, status: 'done', name: 'solo' })
    ]
    // leaf: c1(done), c2(pending), solo(done) → 2/3
    expect(countLeafProgress(tasks)).toEqual({ done: 2, total: 3 })
  })

  it('고아 하위는 leaf로 집계된다', () => {
    const tasks = [
      task({ id: 1, status: 'done' }),
      task({ id: 2, parent_task_id: 999, status: 'pending' })
    ]
    expect(countLeafProgress(tasks)).toEqual({ done: 1, total: 2 })
  })
})
