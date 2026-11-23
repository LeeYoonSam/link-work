import { describe, it, expect } from 'vitest'
import type { Todo } from '../../types'
import {
  buildTodoSections,
  compareTodos,
  localDateKey,
  quickDates,
  shiftDueDate,
  todoBucket,
  todoDueText,
  viewForTodo
} from './todoModel'
import { DUE_OVERDUE, DUE_TODAY } from '../today/todayTokens'

const TODAY = '2026-11-20' // 금요일

const todo = (id: number, over: Partial<Todo> = {}): Todo => ({
  id,
  title: `할 일 ${id}`,
  priority: 'medium',
  due_date: null,
  due_reminder: 0,
  is_completed: 0,
  completed_at: null,
  notes: null,
  source_link: null,
  created_at: '2026-11-01 09:00:00',
  updated_at: '2026-11-01 09:00:00',
  tags: [],
  ...over
})

const open = [
  todo(1, { due_date: '2026-11-18' }),
  todo(2, { due_date: '2026-11-20 15:00', due_reminder: 1 }),
  todo(3, { due_date: '2026-11-20', priority: 'high' }),
  todo(4, { due_date: '2026-11-21' }),
  todo(5, { due_date: '2026-11-25 09:00', due_reminder: 1 }),
  todo(6),
  todo(7, { due_date: '2026-11-21', priority: 'low' })
]
const done = [
  todo(8, { is_completed: 1, completed_at: '2026-11-20 10:00:00' }),
  todo(9, { is_completed: 1, completed_at: '2026-11-19 18:00:00' }),
  todo(10, { is_completed: 1, completed_at: '2026-11-20 12:00:00' })
]
const input = { todos: open, completedTodos: done, today: TODAY }
const ids = (ts: Todo[]): number[] => ts.map((t) => t.id)

describe('buildTodoSections', () => {
  it('오늘 뷰: 지난 항목 + 오늘(종일 먼저, 같은 날은 우선순위)', () => {
    const s = buildTodoSections('today', input)
    expect(s.map((x) => [x.key, x.kind, x.title])).toEqual([
      ['overdue', 'overdue', '지난 항목'],
      ['today', 'today', '오늘']
    ])
    expect(ids(s[0].todos)).toEqual([1])
    expect(ids(s[1].todos)).toEqual([3, 2])
  })

  it('예정 뷰: 내일 이후 날짜별', () => {
    const s = buildTodoSections('upcoming', input)
    expect(s.map((x) => [x.key, x.kind, x.title])).toEqual([
      ['date:2026-11-21', 'date', '내일 · 11/21 (토)'],
      ['date:2026-11-25', 'date', '11/25 (수)']
    ])
    expect(ids(s[0].todos)).toEqual([4, 7])
    expect(ids(s[1].todos)).toEqual([5])
  })

  it('전체 뷰: 지남/오늘/예정/날짜 없음', () => {
    const s = buildTodoSections('all', input)
    expect(s.map((x) => x.key)).toEqual(['overdue', 'today', 'later', 'none'])
    expect(s.map((x) => x.kind)).toEqual(['overdue', 'today', 'date', 'none'])
    expect(ids(s[2].todos)).toEqual([4, 7, 5])
    expect(ids(s[3].todos)).toEqual([6])
  })

  it('완료 뷰: 완료 날짜별, 최근 먼저', () => {
    const s = buildTodoSections('done', input)
    expect(s.map((x) => [x.key, x.kind, x.title])).toEqual([
      ['done:2026-11-20', 'done', '오늘'],
      ['done:2026-11-19', 'done', '어제 · 11/19 (목)']
    ])
    expect(ids(s[0].todos)).toEqual([10, 8])
    expect(ids(s[1].todos)).toEqual([9])
  })

  it('빈 구획은 내지 않는다', () => {
    expect(buildTodoSections('today', { todos: [open[1]], completedTodos: [], today: TODAY }).map((x) => x.key)).toEqual([
      'today'
    ])
    expect(buildTodoSections('upcoming', { todos: [open[0], open[5]], completedTodos: [], today: TODAY })).toEqual([])
    expect(buildTodoSections('done', { todos: open, completedTodos: [], today: TODAY })).toEqual([])
  })

  it('미완료 목록에 섞인 완료 항목은 뷰에 넣지 않는다', () => {
    const s = buildTodoSections('all', { todos: [...open, done[0]], completedTodos: [], today: TODAY })
    expect(s.flatMap((x) => ids(x.todos))).not.toContain(8)
  })
})

describe('viewForTodo', () => {
  it('완료→done, 지남·오늘→today, 내일 이후→upcoming, 날짜 없음→all', () => {
    expect(viewForTodo(done[0], TODAY)).toBe('done')
    expect(viewForTodo(open[0], TODAY)).toBe('today')
    expect(viewForTodo(open[1], TODAY)).toBe('today')
    expect(viewForTodo(open[3], TODAY)).toBe('upcoming')
    expect(viewForTodo(open[5], TODAY)).toBe('all')
  })
})

