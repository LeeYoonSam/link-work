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

  it('A58: assistant_exclusions 테이블과 컬럼 5개를 만든다 (부록 M)', () => {
    const db = new Database(':memory:')
    db.exec(ASSISTANT_SCHEMA)
    expect(names(db, 'table')).toContain('assistant_exclusions')
    expect(columns(db, 'assistant_exclusions')).toEqual([
      'candidate_id', 'jira_key', 'title', 'source', 'excluded_at'
    ])
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

// 업무 유형 컬럼 4개가 없던 MVP5 시점 plan_items DDL 이다 (부록 J.5)
const WORK_COLUMNS = ['work_type', 'work_version', 'parent_key', 'group_name']
const PRE_J_SCHEMA = ASSISTANT_SCHEMA.replace(
  "    work_type TEXT NOT NULL DEFAULT 'etc',\n    work_version TEXT,\n    parent_key TEXT,\n    group_name TEXT,\n",
  ''
)

describe('A50: plan_items 업무 유형 컬럼', () => {
  it('A50: 새 DDL 의 plan_items 에 컬럼 4개가 있고 work_type 기본값은 etc 다', () => {
    const db = new Database(':memory:')
    db.exec(ASSISTANT_SCHEMA)
    expect(columns(db, 'plan_items')).toEqual(expect.arrayContaining(WORK_COLUMNS))
    db.prepare("INSERT INTO daily_plans (plan_date, started_at) VALUES ('2026-11-03', '2026-11-03 09:00:00')").run()
    db.prepare(
      "INSERT INTO plan_items (plan_id, candidate_id, source, title, score, added_by) VALUES (1, 'todo:1', 'todo', 't', 0, 'start')"
    ).run()
    expect(db.prepare('SELECT work_type, work_version, parent_key, group_name FROM plan_items').get()).toEqual({
      work_type: 'etc', work_version: null, parent_key: null, group_name: null
    })
    db.close()
  })

  it('A50: 옛 DDL 에 컬럼 4개를 더하고 기존 행은 etc·null 이 된다', () => {
    expect(PRE_J_SCHEMA).not.toBe(ASSISTANT_SCHEMA)
    const db = new Database(':memory:')
    db.exec(PRE_J_SCHEMA)
    for (const c of WORK_COLUMNS) expect(columns(db, 'plan_items')).not.toContain(c)
    db.prepare("INSERT INTO daily_plans (plan_date, started_at) VALUES ('2026-11-03', '2026-11-03 09:00:00')").run()
    db.prepare(
      "INSERT INTO plan_items (plan_id, candidate_id, source, title, score, added_by) VALUES (1, 'jira:ICA-8054', 'jira', '안드로이드QA-2026', 5, 'start')"
    ).run()

    migrateAssistantSchema(db)

    expect(columns(db, 'plan_items')).toEqual(expect.arrayContaining(WORK_COLUMNS))
    expect(db.prepare('SELECT title, work_type, work_version, parent_key, group_name FROM plan_items').get()).toEqual({
      title: '안드로이드QA-2026', work_type: 'etc', work_version: null, parent_key: null, group_name: null
    })
    db.close()
  })

  it('A50: 마이그레이션을 여러 번 실행해도 컬럼 목록이 같다 (멱등성)', () => {
    const db = new Database(':memory:')
    db.exec(PRE_J_SCHEMA)
    migrateAssistantSchema(db)
    const once = columns(db, 'plan_items')
    expect(() => migrateAssistantSchema(db)).not.toThrow()
    migrateAssistantSchema(db)
    expect(columns(db, 'plan_items')).toEqual(once)
    for (const c of WORK_COLUMNS) expect(once.filter((x) => x === c)).toHaveLength(1)

    const fresh = new Database(':memory:')
    fresh.exec(ASSISTANT_SCHEMA)
    const before = columns(fresh, 'plan_items')
    migrateAssistantSchema(fresh)
    expect(columns(fresh, 'plan_items')).toEqual(before)
    db.close()
    fresh.close()
  })
})

describe('initDatabase', () => {
  afterAll(() => closeDatabase())

  it('initDatabase 가 ASSISTANT_SCHEMA 를 실행한다', () => {
    initDatabase()
    const db = getDatabase()
    expect(names(db, 'table')).toEqual(
      expect.arrayContaining(['daily_plans', 'plan_items', 'assistant_events', 'assistant_exclusions', 'app_settings'])
    )
    expect(names(db, 'index')).toContain('idx_daily_plans_one_active')
    // database.ts 가 ASSISTANT_SCHEMA 다음에 migrateAssistantSchema 를 부른다
    expect(columns(db, 'daily_plans')).toContain('briefing_instruction')
  })
})
