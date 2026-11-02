import { describe, it, expect } from 'vitest'
import { TRAY_ITEM_LIMIT, toTraySummary } from './assistant-tray'
import type { AssistantSettings, DailyPlan, PlanItem, TodayPayload } from './assistant-types'

const SETTINGS: AssistantSettings = {
  enabled: true, dayRollover: '04:00', startNudge: true, workEnd: '18:00',
  planSize: 5, llmEnabled: true, llmModel: 'sonnet', jiraScope: 'all', openAtLogin: false,
  refreshCalendarMin: 5, refreshJiraMin: 15, refreshNotify: true,
  checkinMinGap: 45, checkinDailyCap: 4, meetingLeadMin: 15, startView: 'auto',
  checkinEnabled: true
}

const plan = (over: Partial<DailyPlan> = {}): DailyPlan => ({
  id: 1, plan_date: '2026-11-02', status: 'active',
  started_at: '2026-11-02 09:40:12', closed_at: null, closed_by: null,
  source_snapshot: null,
  briefing_text: null, briefing_source: null, briefing_model: null, briefing_error: null, briefing_at: null,
  recovery_text: null, recovery_source: null, recovery_at: null,
  wrapup_note: null, wrapup_at: null, last_refresh_at: null, briefing_instruction: null,
  created_at: '2026-11-02 09:40:12', updated_at: '2026-11-02 09:40:12',
  ...over
})

const item = (id: number, over: Partial<PlanItem> = {}): PlanItem => ({
  id, plan_id: 1, candidate_id: `todo:${id}`, source: 'todo', title: `일 ${id}`,
  link: null, jira_issue_key: null, project_id: null, due_date: null,
  score: 0, rank: id, slot_start: null, slot_end: null,
  pinned: false, added_by: 'start', urgent: false,
  status: 'planned', status_note: null, status_at: null, first_planned_date: null,
  ...over
})

const payload = (over: Partial<TodayPayload> = {}): TodayPayload => ({
  logicalDate: '2026-11-02',
  plan: plan(),
  items: [],
  timeline: { entries: [], freeMinutesLeft: 120, focusItemId: null, unplacedDeadlineItemIds: [] },
  events: [],
  settings: SETTINGS,
  missingWrapupDate: null,
  aiAvailable: true, jiraConnected: true, calendarConnected: true, jiraTruncated: false,
  lastErrors: [],
  recovery: { inFlight: false, error: null },
  ...over
})

describe('toTraySummary', () => {
  it('A27 규칙 1: 계획이 없으면 none·빈 목록·수치 0 이다', () => {
    const r = toTraySummary(
      payload({
        plan: null,
        items: [item(1, { status: 'suggested', urgent: true })],
        timeline: { entries: [], freeMinutesLeft: 300, focusItemId: 1, unplacedDeadlineItemIds: [] }
      })
    )
    expect(r).toEqual({
      logicalDate: '2026-11-02', status: 'none', startedAt: null, items: [],
      activeCount: 0, doneCount: 0, suggestedCount: 0, urgentSuggestedCount: 0, freeMinutesLeft: 0
    })
  })

  it('A27 규칙 2: 활성 항목만 rank 오름차순 상위 3건이다. rank null 은 뒤, 같으면 id 순이다', () => {
    const r = toTraySummary(
      payload({
        items: [
          item(10, { rank: null }),
          item(5, { rank: 2, status: 'in_progress' }),
          item(4, { rank: 2 }),
          item(3, { rank: 1, status: 'done' }),
          item(2, { rank: 0, status: 'suggested' }),
          item(9, { rank: null }),
          item(7, { rank: 3, status: 'deferred' })
        ]
      })
    )
    expect(TRAY_ITEM_LIMIT).toBe(3)
    expect(r.items.map((i) => i.id)).toEqual([4, 5, 9])
    expect(r.items[1]).toEqual({ id: 5, title: '일 5', rank: 2, status: 'in_progress', isFocus: false })
  })

  it('A27 규칙 2: isFocus 는 timeline.focusItemId 와 같은 항목만 true 다', () => {
    const r = toTraySummary(
      payload({
        items: [item(1), item(2), item(3)],
        timeline: { entries: [], freeMinutesLeft: 60, focusItemId: 2, unplacedDeadlineItemIds: [] }
      })
    )
    expect(r.items.map((i) => i.isFocus)).toEqual([false, true, false])
  })

  it('A27 규칙 3: 활성·완료·제안·긴급 제안 수를 센다', () => {
    const r = toTraySummary(
      payload({
        items: [
          item(1), item(2, { status: 'in_progress' }), item(3), item(4), item(5),
          item(6, { status: 'done' }), item(7, { status: 'done' }),
          item(8, { status: 'suggested', urgent: true }), item(9, { status: 'suggested' }),
          item(10, { status: 'dismissed', urgent: true }), item(11, { status: 'dropped' })
        ]
      })
    )
    expect(r.items).toHaveLength(3)
    expect(r.activeCount).toBe(5)
    expect(r.doneCount).toBe(2)
    expect(r.suggestedCount).toBe(2)
    expect(r.urgentSuggestedCount).toBe(1)
  })

  it('A27 규칙 4: freeMinutesLeft·startedAt(HH:mm)·status 를 옮긴다', () => {
    const active = toTraySummary(payload())
    expect(active.status).toBe('active')
    expect(active.startedAt).toBe('09:40')
    expect(active.freeMinutesLeft).toBe(120)

    const closed = toTraySummary(payload({ plan: plan({ status: 'closed', closed_at: '2026-11-02 18:10:00' }) }))
    expect(closed.status).toBe('closed')
    expect(closed.logicalDate).toBe('2026-11-02')
  })

  it('A27 규칙 5: 입력을 바꾸지 않는다 (A14)', () => {
    const p = payload({ items: [item(3, { rank: 3 }), item(1, { rank: 1 }), item(2, { rank: 2 })] })
    const before = JSON.stringify(p)
    toTraySummary(p)
    expect(JSON.stringify(p)).toBe(before)
    expect(p.items.map((i) => i.id)).toEqual([3, 1, 2])
  })
})
