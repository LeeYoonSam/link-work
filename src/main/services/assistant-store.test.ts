import { beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3 → node:sqlite 교체. 이유는 project-priority.migration.test.ts 상단 주석과 같다.
// 저장소 함수는 db 를 인자로 받으므로 인메모리 DB 에 비서 스키마만 만들어 검증한다.
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  type Args = unknown[]

  class BetterSqlite3Shim {
    private readonly db: InstanceType<typeof DatabaseSync>

    constructor() {
      this.db = new DatabaseSync(':memory:')
    }

    pragma(statement: string): void {
      this.db.exec(`PRAGMA ${statement}`)
    }

    exec(sql: string): void {
      this.db.exec(sql)
    }

    prepare(sql: string): unknown {
      return this.db.prepare(sql)
    }

    transaction<T>(fn: (...args: Args) => T): (...args: Args) => T {
      return (...args: Args): T => {
        this.db.exec('BEGIN')
        try {
          const result = fn(...args)
          this.db.exec('COMMIT')
          return result
        } catch (e) {
          this.db.exec('ROLLBACK')
          throw e
        }
      }
    }

    close(): void {
      this.db.close()
    }
  }

  return { default: BetterSqlite3Shim }
})

import Database from 'better-sqlite3'
import { ASSISTANT_SCHEMA, migrateAssistantSchema } from './assistant-schema'
import { DEFAULT_ASSISTANT_SETTINGS } from './assistant-settings'
import {
  applyRefreshPlan,
  closePlan,
  closeStalePlans,
  createPlan,
  findEventByKey,
  getActivePlan,
  getEventById,
  getLastPlanBefore,
  getPlanByDate,
  getPlanItem,
  insertEvent,
  insertPlanItems,
  listEventsByDate,
  listPlanItems,
  readAssistantSettings,
  reopenPlan,
  saveWrapupNote,
  setBriefing,
  setBriefingError,
  setBriefingInstruction,
  setEventResponse,
  setRecovery,
  updateEventPayload,
  updateEventStatus,
  updatePlanItems,
  writeAssistantSettings
} from './assistant-store'
import type {
  NewAssistantEvent,
  NewPlanItem,
  PlanItem,
  PlanItemStatus,
  RefreshPlan,
  SourceSnapshot
} from './assistant-types'

const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const AT = '2026-11-02 09:40:00'

const SNAPSHOT: SourceSnapshot = {
  calendar: [{ id: 'ev1', title: '스탠드업', start: '10:00', end: '10:30', allDay: false }],
  jira: [],
  seenCandidateIds: ['todo:1'],
  takenAt: AT
}

function item(candidateId: string, over: Partial<NewPlanItem> = {}): NewPlanItem {
  const [source] = candidateId.split(':') as [NewPlanItem['source']]
  return {
    candidate_id: candidateId,
    source,
    title: `제목 ${candidateId}`,
    link: null,
    jira_issue_key: null,
    project_id: null,
    due_date: null,
    score: 10,
    rank: 1,
    // 3판 새 항목은 슬롯 NULL, pinned false 다 (부록 B.6)
    slot_start: null,
    slot_end: null,
    pinned: false,
    added_by: 'start',
    urgent: false,
    status: 'planned',
    status_note: null,
    work_type: 'etc',
    work_version: null,
    parent_key: null,
    group_name: null,
    ...over
  }
}

