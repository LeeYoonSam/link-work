import { create } from 'zustand'
import type { Memo, MemoInput, MemoCategory, MemoCategoryInput } from '../types'

export type MemoSortOrder = 'newest' | 'oldest'
export type MemoCategoryFilter = 'all' | 'uncategorized' | number

interface MemoStore {
  memos: Memo[]
  archivedMemos: Memo[]
  importantMemos: Memo[]
  categories: MemoCategory[]
  loading: boolean
  showArchived: boolean
  sortOrder: MemoSortOrder
  categoryFilter: MemoCategoryFilter

  setShowArchived: (show: boolean) => void
  setSortOrder: (order: MemoSortOrder) => void
  setCategoryFilter: (filter: MemoCategoryFilter) => void
  fetchMemos: () => Promise<void>
  fetchArchivedMemos: () => Promise<void>
  fetchImportantMemos: () => Promise<void>
  fetchCategories: () => Promise<void>
  createMemo: (input: MemoInput) => Promise<void>
  updateMemo: (id: number, input: Partial<MemoInput>) => Promise<void>
  archiveMemo: (id: number) => Promise<void>
  restoreMemo: (id: number) => Promise<void>
  toggleImportant: (id: number) => Promise<void>
  deleteMemo: (id: number) => Promise<void>
  createCategory: (input: MemoCategoryInput) => Promise<void>
  updateCategory: (id: number, input: Partial<MemoCategoryInput>) => Promise<void>
  deleteCategory: (id: number) => Promise<void>
}

export const useMemoStore = create<MemoStore>((set, get) => ({
  memos: [],
  archivedMemos: [],
  importantMemos: [],
  categories: [],
  loading: false,
  showArchived: false,
  sortOrder: 'newest',
  categoryFilter: 'all',

  setShowArchived: (show) => set({ showArchived: show }),
  setSortOrder: (order) => set({ sortOrder: order }),
  setCategoryFilter: (filter) => set({ categoryFilter: filter }),

  fetchMemos: async () => {
    set({ loading: true })
    const memos = await window.api.memo.list(false)
    set({ memos, loading: false })
  },

  fetchArchivedMemos: async () => {
    const archivedMemos = await window.api.memo.list(true)
    set({ archivedMemos })
  },

  fetchImportantMemos: async () => {
    const importantMemos = await window.api.memo.listImportant()
    set({ importantMemos })
  },

  fetchCategories: async () => {
    const categories = await window.api.memoCategory.list()
    set({ categories })
  },

  createMemo: async (input) => {
    await window.api.memo.create(input)
    await get().fetchMemos()
  },

  updateMemo: async (id, input) => {
    await window.api.memo.update(id, input)
    await get().fetchMemos()
  },

  archiveMemo: async (id) => {
    await window.api.memo.archive(id)
    await get().fetchMemos()
    await get().fetchArchivedMemos()
  },

  restoreMemo: async (id) => {
    await window.api.memo.restore(id)
    await get().fetchMemos()
    await get().fetchArchivedMemos()
  },

  toggleImportant: async (id) => {
    await window.api.memo.toggleImportant(id)
    await get().fetchMemos()
    await get().fetchImportantMemos()
  },

  deleteMemo: async (id) => {
    await window.api.memo.delete(id)
    await get().fetchArchivedMemos()
  },

  createCategory: async (input) => {
    await window.api.memoCategory.create(input)
    await get().fetchCategories()
  },

  updateCategory: async (id, input) => {
    await window.api.memoCategory.update(id, input)
    await get().fetchCategories()
    await get().fetchMemos()
    await get().fetchArchivedMemos()
  },

  deleteCategory: async (id) => {
    await window.api.memoCategory.delete(id)
    await get().fetchCategories()
    await get().fetchMemos()
    await get().fetchArchivedMemos()
  }
}))
