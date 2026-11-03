// 비서 테이블 읽기·쓰기 전부 (docs/ASSISTANT.md 부록 A.3).
// A2: 비서 테이블 3개와 app_settings 의 assistant_* 키만 쓴다. 원본 테이블은 건드리지 않는다.
// A12: datetime 인자는 로컬 'YYYY-MM-DD HH:mm:ss' 만 받는다. 형식이 틀리면 throw 한다.
// 쓰기 함수는 각자 db.transaction 으로 감싼다. 내부 헬퍼는 트랜잭션을 열지 않는다.
import type Database from 'better-sqlite3'
import { plansToAutoClose } from './assistant-day'
import { parseAssistantSettings, serializeAssistantSettingsPatch } from './assistant-settings'
import type {
  AssistantEvent,
  AssistantEventStatus,
  AssistantSettings,
  DailyPlan,
  NewAssistantEvent,
  NewPlanItem,
  PlanClosedBy,
  PlanItem,
  PlanItemUpdate,
  RefreshPlan,
  SourceSnapshot
} from './assistant-types'

type Db = Database.Database
type SqlValue = string | number | null

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

function assertDate(value: string, name: string): void {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new Error(`${name} 은 'YYYY-MM-DD' 여야 합니다: ${String(value)}`)
  }
}

function assertDateTime(value: string, name: string): void {
  if (typeof value !== 'string' || !DATETIME_RE.test(value)) {
    throw new Error(`${name} 은 로컬 'YYYY-MM-DD HH:mm:ss' 여야 합니다: ${String(value)}`)
  }
}

// ── 행 변환 ──────────────────────────────────────────────

interface PlanRow extends Omit<DailyPlan, 'source_snapshot'> {
  source_snapshot: string | null
}

interface ItemRow extends Omit<PlanItem, 'pinned' | 'urgent' | 'first_planned_date'> {
  pinned: number
  urgent: number
  first_planned_date: string | null
}

function parseSnapshot(raw: string | null): SourceSnapshot | null {
  if (raw === null || raw === undefined) return null
  try {
    const v: unknown = JSON.parse(raw)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as SourceSnapshot) : null
  } catch {
    return null
  }
}

// briefing_instruction 은 migrateAssistantSchema 가 더한 컬럼이다 (부록 G.7.1). 값이 없으면 null 로 맞춘다.
function toPlan(row: PlanRow): DailyPlan {
  return {
    ...row,
    source_snapshot: parseSnapshot(row.source_snapshot),
    briefing_instruction: row.briefing_instruction ?? null
  }
}

function toItem(row: ItemRow): PlanItem {
  return {
    ...row,
    pinned: Number(row.pinned) === 1,
    urgent: Number(row.urgent) === 1,
    first_planned_date: row.first_planned_date ?? null,
    work_type: row.work_type ?? 'etc',
    work_version: row.work_version ?? null,
    parent_key: row.parent_key ?? null,
    group_name: row.group_name ?? null
  }
}

function toEvent(row: AssistantEvent): AssistantEvent {
  return { ...row }
}

function nullable<T>(v: T | undefined): T | null {
  return v === undefined ? null : v
}

// ── 설정 ────────────────────────────────────────────────

export function readAssistantSettings(db: Db): AssistantSettings {
  const rows = db
    .prepare("SELECT key, value FROM app_settings WHERE key LIKE 'assistant\\_%' ESCAPE '\\'")
    .all() as { key: string; value: string }[]
  return parseAssistantSettings(rows)
}

export function writeAssistantSettings(db: Db, patch: unknown): AssistantSettings {
  // 형식이 틀리면 여기서 throw 하고 아무것도 쓰지 않는다.
  const rows = serializeAssistantSettingsPatch(patch)
  const stmt = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
  db.transaction(() => {
    for (const r of rows) stmt.run(r.key, r.value)
  })()
  return readAssistantSettings(db)
}

// ── 계획 ────────────────────────────────────────────────

function getPlanById(db: Db, planId: number): DailyPlan | null {
  const row = db.prepare('SELECT * FROM daily_plans WHERE id = ?').get(planId) as PlanRow | undefined
  return row ? toPlan(row) : null
}

