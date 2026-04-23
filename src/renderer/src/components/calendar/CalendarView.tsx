import { useEffect, useMemo, useRef, useState } from 'react'
import { useCalendarStore } from '../../stores/calendarStore'
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

const DAY_LABELS = ['월', '화', '수', '목', '금']
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
        <h3 className="text-lg font-semibold text-gray-900">
          This Week&apos;s Schedule ({format(weekStart, 'MM-dd')} ~ {format(weekdayEnd, 'MM-dd')})
        </h3>
        <div className="flex gap-2">
          <button
            onClick={refreshEvents}
            className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200"
          >
            Refresh
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200"
          >
            Settings
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center text-gray-500 py-12">Loading events...</div>
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
                className={`rounded-lg transition-all ${
                  isToday
                    ? 'border-2 border-blue-500 bg-blue-50 ring-4 ring-blue-100 shadow-md'
                    : 'border border-gray-200 bg-white'
                }`}
              >
                <div
                  className={`flex items-center justify-between px-4 border-b ${
                    isToday ? 'py-3 border-blue-200 bg-blue-100/50' : 'py-2 border-gray-100'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {isToday && (
                      <span
                        className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse"
                        aria-hidden
                      />
                    )}
                    <span
                      className={`font-semibold ${
                        isToday ? 'text-base text-blue-800' : 'text-sm text-gray-700'
                      }`}
                    >
                      {DAY_LABELS[idx]}
                    </span>
                    <span
                      className={
                        isToday ? 'text-base font-semibold text-blue-700' : 'text-sm text-gray-500'
                      }
                    >
                      {format(day, 'MM-dd')}
                    </span>
                    {isToday && (
                      <span className="text-xs font-semibold text-white bg-blue-600 px-2 py-0.5 rounded-full shadow-sm">
                        오늘
                      </span>
                    )}
                  </div>
                  <span
                    className={`text-xs ${
                      isToday ? 'text-blue-700 font-medium' : 'text-gray-400'
                    }`}
                  >
                    {dayEvents.length}개 일정
                  </span>
                </div>

                <div className="p-3">
                  {dayEvents.length === 0 ? (
                    <p className="text-xs text-gray-400 text-center py-3">일정 없음</p>
                  ) : (
                    <div className="space-y-2">
                      {dayEvents.map((event) => (
                        <div
                          key={event.id}
                          className={`border rounded-md p-3 transition-colors ${
                            isCurrentEvent(event)
                              ? 'border-blue-400 bg-blue-50'
                              : 'border-gray-200 bg-white'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <h4 className="font-medium text-gray-900 text-sm">
                                {event.summary}
                              </h4>
                              {event.description && (
                                <p className="text-xs text-gray-600 mt-1 whitespace-pre-wrap break-words">
                                  {renderDescription(event.description)}
                                </p>
                              )}
                              {event.location && (
                                <p className="text-xs text-gray-400 mt-1">{event.location}</p>
                              )}
                            </div>
                            <div className="text-right flex-shrink-0">
                              <span className="text-xs font-medium text-gray-700">
                                {getEventTimeDisplay(event)}
                              </span>
                              {isCurrentEvent(event) && (
                                <span className="block text-[10px] text-blue-600 mt-1">Now</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
