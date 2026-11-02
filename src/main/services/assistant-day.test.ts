import { describe, expect, it } from 'vitest'
import {
  addDays,
  daysBetween,
  isoToLocalDateTime,
  logicalDate,
  plansToAutoClose,
  shouldSendStartNudge,
  toHHmm,
  toLocalDateTime,
  type NudgeTrigger
} from './assistant-day'
import { DEFAULT_ASSISTANT_SETTINGS } from './assistant-settings'
import type { AssistantSettings, DailyPlan } from './assistant-types'

// 로컬 시각으로 Date 를 만든다. 테스트가 실행 PC 의 시간대와 무관하게 동작한다.
function local(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  return new Date(y, mo - 1, d, h, mi, s)
}

describe('logicalDate', () => {
  it('날짜 경계 이전 시각이면 전날이다', () => {
    expect(logicalDate(local(2026, 11, 3, 3, 30), '04:00')).toBe('2026-11-02')
  })

  it('날짜 경계 시각부터는 당일이다', () => {
    expect(logicalDate(local(2026, 11, 3, 4, 0), '04:00')).toBe('2026-11-03')
    expect(logicalDate(local(2026, 11, 3, 23, 59), '04:00')).toBe('2026-11-03')
  })

  it('월·연 경계를 넘어 전날을 계산한다', () => {
    expect(logicalDate(local(2026, 1, 1, 1, 0), '04:00')).toBe('2025-12-31')
    expect(logicalDate(local(2026, 3, 1, 2, 0), '04:00')).toBe('2026-02-28')
  })

  it('경계가 00:00 이면 항상 당일이다', () => {
    expect(logicalDate(local(2026, 11, 3, 0, 0), '00:00')).toBe('2026-11-03')
  })

  it('경계 형식이 틀리면 04:00 을 쓴다', () => {
    expect(logicalDate(local(2026, 11, 3, 3, 59), 'abc')).toBe('2026-11-02')
    expect(logicalDate(local(2026, 11, 3, 4, 0), '25:00')).toBe('2026-11-03')
  })
})

describe('A12: 로컬 날짜·시각 형식', () => {
  it('A12: toLocalDateTime 은 로컬 YYYY-MM-DD HH:mm:ss 다', () => {
    expect(toLocalDateTime(local(2026, 11, 2, 9, 5, 7))).toBe('2026-11-02 09:05:07')
  })

  it('A12: toHHmm 은 로컬 HH:mm 다', () => {
    expect(toHHmm(local(2026, 11, 2, 9, 5))).toBe('09:05')
  })

  it('A12: isoToLocalDateTime 은 시간대 ISO 를 로컬 datetime 으로 바꾼다', () => {
    const expected = toLocalDateTime(new Date(Date.UTC(2026, 10, 2, 1, 0, 0)))
    expect(isoToLocalDateTime('2026-11-02T01:00:00.000Z')).toBe(expected)
    // Jira 는 콜론 없는 오프셋을 쓴다
    expect(isoToLocalDateTime('2026-11-02T10:00:00.000+0900')).toBe(expected)
    expect(isoToLocalDateTime('2026-11-02T10:00:00+09:00')).toBe(expected)
  })

  it('isoToLocalDateTime 은 해석할 수 없으면 null 이다', () => {
    expect(isoToLocalDateTime('')).toBeNull()
    expect(isoToLocalDateTime('not a date')).toBeNull()
  })
})

describe('addDays·daysBetween', () => {
  it('addDays 는 월·연 경계를 넘는다', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-11-02', 0)).toBe('2026-11-02')
  })

  it('daysBetween 은 to − from 일수다', () => {
    expect(daysBetween('2026-10-30', '2026-11-02')).toBe(3)
    expect(daysBetween('2026-11-02', '2026-10-30')).toBe(-3)
    expect(daysBetween('2026-11-02', '2026-11-02')).toBe(0)
  })

  it('형식이 틀린 날짜는 throw 한다', () => {
    expect(() => addDays('2026/11/02', 1)).toThrow()
  })
})

