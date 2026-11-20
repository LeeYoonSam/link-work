// 비서 설정과 비서 이벤트 읽기·쓰기 (docs/ASSISTANT.md §4, §5.1).
// assistant_events 와 app_settings 의 assistant_* 키만 쓴다. 원본 테이블은 건드리지 않는다.
// datetime 인자는 로컬 'YYYY-MM-DD HH:mm:ss' 만 받는다. 형식이 틀리면 throw 한다.
import type Database from 'better-sqlite3'
import { parseAssistantSettings, serializeAssistantSettingsPatch } from './assistant-settings'
import type {
  AssistantEvent,
  AssistantEventKind,
  AssistantEventStatus,
  AssistantSettings,
  NewAssistantEvent
} from './assistant-types'

type Db = Database.Database

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

// ── 비서 이벤트 ─────────────────────────────────────────

// 같은 event_key 가 이미 있으면 null 이다. 호출자는 null 이면 알림을 보내지 않는다.
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

// 회의 브리핑 LLM 결과·아침 동기화 상태 기록. payload 만 바꾼다. 상태·시각 컬럼은 그대로 둔다.
export function updateEventPayload(db: Db, eventId: number, payload: string): void {
  db.prepare('UPDATE assistant_events SET payload = ? WHERE id = ?').run(payload, eventId)
}

export function listEventsByDate(db: Db, planDate: string): AssistantEvent[] {
  const rows = db
    .prepare('SELECT * FROM assistant_events WHERE plan_date = ? ORDER BY scheduled_at, id')
    .all(planDate) as AssistantEvent[]
  return rows.map(toEvent)
}

// 읽기 전용. kind 가 같은 행 가운데 마지막 논리 날짜의 행이다 (아침 동기화 상태 표시).
export function findLatestEventByKind(db: Db, kind: AssistantEventKind): AssistantEvent | null {
  const row = db
    .prepare('SELECT * FROM assistant_events WHERE kind = ? ORDER BY plan_date DESC, id DESC LIMIT 1')
    .get(kind) as AssistantEvent | undefined
  return row ? toEvent(row) : null
}
