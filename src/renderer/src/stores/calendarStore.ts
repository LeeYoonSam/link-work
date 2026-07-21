import { create } from 'zustand'
import { format, startOfWeek } from 'date-fns'

export interface CalendarEvent {
  id: string
  summary: string
  description?: string
  start: string
  end: string
  allDay: boolean
  location?: string
  htmlLink?: string
}

interface CalendarStatus {
  connected: boolean
  hasCredentials: boolean
}

/** 어떤 날짜든 그 날이 속한 주(월요일 시작)의 캐시 키로 변환한다. */
export function weekKey(date: Date): string {
  return format(startOfWeek(date, { weekStartsOn: 1 }), 'yyyy-MM-dd')
}

interface CalendarStore {
  // 캘린더가 이전/다음 주로 이동할 수 있으므로 주차별로 보관한다.
  eventsByWeek: Record<string, CalendarEvent[]>
  status: CalendarStatus
  loading: boolean

  fetchEvents: (weekStart?: Date) => Promise<void>
  refreshEvents: (weekStart?: Date) => Promise<void>
  fetchStatus: () => Promise<void>
  connect: () => Promise<{ success: boolean; error?: string }>
  disconnect: () => Promise<void>
  saveSettings: (clientId: string, clientSecret: string) => Promise<void>
}

export const useCalendarStore = create<CalendarStore>((set, get) => ({
  eventsByWeek: {},
  status: { connected: false, hasCredentials: false },
  loading: false,

  fetchEvents: async (weekStart) => {
    const target = weekStart ?? new Date()
    const key = weekKey(target)
    // 이미 받아둔 주는 로딩 표시 없이 갱신해 주 이동이 깜빡이지 않게 한다.
    if (!get().eventsByWeek[key]) set({ loading: true })
    const events = await window.api.calendar.getEvents(target.toISOString())
    set((state) => ({ eventsByWeek: { ...state.eventsByWeek, [key]: events }, loading: false }))
  },

  refreshEvents: async (weekStart) => {
    const target = weekStart ?? new Date()
    const key = weekKey(target)
    set({ loading: true })
    const events = await window.api.calendar.refresh(target.toISOString())
    set((state) => ({ eventsByWeek: { ...state.eventsByWeek, [key]: events }, loading: false }))
  },

  fetchStatus: async () => {
    const status = await window.api.calendar.status()
    set({ status })
  },

  connect: async () => {
    const result = await window.api.calendar.auth()
    if (result.success) {
      set({ status: { connected: true, hasCredentials: true } })
      await get().fetchEvents()
    }
    return result
  },

  disconnect: async () => {
    await window.api.calendar.disconnect()
    set({ eventsByWeek: {}, status: { connected: false, hasCredentials: true } })
  },

  saveSettings: async (clientId: string, clientSecret: string) => {
    await window.api.calendar.saveSettings(clientId, clientSecret)
    set((state) => ({ status: { ...state.status, hasCredentials: true } }))
  }
}))

const EMPTY_EVENTS: CalendarEvent[] = []

/** 주어진 날짜가 속한 주의 일정. 아직 받아오지 않았으면 빈 배열. */
export function useWeekEvents(date: Date): CalendarEvent[] {
  return useCalendarStore((state) => state.eventsByWeek[weekKey(date)] ?? EMPTY_EVENTS)
}
