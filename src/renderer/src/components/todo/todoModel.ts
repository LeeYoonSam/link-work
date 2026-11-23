// 할 일 공용 순수 모델. 할 일 화면·오늘 대시보드·빠른 추가가 같은 규칙을 쓴다.
// React·스토어·window 를 쓰지 않는다. 오늘 날짜(today)·현재 시각(now)은 호출부가 넘긴다.
// due_date 형식은 'YYYY-MM-DD' 또는 'YYYY-MM-DD HH:mm' 이다. 시각이 있으면 due_reminder=1, 없으면 0 이다(알림 규약).
import type { Todo, TodoPriority } from '../../types'
import { DUE_OVERDUE, DUE_TODAY } from '../today/todayTokens'

export type TodoBucket = 'overdue' | 'today' | 'later' | 'none'

export type TodoViewKey = 'today' | 'upcoming' | 'all' | 'done'

export interface TodoSection {
  key: string
  title: string
  kind: 'overdue' | 'today' | 'date' | 'none' | 'done'
  todos: Todo[]
}

export const PRIORITY_RANK: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 }

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 로컬 시각 기준 'YYYY-MM-DD' */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 'YYYY-MM-DD' 를 로컬 자정 Date 로 읽는다. 형식이 틀리면 null */
function parseDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** 'YYYY-MM-DD' 에 n 일을 더한다 */
function addDays(day: string, n: number): string {
  const d = parseDay(day)
  if (!d) return day
  d.setDate(d.getDate() + n)
  return localDateKey(d)
}

/** 'YYYY-MM-DD' → 'M/D' */
const md = (day: string): string => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day)
  return m ? `${Number(m[1])}/${Number(m[2])}` : day
}

/** 'YYYY-MM-DD' → 'M/D (요일)' */
function mdWeekday(day: string): string {
  const d = parseDay(day)
  return d ? `${md(day)} (${WEEKDAYS[d.getDay()]})` : day
}

/** due_date 의 시각 'HH:mm'. 없으면 null */
function dueTime(due: string | null): string | null {
  if (!due) return null
  const m = /^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/.exec(due)
  return m ? m[1] : null
}

/** 마감 묶음. due 앞 10자(날짜)로만 판정한다 */
export function todoBucket(due: string | null, today: string): TodoBucket {
  if (!due) return 'none'
  const day = due.slice(0, 10)
  if (day < today) return 'overdue'
  if (day === today) return 'today'
  return 'later'
}

/**
 * 마감 표시. 지남은 빨강 'M/D 지남', 오늘은 앰버 '오늘', 그 밖은 회색 'M/D'.
 * today 를 주면 내일 마감은 '내일' 로 쓰고, 시각이 있는 마감(지남 제외)은 뒤에 ' HH:mm' 을 붙인다
 */
export function todoDueText(
  row: { dueDate: string | null; bucket: TodoBucket },
  today?: string
): { text: string; cls: string } | null {
  if (!row.dueDate) return null
  const day = row.dueDate.slice(0, 10)
  const m = day.match(/^\d{4}-(\d{2})-(\d{2})$/)
  const mdText = m ? `${Number(m[1])}/${Number(m[2])}` : row.dueDate
  if (row.bucket === 'overdue') return { text: `${mdText} 지남`, cls: DUE_OVERDUE }
  const time = today !== undefined ? dueTime(row.dueDate) : null
  const withTime = (s: string): string => (time ? `${s} ${time}` : s)
  if (row.bucket === 'today') return { text: withTime('오늘'), cls: DUE_TODAY }
  if (today !== undefined && day === addDays(today, 1)) return { text: withTime('내일'), cls: 'text-gray-500' }
  return { text: withTime(mdText), cls: 'text-gray-500' }
}

/** 정렬: 마감(없으면 뒤, 시각 포함 문자열 비교) → 우선순위 → 생성 시각 → id */
export function compareTodos(a: Todo, b: Todo): number {
  if (a.due_date !== b.due_date) {
    if (!a.due_date) return 1
    if (!b.due_date) return -1
    const c = a.due_date.localeCompare(b.due_date)
    if (c !== 0) return c
  }
  return (
    (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) ||
    a.created_at.localeCompare(b.created_at) ||
    a.id - b.id
  )
}

/** 완료 항목 정렬: 완료 시각 최근 먼저 → id 큰 것 먼저 */
function compareDone(a: Todo, b: Todo): number {
  return (b.completed_at ?? '').localeCompare(a.completed_at ?? '') || b.id - a.id
}

