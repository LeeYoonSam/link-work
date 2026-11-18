import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Memo } from '../types'

const memo = (id: number, over: Partial<Memo> = {}): Memo => ({
  id,
  content: `# 메모 ${id}`,
  is_archived: 0,
  is_important: 0,
  color: 'default',
  category_id: null,
  created_at: '2026-11-01 00:00:00',
  updated_at: '2026-11-01 00:00:00',
  ...over
})

function memoryStorage(initial: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k)
  }
}

let active: Memo[] = []
let archived: Memo[] = []
const api = {
  memo: {
    list: vi.fn(async (isArchived?: boolean) => (isArchived ? archived : active)),
    listImportant: vi.fn(async () => active.filter((m) => m.is_important === 1)),
    delete: vi.fn(async () => ({ success: true })),
    archive: vi.fn(async () => ({ success: true })),
    restore: vi.fn(async () => ({ success: true })),
    update: vi.fn(async () => active[0]),
    create: vi.fn(async () => ({ id: 1 })),
    toggleImportant: vi.fn(async () => ({ success: true, is_important: 1 }))
  },
  memoCategory: {
    list: vi.fn(async () => []),
    delete: vi.fn(async () => ({ success: true }))
  }
}

async function loadStore(storage: Storage | null) {
  vi.resetModules()
  vi.stubGlobal('window', { api })
  if (storage) vi.stubGlobal('localStorage', storage)
  else vi.stubGlobal('localStorage', undefined)
  return (await import('./memoStore')).useMemoStore
}

beforeEach(() => {
  active = [memo(1), memo(2)]
  archived = [memo(3, { is_archived: 1 })]
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('memoStore 탐색 상태', () => {
  it('저장소가 없어도 기본값으로 시작한다', async () => {
    const store = await loadStore(null)
    const s = store.getState()
    expect(s.rail).toBe('all')
    expect(s.sortOrder).toBe('updated')
    expect(s.query).toBe('')
    expect(s.recentIds).toEqual([])
    expect(s.selectedMemoId).toBeNull()
  })

  it('저장된 화면 상태를 복원하고 예전 정렬값 newest 를 created 로 옮긴다', async () => {
    const storage = memoryStorage({
      'linkwork.memo.ui': JSON.stringify({ rail: 7, sortOrder: 'newest', railCollapsed: true, selectedMemoId: 2 }),
      'linkwork.memo.recent': JSON.stringify([2, 'x', 1, 2])
    })
    const s = (await loadStore(storage)).getState()
    expect(s.rail).toBe(7)
    expect(s.sortOrder).toBe('created')
    expect(s.railCollapsed).toBe(true)
    expect(s.selectedMemoId).toBe(2)
    expect(s.recentIds).toEqual([2, 1])
  })

  it('깨진 저장값이면 기본값', async () => {
    const storage = memoryStorage({ 'linkwork.memo.ui': '{깨짐', 'linkwork.memo.recent': '"문자열"' })
    const s = (await loadStore(storage)).getState()
    expect(s.rail).toBe('all')
    expect(s.recentIds).toEqual([])
  })

  it('레일·정렬·선택·최근 본을 저장한다', async () => {
    const storage = memoryStorage()
    const store = await loadStore(storage)
    store.getState().setRail('important')
    store.getState().setSortOrder('title')
    store.getState().selectMemo(2)
    store.getState().recordRecent(1)
    store.getState().recordRecent(2)
    store.getState().recordRecent(1)
    expect(JSON.parse(storage.data.get('linkwork.memo.ui')!)).toEqual({
      rail: 'important',
      sortOrder: 'title',
      railCollapsed: false,
      selectedMemoId: 2
    })
    expect(JSON.parse(storage.data.get('linkwork.memo.recent')!)).toEqual([1, 2])
  })

  it('저장이 실패해도 상태는 바뀐다', async () => {
    const storage = memoryStorage()
    storage.setItem = () => {
      throw new Error('quota')
    }
    const store = await loadStore(storage)
    store.getState().recordRecent(5)
    expect(store.getState().recentIds).toEqual([5])
  })

  it('검색어를 지우면 분류 칩과 보관함 포함 검색도 풀린다', async () => {
    const store = await loadStore(null)
    store.getState().setQuery('배포')
    store.getState().setScope(1)
    store.getState().setSearchArchivedToo(true)
    store.getState().setQuery('')
    const s = store.getState()
    expect(s.scope).toBeNull()
    expect(s.searchArchivedToo).toBe(false)
  })

  it('레일을 바꾸면 분류 칩이 풀린다', async () => {
    const store = await loadStore(null)
    store.getState().setScope(2)
    store.getState().setRail(1)
    expect(store.getState().scope).toBeNull()
  })
})

describe('revealMemo (앱 내 링크 포커스)', () => {
  it('보관 메모 id 면 레일을 보관함으로 바꾸고 검색을 풀고 선택한다', async () => {
    const store = await loadStore(null)
    await store.getState().fetchMemos()
    await store.getState().fetchArchivedMemos()
    store.getState().setRail(4)
    store.getState().setQuery('무엇')
    expect(store.getState().revealMemo(3)).toBe(true)
    const s = store.getState()
    expect(s.rail).toBe('archived')
    expect(s.query).toBe('')
    expect(s.selectedMemoId).toBe(3)
  })

  it('활성 메모 id 면 레일을 전체로 바꾼다', async () => {
    const store = await loadStore(null)
    await store.getState().fetchMemos()
    store.getState().setRail('important')
    expect(store.getState().revealMemo(2)).toBe(true)
    expect(store.getState().rail).toBe('all')
    expect(store.getState().selectedMemoId).toBe(2)
  })

  it('없는 메모면 false 이고 상태를 바꾸지 않는다', async () => {
    const store = await loadStore(null)
    await store.getState().fetchMemos()
    store.getState().setRail('important')
    expect(store.getState().revealMemo(99)).toBe(false)
    expect(store.getState().rail).toBe('important')
  })
})

describe('CRUD 후 선택 정리', () => {
  it('선택한 메모를 영구 삭제하면 선택을 풀고 최근 본에서도 뺀다', async () => {
    const store = await loadStore(null)
    store.getState().selectMemo(3)
    store.getState().recordRecent(3)
    store.getState().recordRecent(1)
    await store.getState().deleteMemo(3)
    expect(api.memo.delete).toHaveBeenCalledWith(3)
    expect(store.getState().selectedMemoId).toBeNull()
    expect(store.getState().recentIds).toEqual([1])
  })

  it('보관하면 활성·보관·중요 목록을 모두 다시 읽는다', async () => {
    const store = await loadStore(null)
    api.memo.listImportant.mockClear()
    await store.getState().archiveMemo(1)
    expect(api.memo.archive).toHaveBeenCalledWith(1)
    expect(api.memo.listImportant).toHaveBeenCalled()
  })

  it('보고 있던 분류를 지우면 레일을 전체로 돌린다', async () => {
    const store = await loadStore(null)
    store.getState().setRail(8)
    await store.getState().deleteCategory(8)
    expect(store.getState().rail).toBe('all')
  })
})
