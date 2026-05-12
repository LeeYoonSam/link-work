import { create } from 'zustand'
import type { Memo, MemoInput } from '../types'

export type MemoSortOrder = 'newest' | 'oldest'

interface MemoStore {
  memos: Memo[]
  archivedMemos: Memo[]
  importantMemos: Memo[]
  loading: boolean
  showArchived: boolean
  sortOrder: MemoSortOrder

  setShowArchived: (show: boolean) => void
  setSortOrder: (order: MemoSortOrder) => void
  fetchMemos: () => Promise<void>
  fetchArchivedMemos: () => Promise<void>
  fetchImportantMemos: () => Promise<void>
  createMemo: (input: MemoInput) => Promise<void>
  updateMemo: (id: number, input: Partial<MemoInput>) => Promise<void>
  archiveMemo: (id: number) => Promise<void>
  restoreMemo: (id: number) => Promise<void>
  toggleImportant: (id: number) => Promise<void>
  deleteMemo: (id: number) => Promise<void>
}

export const useMemoStore = create<MemoStore>((set, get) => ({
  memos: [],
  archivedMemos: [],
  importantMemos: [],
  loading: false,
  showArchived: false,
  sortOrder: 'newest',

  setShowArchived: (show) => set({ showArchived: show }),
  setSortOrder: (order) => set({ sortOrder: order }),

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
  }
}))
