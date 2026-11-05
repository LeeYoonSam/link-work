import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import DayScheduleCard from './DayScheduleCard'
import { FOCUS_RING_CLASS } from '../../hooks/useFocusFlash'
import type { CalendarEvent } from '../../stores/calendarStore'

// 앱 내 링크(linkwork://calendar/{date}[/{eventId}])로 들어온 날 카드와 일정 행의 강조를 마크업으로 잠근다.
// 스크롤과 주 이동은 effect 라 서버 렌더로 검증하지 않는다. prop 에 따른 DOM id 와 링 클래스만 본다.

const DAY = new Date(2026, 10, 5) // 2026-11-05 (목)
// 강조 링이 NOW 배경과 섞이지 않도록 현재 시각은 그 날의 일정 밖에 둔다
const NOW = new Date(2026, 10, 5, 20, 0)

const EVENTS: CalendarEvent[] = [
  {
    id: 'abc',
    summary: '스프린트 리뷰',
    start: '2026-11-05T15:00:00',
    end: '2026-11-05T16:00:00',
    allDay: false
  },
  {
    id: 'other',
    summary: '데일리 스탠드업',
    start: '2026-11-05T10:00:00',
    end: '2026-11-05T10:30:00',
    allDay: false
  },
  {
    id: 'allday1',
    summary: '워크샵',
    start: '2026-11-05',
    end: '2026-11-06',
    allDay: true
  }
]

const render = (props: { focused?: boolean; highlightEventId?: string | null } = {}): string =>
  renderToStaticMarkup(<DayScheduleCard day={DAY} now={NOW} events={EVENTS} {...props} />)

// id 로 여는 태그를 찾는다
const tagById = (html: string, id: string): string | undefined =>
  html.match(new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>`))?.[0]

describe('DayScheduleCard 포커스', () => {
  it('카드 루트에 calendar-day-{YYYY-MM-DD} DOM id 가 늘 붙는다', () => {
    const tag = tagById(render(), 'calendar-day-2026-11-05')
    expect(tag).toBeDefined()
    expect(tag).not.toContain(FOCUS_RING_CLASS)
  })

  it('focused 이면 카드에 강조 링을 단다', () => {
    const tag = tagById(render({ focused: true }), 'calendar-day-2026-11-05')
    expect(tag).toContain(FOCUS_RING_CLASS)
    // 링 배경과 겹치지 않도록 흰 배경을 뺀다
    expect(tag).not.toContain('bg-white')
  })

  it('highlightEventId 의 시간 일정 행에 calendar-event-{id} 와 강조 링을 단다', () => {
    const html = render({ focused: true, highlightEventId: 'abc' })
    const tag = tagById(html, 'calendar-event-abc')
    expect(tag, 'id="calendar-event-abc" 행이 없다').toBeDefined()
    expect(tag).toContain(FOCUS_RING_CLASS)
    // 카드가 overflow-hidden 이라 행 링은 안쪽에 그린다
    expect(tag).toContain('ring-inset')
    // 다른 일정은 강조하지 않고 id 도 달지 않는다
    expect(html).not.toContain('id="calendar-event-other"')
  })

  it('종일 일정 칩도 강조할 수 있다', () => {
    const tag = tagById(render({ focused: true, highlightEventId: 'allday1' }), 'calendar-event-allday1')
    expect(tag).toContain(FOCUS_RING_CLASS)
  })

  it('이 날에 없는 일정 id 는 아무 행도 강조하지 않는다', () => {
    const html = render({ focused: true, highlightEventId: 'missing' })
    expect(html).not.toContain('id="calendar-event-')
    // 카드 강조만 남는다
    expect(html.split(FOCUS_RING_CLASS)).toHaveLength(2)
  })

  it('기본값은 강조 없음이다 — 오늘 화면의 카드는 바뀌지 않는다', () => {
    const html = render()
    expect(html).not.toContain(FOCUS_RING_CLASS)
    expect(html).not.toContain('id="calendar-event-')
  })
})
