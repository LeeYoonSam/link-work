import { useEffect, useMemo } from 'react'
import { useCalendarStore, useWeekEvents, weekKey } from '../../stores/calendarStore'
import { useTodoStore } from '../../stores/todoStore'
import { useProjectStore } from '../../stores/projectStore'
import type { Todo } from '../../types'
import { SectionTitle } from '../ui'
import TodaySchedule from './TodaySchedule'

// 'YYYY-MM-DD' 를 로컬 자정 Date 로 바꾼다. 값이 없거나 형식이 틀리면 now 를 돌려준다
export function homeBaseDate(logicalDate: string | null | undefined, now: Date = new Date()): Date {
  const m = logicalDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return now
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

// 홈('오늘' 화면)의 오늘 일정. 오늘 계획이 없을 때만 그린다.
// 계획이 있으면 시간표가 같은 자리를 맡는다. 그래서 일정은 화면에 1번만 보인다.
// 기준 날짜는 logicalDate 다. 없으면 로컬 날짜다.
// 조회 주차와 일정을 거르는 날짜가 모두 이 기준 날짜를 쓴다.
// 이유: 날짜 경계 전 새벽에는 논리 날짜가 전날이다. 둘이 다르면 월요일 새벽에 0건이 된다.
export default function HomeSchedule({
  logicalDate
}: {
  logicalDate?: string | null
}): React.ReactNode {
  const { status, fetchEvents, fetchStatus } = useCalendarStore()
  const { activeTodos, fetchActiveTodos, setSelectedTodoId, setFilterTagId } = useTodoStore()
  const { setView } = useProjectStore()
  const base = useMemo(() => homeBaseDate(logicalDate), [logicalDate])
  const baseWeek = weekKey(base)
  const events = useWeekEvents(base)

  useEffect(() => {
    void fetchStatus()
    void fetchActiveTodos()
  }, [])

  useEffect(() => {
    if (status.connected) void fetchEvents(base)
  }, [status.connected, baseWeek])

  // 일정 타임라인의 TODO 행을 누르면 할 일 메뉴에서 그 항목을 고른다.
  // 필터 태그가 있으면 선택 항목이 가려진다. 그래서 필터를 함께 비운다
  const selectTodo = (todo: Todo): void => {
    setFilterTagId(null)
    setSelectedTodoId(todo.id)
    setView('todos')
  }

  return (
    <section id="home-schedule">
      <SectionTitle variant="page" className="mb-3">오늘 일정</SectionTitle>
      <TodaySchedule
        events={events}
        connected={status.connected}
        todos={activeTodos}
        onSelectTodo={selectTodo}
        day={base}
      />
    </section>
  )
}