function requirePlan(db: Db, planId: number): DailyPlan {
  const plan = getPlanById(db, planId)
  if (!plan) throw new Error(`계획을 찾을 수 없습니다: ${planId}`)
  return plan
}

export function getPlanByDate(db: Db, planDate: string): DailyPlan | null {
  const row = db.prepare('SELECT * FROM daily_plans WHERE plan_date = ?').get(planDate) as
    | PlanRow
    | undefined
  return row ? toPlan(row) : null
}

export function getActivePlan(db: Db): DailyPlan | null {
  const row = db
    .prepare("SELECT * FROM daily_plans WHERE status = 'active' ORDER BY plan_date DESC LIMIT 1")
    .get() as PlanRow | undefined
  return row ? toPlan(row) : null
}

export function getLastPlanBefore(db: Db, planDate: string): DailyPlan | null {
  const row = db
    .prepare('SELECT * FROM daily_plans WHERE plan_date < ? ORDER BY plan_date DESC LIMIT 1')
    .get(planDate) as PlanRow | undefined
  return row ? toPlan(row) : null
}

// A17: active 계획이 이미 있으면 throw 한다. 부분 UNIQUE 인덱스도 같은 규칙을 지킨다.
export function createPlan(
  db: Db,
  input: { plan_date: string; started_at: string; source_snapshot: SourceSnapshot; items: NewPlanItem[] }
): DailyPlan {
  assertDate(input.plan_date, 'plan_date')
  assertDateTime(input.started_at, 'started_at')
  return db.transaction(() => {
    const active = getActivePlan(db)
    if (active) {
      throw new Error(`이미 진행 중인 계획이 있습니다: ${active.plan_date}`)
    }
    const res = db
      .prepare(
        `INSERT INTO daily_plans (plan_date, status, started_at, source_snapshot, created_at, updated_at)
         VALUES (?, 'active', ?, ?, ?, ?)`
      )
      .run(
        input.plan_date,
        input.started_at,
        JSON.stringify(input.source_snapshot),
        input.started_at,
        input.started_at
      )
    const planId = Number(res.lastInsertRowid)
    insertItemsRaw(db, planId, input.items, false)
    return requirePlan(db, planId)
  })()
}

// 이미 닫힌 계획이면 바꾸지 않고 그대로 돌려준다. note 가 비어 있지 않으면 퇴근 메모로 저장한다.
export function closePlan(
  db: Db,
  planId: number,
  by: PlanClosedBy,
  at: string,
  note?: string | null
): DailyPlan {
  assertDateTime(at, 'at')
  return db.transaction(() => {
    const plan = requirePlan(db, planId)
    if (plan.status !== 'active') return plan
    db.prepare(
      "UPDATE daily_plans SET status = 'closed', closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ?"
    ).run(at, by, at, planId)
    const trimmed = typeof note === 'string' ? note.trim() : ''
    if (trimmed) {
      db.prepare('UPDATE daily_plans SET wrapup_note = ?, wrapup_at = ? WHERE id = ?').run(
        trimmed,
        at,
        planId
      )
    }
    return requirePlan(db, planId)
  })()
}

// A18: 논리 날짜가 지난 active 계획만 자동 닫기한다. 닫은 id 를 돌려준다.
export function closeStalePlans(db: Db, today: string, at: string): number[] {
  assertDate(today, 'today')
  assertDateTime(at, 'at')
  return db.transaction(() => {
    const rows = db
      .prepare("SELECT id, plan_date, status FROM daily_plans WHERE status = 'active'")
      .all() as Pick<DailyPlan, 'id' | 'plan_date' | 'status'>[]
    const ids = plansToAutoClose(rows, today)
    const stmt = db.prepare(
      "UPDATE daily_plans SET status = 'closed', closed_at = ?, closed_by = 'auto', updated_at = ? WHERE id = ? AND status = 'active'"
    )
    for (const id of ids) stmt.run(at, at, id)
    return ids
  })()
}