describe('compareTodos', () => {
  it('마감(없으면 뒤) → 우선순위 → 생성 시각 → id', () => {
    const list = [
      todo(1),
      todo(2, { due_date: '2026-11-20 09:00' }),
      todo(3, { due_date: '2026-11-20' }),
      todo(4, { due_date: '2026-11-20', priority: 'high' }),
      todo(5, { due_date: '2026-11-20', priority: 'high', created_at: '2026-10-01 00:00:00' }),
      todo(6, { due_date: '2026-11-19', priority: 'low' })
    ]
    expect(ids([...list].sort(compareTodos))).toEqual([6, 5, 4, 3, 2, 1])
  })

  it('모든 값이 같으면 id 순', () => {
    expect(compareTodos(todo(2), todo(1))).toBeGreaterThan(0)
    expect(compareTodos(todo(1), todo(1))).toBe(0)
  })
})

describe('shiftDueDate', () => {
  it('시각이 있던 항목은 시각을 유지하고 알림을 켠다', () => {
    expect(shiftDueDate('2026-11-18 14:30', '2026-11-20')).toEqual({ due_date: '2026-11-20 14:30', due_reminder: 1 })
  })
  it('날짜만 있던 항목은 날짜만 바꾼다', () => {
    expect(shiftDueDate('2026-11-18', '2026-11-20')).toEqual({ due_date: '2026-11-20', due_reminder: 0 })
    expect(shiftDueDate(null, '2026-11-20')).toEqual({ due_date: '2026-11-20', due_reminder: 0 })
  })
  it('대상이 null 이면 마감을 지운다', () => {
    expect(shiftDueDate('2026-11-18 14:30', null)).toEqual({ due_date: null, due_reminder: 0 })
  })
})

describe('todoDueText', () => {
  it('today 없이: 기존 TodoCard 표시 그대로', () => {
    expect(todoDueText({ dueDate: null, bucket: 'none' })).toBeNull()
    expect(todoDueText({ dueDate: '2026-11-18', bucket: 'overdue' })).toEqual({ text: '11/18 지남', cls: DUE_OVERDUE })
    expect(todoDueText({ dueDate: '2026-11-20 15:00', bucket: 'today' })).toEqual({ text: '오늘', cls: DUE_TODAY })
    expect(todoDueText({ dueDate: '2026-11-21 09:00', bucket: 'later' })).toEqual({ text: '11/21', cls: 'text-gray-500' })
  })

  it('today 를 주면 내일·시각을 붙인다', () => {
    expect(todoDueText({ dueDate: '2026-11-20 15:00', bucket: 'today' }, TODAY)?.text).toBe('오늘 15:00')
    expect(todoDueText({ dueDate: '2026-11-21 09:00', bucket: 'later' }, TODAY)?.text).toBe('내일 09:00')
    expect(todoDueText({ dueDate: '2026-11-21', bucket: 'later' }, TODAY)?.text).toBe('내일')
    expect(todoDueText({ dueDate: '2026-11-25', bucket: 'later' }, TODAY)?.text).toBe('11/25')
    expect(todoDueText({ dueDate: '2026-11-18 10:00', bucket: 'overdue' }, TODAY)).toEqual({
      text: '11/18 지남',
      cls: DUE_OVERDUE
    })
  })
})

describe('todoBucket·localDateKey·quickDates', () => {
  it('todoBucket 은 날짜 앞 10자로 판정한다', () => {
    expect(todoBucket(null, TODAY)).toBe('none')
    expect(todoBucket('2026-11-19 23:59', TODAY)).toBe('overdue')
    expect(todoBucket('2026-11-20 00:00', TODAY)).toBe('today')
    expect(todoBucket('2026-11-20', TODAY)).toBe('today')
    expect(todoBucket('2026-11-21', TODAY)).toBe('later')
  })

  it('localDateKey 는 로컬 날짜', () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })

  it('quickDates: 다음 주는 다음 월요일', () => {
    expect(quickDates(new Date(2026, 10, 20, 10))).toEqual({
      today: '2026-11-20',
      tomorrow: '2026-11-21',
      nextWeek: '2026-11-23'
    })
    // 월요일이면 7일 뒤, 일요일이면 다음 날
    expect(quickDates(new Date(2026, 10, 23)).nextWeek).toBe('2026-11-30')
    expect(quickDates(new Date(2026, 10, 22)).nextWeek).toBe('2026-11-23')
    // 달·해 넘김
    expect(quickDates(new Date(2026, 11, 31)).tomorrow).toBe('2027-01-01')
  })
})
