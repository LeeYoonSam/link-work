import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ Notification: class {} }))
vi.mock('../db/database', () => ({ getDatabase: () => ({}) }))
vi.mock('./google-calendar', () => ({
  getTodayEvents: async () => [],
  isOwnCalendarEvent: (e: { calendarId?: string }) => e.calendarId === undefined || e.calendarId === 'primary'
}))

import type { CalendarEvent } from './google-calendar'
import { dueEventNotifications } from './notification'

const NOW = new Date('2026-11-19T13:52:00+09:00')
const ev = (id: string, start: string, calendarId?: string, allDay = false): CalendarEvent => ({
  id,
  summary: id,
  start,
  end: start,
  allDay,
  calendarId
})

describe('dueEventNotifications', () => {
  it('10·5·1분 전 구간을 나눈다', () => {
    const r = dueEventNotifications(
      [
        ev('a', '2026-11-19T14:00:00+09:00', 'primary'),
        ev('b', '2026-11-19T13:55:00+09:00', 'primary'),
        ev('c', '2026-11-19T13:52:30+09:00'),
        ev('d', '2026-11-19T15:00:00+09:00', 'primary')
      ],
      NOW
    )
    expect(r.map((x) => [x.event.id, x.minutesBefore])).toEqual([
      ['a', 10],
      ['b', 5],
      ['c', 1]
    ])
  })

  it('기본 캘린더가 아닌 캘린더의 일정과 종일 일정은 알리지 않는다', () => {
    const r = dueEventNotifications(
      [
        ev('tech', '2026-11-19T14:00:00+09:00', 'c_tech@group.calendar.google.com'),
        ev('allday', '2026-11-19', 'primary', true)
      ],
      NOW
    )
    expect(r).toEqual([])
  })
})
