import { useEffect, useMemo, useRef, useState } from 'react'
import { useCalendarStore } from '../../stores/calendarStore'
import CalendarSettings from './CalendarSettings'
import DayScheduleCard from './DayScheduleCard'
import { addDays, format, isSameDay, startOfWeek } from 'date-fns'
import { SectionTitle, EmptyState, button } from '../ui'

const WORK_DAYS = 5

export default function CalendarView(): React.ReactNode {
  const { events, status, loading, fetchEvents, fetchStatus, refreshEvents } = useCalendarStore()
  const [showSettings, setShowSettings] = useState(false)
  const todayRef = useRef<HTMLDivElement>(null)
  const didScrollToTodayRef = useRef(false)

  useEffect(() => {
    fetchStatus()
  }, [])

  useEffect(() => {
    if (status.connected) {
      fetchEvents()
    }
  }, [status.connected])

  useEffect(() => {
    if (loading || didScrollToTodayRef.current) return
    if (todayRef.current) {
      todayRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
      didScrollToTodayRef.current = true
    }
  }, [loading])

  const now = new Date()
  const weekStart = useMemo(() => startOfWeek(now, { weekStartsOn: 1 }), [])
  const weekdayEnd = useMemo(() => addDays(weekStart, WORK_DAYS - 1), [weekStart])

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
      <div className="flex items-center justify-between mb-6">
        <SectionTitle variant="page">
          This Week&apos;s Schedule ({format(weekStart, 'MM-dd')} ~ {format(weekdayEnd, 'MM-dd')})
        </SectionTitle>
        <div className="flex gap-2">
          <button
            onClick={refreshEvents}
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