type PlanLite = Pick<DailyPlan, 'id' | 'plan_date' | 'status'>

describe('A18: plansToAutoClose', () => {
  const plans: PlanLite[] = [
    { id: 3, plan_date: '2026-11-02', status: 'active' },
    { id: 1, plan_date: '2026-10-30', status: 'active' },
    { id: 2, plan_date: '2026-10-31', status: 'closed' }
  ]

  it('A18: 논리 날짜가 지난 active 계획만 고른다', () => {
    expect(plansToAutoClose(plans, '2026-11-03')).toEqual([1, 3])
  })

  it('A18: 오늘 논리 날짜의 active 계획은 닫지 않는다', () => {
    // 자정을 넘어 03:30 에 일해도 논리 날짜가 같으면 하루가 끊기지 않는다
    expect(plansToAutoClose(plans, '2026-11-02')).toEqual([1])
  })

  it('A18: 여러 번 실행해도 결과가 같다', () => {
    const first = plansToAutoClose(plans, '2026-11-03')
    expect(plansToAutoClose(plans, '2026-11-03')).toEqual(first)
    // 닫은 결과에 다시 적용하면 대상이 없다
    const after = plans.map((p) => (first.includes(p.id) ? { ...p, status: 'closed' as const } : p))
    expect(plansToAutoClose(after, '2026-11-03')).toEqual([])
  })

  it('A18: 입력 배열을 바꾸지 않는다', () => {
    const copy = JSON.parse(JSON.stringify(plans))
    plansToAutoClose(plans, '2026-11-03')
    expect(plans).toEqual(copy)
  })
})

describe('A22: shouldSendStartNudge', () => {
  // 2026-11-02 는 월요일이다
  const base = {
    settings: DEFAULT_ASSISTANT_SETTINGS,
    today: '2026-11-02',
    weekday: 1,
    hasPlanToday: false,
    nudgeSentToday: false,
    trigger: 'unlock-screen' as NudgeTrigger
  }
  const withSettings = (s: Partial<AssistantSettings>): AssistantSettings => ({
    ...DEFAULT_ASSISTANT_SETTINGS,
    ...s
  })

  it('A22: 모든 조건이 참이면 보낸다', () => {
    expect(shouldSendStartNudge(base)).toBe(true)
  })

  it('A22: 트리거는 unlock-screen·resume·focus 모두 허용한다', () => {
    for (const trigger of ['unlock-screen', 'resume', 'focus'] as NudgeTrigger[]) {
      expect(shouldSendStartNudge({ ...base, trigger })).toBe(true)
    }
  })

  it('A22: 오늘 계획이 있으면 보내지 않는다', () => {
    expect(shouldSendStartNudge({ ...base, hasPlanToday: true })).toBe(false)
  })

  it('A22: 논리 날짜당 최대 1회다. 이미 보냈으면 보내지 않는다', () => {
    expect(shouldSendStartNudge({ ...base, nudgeSentToday: true })).toBe(false)
  })

  it('A22: 토요일·일요일에는 보내지 않는다', () => {
    expect(shouldSendStartNudge({ ...base, weekday: 6 })).toBe(false)
    expect(shouldSendStartNudge({ ...base, weekday: 0 })).toBe(false)
    expect(shouldSendStartNudge({ ...base, weekday: 5 })).toBe(true)
  })

  it('A22: 비서가 꺼져 있거나 시작 알림이 꺼져 있으면 보내지 않는다', () => {
    expect(shouldSendStartNudge({ ...base, settings: withSettings({ enabled: false }) })).toBe(false)
    expect(shouldSendStartNudge({ ...base, settings: withSettings({ startNudge: false }) })).toBe(false)
  })

  it('A22: 알 수 없는 트리거면 보내지 않는다', () => {
    expect(shouldSendStartNudge({ ...base, trigger: 'tick' as unknown as NudgeTrigger })).toBe(false)
  })
})
