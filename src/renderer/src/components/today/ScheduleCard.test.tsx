import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AssistantEvent, MeetingBriefingPayload } from '../../types'
import ScheduleCard, { defaultOpenBriefingId, effectiveOpenIds, isOtherCalendar, localStamp, matchBriefings } from './ScheduleCard'
import type { ScheduleRow, TodayDashboard } from './todayModel'
import type { MeetingBriefingRow } from './MeetingBriefingCard'

const NOW = new Date(2026, 10, 19, 11, 20, 0)
const iso = (h: number, m: number): string => new Date(2026, 10, 19, h, m).toISOString()

const srow = (id: string, title: string, sh: number, eh: number, timing: ScheduleRow['timing']): ScheduleRow => ({
  id,
  title,
  start: `${String(sh).padStart(2, '0')}:00`,
  end: `${String(eh).padStart(2, '0')}:00`,
  startISO: iso(sh, 0),
  endISO: iso(eh, 0),
  timing,
  location: null,
  htmlLink: null
})

const schedule = (over: Partial<TodayDashboard['schedule']> = {}): TodayDashboard['schedule'] => ({
  connected: true,
  allDay: [{ id: 'ad1', title: '창립기념일' }],
  rows: [
    srow('cal-a', '스크럼', 10, 11, 'past'),
    srow('cal-b', 'Tech weekly', 14, 15, 'upcoming'),
    srow('cal-c', '1:1', 16, 17, 'upcoming')
  ],
  nowIndex: 1,
  tomorrowCount: 2,
  tomorrowFirst: '09:30 스크럼',
  ...over
})

const briefing = (eventId: number, meetingId: string, startAt: string, rule = `규칙 본문 ${meetingId}`): MeetingBriefingRow => {
  const payload: MeetingBriefingPayload = {
    meeting: { id: meetingId, title: meetingId, startAt, endAt: startAt },
    title: '',
    body: '',
    hasContext: true,
    ruleMarkdown: `# 제목\n- ${rule}`,
    llmStatus: 'off',
    llmMarkdown: null,
    llmModel: null,
    llmAt: null,
    llmError: null
  }
  const event = {
    id: eventId,
    event_key: `meeting_briefing:${meetingId}`,
    kind: 'meeting_briefing',
    plan_date: '2026-11-19',
    scheduled_at: startAt,
    fired_at: startAt,
    status: 'sent',
    ref_id: meetingId,
    payload: JSON.stringify(payload),
    response: null,
    responded_at: null,
    created_at: startAt
  } as AssistantEvent
  return { event, payload }
}

const BRIEFINGS = [
  briefing(5, 'cal-a', '2026-11-19 10:00:00'),
  briefing(6, 'cal-b', '2026-11-19 14:00:00'),
  briefing(7, 'cal-c', '2026-11-19 16:00:00'),
  // 오늘 일정 행에 없는 회의
  briefing(8, 'cal-x', '2026-11-19 12:00:00')
]

const noop = (): void => {}
const render = (over: Partial<Parameters<typeof ScheduleCard>[0]> = {}): string =>
  renderToStaticMarkup(
    <ScheduleCard
      schedule={schedule()}
      now={NOW}
      briefings={BRIEFINGS}
      regeneratingIds={[]}
      canRegenerate
      onRegenerate={noop}
      forceOpenEventId={null}
      onOpenCalendar={noop}
      onOpenSettings={noop}
      {...over}
    />
  )