function emptyRefresh(over: Partial<RefreshPlan> = {}): RefreshPlan {
  return {
    inserts: [],
    updates: [],
    snapshot: { ...SNAPSHOT, takenAt: '2026-11-02 11:00:00' },
    summary: {
      calendarAdded: 0,
      calendarChanged: 0,
      calendarRemoved: 0,
      suggested: 0,
      urgentSuggestedIds: [],
      completed: 0,
      dropped: 0,
      replaced: 0,
      timelineChanged: false,
      currentOrNextChanged: false
    },
    ...over
  }
}

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`)
  db.exec(ASSISTANT_SCHEMA)
  // database.ts 와 같은 순서다. 옛 DB 에서만 컬럼을 더한다 (부록 G.16 위험 13)
  migrateAssistantSchema(db)
})

function startPlan(date = '2026-11-02', items: NewPlanItem[] = [item('todo:1')]) {
  return createPlan(db, { plan_date: date, started_at: `${date} 09:40:00`, source_snapshot: SNAPSHOT, items })
}

describe('설정', () => {
  it('행이 없으면 기본값이다', () => {
    expect(readAssistantSettings(db)).toEqual(DEFAULT_ASSISTANT_SETTINGS)
  })

  it('writeAssistantSettings 는 assistant_* 키만 쓰고 결과를 돌려준다', () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('jira_site', 'x')").run()
    const s = writeAssistantSettings(db, { planSize: 3, workEnd: '19:00' })
    expect(s.planSize).toBe(3)
    expect(s.workEnd).toBe('19:00')
    // 덮어쓰기
    expect(writeAssistantSettings(db, { planSize: 4 }).planSize).toBe(4)
    const rows = db.prepare('SELECT key, value FROM app_settings ORDER BY key').all()
    expect(rows).toEqual([
      { key: 'assistant_plan_size', value: '4' },
      { key: 'assistant_work_end', value: '19:00' },
      { key: 'jira_site', value: 'x' }
    ])
  })

  it('형식이 틀린 patch 는 throw 하고 아무것도 쓰지 않는다', () => {
    expect(() => writeAssistantSettings(db, { planSize: 3, workEnd: 'late' })).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM app_settings').get()).toEqual({ n: 0 })
  })
})

describe('계획 생성·조회', () => {
  it('createPlan 은 계획·항목·스냅샷을 저장하고 boolean·JSON 을 변환해 돌려준다', () => {
    const plan = startPlan('2026-11-02', [item('todo:1', { urgent: true }), item('task:2', { rank: 2 })])
    expect(plan.status).toBe('active')
    expect(plan.source_snapshot).toEqual(SNAPSHOT)
    const items = listPlanItems(db, plan.id)
    expect(items.map((i) => i.candidate_id)).toEqual(['todo:1', 'task:2'])
    expect(items[0].pinned).toBe(false)
    expect(items[0].urgent).toBe(true)
    expect(items[1].pinned).toBe(false)
    expect(items[1].urgent).toBe(false)
    expect(getPlanByDate(db, '2026-11-02')?.id).toBe(plan.id)
    expect(getActivePlan(db)?.id).toBe(plan.id)
  })

  it('B.6: 새 항목은 slot_start·slot_end NULL, pinned 0 으로 저장한다', () => {
    const plan = startPlan('2026-11-02', [item('todo:1'), item('task:2', { rank: 2 })])
    const rows = db
      .prepare('SELECT slot_start, slot_end, pinned FROM plan_items WHERE plan_id = ? ORDER BY id')
      .all(plan.id)
    expect(rows).toEqual([
      { slot_start: null, slot_end: null, pinned: 0 },
      { slot_start: null, slot_end: null, pinned: 0 }
    ])
  })

  it('source_snapshot JSON 파싱이 실패하면 null 이다', () => {
    const plan = startPlan()
    db.prepare("UPDATE daily_plans SET source_snapshot = '{broken' WHERE id = ?").run(plan.id)
    expect(getPlanByDate(db, '2026-11-02')?.source_snapshot).toBeNull()
  })

  it('A17: active 계획이 이미 있으면 createPlan 이 throw 한다', () => {
    startPlan('2026-11-01')
    expect(() => startPlan('2026-11-02')).toThrow()
    // 트랜잭션이 롤백되어 두 번째 계획과 항목이 남지 않는다
    expect(getPlanByDate(db, '2026-11-02')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM plan_items').get()).toEqual({ n: 1 })
  })

  it('A17: SQL 로 active 계획을 하나 더 넣으면 부분 UNIQUE 인덱스가 막는다', () => {
    startPlan('2026-11-01')
    expect(() =>
      db
        .prepare("INSERT INTO daily_plans (plan_date, status, started_at) VALUES ('2026-11-02', 'active', ?)")
        .run(AT)
    ).toThrow()
  })

  it('A17: 다른 active 계획이 있으면 reopenPlan 이 throw 한다', () => {
    const old = startPlan('2026-11-01')
    closePlan(db, old.id, 'button', '2026-11-01 18:00:00')
    startPlan('2026-11-02')
    expect(() => reopenPlan(db, old.id, AT)).toThrow()
    expect(getPlanByDate(db, '2026-11-01')?.status).toBe('closed')
  })

  it('getLastPlanBefore 는 지정 날짜 이전의 가장 최근 계획이다', () => {
    const a = startPlan('2026-10-30')
    closePlan(db, a.id, 'button', '2026-10-30 18:00:00')
    const b = startPlan('2026-10-31')
    closePlan(db, b.id, 'auto', '2026-11-02 09:00:00')
    expect(getLastPlanBefore(db, '2026-11-02')?.plan_date).toBe('2026-10-31')
    expect(getLastPlanBefore(db, '2026-10-30')).toBeNull()
  })
})

describe('퇴근·다시 열기·메모', () => {
  it('closePlan 은 closed·closed_by·퇴근 메모를 저장한다', () => {
    const plan = startPlan()
    const closed = closePlan(db, plan.id, 'button', '2026-11-02 18:30:00', '  내일 리뷰  ')
    expect(closed.status).toBe('closed')
    expect(closed.closed_by).toBe('button')
    expect(closed.closed_at).toBe('2026-11-02 18:30:00')
    expect(closed.wrapup_note).toBe('내일 리뷰')
    expect(closed.wrapup_at).toBe('2026-11-02 18:30:00')
    expect(getActivePlan(db)).toBeNull()
  })

  it('closePlan 은 빈 메모를 저장하지 않는다', () => {
    const plan = startPlan()
    expect(closePlan(db, plan.id, 'button', '2026-11-02 18:30:00', '   ').wrapup_note).toBeNull()
  })

  it('이미 닫힌 계획에 closePlan 을 다시 부르면 바꾸지 않는다', () => {
    const plan = startPlan()
    closePlan(db, plan.id, 'button', '2026-11-02 18:30:00')
    const again = closePlan(db, plan.id, 'auto', '2026-11-03 09:00:00')
    expect(again.closed_by).toBe('button')
    expect(again.closed_at).toBe('2026-11-02 18:30:00')
  })

  it('reopenPlan 은 closed 계획을 active 로 되돌린다', () => {
    const plan = startPlan()
    closePlan(db, plan.id, 'button', '2026-11-02 18:30:00')
    const reopened = reopenPlan(db, plan.id, '2026-11-02 18:31:00')
    expect(reopened.status).toBe('active')
    expect(reopened.closed_at).toBeNull()
    expect(reopened.closed_by).toBeNull()
  })

  it('saveWrapupNote 는 지정 날짜 계획에 저장한다. 계획이 없으면 null 이다', () => {
    const plan = startPlan()
    closePlan(db, plan.id, 'auto', '2026-11-03 09:00:00')
    expect(saveWrapupNote(db, '2026-11-02', '어제 메모', '2026-11-03 09:10:00')?.wrapup_note).toBe('어제 메모')
    expect(saveWrapupNote(db, '2026-10-01', 'x', '2026-11-03 09:10:00')).toBeNull()
  })
})

describe('A18: closeStalePlans', () => {
  it('A18: 논리 날짜가 지난 active 계획만 auto 로 닫는다', () => {
    const plan = startPlan('2026-11-02')
    expect(closeStalePlans(db, '2026-11-02', '2026-11-03 03:30:00')).toEqual([])
    expect(getPlanByDate(db, '2026-11-02')?.status).toBe('active')
    expect(closeStalePlans(db, '2026-11-03', '2026-11-03 09:00:00')).toEqual([plan.id])
    const closed = getPlanByDate(db, '2026-11-02')
    expect(closed?.status).toBe('closed')
    expect(closed?.closed_by).toBe('auto')
    expect(closed?.closed_at).toBe('2026-11-03 09:00:00')
  })

  it('A18: 여러 번 실행해도 결과가 같다', () => {
    startPlan('2026-11-02')
    closeStalePlans(db, '2026-11-03', '2026-11-03 09:00:00')
    const snapshot = getPlanByDate(db, '2026-11-02')
    expect(closeStalePlans(db, '2026-11-03', '2026-11-03 10:00:00')).toEqual([])
    expect(getPlanByDate(db, '2026-11-02')).toEqual(snapshot)
  })
})

describe('A12: 날짜·시각 형식', () => {
  it('A12: 저장된 datetime 은 모두 로컬 YYYY-MM-DD HH:mm:ss 다', () => {
    const plan = startPlan()
    setBriefing(db, plan.id, { text: '본문', source: 'rules', model: null, at: '2026-11-02 09:41:00' })
    setBriefingError(db, plan.id, 'AI 로그인 필요')
    const [it0] = listPlanItems(db, plan.id)
    updatePlanItems(db, [{ id: it0.id, patch: { status: 'done' } }], '2026-11-02 10:00:00')
    closePlan(db, plan.id, 'button', '2026-11-02 18:00:00', '메모')
    const row = db.prepare('SELECT * FROM daily_plans WHERE id = ?').get(plan.id) as Record<string, unknown>
    for (const col of ['started_at', 'closed_at', 'briefing_at', 'wrapup_at', 'created_at', 'updated_at']) {
      expect(row[col], col).toMatch(DATETIME_RE)
    }
    expect(row.plan_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(getPlanItem(db, it0.id)?.status_at).toMatch(DATETIME_RE)
    const ev = insertEvent(db, {
      event_key: 'start_nudge:2026-11-02:-',
      kind: 'start_nudge',
      plan_date: '2026-11-02',
      scheduled_at: AT,
      fired_at: AT,
      status: 'sent',
      ref_id: null,
      payload: null
    })
    expect(ev?.created_at).toMatch(DATETIME_RE)
  })

  it('A12: UTC ISO datetime 을 넘기면 throw 하고 쓰지 않는다', () => {
    const iso = '2026-11-02T00:40:00.000Z'
    expect(() =>
      createPlan(db, { plan_date: '2026-11-02', started_at: iso, source_snapshot: SNAPSHOT, items: [] })
    ).toThrow()
    expect(getActivePlan(db)).toBeNull()
    const plan = startPlan()
    expect(() => closePlan(db, plan.id, 'button', iso)).toThrow()
    expect(() => closeStalePlans(db, '2026-11-03', iso)).toThrow()
    expect(() => updatePlanItems(db, [], iso)).toThrow()
    expect(() =>
      insertEvent(db, {
        event_key: 'k',
        kind: 'start_nudge',
        plan_date: '2026-11-02',
        scheduled_at: iso,
        fired_at: null,
        status: 'sent',
        ref_id: null,
        payload: null
      })
    ).toThrow()
    expect(getActivePlan(db)?.status).toBe('active')
  })
})

describe('계획 항목', () => {
  it('insertPlanItems 는 항목을 추가하고 돌려준다. 같은 후보는 throw 한다', () => {
    const plan = startPlan()
    const added = insertPlanItems(db, plan.id, [item('jira:PROJ-1', { status: 'suggested', rank: null, added_by: 'refresh', urgent: true })])
    expect(added).toHaveLength(1)
    expect(added[0].status).toBe('suggested')
    expect(added[0].urgent).toBe(true)
    expect(added[0].status_at).toBeNull()
    expect(() => insertPlanItems(db, plan.id, [item('todo:1')])).toThrow()
  })

  it('listPlanItems 는 rank 순, rank 없는 항목은 뒤로 정렬한다', () => {
    const plan = startPlan('2026-11-02', [
      item('todo:3', { rank: 2 }),
      item('todo:1', { rank: 1 }),
      item('jira:A-1', { rank: null, status: 'suggested' })
    ])
    expect(listPlanItems(db, plan.id).map((i) => i.candidate_id)).toEqual(['todo:1', 'todo:3', 'jira:A-1'])
  })

  it('updatePlanItems 는 status 가 바뀔 때만 status_at 을 바꾼다', () => {
    const plan = startPlan()
    const [it0] = listPlanItems(db, plan.id)
    updatePlanItems(db, [{ id: it0.id, patch: { rank: 3, status_note: '메모' } }], '2026-11-02 10:00:00')
    let cur = getPlanItem(db, it0.id) as PlanItem
    expect(cur.rank).toBe(3)
    expect(cur.status_note).toBe('메모')
    expect(cur.status_at).toBeNull()
    updatePlanItems(db, [{ id: it0.id, patch: { status: 'in_progress' } }], '2026-11-02 10:05:00')
    cur = getPlanItem(db, it0.id) as PlanItem
    expect(cur.status_at).toBe('2026-11-02 10:05:00')
    // 같은 status 로 다시 써도 status_at 은 그대로다
    updatePlanItems(db, [{ id: it0.id, patch: { status: 'in_progress' } }], '2026-11-02 10:10:00')
    expect(getPlanItem(db, it0.id)?.status_at).toBe('2026-11-02 10:05:00')
  })

  it('updatePlanItems 는 없는 항목 id 를 건너뛴다', () => {
    startPlan()
    expect(() => updatePlanItems(db, [{ id: 999, patch: { status: 'done' } }], AT)).not.toThrow()
  })
})

describe('A50: 업무 유형 컬럼 저장', () => {
  it('A50: insertPlanItems 가 4개 컬럼을 저장하고 돌려준다', () => {
    const plan = startPlan()
    const [added] = insertPlanItems(db, plan.id, [
      item('jira:ICA-8971', {
        title: '안드로이드 구매자 앱 v4.174.0 QA', jira_issue_key: 'ICA-8971',
        work_type: 'qa', work_version: '4.174.0', parent_key: 'ICA-8054', group_name: '안드로이드QA-2026'
      })
    ])
    expect(added).toMatchObject({
      work_type: 'qa', work_version: '4.174.0', parent_key: 'ICA-8054', group_name: '안드로이드QA-2026'
    })
    expect(getPlanItem(db, added.id)).toMatchObject({ work_type: 'qa', parent_key: 'ICA-8054' })
  })

  it('A50: updatePlanItems 는 4개 컬럼을 바꾸고 상태·status_at 은 그대로 둔다', () => {
    const plan = startPlan('2026-11-02', [item('jira:ICA-8984', { jira_issue_key: 'ICA-8984', status: 'in_progress' })])
    const [it0] = listPlanItems(db, plan.id)
    updatePlanItems(db, [{
      id: it0.id,
      patch: { work_type: 'prd', work_version: null, parent_key: 'ICA-8929', group_name: '[폴더블] 넓은 화면 공통 기준 적용 - Android' }
    }], AT)
    const cur = getPlanItem(db, it0.id) as PlanItem
    expect(cur).toMatchObject({
      work_type: 'prd', parent_key: 'ICA-8929', group_name: '[폴더블] 넓은 화면 공통 기준 적용 - Android',
      status: 'in_progress', status_at: null
    })
  })

  it('A50: 분류 없이 넣은 항목은 work_type etc, 나머지 3개는 null 로 읽는다', () => {
    const plan = startPlan()
    const [it0] = listPlanItems(db, plan.id)
    expect(it0).toMatchObject({ work_type: 'etc', work_version: null, parent_key: null, group_name: null })
  })
})

describe('B.5: first_planned_date', () => {
  // 하루 계획을 만들고 닫는다. 다음 날 계획을 만들 수 있게 한다.
  function closedPlan(date: string, items: NewPlanItem[]) {
    const plan = startPlan(date, items)
    closePlan(db, plan.id, 'button', `${date} 18:00:00`)
    return plan
  }

  function byCand(planId: number): Record<string, PlanItem> {
    return Object.fromEntries(listPlanItems(db, planId).map((i) => [i.candidate_id, i]))
  }

  it('B.5: 오늘 계획에만 있으면 오늘 날짜다', () => {
    const plan = startPlan('2026-11-02', [item('todo:1')])
    expect(listPlanItems(db, plan.id)[0].first_planned_date).toBe('2026-11-02')
  })

  it('B.5: 여러 날 계획에 오른 후보는 처음 오른 날짜다', () => {
    const d1 = closedPlan('2026-10-29', [item('todo:1'), item('todo:2', { rank: 2 })])
    const d2 = closedPlan('2026-10-30', [item('todo:1', { status: 'deferred' })])
    const today = startPlan('2026-11-02', [item('todo:1'), item('todo:2', { rank: 2 }), item('todo:3', { rank: 3 })])
    const cur = byCand(today.id)
    expect(cur['todo:1'].first_planned_date).toBe('2026-10-29')
    expect(cur['todo:2'].first_planned_date).toBe('2026-10-29')
    expect(cur['todo:3'].first_planned_date).toBe('2026-11-02')
    // getPlanItem 도 같은 값을 채운다
    expect(getPlanItem(db, cur['todo:1'].id)?.first_planned_date).toBe('2026-10-29')
    // 지난 계획의 항목도 같은 정의다
    expect(byCand(d1.id)['todo:1'].first_planned_date).toBe('2026-10-29')
    expect(byCand(d2.id)['todo:1'].first_planned_date).toBe('2026-10-29')
  })

  it('B.5: suggested·dismissed 행은 계산에서 뺀다', () => {
    closedPlan('2026-10-29', [item('jira:A-1', { status: 'suggested', rank: null, added_by: 'refresh' })])
    closedPlan('2026-10-30', [item('jira:A-1', { status: 'dismissed', rank: null, added_by: 'refresh' })])
    const today = startPlan('2026-11-02', [item('jira:A-1')])
    expect(byCand(today.id)['jira:A-1'].first_planned_date).toBe('2026-11-02')
  })

  it('B.5: suggested 행뿐이면 null 이다. 수락하면 그 계획 날짜가 된다', () => {
    const plan = startPlan('2026-11-02', [item('todo:1')])
    const [sugg] = insertPlanItems(db, plan.id, [
      item('jira:B-2', { status: 'suggested', rank: null, added_by: 'refresh' })
    ])
    expect(sugg.first_planned_date).toBeNull()
    updatePlanItems(db, [{ id: sugg.id, patch: { status: 'planned', rank: 2 } }], '2026-11-02 11:00:00')
    expect(getPlanItem(db, sugg.id)?.first_planned_date).toBe('2026-11-02')
  })

  it('B.5: insertPlanItems·applyRefreshPlan 이 넣은 항목도 값을 채운다', () => {
    closedPlan('2026-10-30', [item('todo:7')])
    const plan = startPlan('2026-11-02', [item('todo:1')])
    const [added] = insertPlanItems(db, plan.id, [item('todo:7', { rank: 2, added_by: 'user' })])
    expect(added.first_planned_date).toBe('2026-10-30')
    applyRefreshPlan(
      db,
      plan.id,
      emptyRefresh({ inserts: [item('jira:C-3', { status: 'suggested', rank: null, added_by: 'refresh' })] }),
      '2026-11-02 11:00:00'
    )
    expect(byCand(plan.id)['jira:C-3'].first_planned_date).toBeNull()
  })

  it('B.5: 지난 계획을 볼 때 그 뒤 계획의 날짜는 쓰지 않는다', () => {
    const old = closedPlan('2026-10-30', [item('jira:D-4', { status: 'suggested', rank: null, added_by: 'refresh' })])
    startPlan('2026-11-02', [item('jira:D-4')])
    expect(byCand(old.id)['jira:D-4'].first_planned_date).toBeNull()
  })
})

describe('A15: 사용자 결정 보존', () => {
  const decided: PlanItemStatus[] = ['done', 'deferred', 'dropped', 'dismissed']

  function planWithDecisions() {
    const plan = startPlan('2026-11-02', [
      item('todo:1', { rank: 1 }),
      item('todo:2', { rank: 2, status: 'done' }),
      item('todo:3', { rank: 3, status: 'deferred' }),
      item('todo:4', { rank: 4, status: 'dropped' }),
      item('jira:A-1', { rank: null, status: 'dismissed' })
    ])
    const items = listPlanItems(db, plan.id)
    const byCand = Object.fromEntries(items.map((i) => [i.candidate_id, i]))
    return { plan, items, byCand }
  }

  it('A15: updatePlanItems 는 지정하지 않은 항목의 done·deferred·dropped·dismissed 상태를 바꾸지 않는다', () => {
    const { byCand, items } = planWithDecisions()
    const before = items.filter((i) => decided.includes(i.status))
    updatePlanItems(db, [{ id: byCand['todo:1'].id, patch: { rank: 1, status: 'in_progress' } }], '2026-11-02 11:00:00')
    for (const b of before) {
      expect(getPlanItem(db, b.id)).toEqual(b)
    }
    expect(getPlanItem(db, byCand['todo:1'].id)?.status).toBe('in_progress')
  })

  it('A15: updatePlanItems 는 patch 에 없는 필드를 바꾸지 않는다', () => {
    const { byCand } = planWithDecisions()
    const done = byCand['todo:2']
    updatePlanItems(db, [{ id: done.id, patch: { status_note: '끝냄' } }], '2026-11-02 11:00:00')
    const after = getPlanItem(db, done.id) as PlanItem
    expect(after.status).toBe('done')
    expect(after.status_at).toBe(done.status_at)
    expect(after.status_note).toBe('끝냄')
    expect({ ...after, status_note: done.status_note }).toEqual(done)
  })

  it('A15: applyRefreshPlan 은 지정하지 않은 항목의 done·deferred·dropped·dismissed 상태를 바꾸지 않는다', () => {
    const { plan, items, byCand } = planWithDecisions()
    const before = items.filter((i) => decided.includes(i.status))
    applyRefreshPlan(
      db,
      plan.id,
      emptyRefresh({
        inserts: [item('jira:B-2', { rank: null, status: 'suggested', added_by: 'refresh' })],
        updates: [{ id: byCand['todo:1'].id, patch: { rank: 2 } }]
      }),
      '2026-11-02 11:00:00'
    )
    for (const b of before) {
      expect(getPlanItem(db, b.id)).toEqual(b)
    }
    const after = listPlanItems(db, plan.id)
    expect(after).toHaveLength(items.length + 1)
    expect(after.find((i) => i.candidate_id === 'jira:B-2')?.status).toBe('suggested')
  })
})

describe('applyRefreshPlan', () => {
  it('스냅샷·last_refresh_at 을 저장한다', () => {
    const plan = startPlan()
    const refresh = emptyRefresh()
    applyRefreshPlan(db, plan.id, refresh, '2026-11-02 11:00:00')
    const after = getPlanByDate(db, '2026-11-02')
    expect(after?.source_snapshot).toEqual(refresh.snapshot)
    expect(after?.last_refresh_at).toBe('2026-11-02 11:00:00')
  })

  it('이미 계획에 있는 후보의 insert 는 건너뛴다', () => {
    const plan = startPlan()
    expect(() =>
      applyRefreshPlan(db, plan.id, emptyRefresh({ inserts: [item('todo:1', { status: 'suggested' })] }), '2026-11-02 11:00:00')
    ).not.toThrow()
    const items = listPlanItems(db, plan.id)
    expect(items).toHaveLength(1)
    expect(items[0].status).toBe('planned')
  })

  it('다른 계획의 항목 update 는 반영하지 않는다', () => {
    const old = startPlan('2026-11-01')
    const [oldItem] = listPlanItems(db, old.id)
    closePlan(db, old.id, 'button', '2026-11-01 18:00:00')
    const plan = startPlan('2026-11-02')
    applyRefreshPlan(db, plan.id, emptyRefresh({ updates: [{ id: oldItem.id, patch: { status: 'dropped' } }] }), '2026-11-02 11:00:00')
    expect(getPlanItem(db, oldItem.id)?.status).toBe('planned')
  })

  it('중간에 실패하면 전부 롤백한다', () => {
    const plan = startPlan()
    const bad = emptyRefresh({
      inserts: [item('jira:C-3', { status: 'suggested' })],
      // title 은 NOT NULL 이다
      updates: [{ id: listPlanItems(db, plan.id)[0].id, patch: { title: null as unknown as string } }]
    })
    expect(() => applyRefreshPlan(db, plan.id, bad, '2026-11-02 11:00:00')).toThrow()
    expect(listPlanItems(db, plan.id)).toHaveLength(1)
    expect(getPlanByDate(db, '2026-11-02')?.last_refresh_at).toBeNull()
  })
})

describe('브리핑', () => {
  it('setBriefing 은 briefing_error 를 지운다. setBriefingError 는 본문을 유지한다', () => {
    const plan = startPlan()
    setBriefing(db, plan.id, { text: '규칙 본문', source: 'rules', model: null, at: '2026-11-02 09:41:00' })
    setBriefingError(db, plan.id, '로그인 필요')
    let p = getPlanByDate(db, '2026-11-02')
    expect(p?.briefing_text).toBe('규칙 본문')
    expect(p?.briefing_error).toBe('로그인 필요')
    setBriefing(db, plan.id, { text: 'LLM 본문', source: 'llm', model: 'claude-sonnet-5-5', at: '2026-11-02 09:42:00' })
    p = getPlanByDate(db, '2026-11-02')
    expect(p?.briefing_text).toBe('LLM 본문')
    expect(p?.briefing_source).toBe('llm')
    expect(p?.briefing_model).toBe('claude-sonnet-5-5')
    expect(p?.briefing_error).toBeNull()
  })
})

describe('브리핑 지시 저장 (부록 G.7.1)', () => {
  it('새 계획의 briefing_instruction 은 null 이다', () => {
    startPlan()
    expect(getPlanByDate(db, '2026-11-02')?.briefing_instruction).toBeNull()
  })

  it('setBriefingInstruction 은 briefing_instruction 과 updated_at 만 쓰고 브리핑 본문은 건드리지 않는다', () => {
    const plan = startPlan()
    setBriefing(db, plan.id, { text: '규칙 본문', source: 'rules', model: null, at: '2026-11-02 09:41:00' })
    setBriefingInstruction(db, plan.id, '배포 준비 위주', '2026-11-02 10:00:00')
    let p = getPlanByDate(db, '2026-11-02')
    expect(p?.briefing_instruction).toBe('배포 준비 위주')
    expect(p?.updated_at).toBe('2026-11-02 10:00:00')
    expect(p?.briefing_text).toBe('규칙 본문')
    expect(p?.briefing_at).toBe('2026-11-02 09:41:00')
    expect(getActivePlan(db)?.briefing_instruction).toBe('배포 준비 위주')
    expect(getLastPlanBefore(db, '2026-11-03')?.briefing_instruction).toBe('배포 준비 위주')

    setBriefingInstruction(db, plan.id, null, '2026-11-02 10:05:00')
    p = getPlanByDate(db, '2026-11-02')
    expect(p?.briefing_instruction).toBeNull()
    expect(p?.updated_at).toBe('2026-11-02 10:05:00')
  })

  it('A12: setBriefingInstruction 은 로컬 형식이 아닌 at 을 거부한다', () => {
    const plan = startPlan()
    expect(() => setBriefingInstruction(db, plan.id, '방침', '2026-11-02T10:00:00Z')).toThrow()
    expect(getPlanByDate(db, '2026-11-02')?.briefing_instruction).toBeNull()
  })

  it('옛 DDL 에 migrateAssistantSchema 를 실행한 DB 에서도 저장·조회한다', () => {
    const old = new Database(':memory:')
    old.exec(ASSISTANT_SCHEMA.replace('    briefing_instruction TEXT,\n', ''))
    migrateAssistantSchema(old)
    const plan = createPlan(old, {
      plan_date: '2026-11-02', started_at: '2026-11-02 09:40:00', source_snapshot: SNAPSHOT, items: []
    })
    expect(plan.briefing_instruction).toBeNull()
    setBriefingInstruction(old, plan.id, '리뷰 먼저', '2026-11-02 10:00:00')
    expect(getPlanByDate(old, '2026-11-02')?.briefing_instruction).toBe('리뷰 먼저')
    old.close()
  })
})

describe('맥락 복구 저장', () => {
  it('setRecovery 는 recovery_* 3개 컬럼과 updated_at 을 쓰고 브리핑은 건드리지 않는다', () => {
    const plan = startPlan()
    setBriefing(db, plan.id, { text: '브리핑', source: 'rules', model: null, at: '2026-11-02 09:41:00' })
    setRecovery(db, plan.id, { text: '# 규칙 복구', source: 'rules', at: '2026-11-02 09:42:00' })
    let p = getPlanByDate(db, '2026-11-02')
    expect(p?.recovery_text).toBe('# 규칙 복구')
    expect(p?.recovery_source).toBe('rules')
    expect(p?.recovery_at).toBe('2026-11-02 09:42:00')
    expect(p?.updated_at).toBe('2026-11-02 09:42:00')
    expect(p?.briefing_text).toBe('브리핑')

    setRecovery(db, plan.id, { text: '# AI 복구', source: 'llm', at: '2026-11-02 09:43:00' })
    p = getPlanByDate(db, '2026-11-02')
    expect(p?.recovery_text).toBe('# AI 복구')
    expect(p?.recovery_source).toBe('llm')
    expect(p?.recovery_at).toBe('2026-11-02 09:43:00')
  })

  it('setRecovery 는 닫힌 계획에도 plan_id 로 저장한다', () => {
    const plan = startPlan()
    closePlan(db, plan.id, 'button', '2026-11-02 18:00:00', null)
    setRecovery(db, plan.id, { text: '본문', source: 'rules', at: '2026-11-02 18:01:00' })
    const p = getPlanByDate(db, '2026-11-02')
    expect(p?.status).toBe('closed')
    expect(p?.recovery_text).toBe('본문')
  })

  it('A12: setRecovery 는 로컬 형식이 아닌 at 을 거부한다', () => {
    const plan = startPlan()
    expect(() =>
      setRecovery(db, plan.id, { text: '본문', source: 'rules', at: '2026-11-02T09:42:00Z' })
    ).toThrow()
    expect(getPlanByDate(db, '2026-11-02')?.recovery_text).toBeNull()
  })
})

describe('비서 이벤트', () => {
  const ev: NewAssistantEvent = {
    event_key: 'start_nudge:2026-11-02:-',
    kind: 'start_nudge',
    plan_date: '2026-11-02',
    scheduled_at: AT,
    fired_at: null,
    status: 'sent',
    ref_id: null,
    payload: '{"title":"오늘 시작할까요?"}'
  }

  it('A5: 같은 event_key 는 1회만 기록한다. 두 번째 insertEvent 는 null 이다', () => {
    const first = insertEvent(db, ev)
    expect(first?.event_key).toBe(ev.event_key)
    expect(insertEvent(db, { ...ev, status: 'late' })).toBeNull()
    expect(findEventByKey(db, ev.event_key)?.status).toBe('sent')
  })

  it('updateEventStatus·listEventsByDate', () => {
    const a = insertEvent(db, ev)
    insertEvent(db, { ...ev, event_key: 'plan_update:2026-11-02:1', kind: 'plan_update', status: 'logged', scheduled_at: '2026-11-02 11:00:00' })
    insertEvent(db, { ...ev, event_key: 'start_nudge:2026-11-03:-', plan_date: '2026-11-03', scheduled_at: '2026-11-03 09:00:00' })
    updateEventStatus(db, a!.id, 'failed')
    const list = listEventsByDate(db, '2026-11-02')
    expect(list.map((e) => e.event_key)).toEqual(['start_nudge:2026-11-02:-', 'plan_update:2026-11-02:1'])
    expect(list[0].status).toBe('failed')
    expect(findEventByKey(db, 'none')).toBeNull()
  })

  it('getEventById: id 로 행을 읽는다. 없으면 null 이다', () => {
    const a = insertEvent(db, ev)
    expect(getEventById(db, a!.id)?.event_key).toBe(ev.event_key)
    expect(getEventById(db, a!.id)?.response).toBeNull()
    expect(getEventById(db, 9999)).toBeNull()
  })

  it('setEventResponse: response·responded_at 만 쓴다 (부록 H.7)', () => {
    const meeting = insertEvent(db, {
      ...ev,
      event_key: 'meeting_briefing:2026-11-02:m7',
      kind: 'meeting_briefing',
      scheduled_at: '2026-11-02 10:55:00',
      fired_at: '2026-11-02 10:55:30',
      ref_id: '7',
      payload: '{"itemId":7}'
    })
    setEventResponse(db, meeting!.id, 'button:done', '2026-11-02 10:58:00')
    const row = getEventById(db, meeting!.id)
    expect(row?.response).toBe('button:done')
    expect(row?.responded_at).toBe('2026-11-02 10:58:00')
    // 다른 컬럼은 그대로다
    expect(row?.status).toBe('sent')
    expect(row?.payload).toBe('{"itemId":7}')
  })

  it('A12: setEventResponse 는 at 형식이 틀리면 throw 하고 쓰지 않는다', () => {
    const a = insertEvent(db, ev)
    expect(() => setEventResponse(db, a!.id, 'skip', '2026-11-02T10:58:00')).toThrow()
    expect(getEventById(db, a!.id)?.response).toBeNull()
  })

  it('updateEventPayload: 지정한 행의 payload 만 바꾼다 (부록 I.8)', () => {
    const meeting = insertEvent(db, {
      ...ev,
      event_key: 'meeting_briefing:2026-11-02:evt-1',
      kind: 'meeting_briefing',
      scheduled_at: '2026-11-02 13:45:00',
      fired_at: '2026-11-02 13:45:10',
      ref_id: 'evt-1',
      payload: '{"llmStatus":"pending"}'
    })
    const other = insertEvent(db, ev)
    updateEventPayload(db, meeting!.id, '{"llmStatus":"done"}')
    const row = getEventById(db, meeting!.id)
    expect(row?.payload).toBe('{"llmStatus":"done"}')
    // 다른 컬럼과 다른 행은 그대로다
    expect(row?.status).toBe('sent')
    expect(row?.scheduled_at).toBe('2026-11-02 13:45:00')
    expect(row?.fired_at).toBe('2026-11-02 13:45:10')
    expect(row?.ref_id).toBe('evt-1')
    expect(getEventById(db, other!.id)?.payload).toBe(ev.payload)
  })

  it('updateEventPayload: 없는 id 는 아무 행도 바꾸지 않는다', () => {
    const a = insertEvent(db, ev)
    updateEventPayload(db, 9999, '{}')
    expect(getEventById(db, a!.id)?.payload).toBe(ev.payload)
  })
})

describe('A2: 원본 테이블 보호', () => {
  it('A2: 저장소는 비서 테이블과 app_settings 만 쓴다', () => {
    // 원본 테이블이 없는 DB 에서 모든 쓰기 함수가 동작하면, 원본 테이블을 건드리지 않는다
    const plan = startPlan()
    const [it0] = listPlanItems(db, plan.id)
    updatePlanItems(db, [{ id: it0.id, patch: { status: 'done' } }], AT)
    applyRefreshPlan(db, plan.id, emptyRefresh(), AT)
    closePlan(db, plan.id, 'button', AT, '메모')
    reopenPlan(db, plan.id, AT)
    closeStalePlans(db, '2026-11-03', AT)
    writeAssistantSettings(db, { enabled: false })
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
    expect(tables).toEqual(['app_settings', 'assistant_events', 'daily_plans', 'plan_items'])
  })
})
