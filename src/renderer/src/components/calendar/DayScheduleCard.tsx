import { useMemo, useState } from 'react'
import { format, isAfter, isBefore, isSameDay } from 'date-fns'
import type { CalendarEvent } from '../../stores/calendarStore'
import type { Todo } from '../../types'
import { eventsForDay, todosForDay, type TodoScheduleItem } from '../../utils/schedule'
import MarkdownContent from '../memo/MarkdownContent'
import { Badge, todoPriority } from '../ui'

// 캘린더 메뉴(주간 뷰)와 대시보드(오늘 일정)가 공유하는 "하루치 일정 카드".
// 두 화면이 같은 컴포넌트를 쓰기 때문에 아이템 판정·정렬·표시가 구조적으로 동일하다.

const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토']

// 일정 설명 / TODO 메모: 기본은 접힌 미리보기, "더 보기"로 펼친다.
function CollapsibleNote({ content, allowHtml }: { content: string; allowHtml?: boolean }): React.ReactNode {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <div className={`mt-1 ${expanded ? '' : 'max-h-[3.25rem] overflow-hidden'}`}>
        <MarkdownContent
          content={content}
          allowHtml={allowHtml}
          compact
          // 일정 행은 조밀하므로 본문 텍스트를 xs/회색으로 낮춰 제목보다 덜 튀게 한다.
          className="break-words [&_p]:text-xs [&_p]:text-gray-600 [&_li]:text-xs [&_li]:text-gray-600 [&_ul]:text-xs [&_ol]:text-xs"
        />
      </div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-[11px] text-blue-600 hover:text-blue-700 mt-1"
      >
        {expanded ? '접기' : '더 보기'}
      </button>
    </>
  )
}

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
        {hasDescription && <CollapsibleNote content={event.description!} allowHtml />}
        {event.location && (
          <p className="text-[11px] text-gray-400 mt-1 truncate" title={event.location}>
            {event.location}
          </p>
        )}
      </div>
    </article>
  )
}

// TODO 행: 일정 행과 동일한 타임라인 레이아웃을 쓰되 색상/배지로 구분한다.
function TodoRow({ item, onSelect }: { item: TodoScheduleItem; onSelect?: (todo: Todo) => void }): React.ReactNode {
  const { todo, at, isCompleted } = item
  const clickable = Boolean(onSelect)

  return (
    <article
      onClick={onSelect ? () => onSelect(todo) : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(todo)
              }
            }
          : undefined
      }
      title={clickable ? 'TODO 메뉴에서 보기' : undefined}
      className={`flex gap-3 px-4 py-2.5 ${isCompleted ? 'bg-green-50/40' : ''} ${
        clickable ? 'cursor-pointer hover:bg-blue-50/40 transition-colors' : ''
      }`}
    >
      <span
        className={`w-24 shrink-0 text-xs tabular-nums pt-0.5 text-right ${
          isCompleted ? 'text-green-600' : 'text-gray-500'
        }`}
      >
        {format(at, 'HH:mm')}
      </span>
      <div
        className={`w-0.5 self-stretch rounded-full ${isCompleted ? 'bg-green-500' : 'bg-green-300'}`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {isCompleted ? (
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
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${todoPriority[todo.priority].dot}`}
            />
          )}
          <h4
            className={`font-medium text-sm truncate ${
              isCompleted ? 'line-through text-gray-400' : 'text-gray-900'
            }`}
            title={todo.title}
          >
            {todo.title}
          </h4>
          <Badge
            size="xs"
            color={isCompleted ? 'bg-green-100 text-green-700' : 'bg-green-50 text-green-600'}
          >
            {isCompleted ? '완료' : 'TODO'}
          </Badge>
        </div>
        {todo.notes ? <CollapsibleNote content={todo.notes} /> : null}
      </div>
    </article>
  )
}

interface Props {
  day: Date
  now: Date
  events: CalendarEvent[]
  // 대시보드에서만 전달 (캘린더 주간 뷰에는 TODO를 섞지 않는다)
  todos?: Todo[]
  onSelectTodo?: (todo: Todo) => void
  cardRef?: React.Ref<HTMLDivElement>
}

export default function DayScheduleCard({
  day,
  now,
  events,
  todos,
  onSelectTodo,
  cardRef
}: Props): React.ReactNode {
  const dayEvents = useMemo(() => eventsForDay(events, day), [events, day])
  const todoItems = useMemo(() => (todos ? todosForDay(todos, day) : []), [todos, day])

  const isToday = isSameDay(day, now)
  const allDayEvents = dayEvents.filter((e) => e.allDay)
  const timedEvents = dayEvents.filter((e) => !e.allDay)

  const isCurrentEvent = (event: CalendarEvent): boolean => {
    if (event.allDay) return false
    return isAfter(now, new Date(event.start)) && isBefore(now, new Date(event.end))
  }

  const getEventTimeDisplay = (event: CalendarEvent): string => {
    if (event.allDay) return 'All Day'
    const start = format(new Date(event.start), 'HH:mm')
    const end = format(new Date(event.end), 'HH:mm')
    return `${start} - ${end}`
  }

  // 시간 지정 일정과 TODO를 하나의 타임라인으로 병합 (동시각이면 일정 먼저)
  type Row = { key: string; at: number; order: number; node: React.ReactNode }
  const rows: Row[] = [
    ...timedEvents.map((event) => ({
      key: `event-${event.id}`,
      at: new Date(event.start).getTime(),
      order: 0,
      node: (
        <EventRow
          event={event}
          current={isCurrentEvent(event)}
          timeText={getEventTimeDisplay(event)}
        />
      )
    })),
    ...todoItems.map((item) => ({
      key: `todo-${item.todo.id}`,
      at: item.at.getTime(),
      order: 1,
      node: <TodoRow item={item} onSelect={onSelectTodo} />
    }))
  ].sort((a, b) => a.at - b.at || a.order - b.order)

  const itemCount = dayEvents.length + todoItems.length

  return (
    <div
      ref={cardRef}
      className={`rounded-lg border bg-white overflow-hidden ${
        isToday ? 'border-blue-300 ring-1 ring-blue-200' : 'border-gray-200'
      }`}
    >
      <div
        className={`flex items-center gap-2 px-4 py-2.5 ${
          rows.length > 0 ? 'border-b border-gray-100' : ''
        }`}
      >
        <span className={`text-sm font-semibold ${isToday ? 'text-blue-700' : 'text-gray-700'}`}>
          {DAY_LABELS[day.getDay()]} {format(day, 'MM-dd')}
        </span>
        {isToday && (
          <Badge color="bg-blue-100 text-blue-700" size="xs">
            오늘
          </Badge>
        )}
        {/* 종일 일정은 별도 행 대신 헤더의 컴팩트 칩으로 */}
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
          {itemCount === 0 ? '일정 없음' : `${itemCount}개 일정`}
        </span>
      </div>

      {rows.length > 0 && (
        <div className="divide-y divide-gray-50">
          {rows.map((row) => (
            <div key={row.key}>{row.node}</div>
          ))}
        </div>
      )}
    </div>
  )
}