// 다른 active 계획이 있으면 throw 한다 (A17). 날짜 확인은 assistant-service 가 한다.
export function reopenPlan(db: Db, planId: number, at: string): DailyPlan {
  assertDateTime(at, 'at')
  return db.transaction(() => {
    const plan = requirePlan(db, planId)
    if (plan.status === 'active') return plan
    const active = getActivePlan(db)
    if (active && active.id !== planId) {
      throw new Error(`이미 진행 중인 계획이 있습니다: ${active.plan_date}`)
    }
    db.prepare(
      "UPDATE daily_plans SET status = 'active', closed_at = NULL, closed_by = NULL, updated_at = ? WHERE id = ?"
    ).run(at, planId)
    return requirePlan(db, planId)
  })()
}

// 계획이 없으면 null 이다.
export function saveWrapupNote(db: Db, planDate: string, note: string, at: string): DailyPlan | null {
  assertDate(planDate, 'planDate')
  assertDateTime(at, 'at')
  return db.transaction(() => {
    const plan = getPlanByDate(db, planDate)
    if (!plan) return null
    db.prepare('UPDATE daily_plans SET wrapup_note = ?, wrapup_at = ?, updated_at = ? WHERE id = ?').run(
      note,
      at,
      at,
      plan.id
    )
    return requirePlan(db, plan.id)
  })()
}

// briefing_error 를 NULL 로 둔다.
export function setBriefing(
  db: Db,
  planId: number,
  b: { text: string; source: 'rules' | 'llm'; model: string | null; at: string }
): void {
  assertDateTime(b.at, 'at')
  db.prepare(
    `UPDATE daily_plans SET briefing_text = ?, briefing_source = ?, briefing_model = ?,
       briefing_at = ?, briefing_error = NULL, updated_at = ? WHERE id = ?`
  ).run(b.text, b.source, b.model, b.at, b.at, planId)
}

