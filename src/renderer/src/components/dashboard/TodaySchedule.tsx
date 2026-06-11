import { format, isAfter, isBefore, isSameDay } from 'date-fns'
import type { CalendarEvent } from '../../stores/calendarStore'
import type { Todo } from '../../types'
import { Badge, Card, EmptyState, todoPriority } from '../ui'

interface Props {
  events: CalendarEvent[]
  connected: boolean
  todos?: Todo[]
}

type ScheduleItem =
  | {
      kind: 'event'
      id: string
      start: Date | null
      end: Date | null
      allDay: boolean
      title: string
      location?: string
    }
  | {
      kind: 'todo'
      id: string
      start: Date
      end: null
      allDay: false
      title: string
      priority: 'low' | 'medium' | 'high'
      isCompleted: boolean
    }

function hasTime(dueDate: string): boolean {
  return /\s\d{2}:\d{2}/.test(dueDate)
}

export default function TodaySchedule({ events, connected, todos = [] }: Props): React.ReactNode {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const todoItems: ScheduleItem[] = todos
    .map((todo) => {
      const completedAt =
        todo.is_completed === 1 && todo.completed_at ? new Date(todo.completed_at) : null
      const dueAt =
        todo.due_date && hasTime(todo.due_date) ? new Date(todo.due_date) : null

      // Prefer completed_at when completed today; otherwise fall back to due_date time
      let schedDate: Date | null = null
      if (completedAt && isSameDay(completedAt, today)) {
        schedDate = completedAt
      } else if (dueAt && isSameDay(dueAt, today)) {
        schedDate = dueAt
      }

      if (!schedDate) return null
      return {
        kind: 'todo' as const,
        id: `todo-${todo.id}`,
        start: schedDate,
        end: null,
        allDay: false as const,
        title: todo.title,
        priority: todo.priority,
        isCompleted: todo.is_completed === 1
      }
    })
    .filter((item): item is Extract<ScheduleItem, { kind: 'todo' }> => item !== null)

  // Today view dedup 키
  // - all-day: 동일 제목의 all-day 이벤트가 오늘을 덮으면 1개로 합침 (서로 다른 다중일 범위로 겹치는 경우까지 처리)
  // - 시간 지정 이벤트: 제목+시작+종료가 같을 때만 중복 제거
  const todayDedupKey = (e: CalendarEvent): string =>
    e.allDay ? `ad|${e.summary}` : `t|${e.summary}|${e.start}|${e.end}`

  const seenEventKeys = new Set<string>()
  const eventItems: ScheduleItem[] = connected
    ? events
        .filter((e) => {
          if (!e.start) return false
          const startDate = new Date(e.start)
          if (e.allDay) {
            const endDate = e.end ? new Date(e.end) : startDate
            if (
              !(
                isSameDay(startDate, today) ||
                (isBefore(startDate, today) && isAfter(endDate, today))
              )
            ) {
              return false
            }
          } else if (!isSameDay(startDate, today)) {
            return false
          }
          const key = todayDedupKey(e)
          if (seenEventKeys.has(key)) return false
          seenEventKeys.add(key)
          return true
        })
        .map((e) => ({
          kind: 'event' as const,
          id: `event-${e.id}`,
          start: e.allDay ? null : new Date(e.start),
          end: e.allDay ? null : new Date(e.end),
          allDay: e.allDay,
          title: e.summary,
          location: e.location
        }))
    : []

  const allItems = [...eventItems, ...todoItems].sort((a, b) => {
    // All-day events first
    if (a.allDay && !b.allDay) return -1
    if (!a.allDay && b.allDay) return 1
    if (a.allDay && b.allDay) return 0
    const ta = a.start ? a.start.getTime() : 0
    const tb = b.start ? b.start.getTime() : 0
    return ta - tb
  })

  if (allItems.length === 0) {
    return (
      <Card>
        <EmptyState compact>
          {connected
            ? 'No events scheduled for today'
            : "Connect Google Calendar to view today's schedule"}
        </EmptyState>
      </Card>
    )
  }

  const isCurrent = (item: ScheduleItem): boolean => {
    if (item.allDay) return true
    if (item.kind === 'event' && item.start && item.end) {
      return isAfter(now, item.start) && isBefore(now, item.end)
    }
    return false
  }

  const getTimeDisplay = (item: ScheduleItem): string => {
    if (item.allDay) return 'All Day'
    if (!item.start) return ''
    if (item.kind === 'todo') {
      return format(item.start, 'HH:mm')
    }
    const start = format(item.start, 'HH:mm')
    const end = item.end ? format(item.end, 'HH:mm') : ''
    return end ? `${start} - ${end}` : start
  }

  const priorityDotClass = (priority: 'low' | 'medium' | 'high'): string =>
    todoPriority[priority].dot

  return (
    <Card padding="none" className="divide-y divide-gray-100">
      {allItems.map((item) => {
        const current = isCurrent(item)
        const isCompletedTodo = item.kind === 'todo' && item.isCompleted
        const rowBg = isCompletedTodo ? 'bg-green-50/40' : current ? 'bg-blue-50' : ''
        return (
          <div
            key={item.id}
            className={`flex items-center gap-4 px-4 py-3 ${rowBg}`}
          >
            <div className="w-20 text-right">
              <span
                className={`text-sm font-medium ${
                  isCompletedTodo
                    ? 'text-green-600'
                    : current
                      ? 'text-blue-600'
                      : 'text-gray-500'
                }`}
              >
                {getTimeDisplay(item)}
              </span>
            </div>
            <div
              className={`w-0.5 h-8 rounded-full ${
                item.kind === 'todo'
                  ? isCompletedTodo
                    ? 'bg-green-500'
                    : 'bg-green-300'
                  : current
                    ? 'bg-blue-500'
                    : 'bg-gray-300'
              }`}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {item.kind === 'todo' ? (
                  isCompletedTodo ? (
                    <span className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
                      <svg
                        className="w-2.5 h-2.5 text-white"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={3}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </span>
                  ) : (
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityDotClass(item.priority)}`}
                    />
                  )
                ) : null}
                <p
                  className={`text-sm font-medium truncate ${
                    isCompletedTodo
                      ? 'line-through text-gray-400'
                      : current
                        ? 'text-blue-900'
                        : 'text-gray-800'
                  }`}
                >
                  {item.title}
                </p>
                {item.kind === 'todo' ? (
                  <Badge
                    size="xs"
                    color={
                      isCompletedTodo ? 'bg-green-100 text-green-700' : 'bg-green-50 text-green-600'
                    }
                  >
                    {isCompletedTodo ? '완료' : 'TODO'}
                  </Badge>
                ) : null}
              </div>
              {item.kind === 'event' && item.location ? (
                <p className="text-xs text-gray-400 truncate">{item.location}</p>
              ) : null}
            </div>
            {current && item.kind === 'event' ? (
              <Badge color="bg-blue-100 text-blue-600">Now</Badge>
            ) : null}
          </div>
        )
      })}
    </Card>
  )
}
