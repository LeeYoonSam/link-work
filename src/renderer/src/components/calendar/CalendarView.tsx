import { useEffect, useMemo, useRef, useState } from 'react'
import { useCalendarStore, useWeekEvents } from '../../stores/calendarStore'
import CalendarSettings from './CalendarSettings'
import DayScheduleCard from './DayScheduleCard'
import { addDays, addWeeks, format, isSameDay, startOfWeek } from 'date-fns'
import { SectionTitle, EmptyState, Badge, button } from '../ui'

const WORK_DAYS = 5

export default function CalendarView(): React.ReactNode {
  const { status, loading, fetchEvents, fetchStatus, refreshEvents } = useCalendarStore()
  const [showSettings, setShowSettings] = useState(false)
  // 0 = 이번 주, -1 = 지난주, +1 = 다음 주
  const [weekOffset, setWeekOffset] = useState(0)
  const todayRef = useRef<HTMLDivElement>(null)
  const didScrollToTodayRef = useRef(false)

  const now = new Date()
  const thisWeekStart = useMemo(() => startOfWeek(now, { weekStartsOn: 1 }), [])
  const weekStart = useMemo(() => addWeeks(thisWeekStart, weekOffset), [thisWeekStart, weekOffset])
  const weekdayEnd = useMemo(() => addDays(weekStart, WORK_DAYS - 1), [weekStart])
  const isCurrentWeek = weekOffset === 0

  const events = useWeekEvents(weekStart)

  useEffect(() => {
    fetchStatus()
  }, [])

  useEffect(() => {
    if (status.connected) {
      fetchEvents(weekStart)
    }
  }, [status.connected, weekStart])

  useEffect(() => {
    if (loading || didScrollToTodayRef.current || !isCurrentWeek) return
    if (todayRef.current) {
      todayRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
      didScrollToTodayRef.current = true
    }
  }, [loading, isCurrentWeek])

  const days = useMemo(
    () => Array.from({ length: WORK_DAYS }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  )

  if (!status.hasCredentials || !status.connected) {
    return <CalendarSettings />
  }

  if (showSettings) {
    return <CalendarSettings onBack={() => setShowSettings(false)} />
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <SectionTitle variant="page">
            {format(weekStart, 'yyyy-MM-dd')} ~ {format(weekdayEnd, 'MM-dd')}
          </SectionTitle>
          {isCurrentWeek && (
            <Badge color="bg-blue-100 text-blue-700" size="xs">
              이번 주
            </Badge>
          )}
        </div>
        <div className="flex gap-2">
          {/* 주 단위 이동: ‹ 이전주 · 이번주 복귀 · 다음주 › */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setWeekOffset((v) => v - 1)}
              title="이전 주"
              aria-label="이전 주"
              className={`px-2 py-1.5 ${button.subtle}`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              onClick={() => setWeekOffset(0)}
              disabled={isCurrentWeek}
              className={`px-3 py-1.5 text-sm ${button.subtle} disabled:opacity-40 disabled:cursor-default`}
            >
              이번주
            </button>
            <button
              onClick={() => setWeekOffset((v) => v + 1)}
              title="다음 주"
              aria-label="다음 주"
              className={`px-2 py-1.5 ${button.subtle}`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
          <button
            onClick={() => refreshEvents(weekStart)}
            className={`px-3 py-1.5 text-sm ${button.subtle}`}
          >
            Refresh
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className={`px-3 py-1.5 text-sm ${button.subtle}`}
          >
            Settings
          </button>
        </div>
      </div>

      {loading ? (
        <EmptyState>Loading events...</EmptyState>
      ) : (
        <div className="space-y-5">
          {days.map((day) => (
            <DayScheduleCard
              key={format(day, 'yyyy-MM-dd')}
              day={day}
              now={now}
              events={events}
              cardRef={isSameDay(day, now) ? todayRef : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}
