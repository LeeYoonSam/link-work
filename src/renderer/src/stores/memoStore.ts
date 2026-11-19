import { create } from 'zustand'
import type { Memo, MemoInput, MemoCategory, MemoCategoryInput } from '../types'
import {
  normalizeSortOrder,
  resolveFocusTarget,
  type CategoryKey,
  type MemoSortOrder,
  type RailKey
} from '../components/memo/memoSearch'
import {
  pushRecent,
  readJson,
  sanitizeIds,
  writeJson,
  type KeyValueStorage
} from '../components/memo/memoNav'

export type { MemoSortOrder, RailKey, CategoryKey }

// 메모 화면 상태를 기억하는 localStorage 키. DB 는 쓰지 않는다
export const MEMO_UI_STORAGE_KEY = 'linkwork.memo.ui'
export const MEMO_RECENT_STORAGE_KEY = 'linkwork.memo.recent'

interface StoredUi {
  rail?: unknown
  sortOrder?: unknown
  railCollapsed?: unknown
  selectedMemoId?: unknown
}

function getStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function sanitizeRail(v: unknown): RailKey {
  if (v === 'all' || v === 'important' || v === 'recent' || v === 'uncategorized' || v === 'archived') return v
  if (typeof v === 'number' && Number.isInteger(v)) return v
  return 'all'
}

function loadInitial(): {
  rail: RailKey
  sortOrder: MemoSortOrder
  railCollapsed: boolean
  selectedMemoId: number | null
  recentIds: number[]
} {
  const storage = getStorage()
  const ui = readJson<StoredUi>(storage, MEMO_UI_STORAGE_KEY, {})
  const safe = ui && typeof ui === 'object' ? ui : {}
  return {
    rail: sanitizeRail(safe.rail),
    sortOrder: normalizeSortOrder(safe.sortOrder),
    railCollapsed: safe.railCollapsed === true,
    selectedMemoId:
      typeof safe.selectedMemoId === 'number' && Number.isInteger(safe.selectedMemoId)
        ? safe.selectedMemoId
        : null,
    recentIds: sanitizeIds(readJson<unknown>(storage, MEMO_RECENT_STORAGE_KEY, []))
  }
}

interface MemoStore {
  memos: Memo[]
  archivedMemos: Memo[]
  importantMemos: Memo[]
  categories: MemoCategory[]

  // 탐색 상태
  rail: RailKey
  sortOrder: MemoSortOrder
  query: string
  // 검색 결과를 좁히는 분류 칩. null 이면 전체
  scope: CategoryKey | null
  // 0건일 때 '보관함에서도 찾기'를 누르면 true. 검색어를 지우면 false 로 돌아간다
  searchArchivedToo: boolean
  selectedMemoId: number | null
  recentIds: number[]
  railCollapsed: boolean

  setRail: (rail: RailKey) => void
  setSortOrder: (order: MemoSortOrder) => void
  setQuery: (query: string) => void
  setScope: (scope: CategoryKey | null) => void
  setSearchArchivedToo: (on: boolean) => void
  selectMemo: (id: number | null) => void
  recordRecent: (id: number) => void
  setRailCollapsed: (collapsed: boolean) => void
  // 앱 내 링크로 들어온 메모를 보이게 맞춘다: 레일(전체/보관함)·검색 해제·선택. 메모가 없으면 false
  revealMemo: (id: number) => boolean

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

export const useMemoStore = create<MemoStore>((set, get) => {
  const persistUi = (): void => {
    const { rail, sortOrder, railCollapsed, selectedMemoId } = get()
    writeJson(getStorage(), MEMO_UI_STORAGE_KEY, { rail, sortOrder, railCollapsed, selectedMemoId })
  }

  return {
    memos: [],
    archivedMemos: [],
    importantMemos: [],
    categories: [],

    ...loadInitial(),
    query: '',
    scope: null,
    searchArchivedToo: false,

    setRail: (rail) => {
      set({ rail, scope: null })
      persistUi()
    },
    setSortOrder: (order) => {
      set({ sortOrder: order })
      persistUi()
    },
    setQuery: (query) => {
      if (query.trim() === '') set({ query, scope: null, searchArchivedToo: false })
      else set({ query })
    },
    setScope: (scope) => set({ scope }),
    setSearchArchivedToo: (on) => set({ searchArchivedToo: on }),
    selectMemo: (id) => {
      if (get().selectedMemoId === id) return
      set({ selectedMemoId: id })
      persistUi()
    },
    recordRecent: (id) => {
      const recentIds = pushRecent(get().recentIds, id)
      set({ recentIds })
      writeJson(getStorage(), MEMO_RECENT_STORAGE_KEY, recentIds)
    },
    setRailCollapsed: (collapsed) => {
      set({ railCollapsed: collapsed })
      persistUi()
    },
    revealMemo: (id) => {
      const target = resolveFocusTarget(id, get().memos, get().archivedMemos)
      if (!target) return false
      set({
        rail: target.rail,
        query: '',
        scope: null,
        searchArchivedToo: false,
        selectedMemoId: target.memo.id
      })
      persistUi()
      return true
    },

    fetchMemos: async () => {
      const memos = await window.api.memo.list(false)
      set({ memos })
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
      await get().fetchImportantMemos()
    },

    archiveMemo: async (id) => {
      await window.api.memo.archive(id)
      await get().fetchMemos()
      await get().fetchArchivedMemos()
      await get().fetchImportantMemos()
    },

    restoreMemo: async (id) => {
      await window.api.memo.restore(id)
      await get().fetchMemos()
      await get().fetchArchivedMemos()
      await get().fetchImportantMemos()
    },

    toggleImportant: async (id) => {
      await window.api.memo.toggleImportant(id)
      await get().fetchMemos()
      await get().fetchImportantMemos()
    },

    deleteMemo: async (id) => {
      await window.api.memo.delete(id)
      if (get().selectedMemoId === id) {
        set({ selectedMemoId: null })
        persistUi()
      }
      if (get().recentIds.includes(id)) {
        const recentIds = get().recentIds.filter((x) => x !== id)
        set({ recentIds })
        writeJson(getStorage(), MEMO_RECENT_STORAGE_KEY, recentIds)
      }
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
      if (get().rail === id) {
        set({ rail: 'all' })
        persistUi()
      }
      if (get().scope === id) set({ scope: null })
      await get().fetchCategories()
      await get().fetchMemos()
      await get().fetchArchivedMemos()
    }
  }
})
