import { create } from 'zustand'
import type { ActivityLog, WeeklySummary, DailyStat } from '../types'
import { startOfWeek, endOfWeek, addWeeks, format } from 'date-fns'

interface ReportStore {
  activities: ActivityLog[]
  summary: WeeklySummary[]
  dailyStats: DailyStat[]
  currentWeekStart: Date
  loading: boolean

  fetchWeeklyData: () => Promise<void>
  goToPreviousWeek: () => void
  goToNextWeek: () => void
  goToCurrentWeek: () => void
}

export const useReportStore = create<ReportStore>((set, get) => ({
  activities: [],
  summary: [],
  dailyStats: [],
  currentWeekStart: startOfWeek(new Date(), { weekStartsOn: 1 }),
  loading: false,

  fetchWeeklyData: async () => {
    set({ loading: true })
    try {
      const { currentWeekStart } = get()
      const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 1 })
      const start = format(currentWeekStart, 'yyyy-MM-dd')
      const end = format(weekEnd, 'yyyy-MM-dd')

      const [activities, summary, dailyStats] = await Promise.all([
        window.api.report.weeklyActivities(start, end),
        window.api.report.weeklySummary(start, end),
        window.api.report.dailyStats(start, end)
      ])

      set({ activities, summary, dailyStats })
    } finally {
      set({ loading: false })
    }
  },

  goToPreviousWeek: () => {
    set((state) => ({
      currentWeekStart: addWeeks(state.currentWeekStart, -1)
    }))
  },

  goToNextWeek: () => {
    set((state) => ({
      currentWeekStart: addWeeks(state.currentWeekStart, 1)
    }))
  },

  goToCurrentWeek: () => {
    set({ currentWeekStart: startOfWeek(new Date(), { weekStartsOn: 1 }) })
  }
}))
