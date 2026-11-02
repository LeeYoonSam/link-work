import { describe, expect, it } from 'vitest'
import {
  CHECKIN_LEAD_MIN,
  CHECKIN_RECENT_STATUS_MIN,
  CHECKIN_TITLE_MAX,
  checkinEventKey,
  checkinNoticeText,
  computeDueCheckin,
  decideRefresh,
  LATE_AFTER_MIN,
  minutesBetween,
  TICK_MS,
  WAKE_MIN_GAP_MS
} from './assistant-schedule'
import { buildTimeline } from './assistant-slots'
import type {
  AssistantEvent,
  CalendarRef,
  CheckinDecisionInput,
  PlanItem,
  RefreshDecisionInput
} from './assistant-types'

const MIN = 60_000
const NOW = Date.UTC(2026, 10, 2, 5, 0, 0)

function input(over: Partial<RefreshDecisionInput> = {}): RefreshDecisionInput {
  return {
    nowMs: NOW,
    settings: { enabled: true, refreshCalendarMin: 5, refreshJiraMin: 15 },
    hasActivePlan: true,
    inFlight: false,
    // 기본: 둘 다 방금 확인했다
    times: { calendarAt: NOW - MIN, jiraAt: NOW - MIN },
    wake: false,
    ...over
  }
}

describe('decideRefresh', () => {
  it('상수는 계약 값이다', () => {
    expect(TICK_MS).toBe(60_000)
    expect(WAKE_MIN_GAP_MS).toBe(120_000)
  })

  it('A25: 비서가 꺼져 있으면 null', () => {
    const r = decideRefresh(input({
      settings: { enabled: false, refreshCalendarMin: 5, refreshJiraMin: 15 },
      times: { calendarAt: null, jiraAt: null }
    }))
    expect(r).toBeNull()
  })

  it('A25: 근무 중 계획이 없으면 null', () => {
    expect(decideRefresh(input({ hasActivePlan: false, times: { calendarAt: null, jiraAt: null } }))).toBeNull()
  })

  it('A25: 자동 최신화가 진행 중이면 null', () => {
    expect(decideRefresh(input({ inFlight: true, times: { calendarAt: null, jiraAt: null }, wake: true }))).toBeNull()
  })

  it('A25: 두 주기가 모두 지나지 않았으면 null', () => {
    expect(decideRefresh(input({ times: { calendarAt: NOW - 4 * MIN, jiraAt: NOW - 14 * MIN } }))).toBeNull()
  })

  it('A25: 주기 경계값은 경과로 본다', () => {
    expect(decideRefresh(input({ times: { calendarAt: NOW - 5 * MIN, jiraAt: NOW - MIN } }))).toBe('calendar')
    expect(decideRefresh(input({ times: { calendarAt: NOW - MIN, jiraAt: NOW - 15 * MIN } }))).toBe('jira')
  })

  it('A25: mode 조합 — 둘 다 full, 캘린더만 calendar, Jira 만 jira', () => {
    expect(decideRefresh(input({ times: { calendarAt: null, jiraAt: null } }))).toBe('full')
    expect(decideRefresh(input({ times: { calendarAt: NOW - 6 * MIN, jiraAt: NOW - 16 * MIN } }))).toBe('full')
    expect(decideRefresh(input({ times: { calendarAt: NOW - 6 * MIN, jiraAt: NOW - MIN } }))).toBe('calendar')
    expect(decideRefresh(input({ times: { calendarAt: NOW - MIN, jiraAt: null } }))).toBe('jira')
  })

  it('A25: 깨어남은 캘린더를 2분 간격으로 앞당긴다', () => {
    // 2분 지남 → 캘린더 확인
    expect(decideRefresh(input({ wake: true, times: { calendarAt: NOW - 2 * MIN, jiraAt: NOW - MIN } }))).toBe('calendar')
    // 2분 안 → 앞당기지 않는다
    expect(decideRefresh(input({ wake: true, times: { calendarAt: NOW - 119_999, jiraAt: NOW - MIN } }))).toBeNull()
    // 확인 기록 없음 → 확인
    expect(decideRefresh(input({ wake: true, times: { calendarAt: null, jiraAt: NOW - MIN } }))).toBe('calendar')
  })

  it('A25: 깨어남은 Jira 주기를 앞당기지 않는다', () => {
    const r = decideRefresh(input({ wake: true, times: { calendarAt: NOW - 3 * MIN, jiraAt: NOW - 14 * MIN } }))
    expect(r).toBe('calendar')
    expect(decideRefresh(input({ wake: true, times: { calendarAt: NOW - 3 * MIN, jiraAt: NOW - 15 * MIN } }))).toBe('full')
  })

  it('A25: 설정 주기를 따른다', () => {
    const r = decideRefresh(input({
      settings: { enabled: true, refreshCalendarMin: 1, refreshJiraMin: 240 },
      times: { calendarAt: NOW - MIN, jiraAt: NOW - 239 * MIN }
    }))
    expect(r).toBe('calendar')
  })
})

