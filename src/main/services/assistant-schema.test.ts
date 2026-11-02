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
import { ASSISTANT_SCHEMA } from './assistant-schema'

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

describe('initDatabase', () => {
  afterAll(() => closeDatabase())

  it('initDatabase 가 ASSISTANT_SCHEMA 를 실행한다', () => {
    initDatabase()
    const db = getDatabase()
    expect(names(db, 'table')).toEqual(
      expect.arrayContaining(['daily_plans', 'plan_items', 'assistant_events', 'app_settings'])
    )
    expect(names(db, 'index')).toContain('idx_daily_plans_one_active')
  })
})