/** 날짜 구획 제목. 오늘·내일·어제는 말로, 그 밖은 'M/D (요일)' */
function dayTitle(day: string, today: string): string {
  if (day === today) return '오늘'
  if (day === addDays(today, 1)) return `내일 · ${mdWeekday(day)}`
  if (day === addDays(today, -1)) return `어제 · ${mdWeekday(day)}`
  return mdWeekday(day)
}

/** 날짜별로 묶는다. 입력 순서를 지킨다 */
function groupByDay(todos: Todo[], dayOf: (t: Todo) => string): Map<string, Todo[]> {
  const map = new Map<string, Todo[]>()
  for (const t of todos) {
    const day = dayOf(t)
    const list = map.get(day)
    if (list) list.push(t)
    else map.set(day, [t])
  }
  return map
}

/**
 * 뷰별 구획을 만든다. 빈 구획은 내지 않는다.
 * - today: 지난 항목 + 오늘
 * - upcoming: 내일 이후, 날짜별
 * - all: 지난 항목 / 오늘 / 예정 / 날짜 없음
 * - done: 완료 날짜별(최근 먼저)
 */
export function buildTodoSections(
  view: TodoViewKey,
  input: { todos: Todo[]; completedTodos: Todo[]; today: string }
): TodoSection[] {
  const { today } = input
  if (view === 'done') {
    const done = input.completedTodos.filter((t) => t.is_completed).slice().sort(compareDone)
    const groups = groupByDay(done, (t) => (t.completed_at ? t.completed_at.slice(0, 10) : ''))
    const sections: TodoSection[] = []
    for (const [day, todos] of groups) {
      if (!day) continue
      sections.push({ key: `done:${day}`, title: dayTitle(day, today), kind: 'done', todos })
    }
    const undated = groups.get('')
    if (undated) sections.push({ key: 'done:none', title: '완료 날짜 없음', kind: 'done', todos: undated })
    return sections
  }

  const open = input.todos.filter((t) => !t.is_completed).slice().sort(compareTodos)
  const by: Record<TodoBucket, Todo[]> = { overdue: [], today: [], later: [], none: [] }
  for (const t of open) by[todoBucket(t.due_date, today)].push(t)

  const sections: TodoSection[] = []
  const push = (s: TodoSection): void => {
    if (s.todos.length > 0) sections.push(s)
  }
  if (view === 'today' || view === 'all') {
    push({ key: 'overdue', title: '지난 항목', kind: 'overdue', todos: by.overdue })
    push({ key: 'today', title: '오늘', kind: 'today', todos: by.today })
  }
  if (view === 'upcoming') {
    const groups = groupByDay(by.later, (t) => (t.due_date ?? '').slice(0, 10))
    for (const [day, todos] of groups) {
      push({ key: `date:${day}`, title: dayTitle(day, today), kind: 'date', todos })
    }
  }
  if (view === 'all') {
    push({ key: 'later', title: '예정', kind: 'date', todos: by.later })
    push({ key: 'none', title: '날짜 없음', kind: 'none', todos: by.none })
  }
  return sections
}

/** 이 할 일이 보이는 뷰. 딥링크로 도착했을 때 뷰를 고르는 데 쓴다 */
export function viewForTodo(todo: Todo, today: string): TodoViewKey {
  if (todo.is_completed) return 'done'
  const b = todoBucket(todo.due_date, today)
  if (b === 'overdue' || b === 'today') return 'today'
  if (b === 'later') return 'upcoming'
  return 'all'
}

/** 빠른 날짜. nextWeek 은 다음 월요일(오늘이 월요일이면 7일 뒤) */
export function quickDates(now: Date): { today: string; tomorrow: string; nextWeek: string } {
  const today = localDateKey(now)
  const toMonday = (8 - now.getDay()) % 7 || 7
  return { today, tomorrow: addDays(today, 1), nextWeek: addDays(today, toMonday) }
}

/** 마감 날짜만 옮긴다. 시각이 있던 항목은 시각을 유지하고 due_reminder 1 */
export function shiftDueDate(
  due: string | null,
  targetDate: string | null
): { due_date: string | null; due_reminder: number } {
  if (!targetDate) return { due_date: null, due_reminder: 0 }
  const time = dueTime(due)
  if (time) return { due_date: `${targetDate} ${time}`, due_reminder: 1 }
  return { due_date: targetDate, due_reminder: 0 }
}