// ── MVP4 작업 경계 체크인 (부록 H) ──

const TODAY = '2026-11-02'
// 회의 11–12, 14–15. 빈 블록은 09–11, 12–14, 15–18 이다.
const CAL: CalendarRef[] = [
  { id: 'm1', title: '주간 회의', start: '11:00', end: '12:00', allDay: false },
  { id: 'm2', title: '리뷰', start: '14:00', end: '15:00', allDay: false }
]

function item(over: Partial<PlanItem> & Pick<PlanItem, 'id'>): PlanItem {
  return {
    plan_id: 1, candidate_id: `task:${over.id}`, source: 'task', title: `작업 ${over.id}`,
    link: null, jira_issue_key: null, project_id: null, due_date: null,
    score: 0, rank: over.id, slot_start: null, slot_end: null,
    pinned: false, added_by: 'start', urgent: false,
    status: 'planned', status_note: null, status_at: null, first_planned_date: null,
    ...over
  }
}

function ev(over: Partial<AssistantEvent> & Pick<AssistantEvent, 'id'>): AssistantEvent {
  return {
    event_key: `checkin:${TODAY}:x${over.id}`, kind: 'checkin', plan_date: TODAY,
    scheduled_at: `${TODAY} 09:00:00`, fired_at: `${TODAY} 09:00:00`, status: 'sent',
    ref_id: '1', payload: null, response: null, responded_at: null, created_at: `${TODAY} 09:00:00`,
    ...over
  }
}

function cin(nowHHmm: string, over: Partial<CheckinDecisionInput> = {}): CheckinDecisionInput {
  return {
    today: TODAY,
    nowHHmm,
    at: `${TODAY} ${nowHHmm}:00`,
    settings: { enabled: true, checkinEnabled: true, checkinDailyCap: 4, checkinMinGap: 45 },
    planActive: true,
    dayStart: '09:00',
    workEnd: '18:00',
    calendar: CAL,
    items: [item({ id: 1, title: '보고서 작성' })],
    events: [],
    ...over
  }
}

describe('체크인 상수와 보조 함수', () => {
  it('상수는 계약 값이다', () => {
    expect(CHECKIN_LEAD_MIN).toBe(5)
    expect(CHECKIN_RECENT_STATUS_MIN).toBe(15)
    expect(LATE_AFTER_MIN).toBe(2)
    expect(CHECKIN_TITLE_MAX).toBe(30)
  })

  it('minutesBetween 은 로컬 일시 2개의 분 차이다', () => {
    expect(minutesBetween('2026-11-02 10:00:00', '2026-11-02 10:45:00')).toBe(45)
    expect(minutesBetween('2026-11-02 10:00:00', '2026-11-02 10:00:30')).toBe(0.5)
    expect(minutesBetween('2026-11-02 23:50:00', '2026-11-03 00:10:00')).toBe(20)
    expect(minutesBetween('2026-11-02 10:45:00', '2026-11-02 10:00:00')).toBe(-45)
    expect(minutesBetween('x', '2026-11-02 10:00:00')).toBeNaN()
  })

  it('checkinEventKey 는 checkin:<date>:<HHmm> 이다', () => {
    expect(checkinEventKey(TODAY, '11:00')).toBe('checkin:2026-11-02:1100')
    expect(checkinEventKey(TODAY, '18:00')).toBe('checkin:2026-11-02:1800')
  })

  it('checkinNoticeText 는 항목 제목을 30자로 자른다', () => {
    expect(checkinNoticeText('보고서 작성')).toEqual({
      title: '체크인: 보고서 작성',
      body: '지금까지 어떻게 됐나요? 답장하거나 눌러서 고르세요.'
    })
    const long = '가'.repeat(31)
    expect(checkinNoticeText(long).title).toBe(`체크인: ${'가'.repeat(30)}…`)
    expect(checkinNoticeText('가'.repeat(30)).title).toBe(`체크인: ${'가'.repeat(30)}`)
  })
})