describe('ScheduleCard', () => {
  it('종일 칩, 지난 일정 흐림, 지금 선 위치, 내일 1줄', () => {
    const html = render()
    expect(html).toContain('창립기념일')
    expect(html).toMatch(/data-timing="past"[^>]*>\s*<div[^>]*opacity-55/)
    const line = html.indexOf('지금 11:20')
    expect(line).toBeGreaterThan(html.indexOf('스크럼'))
    expect(line).toBeLessThan(html.indexOf('Tech weekly'))
    expect(html).toContain('일정 2건 · 첫 09:30 스크럼')
  })

  it('브리핑은 일정 id 로 짝짓고 기본으로 시작 전 가장 가까운 1건만 펼친다', () => {
    const html = render()
    expect(html).toContain('id="meeting-briefing-5"')
    expect(html).toContain('id="meeting-briefing-6"')
    expect(html).not.toContain('meeting-briefing-8')
    expect(html).toContain('규칙 본문 cal-b')
    expect(html).not.toContain('규칙 본문 cal-a')
    expect(html).not.toContain('규칙 본문 cal-c')
    expect(html.match(/aria-expanded="true"/g) ?? []).toHaveLength(1)
  })

  it('알림 클릭 focus 로 받은 브리핑은 지난 회의여도 펼친다', () => {
    const html = render({ forceOpenEventId: 5 })
    expect(html).toContain('규칙 본문 cal-a')
    expect(html).toContain('규칙 본문 cal-b')
  })

  it('지금이 모든 일정 뒤면 지금 선이 맨 끝에 온다. 시간 일정이 없으면 안내', () => {
    const late = render({ schedule: schedule({ nowIndex: 3 }) })
    expect(late.indexOf('지금 11:20')).toBeGreaterThan(late.indexOf('1:1'))
    expect(render({ schedule: schedule({ rows: [], nowIndex: 0 }) })).toContain('오늘 시간 일정이 없어요')
  })

  it('미연결이면 연결 안내를 보인다', () => {
    const html = render({ schedule: schedule({ connected: false, rows: [], allDay: [] }) })
    expect(html).toContain('캘린더가 연결되지 않았어요')
    expect(html).toContain('설정에서 연결하기')
  })

  it('헬퍼: matchBriefings·defaultOpenBriefingId·localStamp', () => {
    const matched = matchBriefings(schedule().rows, BRIEFINGS)
    expect([...matched.keys()]).toEqual(['cal-a', 'cal-b', 'cal-c'])
    expect(defaultOpenBriefingId(matched, NOW)).toBe(6)
    expect(defaultOpenBriefingId(matched, new Date(2026, 10, 19, 17, 0))).toBeNull()
    expect(localStamp(NOW)).toBe('2026-11-19 11:20:00')
  })

  it('기본 펼침은 사용자가 바꾸기 전까지 매번 다시 계산한다(새로 생긴 브리핑도 펼침)', () => {
    // 처음엔 브리핑이 없었다가 생긴 경우: 같은 컴포넌트 상태(manual=null)로 새 기본값이 반영된다
    expect([...effectiveOpenIds(null, null, null)]).toEqual([])
    expect([...effectiveOpenIds(null, 6, null)]).toEqual([6])
    expect([...effectiveOpenIds(null, 6, 5)].sort()).toEqual([5, 6])
    // 사용자가 직접 바꾼 뒤에는 그 집합을 따른다
    expect([...effectiveOpenIds(new Set([7]), 6, null)]).toEqual([7])
    expect([...effectiveOpenIds(new Set(), 6, null)]).toEqual([])
    // 화면: 처음 그릴 때 브리핑이 없으면 펼침 0, 브리핑이 들어오면 가장 가까운 1건이 펼쳐진다
    expect(render({ briefings: [] }).match(/aria-expanded="true"/g) ?? []).toHaveLength(0)
    expect(render().match(/aria-expanded="true"/g) ?? []).toHaveLength(1)
  })

  it('기본 캘린더가 아닌 일정은 그대로 보이되 다른 캘린더 꼬리표를 붙인다', () => {
    const rows = schedule().rows.map((r, i) =>
      i === 1 ? { ...r, calendarId: 'c_tech@group.calendar.google.com' } : { ...r, calendarId: i === 0 ? 'primary' : null }
    )
    const html = render({ schedule: schedule({ rows }) })
    expect(html).toContain('Tech weekly')
    expect(html.match(/data-other-calendar/g) ?? []).toHaveLength(1)
    const tw = html.slice(html.indexOf('schedule-row-cal-b'), html.indexOf('schedule-row-cal-c'))
    expect(tw).toContain('다른 캘린더')
    expect(tw).toContain('text-[11px] text-gray-500')
    expect(isOtherCalendar('primary')).toBe(false)
    expect(isOtherCalendar(null)).toBe(false)
    expect(isOtherCalendar(undefined)).toBe(false)
    expect(isOtherCalendar('c_x@group.calendar.google.com')).toBe(true)
  })
})
