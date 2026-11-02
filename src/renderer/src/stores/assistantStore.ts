import { create } from 'zustand'
import type {
  AssistantNavigateEvent,
  AssistantSettings,
  Candidate,
  PlanItem,
  PlanItemStatus,
  TodayPayload,
  TodayResult
} from '../types'

type Focus = NonNullable<AssistantNavigateEvent['focus']>

interface AssistantStore {
  today: TodayPayload | null
  loading: boolean
  // 버튼 동작이 진행 중이면 true. 중복 클릭을 막는다
  busy: boolean
  error: string
  candidates: Candidate[]
  candidatesLoading: boolean
  candidatesError: string
  // 사용자가 '건너뛰기'를 누른 어제 메모 날짜
  skippedWrapupDate: string | null
  // 알림 클릭으로 열린 영역
  focus: Focus | null

  load: () => Promise<void>
  startDay: () => Promise<void>
  closeDay: (note?: string) => Promise<void>
  reopenDay: () => Promise<void>
  saveWrapup: (note: string, date: string) => Promise<boolean>
  skipWrapup: (date: string) => void
  refresh: () => Promise<void>
  refreshBriefing: () => Promise<void>
  loadCandidates: () => Promise<void>
  addItem: (candidateId: string) => Promise<void>
  acceptSuggestion: (itemId: number) => Promise<void>
  dismissSuggestion: (itemId: number) => Promise<void>
  setItemStatus: (itemId: number, status: PlanItemStatus, note?: string) => Promise<void>
  // 항목을 집중 작업으로 바꾼다 (부록 B.4)
  focusItem: (itemId: number) => Promise<void>
  completeOrigin: (item: PlanItem) => Promise<boolean>
  saveSettings: (patch: Partial<AssistantSettings>) => Promise<boolean>
  setFocus: (focus: Focus | null) => void
  clearError: () => void
  // assistant:changed 를 구독한다. 해제 함수를 돌려준다
  subscribe: () => () => void
}

const errorText = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message ? e.message : fallback

// 원본 완료 처리가 가능한 출처인지 판정한다. jira·action_item 은 원본 API 가 없다
export function originTarget(
  item: Pick<PlanItem, 'source' | 'candidate_id'>
): { kind: 'todo' | 'task'; id: number } | null {
  const m = item.candidate_id.match(/^(todo|task):(\d+)$/)
  if (!m || (item.source !== 'todo' && item.source !== 'task')) return null
  return { kind: m[1] as 'todo' | 'task', id: Number(m[2]) }
}

