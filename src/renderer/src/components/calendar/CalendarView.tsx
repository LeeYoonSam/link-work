import { useEffect, useMemo, useRef, useState } from 'react'
import { useCalendarStore, useWeekEvents, weekKey } from '../../stores/calendarStore'
import { useFocusRequest, useFocusStore } from '../../stores/focusStore'
import { useFlash } from '../../hooks/useFocusFlash'
import CalendarSettings from './CalendarSettings'
import DayScheduleCard from './DayScheduleCard'
import {
  addDays,
  addWeeks,
  differenceInCalendarWeeks,
  format,
  isSameDay,
  isValid,
  parseISO,
  startOfWeek
} from 'date-fns'
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
  // 이 주의 일정을 한 번이라도 받았는지. 빈 주(일정 0건)와 아직 안 받은 주를 가른다
  const weekLoaded = useCalendarStore((s) => weekKey(weekStart) in s.eventsByWeek)
  // 연동 상태를 한 번 받아 왔는지. 초기값 connected=false 를 미연동으로 오해하지 않기 위해서다
  const [statusChecked, setStatusChecked] = useState(false)

  useEffect(() => {
    void fetchStatus().finally(() => setStatusChecked(true))
  }, [])

  // 앱 내 링크(linkwork://calendar/{date}[/{eventId}])로 들어온 날짜를 연다.
  // 1) 그 날짜의 주로 한 번 옮긴다. 2) 일정이 오면 그 날 카드와 일정을 강조하고 요청을 소비한다.
  // 주말은 카드가 없고 미연동이면 일정이 없다. 이때는 주 이동만 하고 소비한다
  const focusRequest = useFocusRequest('calendar')
  const [flashDayKey, flashDay] = useFlash<string>()
  const [flashEventId, flashEvent] = useFlash<string>()
  const movedNonceRef = useRef<number | null>(null)

  useEffect(() => {
    if (!focusRequest) return
    const consume = (): void => useFocusStore.getState().consume(focusRequest.nonce)
    const target = parseISO(focusRequest.date)
    if (!isValid(target)) {
      consume()
      return
    }
    // 링크로 들어온 날이 있으면 오늘 카드로 자동 스크롤하지 않는다
    didScrollToTodayRef.current = true
    const offset = differenceInCalendarWeeks(
      startOfWeek(target, { weekStartsOn: 1 }),
      thisWeekStart,
      { weekStartsOn: 1 }
    )
    if (movedNonceRef.current !== focusRequest.nonce) {
      movedNonceRef.current = focusRequest.nonce
      if (offset !== weekOffset) {
        setWeekOffset(offset)
        return
      }
    }
    // 이동을 기다리는 동안 사용자가 주를 바꿨으면 그 선택을 따른다
    if (offset !== weekOffset) {
      consume()
      return
    }
    if (!statusChecked) return
    const weekday = target.getDay()
    if (!status.connected || weekday === 0 || weekday === 6) {
      consume()
      return
    }
    if (!weekLoaded) return
    flashDay(focusRequest.date)
    if (focusRequest.eventId && events.some((e) => e.id === focusRequest.eventId)) {
      flashEvent(focusRequest.eventId)
    }
    consume()
  }, [focusRequest, weekOffset, statusChecked, status.connected, weekLoaded, events])

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
              focused={format(day, 'yyyy-MM-dd') === flashDayKey}
              highlightEventId={format(day, 'yyyy-MM-dd') === flashDayKey ? flashEventId : null}
            />
          ))}
        </div>
      )}
    </div>
  )
}
