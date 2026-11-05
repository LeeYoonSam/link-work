import { describe, expect, it } from 'vitest'
import {
  computeDueMeetingBriefings,
  decideMorningSync,
  decideRefresh,
  LATE_AFTER_MIN,
  MEETING_BRIEFING_DAILY_CAP,
  meetingEventKey,
  minutesBetween,
  MORNING_SYNC_MAX_ATTEMPTS,
  MORNING_SYNC_RETRY_MIN,
  MORNING_SYNC_STALE_MIN,
  TICK_MS,
  WAKE_MIN_GAP_MS
} from './assistant-schedule'
import type {
  AssistantEvent,
  MeetingDecisionInput,
  MeetingRef,
  MorningSyncDecisionInput,
  MorningSyncPart,
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

// ── 공용 시각 계산 ──

const TODAY = '2026-11-02'

function ev(over: Partial<AssistantEvent> & Pick<AssistantEvent, 'id'>): AssistantEvent {
  return {
    event_key: `start_nudge:${TODAY}:x${over.id}`, kind: 'start_nudge', plan_date: TODAY,
    scheduled_at: `${TODAY} 09:00:00`, fired_at: `${TODAY} 09:00:00`, status: 'sent',
    ref_id: '1', payload: null, response: null, responded_at: null, created_at: `${TODAY} 09:00:00`,
    ...over
  }
}

describe('공용 시각 계산', () => {
  it('LATE_AFTER_MIN 은 계약 값이다', () => {
    expect(LATE_AFTER_MIN).toBe(2)
  })

  it('minutesBetween 은 로컬 일시 2개의 분 차이다', () => {
    expect(minutesBetween('2026-11-02 10:00:00', '2026-11-02 10:45:00')).toBe(45)
    expect(minutesBetween('2026-11-02 10:00:00', '2026-11-02 10:00:30')).toBe(0.5)
    expect(minutesBetween('2026-11-02 23:50:00', '2026-11-03 00:10:00')).toBe(20)
    expect(minutesBetween('2026-11-02 10:45:00', '2026-11-02 10:00:00')).toBe(-45)
    expect(minutesBetween('x', '2026-11-02 10:00:00')).toBeNaN()
  })
})

// ── MVP5 회의 전 브리핑 (부록 I) ──

function mtg(id: string, start: string, end = '23:00'): MeetingRef {
  return { id, title: `회의 ${id}`, startAt: `${TODAY} ${start}:00`, endAt: `${TODAY} ${end}:00` }
}

function mev(over: Partial<AssistantEvent> & Pick<AssistantEvent, 'id'>): AssistantEvent {
  return ev({
    event_key: `meeting_briefing:${TODAY}:x${over.id}`, kind: 'meeting_briefing', ref_id: null,
    ...over
  })
}

// 기본: 14:00 회의, lead 15분 → 창은 [13:45, 14:00)
function min(at: string, over: Partial<MeetingDecisionInput> = {}): MeetingDecisionInput {
  return {
    today: TODAY,
    at: `${TODAY} ${at}`,
    settings: { enabled: true, meetingBriefingEnabled: true, meetingLeadMin: 15 },
    meetings: [mtg('a', '14:00')],
    events: [],
    ...over
  }
}

describe('회의 브리핑 상수와 키', () => {
  it('상수는 계약 값이다', () => {
    expect(MEETING_BRIEFING_DAILY_CAP).toBe(6)
  })

  it('meetingEventKey 는 meeting_briefing:<date>:<id> 이다', () => {
    expect(meetingEventKey(TODAY, 'abc_20261102T050000Z')).toBe('meeting_briefing:2026-11-02:abc_20261102T050000Z')
  })
})

describe('computeDueMeetingBriefings', () => {
  it('A47: 비서나 회의 브리핑이 꺼져 있으면 빈 배열이다', () => {
    const off1 = min('13:50:00', { settings: { enabled: false, meetingBriefingEnabled: true, meetingLeadMin: 15 } })
    const off2 = min('13:50:00', { settings: { enabled: true, meetingBriefingEnabled: false, meetingLeadMin: 15 } })
    expect(computeDueMeetingBriefings(off1)).toEqual([])
    expect(computeDueMeetingBriefings(off2)).toEqual([])
    // 창이 지난 회의도 skipped 를 만들지 않는다
    expect(computeDueMeetingBriefings(min('15:00:00', { settings: off2.settings }))).toEqual([])
  })

  it('A47: 창 전 (예정 시각 1초 전) 이면 결과가 없다. 행을 만들지 않는다', () => {
    expect(computeDueMeetingBriefings(min('13:44:59'))).toEqual([])
    expect(computeDueMeetingBriefings(min('09:00:00'))).toEqual([])
  })

  it('A47: 창 안이면 send 다. 예정 시각 경계값은 창 안이다', () => {
    const r = computeDueMeetingBriefings(min('13:45:00'))
    expect(r).toEqual([
      {
        action: 'send', meeting: mtg('a', '14:00'), eventKey: 'meeting_briefing:2026-11-02:a',
        scheduledAt: '2026-11-02 13:45:00', late: false
      }
    ])
    // 시작 1초 전도 창 안이다
    expect(computeDueMeetingBriefings(min('13:59:59'))[0]).toMatchObject({ action: 'send' })
  })

  it('A47: 예정 시각보다 2분 이상 늦으면 late 다. 2분 미만이면 late 가 아니다', () => {
    expect(computeDueMeetingBriefings(min('13:47:00'))[0]).toMatchObject({ action: 'send', late: true })
    expect(computeDueMeetingBriefings(min('13:46:59'))[0]).toMatchObject({ action: 'send', late: false })
  })

  it('A47: 시작이 지났고 행이 없으면 skip window 다. 시작 시각 경계값은 창 밖이다', () => {
    expect(computeDueMeetingBriefings(min('14:00:00'))).toEqual([
      {
        action: 'skip', meeting: mtg('a', '14:00'), eventKey: 'meeting_briefing:2026-11-02:a',
        scheduledAt: '2026-11-02 13:45:00', reason: 'window'
      }
    ])
    expect(computeDueMeetingBriefings(min('20:00:00'))[0]).toMatchObject({ action: 'skip', reason: 'window' })
  })

  it('A47: 오늘 sent·late 6건이면 창 안 회의는 skip cap 이다. skipped·failed 는 세지 않는다', () => {
    const six = Array.from({ length: 6 }, (_, i) => mev({ id: i + 1, status: i % 2 === 0 ? 'sent' : 'late' }))
    expect(computeDueMeetingBriefings(min('13:50:00', { events: six }))).toEqual([
      expect.objectContaining({ action: 'skip', reason: 'cap', eventKey: 'meeting_briefing:2026-11-02:a' })
    ])
    const notCounted = [
      ...six.slice(0, 5),
      mev({ id: 7, status: 'skipped' }),
      mev({ id: 8, status: 'failed' }),
      // 다른 날짜와 다른 종류는 세지 않는다
      mev({ id: 9, plan_date: '2026-11-01' }),
      ev({ id: 10, kind: 'start_nudge' })
    ]
    expect(computeDueMeetingBriefings(min('13:50:00', { events: notCounted }))[0]).toMatchObject({ action: 'send' })
  })

  it('A47: 이번 결과의 send 수도 상한에 더한다. 순서는 startAt 오름차순이다', () => {
    // 5건 보낸 날, 창 안 회의 3건 → 첫 1건 send, 나머지 cap
    const five = Array.from({ length: 5 }, (_, i) => mev({ id: i + 1 }))
    const meetings = [mtg('c', '14:10'), mtg('a', '14:00'), mtg('b', '14:05')]
    const r = computeDueMeetingBriefings(min('13:58:00', { meetings, events: five }))
    expect(r.map((d) => [d.meeting.id, d.action, d.action === 'skip' ? d.reason : d.late])).toEqual([
      ['a', 'send', true],
      ['b', 'skip', 'cap'],
      ['c', 'skip', 'cap']
    ])
  })

  it('A47: 같은 키의 행이 이미 있으면 건너뛴다. status 와 무관하다', () => {
    for (const status of ['sent', 'late', 'skipped', 'failed'] as const) {
      const events = [mev({ id: 1, event_key: 'meeting_briefing:2026-11-02:a', status })]
      expect(computeDueMeetingBriefings(min('13:50:00', { events }))).toEqual([])
      expect(computeDueMeetingBriefings(min('15:00:00', { events }))).toEqual([])
    }
  })

  it('A47: 여러 회의를 한 틱에 판정한다. 창 전 회의는 결과에 없다. 회의 중 여부를 보지 않는다', () => {
    // 13:00–14:30 회의 중이어도 14:00 회의 브리핑을 보낸다
    const meetings = [mtg('later', '16:00'), mtg('a', '14:00'), mtg('now', '13:00', '14:30'), mtg('past', '09:00')]
    const r = computeDueMeetingBriefings(min('13:50:00', { meetings }))
    expect(r.map((d) => [d.meeting.id, d.action])).toEqual([
      ['past', 'skip'],
      ['now', 'skip'],
      ['a', 'send']
    ])
  })

  it('A47: lead 를 바꾸면 예정 시각이 바뀐다. 날짜를 넘는 예정 시각도 계산한다', () => {
    const settings = { enabled: true, meetingBriefingEnabled: true, meetingLeadMin: 120 }
    expect(computeDueMeetingBriefings(min('11:59:00', { settings }))).toEqual([])
    expect(computeDueMeetingBriefings(min('12:00:00', { settings }))[0]).toMatchObject({
      action: 'send', scheduledAt: '2026-11-02 12:00:00', late: false
    })
    const early = computeDueMeetingBriefings(
      min('00:10:00', { settings: { ...settings, meetingLeadMin: 30 }, meetings: [mtg('e', '00:20')] })
    )
    expect(early[0]).toMatchObject({ action: 'send', scheduledAt: '2026-11-01 23:50:00', late: true })
  })

  it('A47: 시작 시각을 읽지 못하는 회의와 중복 id 는 1건만 판정하거나 건너뛴다', () => {
    const bad: MeetingRef = { id: 'bad', title: 'x', startAt: '14:00', endAt: '15:00' }
    const r = computeDueMeetingBriefings(min('13:50:00', { meetings: [bad, mtg('a', '14:00'), mtg('a', '14:00')] }))
    expect(r.map((d) => d.meeting.id)).toEqual(['a'])
  })

  it('A14: 같은 입력에 같은 출력이고 입력 배열을 바꾸지 않는다', () => {
    const meetings = [mtg('c', '14:10'), mtg('a', '14:00'), mtg('p', '09:00')]
    const events = [mev({ id: 1 })]
    const input = min('13:58:00', { meetings, events })
    const snapshot = JSON.parse(JSON.stringify(input))
    const r1 = computeDueMeetingBriefings(input)
    const r2 = computeDueMeetingBriefings(input)
    expect(r1).toEqual(r2)
    expect(input).toEqual(snapshot)
    expect(meetings.map((m) => m.id)).toEqual(['c', 'a', 'p'])
  })
})

// ── A54 아침 자동 동기화 판정 ──

function morning(over: Partial<MorningSyncDecisionInput> = {}): MorningSyncDecisionInput {
  return {
    today: '2026-11-05',
    calendarDate: '2026-11-05',
    nowHHmm: '08:10',
    at: '2026-11-05 08:10:00',
    settings: { morningSyncEnabled: true, morningSyncTime: '08:00' },
    inFlight: false,
    payload: null,
    ...over
  }
}

function part(over: Partial<MorningSyncPart> = {}): MorningSyncPart {
  return {
    status: 'ok',
    attempts: 1,
    startedAt: '2026-11-05 08:00:00',
    finishedAt: '2026-11-05 08:01:00',
    error: null,
    newCount: 0,
    updatedCount: 0,
    reviewCount: 0,
    failedCount: 0,
    ...over
  }
}

function withParts(release: MorningSyncPart | null, project: MorningSyncPart | null): MorningSyncDecisionInput['payload'] {
  return { date: '2026-11-05', release, project }
}

describe('A54: decideMorningSync', () => {
  it('A54: 상수는 재시도 30분, 상한 3회, 낡은 running 15분이다', () => {
    expect(MORNING_SYNC_RETRY_MIN).toBe(30)
    expect(MORNING_SYNC_MAX_ATTEMPTS).toBe(3)
    expect(MORNING_SYNC_STALE_MIN).toBe(15)
  })

  it('A54: 오늘 행이 없고 설정 시각이 지났으면 두 부분을 release·project 순서로 고른다', () => {
    expect(decideMorningSync(morning())).toEqual(['release', 'project'])
    expect(decideMorningSync(morning({ nowHHmm: '08:00', at: '2026-11-05 08:00:00' }))).toEqual(['release', 'project'])
  })

  it('A54: 설정 시각 이전이면 실행하지 않는다', () => {
    expect(decideMorningSync(morning({ nowHHmm: '07:59', at: '2026-11-05 07:59:00' }))).toEqual([])
  })

  it('A54: 설정 시각 뒤에 앱을 열어도 그날 1번 실행한다', () => {
    expect(decideMorningSync(morning({ nowHHmm: '15:20', at: '2026-11-05 15:20:00' }))).toEqual(['release', 'project'])
  })

  it('A54: 새벽 논리 날짜이면 전날 키로 실행하지 않는다', () => {
    const input = morning({
      today: '2026-11-04',
      calendarDate: '2026-11-05',
      nowHHmm: '02:30',
      at: '2026-11-05 02:30:00',
      settings: { morningSyncEnabled: true, morningSyncTime: '01:00' }
    })
    expect(decideMorningSync(input)).toEqual([])
  })

  it('A54: 꺼져 있으면 실행하지 않는다', () => {
    expect(decideMorningSync(morning({ settings: { morningSyncEnabled: false, morningSyncTime: '08:00' } }))).toEqual([])
  })

  it('A54: 실행기가 진행 중이면 실행하지 않는다', () => {
    expect(decideMorningSync(morning({ inFlight: true }))).toEqual([])
  })

  it('A54: 이미 ok 인 부분은 다시 실행하지 않는다', () => {
    expect(decideMorningSync(morning({ payload: withParts(part(), part()) }))).toEqual([])
    expect(decideMorningSync(morning({ payload: withParts(part(), null) }))).toEqual(['project'])
  })

  it('A54: skipped 는 다시 실행하지 않는다', () => {
    const skipped = part({ status: 'skipped', error: 'Jira 미연결' })
    expect(decideMorningSync(morning({ nowHHmm: '12:00', at: '2026-11-05 12:00:00', payload: withParts(skipped, skipped) }))).toEqual([])
  })

  it('A54: failed 는 마지막 시도 30분 뒤에 다시 한다', () => {
    const failed = part({ status: 'failed', attempts: 1, finishedAt: '2026-11-05 08:01:00', error: '네트워크 오류' })
    const payload = withParts(failed, part())
    expect(decideMorningSync(morning({ nowHHmm: '08:30', at: '2026-11-05 08:30:59', payload }))).toEqual([])
    expect(decideMorningSync(morning({ nowHHmm: '08:31', at: '2026-11-05 08:31:00', payload }))).toEqual(['release'])
  })

  it('A54: failed 가 3회에 이르면 그날 다시 하지 않는다', () => {
    const twice = part({ status: 'failed', attempts: 2, finishedAt: '2026-11-05 09:00:00' })
    const thrice = part({ status: 'failed', attempts: 3, finishedAt: '2026-11-05 09:00:00' })
    const at = { nowHHmm: '11:00', at: '2026-11-05 11:00:00' }
    expect(decideMorningSync(morning({ ...at, payload: withParts(twice, part()) }))).toEqual(['release'])
    expect(decideMorningSync(morning({ ...at, payload: withParts(thrice, part()) }))).toEqual([])
  })

  it('A54: 15분 안의 running 은 다시 실행하지 않는다', () => {
    const running = part({ status: 'running', startedAt: '2026-11-05 08:00:00', finishedAt: null })
    const payload = withParts(running, running)
    expect(decideMorningSync(morning({ nowHHmm: '08:14', at: '2026-11-05 08:14:59', payload }))).toEqual([])
  })

  it('A54: 15분 넘은 running 은 failed 로 보고 재시도 간격·상한을 적용한다', () => {
    const running = part({ status: 'running', attempts: 1, startedAt: '2026-11-05 08:00:00', finishedAt: null })
    // 15분은 넘었지만 시작 뒤 30분이 지나지 않았다
    expect(decideMorningSync(morning({ nowHHmm: '08:20', at: '2026-11-05 08:20:00', payload: withParts(running, part()) }))).toEqual([])
    expect(decideMorningSync(morning({ nowHHmm: '08:30', at: '2026-11-05 08:30:00', payload: withParts(running, part()) }))).toEqual(['release'])
    const capped = part({ status: 'running', attempts: 3, startedAt: '2026-11-05 08:00:00', finishedAt: null })
    expect(decideMorningSync(morning({ nowHHmm: '09:00', at: '2026-11-05 09:00:00', payload: withParts(capped, part()) }))).toEqual([])
  })

  it('A54: deferred 는 시도 수와 관계없이 30분 뒤에 다시 본다', () => {
    const deferred = part({ status: 'deferred', attempts: 3, finishedAt: '2026-11-05 08:01:00' })
    expect(decideMorningSync(morning({ nowHHmm: '08:20', at: '2026-11-05 08:20:00', payload: withParts(part(), deferred) }))).toEqual([])
    expect(decideMorningSync(morning({ nowHHmm: '08:31', at: '2026-11-05 08:31:00', payload: withParts(part(), deferred) }))).toEqual(['project'])
  })

  it('A54: 다른 날짜의 payload 는 오늘 상태로 쓰지 않는다', () => {
    const old = { date: '2026-11-04', release: part(), project: part() }
    expect(decideMorningSync(morning({ payload: old }))).toEqual(['release', 'project'])
  })

  it('A14: 입력을 바꾸지 않는다', () => {
    const input = morning({ payload: withParts(part({ status: 'failed', attempts: 1 }), null) })
    const before = JSON.parse(JSON.stringify(input))
    decideMorningSync(input)
    expect(input).toEqual(before)
  })
})
