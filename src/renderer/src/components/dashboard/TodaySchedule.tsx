import type { CalendarEvent } from '../../stores/calendarStore'
import type { Todo } from '../../types'
import DayScheduleCard from '../calendar/DayScheduleCard'
import { Card, EmptyState } from '../ui'

interface Props {
  events: CalendarEvent[]
  connected: boolean
  todos?: Todo[]
  onSelectTodo?: (todo: Todo) => void
}

// 대시보드의 "오늘 일정".
// 캘린더 메뉴와 완전히 같은 아이템/모양이 나오도록 주간 뷰와 동일한 DayScheduleCard를 쓰고,
// 여기에 오늘의 TODO만 타임라인에 함께 얹는다.
export default function TodaySchedule({
  events,
  connected,
  todos = [],
  onSelectTodo
}: Props): React.ReactNode {
  const now = new Date()

  if (!connected && todos.length === 0) {
    return (
      <Card>
        <EmptyState compact>Connect Google Calendar to view today&apos;s schedule</EmptyState>
      </Card>
    )
  }

  return (
    <DayScheduleCard
      day={now}
      now={now}
      events={connected ? events : []}
      todos={todos}
      onSelectTodo={onSelectTodo}
    />
  )
}
