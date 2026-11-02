import { afterAll, describe, expect, it, vi } from 'vitest'

// better-sqlite3 → node:sqlite 교체. 이유는 project-priority.migration.test.ts 상단 주석과 같다.
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

vi.mock('electron', () => ({
  app: { getPath: () => '/linkwork-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))

import Database from 'better-sqlite3'
import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import { ASSISTANT_SCHEMA, migrateAssistantSchema } from './assistant-schema'

function names(db: Database.Database, type: 'table' | 'index'): string[] {
  return (
    db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type) as {
      name: string
    }[]
  ).map((r) => r.name)
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name)
}

describe('ASSISTANT_SCHEMA', () => {
  it('2회 실행해도 오류가 없고 결과가 같다 (멱등성)', () => {
    const db = new Database(':memory:')
    db.exec(ASSISTANT_SCHEMA)
    const tables = names(db, 'table')
    const indexes = names(db, 'index')
    expect(() => db.exec(ASSISTANT_SCHEMA)).not.toThrow()
    expect(names(db, 'table')).toEqual(tables)
    expect(names(db, 'index')).toEqual(indexes)
    db.close()
  })

  it('비서 테이블 3개와 인덱스를 만든다', () => {
    const db = new Database(':memory:')
    db.exec(ASSISTANT_SCHEMA)
    const tables = names(db, 'table')
    expect(tables).toEqual(expect.arrayContaining(['daily_plans', 'plan_items', 'assistant_events']))
    expect(names(db, 'index')).toEqual(
      expect.arrayContaining(['idx_daily_plans_one_active', 'idx_assistant_events_date'])
    )
    // 이후 MVP 컬럼도 함께 만든다
    expect(columns(db, 'daily_plans')).toEqual(
      expect.arrayContaining(['recovery_text', 'recovery_source', 'recovery_at', 'wrapup_note', 'last_refresh_at'])
    )
    expect(columns(db, 'assistant_events')).toEqual(expect.arrayContaining(['response', 'responded_at']))
    db.close()
  })

  it('MVP3 맥락 복구 컬럼 3개가 daily_plans 에 있다 (부록 F.6)', () => {
    const db = new Database(':memory:')
    db.exec(ASSISTANT_SCHEMA)
    // 복구는 새 마이그레이션 없이 이 컬럼만 쓴다. 지우면 setRecovery 가 깨진다
    expect(columns(db, 'daily_plans')).toEqual(
      expect.arrayContaining(['recovery_text', 'recovery_source', 'recovery_at'])
    )
    db.close()
  })

  it('A17: 부분 UNIQUE 인덱스가 active 계획 2개를 막는다', () => {
    const db = new Database(':memory:')
    db.exec(ASSISTANT_SCHEMA)
    const insert = db.prepare(
      "INSERT INTO daily_plans (plan_date, status, started_at) VALUES (?, ?, '2026-11-02 09:00:00')"
    )
    insert.run('2026-11-01', 'active')
    expect(() => insert.run('2026-11-02', 'active')).toThrow()
    // closed 계획은 여러 개여도 된다
    insert.run('2026-10-30', 'closed')
    insert.run('2026-10-31', 'closed')
    db.close()
  })

  it('plan_items 는 같은 계획에 같은 후보를 두 번 넣지 못한다', () => {
    const db = new Database(':memory:')
    db.exec(ASSISTANT_SCHEMA)
    db.prepare(
      "INSERT INTO daily_plans (plan_date, started_at) VALUES ('2026-11-02', '2026-11-02 09:00:00')"
    ).run()
    const insert = db.prepare(
      "INSERT INTO plan_items (plan_id, candidate_id, source, title, score, added_by) VALUES (1, 'todo:1', 'todo', 't', 0, 'start')"
    )
    insert.run()
    expect(() => insert.run()).toThrow()
    db.close()
  })
})

// briefing_instruction 컬럼이 없던 MVP3 시점 DDL 이다 (부록 G.7.1)
const OLD_SCHEMA = ASSISTANT_SCHEMA.replace('    briefing_instruction TEXT,\n', '')

describe('migrateAssistantSchema', () => {
  it('새 DDL 의 daily_plans 에 briefing_instruction 컬럼이 있다', () => {
    const db = new Database(':memory:')
    db.exec(ASSISTANT_SCHEMA)
    expect(columns(db, 'daily_plans')).toContain('briefing_instruction')
    db.close()
  })

  it('migrateAssistantSchema 는 옛 DDL 의 daily_plans 에 briefing_instruction 을 더하고 기존 행을 지킨다', () => {
    expect(OLD_SCHEMA).not.toBe(ASSISTANT_SCHEMA)
    const db = new Database(':memory:')
    db.exec(OLD_SCHEMA)
    expect(columns(db, 'daily_plans')).not.toContain('briefing_instruction')
    db.prepare(
      "INSERT INTO daily_plans (plan_date, started_at, briefing_text) VALUES ('2026-11-01', '2026-11-01 09:00:00', '본문')"
    ).run()

    migrateAssistantSchema(db)

    expect(columns(db, 'daily_plans')).toContain('briefing_instruction')
    expect(
      db.prepare('SELECT briefing_text, briefing_instruction FROM daily_plans WHERE plan_date = ?').get('2026-11-01')
    ).toEqual({ briefing_text: '본문', briefing_instruction: null })
    db.close()
  })

  it('migrateAssistantSchema 를 2회 실행해도 오류가 없고 컬럼 목록이 같다 (멱등성)', () => {
    const db = new Database(':memory:')
    db.exec(OLD_SCHEMA)
    migrateAssistantSchema(db)
    const once = columns(db, 'daily_plans')
    expect(() => migrateAssistantSchema(db)).not.toThrow()
    expect(columns(db, 'daily_plans')).toEqual(once)
    expect(once.filter((c) => c === 'briefing_instruction')).toHaveLength(1)

    // 새 DDL 로 만든 DB 에서도 바꾸지 않는다
    const fresh = new Database(':memory:')
    fresh.exec(ASSISTANT_SCHEMA)
    const before = columns(fresh, 'daily_plans')
    migrateAssistantSchema(fresh)
    expect(columns(fresh, 'daily_plans')).toEqual(before)
    db.close()
    fresh.close()
  })

  it('migrateAssistantSchema 는 daily_plans 가 없으면 아무것도 하지 않는다', () => {
    const db = new Database(':memory:')
    expect(() => migrateAssistantSchema(db)).not.toThrow()
    expect(names(db, 'table')).not.toContain('daily_plans')
    db.close()
  })
})

describe('initDatabase', () => {
  afterAll(() => closeDatabase())

  it('initDatabase 가 ASSISTANT_SCHEMA 를 실행한다', () => {
    initDatabase()
    const db = getDatabase()
    expect(names(db, 'table')).toEqual(
      expect.arrayContaining(['daily_plans', 'plan_items', 'assistant_events', 'app_settings'])
    )
    expect(names(db, 'index')).toContain('idx_daily_plans_one_active')
    // database.ts 가 ASSISTANT_SCHEMA 다음에 migrateAssistantSchema 를 부른다
    expect(columns(db, 'daily_plans')).toContain('briefing_instruction')
  })
})
