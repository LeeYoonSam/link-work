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
  findEventByKey,
  getEventById,
  insertEvent,
  listEventsByDate,
  readAssistantSettings,
  updateEventPayload,
  updateEventStatus,
  writeAssistantSettings
} from './assistant-store'
import type { NewAssistantEvent } from './assistant-types'

// 이 파일은 비서 이벤트·설정 함수를 검증한다 (docs/ASSISTANT.md §4, §5.1).

const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const AT = '2026-11-02 09:40:00'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))`)
  db.exec(ASSISTANT_SCHEMA)
  // db/schema.ts 와 같은 순서다. 옛 DB 에서만 컬럼을 더한다
  migrateAssistantSchema(db)
})

describe('설정', () => {
  it('행이 없으면 기본값이다', () => {
    expect(readAssistantSettings(db)).toEqual(DEFAULT_ASSISTANT_SETTINGS)
  })

  it('writeAssistantSettings 는 assistant_* 키만 쓰고 결과를 돌려준다', () => {
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('jira_site', 'x')").run()
    const s = writeAssistantSettings(db, { meetingLeadMin: 3, morningSyncTime: '07:00' })
    expect(s.meetingLeadMin).toBe(3)
    expect(s.morningSyncTime).toBe('07:00')
    // 덮어쓰기
    expect(writeAssistantSettings(db, { meetingLeadMin: 4 }).meetingLeadMin).toBe(4)
    const rows = db.prepare('SELECT key, value FROM app_settings ORDER BY key').all()
    expect(rows).toEqual([
      { key: 'assistant_meeting_lead_min', value: '4' },
      { key: 'assistant_morning_sync_time', value: '07:00' },
      { key: 'jira_site', value: 'x' }
    ])
  })

  it('형식이 틀린 patch 는 throw 하고 아무것도 쓰지 않는다', () => {
    expect(() => writeAssistantSettings(db, { meetingLeadMin: 3, morningSyncTime: 'late' })).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM app_settings').get()).toEqual({ n: 0 })
  })
})

describe('날짜·시각 형식', () => {
  it('insertEvent 가 저장한 created_at 은 로컬 YYYY-MM-DD HH:mm:ss 다', () => {
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

  it('UTC ISO datetime 을 넘기면 throw 하고 쓰지 않는다', () => {
    const iso = '2026-11-02T00:40:00.000Z'
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
    expect(findEventByKey(db, 'k')).toBeNull()
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

  it('같은 event_key 는 1회만 기록한다. 두 번째 insertEvent 는 null 이다', () => {
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


  it('updateEventPayload: 지정한 행의 payload 만 바꾼다', () => {
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

describe('원본 테이블 보호', () => {
  it('저장소는 비서 테이블과 app_settings 만 쓴다', () => {
    // 원본 테이블이 없는 DB 에서 모든 쓰기 함수가 동작하면, 원본 테이블을 건드리지 않는다
    writeAssistantSettings(db, { enabled: false })
    const ev = insertEvent(db, {
      event_key: 'meeting_briefing:2026-11-02:e1',
      kind: 'meeting_briefing',
      plan_date: '2026-11-02',
      scheduled_at: AT,
      fired_at: AT,
      status: 'sent',
      ref_id: 'e1',
      payload: '{}'
    })
    updateEventStatus(db, ev!.id, 'failed')
    updateEventPayload(db, ev!.id, '{"llmStatus":"done"}')
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
    expect(tables).toEqual(['app_settings', 'assistant_events', 'assistant_exclusions', 'daily_plans', 'plan_items'])
  })
})
