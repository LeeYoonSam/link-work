import { differenceInCalendarDays, format, isToday as isTodayFns } from 'date-fns'

export type UrgencyLevel = 'early' | 'mid' | 'late'

export function calculateProgress(startDate: string, endDate: string): number {
  const start = new Date(startDate)
  const end = new Date(endDate)
  const today = new Date()

  const total = differenceInCalendarDays(end, start)
  if (total <= 0) return 100

  const elapsed = differenceInCalendarDays(today, start)
  if (elapsed < 0) return 0

  const progress = Math.round((elapsed / total) * 100)
  return Math.min(100, Math.max(0, progress))
}

export function getUrgencyLevel(progress: number): UrgencyLevel {
  if (progress <= 33) return 'early'
  if (progress <= 66) return 'mid'
  return 'late'
}

export function getUrgencyColor(level: UrgencyLevel): string {
  switch (level) {
    case 'early':
      return '#22c55e'
    case 'mid':
      return '#3b82f6'
    case 'late':
      return '#ef4444'
  }
}

export function getUrgencyBgClass(level: UrgencyLevel): string {
  switch (level) {
    case 'early':
      return 'bg-green-500'
    case 'mid':
      return 'bg-blue-500'
    case 'late':
      return 'bg-red-500'
  }
}

export function getUrgencyTextClass(level: UrgencyLevel): string {
  switch (level) {
    case 'early':
      return 'text-green-600'
    case 'mid':
      return 'text-blue-600'
    case 'late':
      return 'text-red-600'
  }
}

export function formatDate(dateStr: string, fmt = 'yyyy-MM-dd'): string {
  return format(new Date(dateStr), fmt)
}

export function isToday(dateStr: string): boolean {
  return isTodayFns(new Date(dateStr))
}
