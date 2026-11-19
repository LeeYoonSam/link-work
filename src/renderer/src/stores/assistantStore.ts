import { create } from 'zustand'
import type { AssistantNavigateEvent, AssistantSettings, TodayPayload } from '../types'

// 비서 상태 (docs/ASSISTANT.md 부록 O).
// 오늘 화면이 대시보드로 바뀌어 계획 조작(하루 시작·항목 상태·명령 등)은 모두 지웠다.
// 남은 용도: 회의 전 브리핑(today.events), 비서 설정, 알림 클릭 focus.

type Focus = NonNullable<AssistantNavigateEvent['focus']>

interface AssistantStore {
  today: TodayPayload | null
  loading: boolean
  error: string
  // 알림 클릭으로 열린 영역. 대시보드는 'meeting' 만 쓴다
  focus: Focus | null
  // 회의 브리핑을 다시 만드는 중인 이벤트 id. 행 단위로 중복 클릭을 막는다
  meetingRegeneratingIds: number[]

  load: () => Promise<void>
  saveSettings: (patch: Partial<AssistantSettings>) => Promise<boolean>
  setFocus: (focus: Focus | null) => void
  clearError: () => void
  // 회의 브리핑의 AI 본문을 다시 만든다 (부록 I.10.3). 결과를 기다린다
  regenerateMeetingBriefing: (eventId: number) => Promise<void>
  // assistant:changed 를 구독한다. 해제 함수를 돌려준다
  subscribe: () => () => void
}

const errorText = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message ? e.message : fallback

export const useAssistantStore = create<AssistantStore>((set, get) => ({
  today: null,
  loading: false,
  error: '',
  focus: null,
  meetingRegeneratingIds: [],

  load: async () => {
    set({ loading: true })
    try {
      const res = await window.api.assistant.getToday()
      if (res.success) set({ today: res.today, loading: false, error: '' })
      else set({ error: res.error || '오늘 정보를 불러오지 못했습니다', loading: false })
    } catch (e) {
      set({ error: errorText(e, '오늘 정보를 불러오지 못했습니다'), loading: false })
    }
  },

  saveSettings: async (patch) => {
    set({ error: '' })
    try {
      const res = await window.api.assistant.saveSettings(patch)
      if (!res.success) {
        set({ error: res.error || '설정 저장에 실패했습니다' })
        return false
      }
      const today = get().today
      if (today) set({ today: { ...today, settings: res.settings } })
      return true
    } catch (e) {
      set({ error: errorText(e, '설정 저장에 실패했습니다') })
      return false
    }
  },

  setFocus: (focus) => set({ focus }),

  clearError: () => set({ error: '' }),

  // 행 단위 상태를 쓴다. 같은 행의 중복 클릭만 막는다
  regenerateMeetingBriefing: async (eventId) => {
    if (get().meetingRegeneratingIds.includes(eventId)) return
    const fallback = '회의 브리핑을 다시 만들지 못했습니다'
    set({ meetingRegeneratingIds: [...get().meetingRegeneratingIds, eventId], error: '' })
    const finish = (): void =>
      set({ meetingRegeneratingIds: get().meetingRegeneratingIds.filter((id) => id !== eventId) })
    try {
      const res = await window.api.assistant.regenerateMeetingBriefing(eventId)
      finish()
      if (res.success) set({ today: res.today })
      else set({ error: res.error || fallback })
    } catch (e) {
      finish()
      set({ error: errorText(e, fallback) })
    }
  },

  // reason 과 무관하게 다시 읽는다. 'meeting' 도 같다 (부록 I.10.3).
  // 메인 창은 dataSync.installDataSync 가 전역으로 구독한다. 화면에서 이 함수를 부르지 않는다.
  // 이유: 같은 이벤트로 load 가 2번 돈다
  subscribe: () => {
    const api = window.api?.assistant
    if (!api) return () => {}
    return api.onChanged(() => {
      void get().load()
    })
  }
}))
