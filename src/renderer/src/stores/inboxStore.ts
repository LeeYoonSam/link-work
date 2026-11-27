import { create } from 'zustand'
import type { RequestInboxSnapshot } from '../types'
import { useTodoStore } from './todoStore'

// 나에게 온 요청 스토어 (docs/ASSISTANT.md §11.6). 오늘 대시보드가 todayStore 를 통해 불러온다.
// 할 일로 바꾸기·처리함은 낙관적으로 행을 지우고, 실패하면 저장본을 다시 읽는다.

export interface InboxStore {
  snapshot: RequestInboxSnapshot | null
  error: string | null
  /** 처리 중인 요청 id. 버튼을 잠근다 */
  busyIds: string[]
  /** 저장본을 먼저 보이고 원본과 동기화한다. force 면 자동 동기화 간격(10분) 대신 30초 연타 방지만 적용된다 */
  load: (force: boolean) => Promise<void>
  toTodo: (id: string, dueDate: string | null) => Promise<boolean>
  dismiss: (id: string) => Promise<boolean>
  open: (id: string) => Promise<void>
}

let seq = 0

/** 테스트용 */
export function resetInboxStoreInternals(): void {
  seq = 0
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

export const useInboxStore = create<InboxStore>((set, get) => {
  const removeItem = (id: string): void => {
    const snap = get().snapshot
    if (snap) set({ snapshot: { ...snap, items: snap.items.filter((i) => i.id !== id) } })
  }
  const setBusy = (id: string, busy: boolean): void => {
    const ids = get().busyIds.filter((x) => x !== id)
    set({ busyIds: busy ? [...ids, id] : ids })
  }
  const reloadCached = async (): Promise<void> => {
    try {
      const res = await window.api.inbox.cached()
      if (res.success) set({ snapshot: res.snapshot })
    } catch {
      // 직전 값 유지
    }
  }

  return {
    snapshot: null,
    error: null,
    busyIds: [],

    load: async (force) => {
      const api = window.api?.inbox
      if (!api) return
      const my = ++seq
      if (!get().snapshot) {
        try {
          const cached = await api.cached()
          if (my === seq && cached.success) set({ snapshot: cached.snapshot })
        } catch {
          // 동기화 결과를 기다린다
        }
      }
      try {
        const res = await api.sync(force)
        if (my !== seq) return
        if (res.success) set({ snapshot: res.snapshot, error: null })
        else set({ error: res.error || '요청을 불러오지 못했어요' })
      } catch (e) {
        if (my !== seq) return
        set({ error: errorText(e, '요청을 불러오지 못했어요') })
      }
    },

    toTodo: async (id, dueDate) => {
      if (get().busyIds.includes(id)) return false
      setBusy(id, true)
      try {
        const res = await window.api.inbox.toTodo(id, dueDate)
        if (!res.success) {
          set({ error: res.error })
          await reloadCached()
          return false
        }
        removeItem(id)
        const todo = useTodoStore.getState()
        await Promise.allSettled([todo.fetchActiveTodos({ silent: true }), todo.fetchTodos({ silent: true })])
        return true
      } catch (e) {
        set({ error: errorText(e, '할 일로 바꾸지 못했어요') })
        return false
      } finally {
        setBusy(id, false)
      }
    },

    dismiss: async (id) => {
      if (get().busyIds.includes(id)) return false
      setBusy(id, true)
      try {
        const res = await window.api.inbox.dismiss(id)
        if (!res.success) {
          set({ error: res.error })
          await reloadCached()
          return false
        }
        removeItem(id)
        return true
      } catch (e) {
        set({ error: errorText(e, '처리하지 못했어요') })
        return false
      } finally {
        setBusy(id, false)
      }
    },

    open: async (id) => {
      try {
        const res = await window.api.inbox.open(id)
        if (!res.success) set({ error: res.error })
      } catch (e) {
        set({ error: errorText(e, '열지 못했어요') })
      }
    }
  }
})