export const useAssistantStore = create<AssistantStore>((set, get) => {
  // today 를 돌려주는 동작의 공통 처리. 성공하면 today 를 바꾸고, 실패하면 error 를 둔다
  const run = async (call: () => Promise<TodayResult>, fallback: string): Promise<boolean> => {
    if (get().busy) return false
    set({ busy: true, error: '' })
    try {
      const res = await call()
      if (res.success) {
        set({ today: res.today, busy: false })
        return true
      }
      set({ error: res.error || fallback, busy: false })
      return false
    } catch (e) {
      set({ error: errorText(e, fallback), busy: false })
      return false
    }
  }

  return {
    today: null,
    loading: false,
    busy: false,
    error: '',
    candidates: [],
    candidatesLoading: false,
    candidatesError: '',
    skippedWrapupDate: null,
    focus: null,

    load: async () => {
      set({ loading: true })
      try {
        const res = await window.api.assistant.getToday()
        if (res.success) set({ today: res.today, loading: false, error: '' })
        else set({ error: res.error || '오늘 계획을 불러오지 못했습니다', loading: false })
      } catch (e) {
        set({ error: errorText(e, '오늘 계획을 불러오지 못했습니다'), loading: false })
      }
    },

    startDay: async () => {
      await run(() => window.api.assistant.startDay(), '하루 시작에 실패했습니다')
    },

    closeDay: async (note) => {
      const trimmed = note?.trim()
      await run(
        () => window.api.assistant.closeDay(trimmed ? trimmed : undefined),
        '퇴근 처리에 실패했습니다'
      )
    },

    reopenDay: async () => {
      await run(() => window.api.assistant.reopenDay(), '다시 열기에 실패했습니다')
    },

    saveWrapup: async (note, date) => {
      const trimmed = note.trim()
      if (!trimmed) return false
      set({ busy: true, error: '' })
      try {
        const res = await window.api.assistant.saveWrapup(trimmed, date)
        set({ busy: false })
        if (!res.success) {
          set({ error: res.error || '메모 저장에 실패했습니다' })
          return false
        }
        // missingWrapupDate 가 바뀌므로 오늘 화면을 다시 읽는다
        set({ skippedWrapupDate: date })
        await get().load()
        return true
      } catch (e) {
        set({ error: errorText(e, '메모 저장에 실패했습니다'), busy: false })
        return false
      }
    },

    skipWrapup: (date) => set({ skippedWrapupDate: date }),

    refresh: async () => {
      await run(() => window.api.assistant.refresh(), '새로고침에 실패했습니다')
    },

    refreshBriefing: async () => {
      await run(() => window.api.assistant.refreshBriefing(), '브리핑 생성에 실패했습니다')
    },

    loadCandidates: async () => {
      set({ candidatesLoading: true, candidatesError: '' })
      try {
        const res = await window.api.assistant.listCandidates()
        if (res.success) set({ candidates: res.candidates, candidatesLoading: false })
        else
          set({
            candidatesError: res.error || '후보를 불러오지 못했습니다',
            candidatesLoading: false
          })
      } catch (e) {
        set({
          candidatesError: errorText(e, '후보를 불러오지 못했습니다'),
          candidatesLoading: false
        })
      }
    },

    addItem: async (candidateId) => {
      await run(() => window.api.assistant.addItem(candidateId), '계획에 추가하지 못했습니다')
    },

    acceptSuggestion: async (itemId) => {
      await run(
        () => window.api.assistant.acceptSuggestion(itemId),
        '계획에 추가하지 못했습니다'
      )
    },

    dismissSuggestion: async (itemId) => {
      await run(() => window.api.assistant.dismissSuggestion(itemId), '무시 처리에 실패했습니다')
    },

    setItemStatus: async (itemId, status, note) => {
      await run(
        () => window.api.assistant.setItemStatus(itemId, status, note),
        '상태를 바꾸지 못했습니다'
      )
    },

    focusItem: async (itemId) => {
      await run(() => window.api.assistant.focusItem(itemId), '집중 작업을 바꾸지 못했습니다')
    },

    // 비서 main 코드는 원본을 쓰지 않는다(A2). 원본 완료는 기존 API 로 렌더러가 부른다
    completeOrigin: async (item) => {
      const target = originTarget(item)
      if (!target) return false
      try {
        if (target.kind === 'todo') await window.api.todo.complete(target.id)
        else await window.api.task.update(target.id, { status: 'done' })
        return true
      } catch (e) {
        set({ error: errorText(e, '원본 완료 처리에 실패했습니다') })
        return false
      }
    },

    saveSettings: async (patch) => {
      set({ busy: true, error: '' })
      try {
        const res = await window.api.assistant.saveSettings(patch)
        set({ busy: false })
        if (!res.success) {
          set({ error: res.error || '설정 저장에 실패했습니다' })
          return false
        }
        const today = get().today
        if (today) set({ today: { ...today, settings: res.settings } })
        return true
      } catch (e) {
        set({ error: errorText(e, '설정 저장에 실패했습니다'), busy: false })
        return false
      }
    },

    setFocus: (focus) => set({ focus }),

    clearError: () => set({ error: '' }),

    subscribe: () => {
      const api = window.api?.assistant
      if (!api) return () => {}
      return api.onChanged(() => {
        void get().load()
      })
    }
  }
})
