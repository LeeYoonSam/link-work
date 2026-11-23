import { create } from 'zustand'
import type { Todo, TodoTag, TodoInput, TodoTagInput } from '../types'
import { dismissToast, showToast } from '../components/ui/toastStore'
import { shiftDueDate } from '../components/todo/todoModel'

// 배경 갱신 옵션. silent 이면 loading 을 켜지 않는다.
// 이유: 스피너가 뜨면 목록 화면이 편집 상태를 잃는다
interface FetchOptions {
  silent?: boolean
}

interface TodoStore {
  todos: Todo[]
  completedTodos: Todo[]
  tags: TodoTag[]
  activeTodos: Todo[]
  loading: boolean
  showCompleted: boolean
  filterTagId: number | null
  showTagManager: boolean
  selectedTodoId: number | null

  setShowCompleted: (show: boolean) => void
  setFilterTagId: (tagId: number | null) => void
  setShowTagManager: (show: boolean) => void
  setSelectedTodoId: (id: number | null) => void

  fetchTodos: (opts?: FetchOptions) => Promise<void>
  fetchCompletedTodos: () => Promise<void>
  fetchActiveTodos: (opts?: FetchOptions) => Promise<void>
  /** 새 할 일의 id 를 돌려준다 */
  createTodo: (input: TodoInput) => Promise<number>
  updateTodo: (id: number, input: Partial<TodoInput>) => Promise<void>
  completeTodo: (id: number) => Promise<void>
  setCompletedAt: (id: number, completedAt: string) => Promise<void>
  restoreTodo: (id: number) => Promise<void>
  deleteTodo: (id: number) => Promise<void>

  /** 삭제 보류 중이라 목록에서 숨기는 id */
  pendingDeleteIds: number[]
  /** 목록에서 숨기고 '삭제했어요' 토스트를 띄운다. 토스트가 만료되면 실제로 지우고, 실행 취소하면 숨김만 푼다 */
  requestDelete: (todo: Todo) => void
  /** 바로 완료하고 실행 취소(복원) 토스트를 띄운다 */
  completeWithUndo: (todo: Todo) => Promise<void>
  /** 마감 날짜를 옮기고(시각 유지) 실행 취소(이전 마감 복원) 토스트를 띄운다. targetDate null 이면 마감을 지운다 */
  rescheduleWithUndo: (items: Todo[], targetDate: string | null) => Promise<void>

  fetchTags: () => Promise<void>
  createTag: (input: TodoTagInput) => Promise<void>
  updateTag: (id: number, input: Partial<TodoTagInput>) => Promise<void>
  deleteTag: (id: number) => Promise<void>
}

// 지금 떠 있는 삭제 토스트. 새 삭제 요청이 오면 이것을 먼저 확정한다
let pendingDeleteToastId: number | null = null