describe('computeDueCheckin', () => {
  it('A41: 창 전 (블록 끝 6분 전) 은 null', () => {
    expect(computeDueCheckin(cin('10:54'))).toBeNull()
  })

  it('A41: 창 안 (블록 끝 5분 전) 의 첫 틱이 보낸다', () => {
    const due = computeDueCheckin(cin('10:55'))
    expect(due).toEqual({
      eventKey: 'checkin:2026-11-02:1100',
      refId: '1',
      scheduledAt: '2026-11-02 10:55:00',
      late: false,
      title: '체크인: 보고서 작성',
      body: '지금까지 어떻게 됐나요? 답장하거나 눌러서 고르세요.',
      payload: {
        itemId: 1, candidateId: 'task:1', itemTitle: '보고서 작성',
        blockStart: '09:00', blockEnd: '11:00',
        title: '체크인: 보고서 작성', body: '지금까지 어떻게 됐나요? 답장하거나 눌러서 고르세요.'
      }
    })
    // 창의 마지막 분도 창 안이다
    expect(computeDueCheckin(cin('10:59'))?.eventKey).toBe('checkin:2026-11-02:1100')
  })

  it('A41: 창 뒤는 null 이고 skipped 를 만들지 않는다', () => {
    const events: AssistantEvent[] = []
    // 블록 끝 정각은 다음 회의 시작이다. current 블록이 없다
    expect(computeDueCheckin(cin('11:00', { events }))).toBeNull()
    // 하루 마지막 블록이 끝난 뒤
    expect(computeDueCheckin(cin('18:00', { events }))).toBeNull()
    expect(computeDueCheckin(cin('18:03', { events }))).toBeNull()
    // 판정은 행을 만들지 않는다. 돌려준 값도 null 이라 서비스가 INSERT 하지 않는다
    expect(events).toHaveLength(0)
  })

  it('A41: 하루 마지막 블록은 workEnd − 5분에 묻는다', () => {
    const due = computeDueCheckin(cin('17:55'))
    expect(due?.eventKey).toBe('checkin:2026-11-02:1800')
    expect(due?.scheduledAt).toBe('2026-11-02 17:55:00')
    expect(due?.payload.blockStart).toBe('15:00')
  })

  it('예정 시각보다 2분 이상 늦으면 late 다', () => {
    expect(computeDueCheckin(cin('10:56'))?.late).toBe(false)
    expect(computeDueCheckin(cin('10:57'))?.late).toBe(true)
    expect(computeDueCheckin(cin('10:56', { at: `${TODAY} 10:56:59` }))?.late).toBe(false)
  })

  it('A7: 비서나 체크인이 꺼져 있으면 null', () => {
    const base = cin('10:56')
    expect(computeDueCheckin({ ...base, settings: { ...base.settings, enabled: false } })).toBeNull()
    expect(computeDueCheckin({ ...base, settings: { ...base.settings, checkinEnabled: false } })).toBeNull()
  })

  it('A7: 근무 중 계획이 없으면 (계획 없음·닫힘) null', () => {
    expect(computeDueCheckin(cin('10:56', { planActive: false }))).toBeNull()
  })

  it('A7: 회의 중이면 null', () => {
    expect(computeDueCheckin(cin('11:30'))).toBeNull()
    expect(computeDueCheckin(cin('14:56'))).toBeNull()
  })

  it('A7: 오늘 보낸 체크인이 상한에 닿으면 null', () => {
    const four = [1, 2, 3, 4].map((id) => ev({ id, fired_at: `${TODAY} 08:0${id}:00`, status: id === 2 ? 'late' : 'sent' }))
    expect(computeDueCheckin(cin('10:56', { events: four }))).toBeNull()
    // skipped·failed 와 다른 kind 는 세지 않는다
    const mixed = [
      ev({ id: 1, fired_at: `${TODAY} 08:00:00` }),
      ev({ id: 2, status: 'failed' }),
      ev({ id: 3, status: 'skipped' }),
      ev({ id: 4, kind: 'plan_update', event_key: `plan_update:${TODAY}:0800` }),
      ev({ id: 5, kind: 'command', event_key: `command:${TODAY}:1`, status: 'logged' })
    ]
    expect(computeDueCheckin(cin('10:56', { events: mixed }))).not.toBeNull()
    // 상한 0 은 보내지 않는다
    const base = cin('10:56')
    expect(computeDueCheckin({ ...base, settings: { ...base.settings, checkinDailyCap: 0 } })).toBeNull()
  })

  it('A7: 마지막 체크인으로부터 최소 간격이 지나지 않았으면 null', () => {
    const recent = [ev({ id: 1, fired_at: `${TODAY} 10:20:00` }), ev({ id: 2, fired_at: `${TODAY} 08:00:00` })]
    expect(computeDueCheckin(cin('10:56', { events: recent }))).toBeNull()
    // 경계: 정확히 45분이면 보낸다
    expect(computeDueCheckin(cin('10:56', { events: [ev({ id: 1, fired_at: `${TODAY} 10:11:00` })] }))).not.toBeNull()
    // late 행도 간격 기준이다
    expect(computeDueCheckin(cin('10:56', { events: [ev({ id: 1, status: 'late', fired_at: `${TODAY} 10:30:00` })] }))).toBeNull()
  })

  it('A44: 최근 15분 안에 항목 상태가 바뀌었으면 null', () => {
    const changed = (statusAt: string): PlanItem[] => [
      item({ id: 1, title: '보고서 작성' }),
      item({ id: 3, status: 'done', status_at: statusAt })
    ]
    expect(computeDueCheckin(cin('10:56', { items: changed(`${TODAY} 10:45:00`) }))).toBeNull()
    // 15분 이상 지났으면 보낸다
    expect(computeDueCheckin(cin('10:56', { items: changed(`${TODAY} 10:41:00`) }))?.refId).toBe('1')
    expect(computeDueCheckin(cin('10:56', { items: changed(`${TODAY} 10:30:00`) }))?.refId).toBe('1')
  })

  it('같은 event_key 행이 있으면 상태와 무관하게 null', () => {
    const dup = [ev({ id: 9, event_key: 'checkin:2026-11-02:1100', status: 'failed', fired_at: null })]
    expect(computeDueCheckin(cin('10:56', { events: dup }))).toBeNull()
  })

  it('in_progress 항목도 묻는다. 활성 항목이 없으면 null', () => {
    expect(computeDueCheckin(cin('10:56', { items: [item({ id: 1, status: 'in_progress' })] }))?.refId).toBe('1')
    expect(computeDueCheckin(cin('10:56', { items: [item({ id: 1, status: 'done' })] }))).toBeNull()
    expect(computeDueCheckin(cin('10:56', { items: [] }))).toBeNull()
  })

  it('30분 미만 블록은 배정이 없으므로 묻지 않는다', () => {
    const cal = [...CAL, { id: 'm3', title: '점심 약속', start: '12:20', end: '14:00', allDay: false }]
    // 12:00–12:20 블록
    expect(computeDueCheckin(cin('12:16', { calendar: cal }))).toBeNull()
  })

  it('마감: 앞선 예보에서 마감 항목을 받았던 블록도 블록 진행 중 화면에 보인 항목을 묻는다', () => {
    const items = [
      item({ id: 1, title: '집중 작업' }),
      item({ id: 2, title: '오늘 마감 작업', due_date: TODAY })
    ]
    const base = { calendar: CAL, dayStart: '09:00', workEnd: '18:00', items, today: TODAY, closed: false }
    const lastBlock = (nowHHmm: string) =>
      buildTimeline({ ...base, nowHHmm }).entries.find((e) => e.kind === 'block' && e.end === '18:00')
    // 13:30 예보는 15–18 블록을 마감 항목 2 에 배정한다
    expect(lastBlock('13:30')).toMatchObject({ state: 'future', itemId: 2, reason: 'deadline' })
    // 블록 진행 중 화면은 집중 작업 1 을 보인다
    expect(lastBlock('15:00')).toMatchObject({ state: 'current', itemId: 1, reason: 'focus' })
    expect(lastBlock('17:30')).toMatchObject({ state: 'current', itemId: 1, reason: 'focus' })
    // 체크인은 화면에 보인 집중 작업을 묻는다
    const last = computeDueCheckin(cin('17:56', { items }))
    expect(last?.refId).toBe('1')
    expect(last?.payload.itemId).toBe(1)
    expect(last?.payload.blockStart).toBe('15:00')
    expect(last?.title).toBe('체크인: 집중 작업')
  })

  it('명령 입력의 임시 항목도 출처로 가리지 않고 묻는다 (A37)', () => {
    const items = [item({ id: 7, source: 'manual', candidate_id: 'manual:1:1', title: '임시 메모 정리', rank: 1 })]
    const due = computeDueCheckin(cin('10:56', { items }))
    expect(due?.payload.candidateId).toBe('manual:1:1')
    expect(due?.refId).toBe('7')
  })

  it('A14: 같은 입력에 같은 출력이고 입력 배열을 바꾸지 않는다', () => {
    const input = cin('17:56', {
      items: [item({ id: 1 }), item({ id: 2, due_date: TODAY }), item({ id: 3, status: 'done', status_at: `${TODAY} 09:00:00` })],
      events: [ev({ id: 1, fired_at: `${TODAY} 09:00:00` })]
    })
    const snapshot = structuredClone(input)
    const a = computeDueCheckin(input)
    const b = computeDueCheckin(input)
    expect(a).not.toBeNull()
    expect(b).toEqual(a)
    expect(input).toEqual(snapshot)
  })
})
