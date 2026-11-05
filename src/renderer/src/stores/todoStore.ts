import { create } from 'zustand'
import type { Todo, TodoTag, TodoInput, TodoTagInput, TodoHistory } from '../types'
import type { FetchOptions } from './projectStore'

interface TodoStore {
  todos: Todo[]
  completedTodos: Todo[]
  tags: TodoTag[]
  activeTodos: Todo[]
  loading: boolean
  showCompleted: boolean
  filterTagId: number | null
  editingTodo: Todo | null
  showTagManager: boolean
  selectedTodoId: number | null

  setShowCompleted: (show: boolean) => void
  setFilterTagId: (tagId: number | null) => void
  setEditingTodo: (todo: Todo | null) => void
  setShowTagManager: (show: boolean) => void
  setSelectedTodoId: (id: number | null) => void

  fetchTodos: (opts?: FetchOptions) => Promise<void>
  fetchCompletedTodos: () => Promise<void>
  fetchActiveTodos: (opts?: FetchOptions) => Promise<void>
  createTodo: (input: TodoInput) => Promise<void>
  updateTodo: (id: number, input: Partial<TodoInput>) => Promise<void>
  completeTodo: (id: number) => Promise<void>
  setCompletedAt: (id: number, completedAt: string) => Promise<void>
  restoreTodo: (id: number) => Promise<void>
  deleteTodo: (id: number) => Promise<void>
  getTodoHistory: (todoId: number) => Promise<TodoHistory[]>

  fetchTags: () => Promise<void>
  createTag: (input: TodoTagInput) => Promise<void>
  updateTag: (id: number, input: Partial<TodoTagInput>) => Promise<void>
  deleteTag: (id: number) => Promise<void>
}

export const useTodoStore = create<TodoStore>((set, get) => ({
  todos: [],
  completedTodos: [],
  tags: [],
  activeTodos: [],
  loading: false,
  showCompleted: false,
  filterTagId: null,
  editingTodo: null,
  showTagManager: false,
  selectedTodoId: null,

  setShowCompleted: (show) => set({ showCompleted: show }),
  setFilterTagId: (tagId) => set({ filterTagId: tagId }),
  setEditingTodo: (todo) => set({ editingTodo: todo }),
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

  createTodo: async (input) => {
    await window.api.todo.create(input)
    await get().fetchTodos()
    await get().fetchActiveTodos()
  },

  updateTodo: async (id, input) => {
    await window.api.todo.update(id, input)
    await get().fetchTodos()
    await get().fetchActiveTodos()
    set({ editingTodo: null })
  },

  completeTodo: async (id) => {
    await window.api.todo.complete(id)
    await get().fetchTodos()
    await get().fetchCompletedTodos()
    await get().fetchActiveTodos()
  },

  setCompletedAt: async (id, completedAt) => {
    await window.api.todo.setCompletedAt(id, completedAt)
    await get().fetchCompletedTodos()
    await get().fetchActiveTodos()
  },

  restoreTodo: async (id) => {
    await window.api.todo.restore(id)
    await get().fetchTodos()
    await get().fetchCompletedTodos()
    await get().fetchActiveTodos()
  },

  deleteTodo: async (id) => {
    await window.api.todo.delete(id)
    await get().fetchTodos()
    await get().fetchCompletedTodos()
    await get().fetchActiveTodos()
  },

  getTodoHistory: async (todoId) => {
    return await window.api.todo.history(todoId)
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
