import { create } from 'zustand'
import type { AssistantNavigateEvent, TodayPayload } from '../types'

// 비서 상태 (docs/ASSISTANT.md §11, §12).
// 용도: 회의 전 브리핑(today.events), 알림 클릭 focus.
// 비서 설정 저장은 설정 화면(AssistantSection)이 IPC 를 직접 부른다.
// assistant:changed 구독은 dataSync.installDataSync 가 맡는다.

type Focus = NonNullable<AssistantNavigateEvent['focus']>

interface AssistantStore {
  today: TodayPayload | null
  error: string
  // 알림 클릭으로 열린 영역. 대시보드는 'meeting' 만 쓴다
  focus: Focus | null
  // 회의 브리핑을 다시 만드는 중인 이벤트 id. 행 단위로 중복 클릭을 막는다
  meetingRegeneratingIds: number[]

  load: () => Promise<void>
  setFocus: (focus: Focus | null) => void
  // 회의 브리핑의 AI 본문을 다시 만든다 (docs/ASSISTANT.md §7.7). 결과를 기다린다
  regenerateMeetingBriefing: (eventId: number) => Promise<void>
}

const errorText = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message ? e.message : fallback

export const useAssistantStore = create<AssistantStore>((set, get) => ({
  today: null,
  error: '',
  focus: null,
  meetingRegeneratingIds: [],

  load: async () => {
    try {
      const res = await window.api.assistant.getToday()
      if (res.success) set({ today: res.today, error: '' })
      else set({ error: res.error || '오늘 정보를 불러오지 못했습니다' })
    } catch (e) {
      set({ error: errorText(e, '오늘 정보를 불러오지 못했습니다') })
    }
  },

  setFocus: (focus) => set({ focus }),

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
  }
}))
