import { useEffect, useMemo, useRef, useState } from 'react'
import { useCalendarStore, type CalendarEvent } from '../../stores/calendarStore'
import CalendarSettings from './CalendarSettings'
import { renderDescription } from './linkify'
import {
  addDays,
  format,
  isAfter,
  isBefore,
  isSameDay,
  startOfWeek
} from 'date-fns'
import { SectionTitle, EmptyState, button } from '../ui'

const DAY_LABELS = ['월', '화', '수', '목', '금']
const WORK_DAYS = 5

function EventCard({
  event,
  current,
  timeText
}: {
  event: CalendarEvent
  current: boolean
  timeText: string
}): React.ReactNode {
  const [expanded, setExpanded] = useState(false)
  const hasDescription = Boolean(event.description)

  return (
    <article
      className={`rounded-md border px-3 py-2 ${
        current ? 'border-blue-300 bg-blue-50/60' : 'border-gray-200 bg-white'
      }`}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <h4 className="font-medium text-gray-900 text-sm truncate" title={event.summary}>
            {event.summary}
          </h4>
          {current && (
            <span className="text-[10px] font-semibold text-blue-600 bg-blue-100 px-1.5 py-0.5 rounded shrink-0">
              NOW
            </span>
          )}
        </div>
        <span className="text-xs font-medium text-gray-600 shrink-0 tabular-nums">
          {timeText}
        </span>
      </header>
      {hasDescription && (
        <div
          className={`text-xs text-gray-600 mt-1 whitespace-pre-wrap break-words leading-relaxed ${
            expanded ? '' : 'line-clamp-2'
          }`}
        >
          {renderDescription(event.description!)}
        </div>
      )}
      {hasDescription && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-blue-600 hover:text-blue-700 mt-1"
        >
          {expanded ? '접기' : '더 보기'}
        </button>
      )}
      {event.location && (
        <p className="text-[11px] text-gray-400 mt-1 truncate" title={event.location}>
          {event.location}
        </p>
      )}
    </article>
  )
}

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

  const eventsByDay = useMemo(() => {
    const buckets: Record<string, typeof events> = {}
    for (const day of days) {
      buckets[format(day, 'yyyy-MM-dd')] = []
    }
    for (const event of events) {
      if (!event.start) continue
      const eventDate = new Date(event.start)
      const key = format(eventDate, 'yyyy-MM-dd')
      if (buckets[key]) {
        buckets[key].push(event)
      }
    }
    for (const key of Object.keys(buckets)) {
      buckets[key].sort((a, b) => {
        if (a.allDay && !b.allDay) return -1
        if (!a.allDay && b.allDay) return 1
        return new Date(a.start).getTime() - new Date(b.start).getTime()
      })
    }
    return buckets
  }, [events, days])

  if (!status.hasCredentials || !status.connected) {
    return <CalendarSettings />
  }

  if (showSettings) {
    return <CalendarSettings onBack={() => setShowSettings(false)} />
  }

  const getEventTimeDisplay = (event: (typeof events)[0]): string => {
    if (event.allDay) return 'All Day'
    const start = format(new Date(event.start), 'HH:mm')
    const end = format(new Date(event.end), 'HH:mm')
    return `${start} - ${end}`
  }

  const isCurrentEvent = (event: (typeof events)[0]): boolean => {
    if (event.allDay) return false
    return isAfter(now, new Date(event.start)) && isBefore(now, new Date(event.end))
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
          {days.map((day, idx) => {
            const key = format(day, 'yyyy-MM-dd')
            const dayEvents = eventsByDay[key] || []
            const isToday = isSameDay(day, now)

            return (
              <div
                key={key}
                ref={isToday ? todayRef : undefined}
                className={`rounded-lg border bg-white ${
                  isToday ? 'border-blue-400' : 'border-gray-200'
                }`}
              >
                <div
                  className={`flex items-center justify-between px-4 py-2 border-b ${
                    isToday ? 'border-blue-200 bg-blue-50/60' : 'border-gray-100'
                  }`}
                >
                  <div className="flex items-baseline gap-2">
                    <span
                      className={`text-sm font-semibold ${
                        isToday ? 'text-blue-700' : 'text-gray-700'
                      }`}
                    >
                      {DAY_LABELS[idx]} {format(day, 'MM-dd')}
                    </span>
                    {isToday && (
                      <span className="text-[11px] font-medium text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded">
                        오늘
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-gray-400">
                    {dayEvents.length === 0 ? '일정 없음' : `${dayEvents.length}개 일정`}
                  </span>
                </div>

                {dayEvents.length > 0 && (
                  <div
                    className="p-3 grid gap-2"
                    style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
                  >
                    {dayEvents.map((event) => (
                      <EventCard
                        key={event.id}
                        event={event}
                        current={isCurrentEvent(event)}
                        timeText={getEventTimeDisplay(event)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
