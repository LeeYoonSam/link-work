import { create } from 'zustand'
import type { MeetingDetail, MeetingNoteFilter, MeetingNoteItem } from '../types'

// 회의록(요약 완료 회의) 아카이브 상태.
// 선택 id는 전역이라 다른 메뉴에 다녀와도, 녹음 뷰에서 "회의록으로 보기"로 넘어와도 유지된다.
interface MeetingNotesStore {
  items: MeetingNoteItem[]
  loading: boolean
  filter: MeetingNoteFilter
  selectedId: number | null
  detail: MeetingDetail | null
  setFilter: (patch: Partial<MeetingNoteFilter>) => void
  fetch: () => Promise<void>
  select: (id: number | null) => Promise<void>
}

export const useMeetingNotesStore = create<MeetingNotesStore>((set, get) => ({
  items: [],
  loading: false,
  filter: { q: '', kind: 'all', projectId: null },
  selectedId: null,
  detail: null,

  setFilter: (patch) => {
    set({ filter: { ...get().filter, ...patch } })
    get().fetch()
  },

  fetch: async () => {
    // 검색어를 빠르게 바꾸면 이전 요청이 늦게 도착할 수 있다. 요청 시점의 filter 객체와
    // 응답 시점의 filter가 같을 때만 반영해 오래된 목록이 최신 목록을 덮지 않게 한다.
    const filter = get().filter
    set({ loading: true })
    try {
      const items = await window.api.meetingNotes.list(filter)
      if (get().filter === filter) set({ items })
    } finally {
      if (get().filter === filter) set({ loading: false })
    }
  },

  select: async (id) => {
    set({ selectedId: id, detail: null })
    if (id === null) return
    const detail = await window.api.recording.get(id)
    // 로드 중 다른 회의를 고르면 늦게 온 응답을 버린다
    if (get().selectedId === id) set({ detail })
  }
}))