// 본문은 그대로 둔다.
export function setBriefingError(db: Db, planId: number, error: string): void {
  db.prepare(
    "UPDATE daily_plans SET briefing_error = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(error, planId)
}

// 브리핑 지시 (부록 G.7.1). null 이면 지시를 지운다. 브리핑 본문은 건드리지 않는다.
export function setBriefingInstruction(db: Db, planId: number, instruction: string | null, at: string): void {
  assertDateTime(at, 'at')
  db.prepare('UPDATE daily_plans SET briefing_instruction = ?, updated_at = ? WHERE id = ?').run(
    instruction,
    at,
    planId
  )
}

// 맥락 복구 본문 (부록 F.6). plan_id 로 쓴다. 수집 중 하루가 닫혀도 같은 행에 저장한다.
export function setRecovery(
  db: Db,
  planId: number,
  r: { text: string; source: 'rules' | 'llm'; at: string }
): void {
  assertDateTime(r.at, 'at')
  db.prepare(
    'UPDATE daily_plans SET recovery_text = ?, recovery_source = ?, recovery_at = ?, updated_at = ? WHERE id = ?'
  ).run(r.text, r.source, r.at, r.at, planId)
}

// ── 계획 항목 ───────────────────────────────────────────

// 항목 조회 SELECT. first_planned_date 를 상관 서브쿼리로 한 문장 안에서 계산한다 (부록 B.5).
// 정의: 같은 candidate_id 가 처음 계획에 오른 daily_plans.plan_date 다.
// suggested·dismissed 행은 계획에 오른 것이 아니므로 뺀다. 그런 행뿐이면 NULL 이다.
// 이 항목의 계획 날짜보다 늦은 계획은 보지 않는다. 이유: 지난 계획을 볼 때 미래 날짜가 나오지 않게 한다.
const ITEM_SELECT = `
  SELECT pi.*, (
    SELECT MIN(dp2.plan_date)
    FROM plan_items p2
    JOIN daily_plans dp2 ON dp2.id = p2.plan_id
    WHERE p2.candidate_id = pi.candidate_id
      AND p2.status NOT IN ('suggested', 'dismissed')
      AND dp2.plan_date <= dp.plan_date
  ) AS first_planned_date
  FROM plan_items pi
  JOIN daily_plans dp ON dp.id = pi.plan_id`

// rank 순, 그다음 slot 순이다. rank·slot 이 없으면 뒤로 간다.
export function listPlanItems(db: Db, planId: number): PlanItem[] {
  const rows = db
    .prepare(
      `${ITEM_SELECT}
       WHERE pi.plan_id = ?
       ORDER BY pi.rank IS NULL, pi.rank, pi.slot_start IS NULL, pi.slot_start, pi.id`
    )
    .all(planId) as ItemRow[]
  return rows.map(toItem)
}

export function getPlanItem(db: Db, itemId: number): PlanItem | null {
  const row = db.prepare(`${ITEM_SELECT} WHERE pi.id = ?`).get(itemId) as ItemRow | undefined
  return row ? toItem(row) : null
}

// skipConflict 가 참이면 같은 (plan_id, candidate_id) 항목을 건너뛴다. 거짓이면 throw 한다.
// 돌려주는 항목은 getPlanItem 으로 다시 읽는다. 그래서 first_planned_date 가 채워진다.
// 3판 호출자는 slot_start·slot_end 를 NULL, pinned 를 false 로 넘긴다 (부록 B.6).
function insertItemsRaw(db: Db, planId: number, items: NewPlanItem[], skipConflict: boolean): PlanItem[] {
  const stmt = db.prepare(
    `INSERT INTO plan_items (plan_id, candidate_id, source, title, link, jira_issue_key, project_id,
       due_date, score, rank, slot_start, slot_end, pinned, added_by, urgent, status, status_note, status_at,
       work_type, work_version, parent_key, group_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
     ${skipConflict ? 'ON CONFLICT(plan_id, candidate_id) DO NOTHING' : ''}`
  )
  const out: PlanItem[] = []
  for (const it of items) {
    const res = stmt.run(
      planId,
      it.candidate_id,
      it.source,
      it.title,
      nullable(it.link),
      nullable(it.jira_issue_key),
      nullable(it.project_id),
      nullable(it.due_date),
      it.score,
      nullable(it.rank),
      nullable(it.slot_start),
      nullable(it.slot_end),
      it.pinned ? 1 : 0,
      it.added_by,
      it.urgent ? 1 : 0,
      it.status ?? 'planned',
      nullable(it.status_note),
      it.work_type ?? 'etc',
      nullable(it.work_version),
      nullable(it.parent_key),
      nullable(it.group_name)
    )
    if (Number(res.changes) === 0) continue
    const item = getPlanItem(db, Number(res.lastInsertRowid))
    if (item) out.push(item)
  }
  return out
}

// 같은 후보가 이미 계획에 있으면 throw 한다 (UNIQUE).
export function insertPlanItems(db: Db, planId: number, items: NewPlanItem[]): PlanItem[] {
  return db.transaction(() => insertItemsRaw(db, planId, items, false))()
}

// PlanItemUpdate.patch 에서 쓸 수 있는 컬럼.
const PATCH_COLUMNS = [
  'candidate_id',
  'source',
  'link',
  'title',
  'jira_issue_key',
  'project_id',
  'due_date',
  'score',
  'rank',
  'slot_start',
  'slot_end',
  'pinned',
  'urgent',
  'status',
  'status_note',
  'work_type',
  'work_version',
  'parent_key',
  'group_name'
] as const

function toSqlValue(v: unknown): SqlValue {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' || typeof v === 'string') return v
  throw new Error(`저장할 수 없는 값입니다: ${String(v)}`)
}

// 지정한 항목의 지정한 필드만 바꾼다 (A15). planId 를 주면 그 계획의 항목만 바꾼다.
function updateItemsRaw(db: Db, updates: PlanItemUpdate[], at: string, planId: number | null): void {
  for (const u of updates) {
    const current = getPlanItem(db, u.id)
    if (!current) continue
    if (planId !== null && current.plan_id !== planId) continue
    const patch = (u.patch ?? {}) as Record<string, unknown>
    const sets: string[] = []
    const values: SqlValue[] = []
    for (const col of PATCH_COLUMNS) {
      if (!Object.prototype.hasOwnProperty.call(patch, col) || patch[col] === undefined) continue
      sets.push(`${col} = ?`)
      values.push(toSqlValue(patch[col]))
    }
    if (patch.status !== undefined && patch.status !== current.status) {
      sets.push('status_at = ?')
      values.push(at)
    }
    if (sets.length === 0) continue
    db.prepare(`UPDATE plan_items SET ${sets.join(', ')} WHERE id = ?`).run(...values, u.id)
  }
}

// status 가 바뀌면 status_at 을 at 으로 둔다. 없는 항목 id 는 건너뛴다.
export function updatePlanItems(db: Db, updates: PlanItemUpdate[], at: string): void {
  assertDateTime(at, 'at')
  db.transaction(() => updateItemsRaw(db, updates, at, null))()
}

// 트랜잭션. inserts·updates·source_snapshot·last_refresh_at 을 한 번에 반영한다.
// inserts 중 이미 계획에 있는 후보는 건너뛴다. updates 는 이 계획의 항목만 반영한다.
export function applyRefreshPlan(db: Db, planId: number, plan: RefreshPlan, at: string): void {
  assertDateTime(at, 'at')
  db.transaction(() => {
    requirePlan(db, planId)
    insertItemsRaw(db, planId, plan.inserts, true)
    updateItemsRaw(db, plan.updates, at, planId)
    db.prepare(
      'UPDATE daily_plans SET source_snapshot = ?, last_refresh_at = ?, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(plan.snapshot), at, at, planId)
  })()
}

// ── 비서 이벤트 ─────────────────────────────────────────

// A5: 같은 event_key 가 이미 있으면 null 이다. 호출자는 null 이면 알림을 보내지 않는다.
export function insertEvent(db: Db, ev: NewAssistantEvent): AssistantEvent | null {
  assertDate(ev.plan_date, 'plan_date')
  assertDateTime(ev.scheduled_at, 'scheduled_at')
  if (ev.fired_at !== null && ev.fired_at !== undefined) assertDateTime(ev.fired_at, 'fired_at')
  const res = db
    .prepare(
      `INSERT INTO assistant_events (event_key, kind, plan_date, scheduled_at, fired_at, status, ref_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_key) DO NOTHING`
    )
    .run(
      ev.event_key,
      ev.kind,
      ev.plan_date,
      ev.scheduled_at,
      nullable(ev.fired_at),
      ev.status,
      nullable(ev.ref_id),
      nullable(ev.payload)
    )
  if (Number(res.changes) === 0) return null
  const row = db.prepare('SELECT * FROM assistant_events WHERE id = ?').get(Number(res.lastInsertRowid)) as
    | AssistantEvent
    | undefined
  return row ? toEvent(row) : null
}

export function updateEventStatus(db: Db, eventId: number, status: AssistantEventStatus): void {
  db.prepare('UPDATE assistant_events SET status = ? WHERE id = ?').run(status, eventId)
}

export function findEventByKey(db: Db, eventKey: string): AssistantEvent | null {
  const row = db.prepare('SELECT * FROM assistant_events WHERE event_key = ?').get(eventKey) as
    | AssistantEvent
    | undefined
  return row ? toEvent(row) : null
}

export function getEventById(db: Db, eventId: number): AssistantEvent | null {
  const row = db.prepare('SELECT * FROM assistant_events WHERE id = ?').get(eventId) as AssistantEvent | undefined
  return row ? toEvent(row) : null
}

// 체크인 응답 기록 (부록 H.7). 1회 기록 판정은 서비스가 한다. 트랜잭션은 호출자가 연다.
export function setEventResponse(db: Db, eventId: number, response: string, at: string): void {
  assertDateTime(at, 'at')
  db.prepare('UPDATE assistant_events SET response = ?, responded_at = ? WHERE id = ?').run(response, at, eventId)
}

// 회의 브리핑 LLM 결과 기록 (부록 I.8). payload 만 바꾼다. 상태·시각 컬럼은 그대로 둔다.
export function updateEventPayload(db: Db, eventId: number, payload: string): void {
  db.prepare('UPDATE assistant_events SET payload = ? WHERE id = ?').run(payload, eventId)
}

export function listEventsByDate(db: Db, planDate: string): AssistantEvent[] {
  const rows = db
    .prepare('SELECT * FROM assistant_events WHERE plan_date = ? ORDER BY scheduled_at, id')
    .all(planDate) as AssistantEvent[]
  return rows.map(toEvent)
}
