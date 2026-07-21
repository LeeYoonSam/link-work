import { addDays, isSameDay, startOfDay } from 'date-fns'
import type { CalendarEvent } from '../stores/calendarStore'
import type { Todo } from '../types'

// 캘린더 메뉴(주간 뷰)와 대시보드(오늘 뷰)가 같은 아이템을 보여주도록
// "특정 날짜에 속하는 일정" 판정을 이 모듈 한 곳에서만 정의한다.

// 종일 이벤트의 날짜 문자열("YYYY-MM-DD")을 로컬 자정 Date로 파싱한다.
// new Date("YYYY-MM-DD")는 UTC 자정으로 해석돼 KST 등 동쪽 타임존에서 하루 경계가
// 밀리는(어제 종일 일정이 오늘로 새어 들어오는) 문제가 생기므로 직접 분해해 로컬 기준으로 만든다.
export function parseAllDayDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return new Date(s)
}

// 해당 이벤트가 주어진 날짜에 표시되어야 하는지 판정한다.
// 종일 이벤트: Google의 종료일(end.date)은 배타적(exclusive)이므로 반열린 구간
//   [시작일, 종료일)로 판정한다. 그래야 여러 날에 걸친 종일 일정이 중간 날에도 보인다.
// 시간 지정 이벤트: 시작 시각이 같은 날인지로 판정한다.
export function occursOnDay(event: CalendarEvent, day: Date): boolean {
  if (!event.start) return false
  const d = startOfDay(day)
  if (event.allDay) {
    const startDay = parseAllDayDate(event.start)
    const endExclusive = event.end ? parseAllDayDate(event.end) : addDays(startDay, 1)
    return d >= startDay && d < endExclusive
  }
  return isSameDay(new Date(event.start), d)
}

// 중복 제거 키
// - 종일: 동일 제목이 같은 날을 덮으면 1개로 합침 (서로 다른 다중일 범위로 겹치는 경우까지 처리)
// - 시간 지정: 제목+시작+종료가 모두 같을 때만 중복으로 본다
export function eventDedupKey(e: CalendarEvent): string {
  return e.allDay ? `ad|${e.summary}` : `t|${e.summary}|${e.start}|${e.end}`
}

// 정렬: 종일 먼저, 그다음 시작 시각 오름차순
function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  if (a.allDay && !b.allDay) return -1
  if (!a.allDay && b.allDay) return 1
  if (a.allDay && b.allDay) return 0
  return new Date(a.start).getTime() - new Date(b.start).getTime()
}

export function eventsForDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const seen = new Set<string>()
  const result: CalendarEvent[] = []
  for (const e of events) {
    if (!occursOnDay(e, day)) continue
    const key = eventDedupKey(e)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(e)
  }
  return result.sort(compareEvents)
}

export interface TodoScheduleItem {
  todo: Todo
  // 타임라인에 배치될 시각
  at: Date
  isCompleted: boolean
}

function hasTime(dueDate: string): boolean {
  return /\s\d{2}:\d{2}/.test(dueDate)
}

// 해당 날짜의 타임라인에 올릴 TODO를 고른다.
// 그 날 완료된 것은 완료 시각에, 아니면 마감 시각(시간이 지정된 경우)에 배치한다.
export function todosForDay(todos: Todo[], day: Date): TodoScheduleItem[] {
  const items: TodoScheduleItem[] = []
  for (const todo of todos) {
    const completedAt =
      todo.is_completed === 1 && todo.completed_at ? new Date(todo.completed_at) : null
    const dueAt = todo.due_date && hasTime(todo.due_date) ? new Date(todo.due_date) : null

    let at: Date | null = null
    if (completedAt && isSameDay(completedAt, day)) {
      at = completedAt
    } else if (dueAt && isSameDay(dueAt, day)) {
      at = dueAt
    }
    if (!at) continue

    items.push({ todo, at, isCompleted: todo.is_completed === 1 })
  }
  return items.sort((a, b) => a.at.getTime() - b.at.getTime())
}
