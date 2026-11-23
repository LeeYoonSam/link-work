import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Todo } from '../types'

const todo = (id: number, over: Partial<Todo> = {}): Todo => ({
  id,
  title: `할 일 ${id}`,
  priority: 'medium',
  due_date: null,
  due_reminder: 0,
  is_completed: 0,
  completed_at: null,
  notes: null,
  source_link: null,
  created_at: '2026-11-01 09:00:00',
  updated_at: '2026-11-01 09:00:00',
  tags: [],
  ...over
})

let open: Todo[] = []
let done: Todo[] = []
const api = {
  todo: {
    create: vi.fn(async () => ({ id: 42 })),
    list: vi.fn(async (completed?: boolean) => (completed ? done : open)),
    listByTag: vi.fn(async () => []),
    update: vi.fn(async () => open[0]),
    complete: vi.fn(async () => ({ success: true })),
    setCompletedAt: vi.fn(async () => ({ success: true })),
    restore: vi.fn(async () => ({ success: true })),
    delete: vi.fn(async () => ({ success: true })),
    listActive: vi.fn(async () => open)
  },
  todoTag: {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: 1 })),
    update: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({ success: true }))
  }
}

// 비동기 사슬(토스트 콜백 → 스토어 → 재조회)을 끝까지 흘린다
const flush = async (): Promise<void> => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

async function load() {
  vi.resetModules()
  vi.stubGlobal('window', { api })
  const { useTodoStore } = await import('./todoStore')
  const toast = await import('../components/ui/toastStore')
  return { useTodoStore, toast }
}