export const useTodoStore = create<TodoStore>((set, get) => ({
  todos: [],
  completedTodos: [],
  tags: [],
  activeTodos: [],
  loading: false,
  showCompleted: false,
  filterTagId: null,
  showTagManager: false,
  selectedTodoId: null,

  setShowCompleted: (show) => set({ showCompleted: show }),
  setFilterTagId: (tagId) => set({ filterTagId: tagId }),
  setShowTagManager: (show) => set({ showTagManager: show }),
  setSelectedTodoId: (id) => set({ selectedTodoId: id }),

  fetchTodos: async (opts?) => {
    // silent 이면 loading 을 켜지 않는다. 이유: 배경 갱신이 편집 중인 목록을 지우면 안 된다
    const silent = opts?.silent === true
    if (!silent) set({ loading: true })
    const { filterTagId } = get()
    try {
      const todos = filterTagId
        ? await window.api.todo.listByTag(filterTagId, false)
        : await window.api.todo.list(false)
      set(silent ? { todos } : { todos, loading: false })
    } catch (e) {
      if (!silent) set({ loading: false })
      throw e
    }
  },

  fetchCompletedTodos: async () => {
    const { filterTagId } = get()
    const completedTodos = filterTagId
      ? await window.api.todo.listByTag(filterTagId, true)
      : await window.api.todo.list(true)
    set({ completedTodos })
  },

  // 이 조회는 loading 을 켜지 않는다. 그래서 silent 옵션을 볼 필요가 없다
  fetchActiveTodos: async () => {
    const activeTodos = await window.api.todo.listActive()
    set({ activeTodos })
  },

  // 쓰기 뒤 재조회는 silent 다. 이유: 스피너가 뜨면 목록 화면이 펼친 행·입력 상태를 잃는다
  createTodo: async (input) => {
    const { id } = await window.api.todo.create(input)
    await get().fetchTodos({ silent: true })
    await get().fetchActiveTodos()
    return id
  },

  // 완료 항목도 펼쳐 고칠 수 있고 todo:update 는 변경 알림을 보내지 않는다. 그래서 완료 목록도 다시 읽는다
  updateTodo: async (id, input) => {
    await window.api.todo.update(id, input)
    await get().fetchTodos({ silent: true })
    await get().fetchCompletedTodos()
    await get().fetchActiveTodos()
  },

  // 완료 목록은 showCompleted 와 무관하게 다시 읽는다. 완료 뷰·오늘 대시보드가 바로 맞아야 한다
  completeTodo: async (id) => {
    await window.api.todo.complete(id)
    await get().fetchTodos({ silent: true })
    await get().fetchCompletedTodos()
    await get().fetchActiveTodos()
  },

  setCompletedAt: async (id, completedAt) => {
    await window.api.todo.setCompletedAt(id, completedAt)
    await get().fetchTodos({ silent: true })
    await get().fetchCompletedTodos()
    await get().fetchActiveTodos()
  },

  restoreTodo: async (id) => {
    await window.api.todo.restore(id)
    await get().fetchTodos({ silent: true })
    await get().fetchCompletedTodos()
    await get().fetchActiveTodos()
  },

  deleteTodo: async (id) => {
    await window.api.todo.delete(id)
    await get().fetchTodos({ silent: true })
    await get().fetchCompletedTodos()
    await get().fetchActiveTodos()
  },

  pendingDeleteIds: [],

  requestDelete: (todo) => {
    // 새 삭제 요청이 오면 앞선 보류 삭제는 즉시 확정한다(만료 처리 → onExpire)
    if (pendingDeleteToastId !== null) dismissToast(pendingDeleteToastId, 'expire')
    const unhide = (): void =>
      set((s) => ({ pendingDeleteIds: s.pendingDeleteIds.filter((x) => x !== todo.id) }))
    set((s) => ({
      pendingDeleteIds: s.pendingDeleteIds.includes(todo.id) ? s.pendingDeleteIds : [...s.pendingDeleteIds, todo.id]
    }))
    const toastId = showToast({
      message: '삭제했어요',
      actionLabel: '실행 취소',
      onAction: () => {
        if (pendingDeleteToastId === toastId) pendingDeleteToastId = null
        unhide()
      },
      onExpire: async () => {
        if (pendingDeleteToastId === toastId) pendingDeleteToastId = null
        try {
          await get().deleteTodo(todo.id)
        } catch {
          showToast({ message: '할 일을 삭제하지 못했어요.' })
        } finally {
          // 재조회가 끝난 뒤 숨김을 푼다. 먼저 풀면 지운 행이 잠깐 다시 보인다
          unhide()
        }
      }
    })
    pendingDeleteToastId = toastId
  },

  completeWithUndo: async (todo) => {
    await get().completeTodo(todo.id)
    showToast({
      message: '완료했어요',
      actionLabel: '실행 취소',
      onAction: () => get().restoreTodo(todo.id)
    })
  },

  rescheduleWithUndo: async (items, targetDate) => {
    if (items.length === 0) return
    const before = items.map((t) => ({ id: t.id, due_date: t.due_date, due_reminder: t.due_reminder }))
    try {
      for (const t of items) await window.api.todo.update(t.id, shiftDueDate(t.due_date, targetDate))
    } finally {
      // 중간에 실패해도 바뀐 만큼은 화면에 반영한다
      await get().fetchTodos({ silent: true })
      await get().fetchActiveTodos()
    }
    showToast({
      message: targetDate ? `${items.length}개 항목의 날짜를 옮겼어요` : `${items.length}개 항목의 날짜를 지웠어요`,
      actionLabel: '실행 취소',
      onAction: async () => {
        try {
          for (const b of before) {
            await window.api.todo.update(b.id, { due_date: b.due_date, due_reminder: b.due_reminder })
          }
        } finally {
          await get().fetchTodos({ silent: true })
          await get().fetchActiveTodos()
        }
      }
    })
  },

  fetchTags: async () => {
    const tags = await window.api.todoTag.list()
    set({ tags })
  },

  createTag: async (input) => {
    await window.api.todoTag.create(input)
    await get().fetchTags()
  },

  updateTag: async (id, input) => {
    await window.api.todoTag.update(id, input)
    await get().fetchTags()
  },

  deleteTag: async (id) => {
    await window.api.todoTag.delete(id)
    await get().fetchTags()
    set({ filterTagId: null })
  }
}))
