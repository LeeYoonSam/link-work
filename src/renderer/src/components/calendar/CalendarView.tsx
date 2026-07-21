import { useEffect, useMemo, useRef, useState } from 'react'
import { useCalendarStore, type CalendarEvent } from '../../stores/calendarStore'
import CalendarSettings from './CalendarSettings'
import MarkdownContent from '../memo/MarkdownContent'
import {
  addDays,
  format,
  isAfter,
  isBefore,
  isSameDay,
  startOfWeek
} from 'date-fns'
import { Badge, SectionTitle, EmptyState, button } from '../ui'

const DAY_LABELS = ['월', '화', '수', '목', '금']
const WORK_DAYS = 5

// 시간 지정 일정: 시간 컬럼 + 컬러 바 + 내용의 타임라인 행
function EventRow({
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
    <article className={`flex gap-3 px-4 py-2.5 ${current ? 'bg-blue-50/60' : ''}`}>
      <span
        className={`w-24 shrink-0 text-xs tabular-nums pt-0.5 text-right ${
          current ? 'text-blue-600 font-semibold' : 'text-gray-500'
        }`}
      >
        {timeText}
      </span>
      <div
        className={`w-0.5 self-stretch rounded-full ${current ? 'bg-blue-500' : 'bg-gray-200'}`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <h4 className="font-medium text-gray-900 text-sm truncate" title={event.summary}>
            {event.summary}
          </h4>
          {current && (
            <Badge color="bg-blue-100 text-blue-600" size="xs">
              NOW
            </Badge>
          )}
        </div>
        {hasDescription && (
          <div className={`mt-1 ${expanded ? '' : 'max-h-[3.25rem] overflow-hidden'}`}>
            <MarkdownContent
              content={event.description!}
              allowHtml
              compact
              // 캘린더 행은 조밀하므로 본문 텍스트를 xs/회색으로 낮춰 제목보다 덜 튀게 한다.
              className="break-words [&_p]:text-xs [&_p]:text-gray-600 [&_li]:text-xs [&_li]:text-gray-600 [&_ul]:text-xs [&_ol]:text-xs"
            />
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
      </div>
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
            const allDayEvents = dayEvents.filter((e) => e.allDay)
            const timedEvents = dayEvents.filter((e) => !e.allDay)

            return (
              <div
                key={key}
                ref={isToday ? todayRef : undefined}
                className={`rounded-lg border bg-white overflow-hidden ${
                  isToday ? 'border-blue-300 ring-1 ring-blue-200' : 'border-gray-200'
                }`}
              >
                <div
                  className={`flex items-center gap-2 px-4 py-2.5 ${
                    timedEvents.length > 0 ? 'border-b border-gray-100' : ''
                  }`}
                >
                  <span
                    className={`text-sm font-semibold ${
                      isToday ? 'text-blue-700' : 'text-gray-700'
                    }`}
                  >
                    {DAY_LABELS[idx]} {format(day, 'MM-dd')}
                  </span>
                  {isToday && (
                    <Badge color="bg-blue-100 text-blue-700" size="xs">
                      오늘
                    </Badge>
                  )}
                  {/* 종일 일정은 별도 카드 대신 헤더의 컴팩트 칩으로 */}
                  <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                    {allDayEvents.map((e) => (
                      <span
                        key={e.id}
                        className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-[11px] font-medium truncate max-w-[160px]"
                        title={`${e.summary} · All Day`}
                      >
                        {e.summary}
                      </span>
                    ))}
                  </div>
                  <span className="ml-auto shrink-0 text-xs text-gray-400">
                    {dayEvents.length === 0 ? '일정 없음' : `${dayEvents.length}개 일정`}
                  </span>
                </div>

                {timedEvents.length > 0 && (
                  <div className="divide-y divide-gray-50">
                    {timedEvents.map((event) => (
                      <EventRow
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
