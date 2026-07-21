import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { addDays, format, startOfDay } from 'date-fns'
import TodaySchedule from './TodaySchedule'
import DayScheduleCard from '../calendar/DayScheduleCard'
import type { CalendarEvent } from '../../stores/calendarStore'
import type { Todo } from '../../types'

// 대시보드의 "오늘 일정"이 캘린더 메뉴의 오늘 카드와 동일한 아이템/모양으로 나오는지 검증한다.
// 캘린더 메뉴(CalendarView)는 주간 각 날짜를 DayScheduleCard로 그리므로,
// 같은 이벤트 배열로 오늘 날짜 카드를 렌더한 것이 곧 "캘린더 메뉴가 오늘 보여주는 것"이다.

const today = startOfDay(new Date())
const day = (offset: number): string => format(addDays(today, offset), 'yyyy-MM-dd')
const at = (hh: number, mm = 0): string =>
  format(new Date(today.getFullYear(), today.getMonth(), today.getDate(), hh, mm), "yyyy-MM-dd'T'HH:mm:ss")

const EVENTS: CalendarEvent[] = [
  {
    id: 'e1',
    summary: '데일리 스탠드업',
    description: '<ul><li>PRD : <a href="https://docs.example.com/prd">기획서</a></li><li>WBS : TBU</li></ul>',
    start: at(10),
    end: at(10, 30),
    allDay: false,
    location: '회의실 A'
  },
  {
    id: 'e2',
    summary: '스프린트 리뷰',
    description: '지난 스프린트 회고',
    start: at(15),
    end: at(16),
    allDay: false
  },
  // 여러 날에 걸친 종일 일정 (어제 시작 → 내일 종료, 오늘도 걸쳐 있음)
  {
    id: 'e3',
    summary: '워크샵 주간',
    start: day(-1),
    end: day(1),
    allDay: true
  },
  // 오늘과 무관한 일정 (양쪽 모두에서 제외되어야 함)
  {
    id: 'e4',
    summary: '다음 주 회의',
    start: format(addDays(today, 3), "yyyy-MM-dd'T'HH:mm:ss"),
    end: format(addDays(today, 3), "yyyy-MM-dd'T'HH:mm:ss"),
    allDay: false
  }
]

const TODOS: Todo[] = [
  {
    id: 1,
    title: '릴리즈 노트 작성',
    priority: 'high',
    due_date: format(today, 'yyyy-MM-dd 14:00'),
    due_reminder: 0,
    is_completed: 0,
    completed_at: null,
    notes: '변경사항 정리 후 공유',
    created_at: at(9),
    updated_at: at(9)
  }
]

const renderDashboard = (todos: Todo[] = []): string =>
  renderToStaticMarkup(<TodaySchedule events={EVENTS} connected todos={todos} />)

// 캘린더 메뉴가 오늘 날짜에 대해 렌더하는 카드
const renderCalendarToday = (): string => {
  const now = new Date()
  return renderToStaticMarkup(<DayScheduleCard day={now} now={now} events={EVENTS} />)
}

describe('대시보드 오늘 일정 vs 캘린더 메뉴', () => {
  it('TODO가 없으면 캘린더 메뉴의 오늘 카드와 완전히 동일한 마크업을 낸다', () => {
    expect(renderDashboard()).toBe(renderCalendarToday())
  })

  it('오늘 일정만 포함한다 (다른 날 일정 제외)', () => {
    const html = renderDashboard()
    expect(html).toContain('데일리 스탠드업')
    expect(html).toContain('스프린트 리뷰')
    expect(html).not.toContain('다음 주 회의')
  })

  it('여러 날에 걸친 종일 일정을 오늘 헤더 칩으로 보여준다', () => {
    const html = renderDashboard()
    expect(html).toContain('워크샵 주간')
    expect(html).toContain('All Day')
  })

  it('일정 설명(메모)을 캘린더와 동일하게 마크다운/HTML로 렌더한다', () => {
    const html = renderDashboard()
    // raw 태그가 그대로 노출되지 않고 실제 리스트/링크로 렌더됨
    expect(html).toContain('<li')
    expect(html).toContain('href="https://docs.example.com/prd"')
    expect(html).not.toContain('&lt;ul&gt;')
    expect(html).toContain('지난 스프린트 회고')
    // 길이가 긴 설명을 위한 접기/펼치기 토글
    expect(html).toContain('더 보기')
  })

  it('일정 시간과 장소를 캘린더와 동일한 형식으로 보여준다', () => {
    const html = renderDashboard()
    expect(html).toContain('10:00 - 10:30')
    expect(html).toContain('15:00 - 16:00')
    expect(html).toContain('회의실 A')
  })

  it('TODO를 시간순으로 일정 사이에 끼워 넣는다', () => {
    const html = renderDashboard(TODOS)
    const standup = html.indexOf('데일리 스탠드업')
    const todo = html.indexOf('릴리즈 노트 작성')
    const review = html.indexOf('스프린트 리뷰')
    expect(standup).toBeGreaterThan(-1)
    expect(todo).toBeGreaterThan(standup) // 10:00 < 14:00
    expect(review).toBeGreaterThan(todo) // 14:00 < 15:00
    // TODO 메모도 함께 노출
    expect(html).toContain('변경사항 정리 후 공유')
  })

  it('TODO를 추가해도 일정 아이템 자체는 캘린더와 동일하게 유지된다', () => {
    const withTodos = renderDashboard(TODOS)
    for (const text of ['데일리 스탠드업', '스프린트 리뷰', '워크샵 주간', '회의실 A']) {
      expect(withTodos).toContain(text)
    }
    expect(withTodos).not.toContain('다음 주 회의')
  })
})

describe('중복 일정 처리', () => {
  it('동일한 종일 일정이 여러 건 들어와도 한 번만 표시한다', () => {
    const dup: CalendarEvent[] = [
      { id: 'a', summary: '휴가', start: day(-1), end: day(1), allDay: true },
      { id: 'b', summary: '휴가', start: day(0), end: day(2), allDay: true }
    ]
    const now = new Date()
    const html = renderToStaticMarkup(<DayScheduleCard day={now} now={now} events={dup} />)
    expect((html.match(/휴가/g) || []).length).toBe(2) // 칩 본문 + title 속성
  })
})
