import type { Task } from '../types'

// 상위 작업과 그에 속한 하위 작업들을 묶은 트리 노드.
// 깊이는 1단계만 — children의 원소는 다시 children을 갖지 않는다.
export interface TaskTreeNode {
  task: Task
  children: Task[]
}

// sort_order 오름차순 정렬. 동률이면 id로 안정적으로 정렬한다.
function bySortOrder(a: Task, b: Task): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
  return a.id - b.id
}

// 평면 목록을 최상위→하위 트리로 변환한다.
// - 최상위(parent_task_id=null)는 sort_order 순.
// - 각 상위의 children은 sort_order 순으로 상위 바로 아래 배치.
// - 고아(parent_task_id가 목록에 없는 하위)는 최상위로 취급해 유실 없이 표시.
export function buildTaskTree(tasks: Task[]): TaskTreeNode[] {
  const idSet = new Set(tasks.map((t) => t.id))
  // 최상위로 취급할 작업: parent가 없거나, parent가 목록에 없는 고아
  const isRoot = (t: Task): boolean =>
    t.parent_task_id == null || !idSet.has(t.parent_task_id)

  const childrenByParent = new Map<number, Task[]>()
  for (const t of tasks) {
    if (isRoot(t)) continue
    const list = childrenByParent.get(t.parent_task_id as number) ?? []
    list.push(t)
    childrenByParent.set(t.parent_task_id as number, list)
  }

  return tasks
    .filter(isRoot)
    .sort(bySortOrder)
    .map((task) => ({
      task,
      children: (childrenByParent.get(task.id) ?? []).slice().sort(bySortOrder)
    }))
}

// leaf(하위가 없는 작업)만 진행률 분모/분자로 집계한다.
// 하위를 가진 상위는 롤업 대상에서 제외 — 하위들이 실제 진행 단위이기 때문.
export function countLeafProgress(tasks: Task[]): { done: number; total: number } {
  const parentIds = new Set<number>()
  for (const t of tasks) {
    if (t.parent_task_id != null) parentIds.add(t.parent_task_id)
  }
  // 실제 하위를 가진 id만 상위로 인정(고아의 유령 부모는 무시)
  const hasChildren = (t: Task): boolean => parentIds.has(t.id)

  let done = 0
  let total = 0
  for (const t of tasks) {
    if (hasChildren(t)) continue
    total++
    if (t.status === 'done') done++
  }
  return { done, total }
}
