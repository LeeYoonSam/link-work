import { create } from 'zustand'

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

interface CalendarStore {
  events: CalendarEvent[]
  status: CalendarStatus
  loading: boolean

  fetchEvents: () => Promise<void>
  refreshEvents: () => Promise<void>
  fetchStatus: () => Promise<void>
  connect: () => Promise<{ success: boolean; error?: string }>
  disconnect: () => Promise<void>
  saveSettings: (clientId: string, clientSecret: string) => Promise<void>
}

export const useCalendarStore = create<CalendarStore>((set) => ({
  events: [],
  status: { connected: false, hasCredentials: false },
  loading: false,

  fetchEvents: async () => {
    set({ loading: true })
    const events = await window.api.calendar.getEvents()
    set({ events, loading: false })
  },

  refreshEvents: async () => {
    set({ loading: true })
    const events = await window.api.calendar.refresh()
    set({ events, loading: false })
  },

  fetchStatus: async () => {
    const status = await window.api.calendar.status()
    set({ status })
  },

  connect: async () => {
    const result = await window.api.calendar.auth()
    if (result.success) {
      set({ status: { connected: true, hasCredentials: true } })
      const events = await window.api.calendar.getEvents()
      set({ events })
    }
    return result
  },

  disconnect: async () => {
    await window.api.calendar.disconnect()
    set({ events: [], status: { connected: false, hasCredentials: true } })
  },

  saveSettings: async (clientId: string, clientSecret: string) => {
    await window.api.calendar.saveSettings(clientId, clientSecret)
    set((state) => ({ status: { ...state.status, hasCredentials: true } }))
  }
}))