beforeEach(() => {
  open = [todo(1), todo(2)]
  done = [todo(3, { is_completed: 1, completed_at: '2026-11-20 09:00:00' })]
  for (const group of [api.todo, api.todoTag]) for (const fn of Object.values(group)) fn.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('todoStore 호환', () => {
  it('기존 필드·메서드 이름을 유지하고 그 밖의 키(옛 편집 모달 상태 등)는 없다', async () => {
    const { useTodoStore } = await load()
    const s = useTodoStore.getState()
    const fields = ['todos', 'completedTodos', 'activeTodos', 'tags', 'loading', 'showCompleted', 'filterTagId', 'selectedTodoId', 'showTagManager', 'pendingDeleteIds']
    for (const k of fields) expect(k in s).toBe(true)
    const methods = [
      'fetchTodos',
      'fetchCompletedTodos',
      'fetchActiveTodos',
      'createTodo',
      'updateTodo',
      'completeTodo',
      'setCompletedAt',
      'restoreTodo',
      'deleteTodo',
      'fetchTags',
      'createTag',
      'updateTag',
      'deleteTag',
      'setShowCompleted',
      'setFilterTagId',
      'setShowTagManager',
      'setSelectedTodoId',
      'requestDelete',
      'completeWithUndo',
      'rescheduleWithUndo'
    ]
    for (const k of methods) expect(typeof (s as unknown as Record<string, unknown>)[k]).toBe('function')
    // 키 목록이 정확히 이것뿐이다. 지운 편집 모달 상태가 되살아나면 실패한다
    expect(Object.keys(s).sort()).toEqual([...fields, ...methods].sort())
    expect(s.pendingDeleteIds).toEqual([])
  })
})

describe('todoStore 쓰기는 loading 을 켜지 않는다(silent 재조회)', () => {
  it('create 는 새 id 를 돌려주고 목록·활성 목록을 다시 읽는다', async () => {
    const { useTodoStore } = await load()
    let sawLoading = false
    const unsub = useTodoStore.subscribe((s) => {
      if (s.loading) sawLoading = true
    })
    const id = await useTodoStore.getState().createTodo({ title: '새 할 일' })
    expect(id).toBe(42)
    expect(api.todo.create).toHaveBeenCalledWith({ title: '새 할 일' })
    expect(api.todo.list).toHaveBeenCalledWith(false)
    expect(api.todo.listActive).toHaveBeenCalled()
    expect(sawLoading).toBe(false)
    unsub()
  })

  it('update/complete/restore/delete/setCompletedAt 도 loading 을 켜지 않는다', async () => {
    const { useTodoStore } = await load()
    let sawLoading = false
    const unsub = useTodoStore.subscribe((s) => {
      if (s.loading) sawLoading = true
    })
    const s = useTodoStore.getState()
    await s.updateTodo(1, { title: '고침' })
    await s.completeTodo(1)
    await s.restoreTodo(1)
    await s.deleteTodo(2)
    await s.setCompletedAt(3, '2026-11-19 10:00')
    expect(api.todo.update).toHaveBeenCalledWith(1, { title: '고침' })
    expect(api.todo.complete).toHaveBeenCalledWith(1)
    expect(api.todo.restore).toHaveBeenCalledWith(1)
    expect(api.todo.delete).toHaveBeenCalledWith(2)
    expect(api.todo.setCompletedAt).toHaveBeenCalledWith(3, '2026-11-19 10:00')
    expect(sawLoading).toBe(false)
    unsub()
  })

  it('완료 항목을 update 하면 완료 목록도 다시 읽는다(todo:update 는 변경 알림이 없다)', async () => {
    const { useTodoStore } = await load()
    expect(useTodoStore.getState().showCompleted).toBe(false)
    await useTodoStore.getState().updateTodo(3, { title: '완료 항목 고침' })
    expect(api.todo.update).toHaveBeenCalledWith(3, { title: '완료 항목 고침' })
    expect(api.todo.list).toHaveBeenCalledWith(true)
    expect(useTodoStore.getState().completedTodos.map((t) => t.id)).toEqual([3])
  })

  it('완료 목록은 showCompleted 와 무관하게 complete/restore/delete 뒤 다시 읽는다', async () => {
    const { useTodoStore } = await load()
    expect(useTodoStore.getState().showCompleted).toBe(false)
    await useTodoStore.getState().completeTodo(1)
    expect(api.todo.list).toHaveBeenCalledWith(true)
    expect(useTodoStore.getState().completedTodos.map((t) => t.id)).toEqual([3])
  })
})

describe('requestDelete (실행 취소 토스트)', () => {
  it('토스트가 만료되기 전에는 지우지 않고 목록에서만 숨긴다. 만료되면 지운다', async () => {
    const { useTodoStore, toast } = await load()
    useTodoStore.getState().requestDelete(open[0])
    expect(useTodoStore.getState().pendingDeleteIds).toEqual([1])
    expect(toast.useToastStore.getState().toasts.map((t) => t.message)).toEqual(['삭제했어요'])
    vi.advanceTimersByTime(4999)
    await flush()
    expect(api.todo.delete).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await flush()
    expect(api.todo.delete).toHaveBeenCalledWith(1)
    expect(useTodoStore.getState().pendingDeleteIds).toEqual([])
  })

  it('실행 취소하면 지우지 않고 숨김만 푼다', async () => {
    const { useTodoStore, toast } = await load()
    useTodoStore.getState().requestDelete(open[0])
    const t = toast.useToastStore.getState().toasts[0]
    expect(t.actionLabel).toBe('실행 취소')
    toast.dismissToast(t.id, 'action')
    await flush()
    expect(useTodoStore.getState().pendingDeleteIds).toEqual([])
    vi.advanceTimersByTime(10_000)
    await flush()
    expect(api.todo.delete).not.toHaveBeenCalled()
  })

  it('flushToasts 가 보류 중인 삭제를 확정한다', async () => {
    const { useTodoStore, toast } = await load()
    useTodoStore.getState().requestDelete(open[1])
    toast.flushToasts()
    await flush()
    expect(api.todo.delete).toHaveBeenCalledWith(2)
    expect(useTodoStore.getState().pendingDeleteIds).toEqual([])
  })

  it('새 삭제 요청이 오면 앞선 것은 즉시 확정한다', async () => {
    const { useTodoStore } = await load()
    useTodoStore.getState().requestDelete(open[0])
    useTodoStore.getState().requestDelete(open[1])
    await flush()
    expect(api.todo.delete).toHaveBeenCalledTimes(1)
    expect(api.todo.delete).toHaveBeenCalledWith(1)
    expect(useTodoStore.getState().pendingDeleteIds).toEqual([2])
  })
})

describe('completeWithUndo', () => {
  it('바로 완료하고 실행 취소하면 restore 를 부른다', async () => {
    const { useTodoStore, toast } = await load()
    await useTodoStore.getState().completeWithUndo(open[0])
    expect(api.todo.complete).toHaveBeenCalledWith(1)
    const t = toast.useToastStore.getState().toasts[0]
    expect(t.message).toBe('완료했어요')
    toast.dismissToast(t.id, 'action')
    await flush()
    expect(api.todo.restore).toHaveBeenCalledWith(1)
  })

  it('만료되면 restore 를 부르지 않는다', async () => {
    const { useTodoStore } = await load()
    await useTodoStore.getState().completeWithUndo(open[0])
    vi.advanceTimersByTime(5000)
    await flush()
    expect(api.todo.restore).not.toHaveBeenCalled()
  })
})

describe('rescheduleWithUndo', () => {
  it('시각을 유지해 순차로 옮기고, 재조회는 끝에 1회, 실행 취소는 이전 마감으로 되돌린다', async () => {
    const { useTodoStore, toast } = await load()
    const items = [
      todo(1, { due_date: '2026-11-18 14:30', due_reminder: 1 }),
      todo(2, { due_date: '2026-11-17', due_reminder: 0 })
    ]
    await useTodoStore.getState().rescheduleWithUndo(items, '2026-11-20')
    expect(api.todo.update.mock.calls).toEqual([
      [1, { due_date: '2026-11-20 14:30', due_reminder: 1 }],
      [2, { due_date: '2026-11-20', due_reminder: 0 }]
    ])
    expect(api.todo.list).toHaveBeenCalledTimes(1)
    expect(api.todo.list).toHaveBeenCalledWith(false)

    api.todo.update.mockClear()
    const t = toast.useToastStore.getState().toasts[0]
    expect(t.actionLabel).toBe('실행 취소')
    toast.dismissToast(t.id, 'action')
    await flush()
    expect(api.todo.update.mock.calls).toEqual([
      [1, { due_date: '2026-11-18 14:30', due_reminder: 1 }],
      [2, { due_date: '2026-11-17', due_reminder: 0 }]
    ])
  })

  it('빈 목록이면 아무것도 하지 않는다', async () => {
    const { useTodoStore, toast } = await load()
    await useTodoStore.getState().rescheduleWithUndo([], '2026-11-20')
    expect(api.todo.update).not.toHaveBeenCalled()
    expect(toast.useToastStore.getState().toasts).toEqual([])
  })
})
