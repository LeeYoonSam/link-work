import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// todos.source_link 가 신규 설치(CREATE)와 구버전 DB 업그레이드(ALTER) 두 경로에서
// 같은 모양으로 생기는지 확인한다. 방식은 project-priority.migration.test.ts 와 같다:
// better-sqlite3 는 Electron ABI 로 빌드돼 vitest 의 Node 에서 못 쓰므로 node:sqlite 로 갈아끼우고,
// initDatabase() 를 껐다 켜며 같은 파일 DB 를 다시 연다.
const testDir = vi.hoisted(() => `/tmp/linkwork-todo-source-link-${process.pid}`)

vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  type Args = unknown[]

  class BetterSqlite3Shim {
    private readonly db: InstanceType<typeof DatabaseSync>

    constructor(path: string) {
      this.db = new DatabaseSync(path)
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
  app: { getPath: () => testDir },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { closeDatabase, getDatabase, initDatabase } from './database'

const dbPath = join(testDir, 'linkwork.db')

// 출처 링크 도입 전 todos 테이블. CREATE TABLE IF NOT EXISTS 가 그냥 지나치므로
// initDatabase() 는 ALTER 경로로만 컬럼을 채워야 한다.
const LEGACY_TODOS_DDL = `
  CREATE TABLE todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium',
    due_date TEXT,
    due_reminder INTEGER NOT NULL DEFAULT 0,
    is_completed INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  )
`

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
}

function sourceLinkColumn(): ColumnInfo | undefined {
  const columns = getDatabase().prepare('PRAGMA table_info(todos)').all() as unknown as ColumnInfo[]
  return columns.find((c) => c.name === 'source_link')
}

beforeEach(() => {
  closeDatabase()
  rmSync(testDir, { recursive: true, force: true })
  mkdirSync(testDir, { recursive: true })
})

afterAll(() => {
  closeDatabase()
  rmSync(testDir, { recursive: true, force: true })
})

describe('todos 출처 링크 컬럼', () => {
  it('신규 설치는 CREATE 로 nullable TEXT source_link 를 만든다', () => {
    initDatabase()

    const column = sourceLinkColumn()
    expect(column).toBeDefined()
    expect(column?.type).toBe('TEXT')
    expect(column?.notnull).toBe(0)
    expect(column?.dflt_value).toBeNull()
  })

  it('컬럼이 없는 구버전 DB 는 ALTER 로 컬럼이 붙고 기존 행은 null 로 남는다', () => {
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(LEGACY_TODOS_DDL)
    legacy.prepare("INSERT INTO todos (title, notes) VALUES ('구버전 할 일', '메모')").run()
    legacy.close()

    initDatabase()

    const column = sourceLinkColumn()
    expect(column).toBeDefined()
    expect(column?.type).toBe('TEXT')
    expect(column?.notnull).toBe(0)

    const row = getDatabase()
      .prepare('SELECT title, notes, source_link FROM todos WHERE title = ?')
      .get('구버전 할 일') as { title: string; notes: string | null; source_link: string | null }
    expect(row.notes).toBe('메모')
    expect(row.source_link).toBeNull()
  })

  it('이미 마이그레이션된 DB 를 다시 열어도 값이 그대로다 (ALTER 재실행 없음)', () => {
    initDatabase()
    getDatabase()
      .prepare("INSERT INTO todos (title, source_link) VALUES ('출처 있음', 'linkwork://memo/3')")
      .run()
    closeDatabase()

    initDatabase()

    const row = getDatabase()
      .prepare('SELECT source_link FROM todos WHERE title = ?')
      .get('출처 있음') as { source_link: string | null }
    expect(row.source_link).toBe('linkwork://memo/3')
  })
})
