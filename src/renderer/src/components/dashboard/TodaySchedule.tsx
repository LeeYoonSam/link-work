import type { CalendarEvent } from '../../stores/calendarStore'
import type { Todo } from '../../types'
import DayScheduleCard from '../calendar/DayScheduleCard'
import { Card, EmptyState } from '../ui'

interface Props {
  events: CalendarEvent[]
  connected: boolean
  todos?: Todo[]
  onSelectTodo?: (todo: Todo) => void
  // 일정을 거르는 날짜다. 없으면 지금의 달력 날짜를 쓴다
  day?: Date
}

// 홈(계획 없음)의 "오늘 일정". HomeSchedule 이 그린다.
// 캘린더 메뉴와 완전히 같은 아이템/모양이 나오도록 주간 뷰와 동일한 DayScheduleCard를 쓰고,
// 여기에 오늘의 TODO만 타임라인에 함께 얹는다.
// day 를 받으면 그 날짜로 일정과 TODO 를 거른다. 홈은 논리 날짜를 넘긴다.
export default function TodaySchedule({
  events,
  connected,
  todos = [],
  onSelectTodo,
  day
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
      day={day ?? now}
      now={now}
      events={connected ? events : []}
      todos={todos}
      onSelectTodo={onSelectTodo}
    />
  )
}
