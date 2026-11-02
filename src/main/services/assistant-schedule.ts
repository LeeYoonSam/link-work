// 자동 최신화 틱 판정 (docs/ASSISTANT.md 부록 E.2). 순수 모듈이다 (A3).
import type { RefreshDecisionInput, RefreshMode } from './assistant-types'

export const TICK_MS = 60_000
/** 깨어남이 캘린더 확인을 앞당기는 최소 간격. */
export const WAKE_MIN_GAP_MS = 120_000

function elapsed(nowMs: number, at: number | null, gapMs: number): boolean {
  return at === null || nowMs - at >= gapMs
}

/** A25. E.2.3 순서로 이번 틱의 mode 를 정한다. 할 일이 없으면 null. */
export function decideRefresh(input: RefreshDecisionInput): RefreshMode | null {
  const { nowMs, settings, times } = input
  if (!settings.enabled) return null
  if (!input.hasActivePlan) return null
  if (input.inFlight) return null

  let calendarDue = elapsed(nowMs, times.calendarAt, settings.refreshCalendarMin * 60_000)
  if (input.wake && elapsed(nowMs, times.calendarAt, WAKE_MIN_GAP_MS)) calendarDue = true
  // 깨어남은 Jira 주기를 앞당기지 않는다 (E.9)
  const jiraDue = elapsed(nowMs, times.jiraAt, settings.refreshJiraMin * 60_000)

  if (calendarDue && jiraDue) return 'full'
  if (calendarDue) return 'calendar'
  if (jiraDue) return 'jira'
  return null
}
