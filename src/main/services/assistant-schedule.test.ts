import { describe, expect, it } from 'vitest'
import { decideRefresh, TICK_MS, WAKE_MIN_GAP_MS } from './assistant-schedule'
import type { RefreshDecisionInput } from './assistant-types'

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
