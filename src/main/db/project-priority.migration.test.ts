import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 신규 설치(CREATE)와 구버전 DB 업그레이드(ALTER) 두 경로가 같은 projects 스키마로
// 수렴하는지 확인한다. 한쪽만 고치면 "내 PC에서는 되는데" 류의 조용한 차이가 남는다.
//
// better-sqlite3는 electron-builder가 Electron ABI로 빌드해 두므로 vitest가 도는 Node에서는
// 로드할 수 없다(NODE_MODULE_VERSION 불일치). 테스트에서만 Node 내장 node:sqlite로 갈아끼운다
// (recognition-aids.test.ts와 같은 방식). 다만 여기서는 initDatabase()를 껐다 켜며 같은 DB를
// 다시 열어야 하므로 :memory: 대신 **넘어온 경로 그대로** 파일 DB를 연다.
const testDir = vi.hoisted(() => `/tmp/linkwork-project-priority-${process.pid}`)

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

// 구버전(우선순위 도입 전) projects 테이블. CREATE TABLE IF NOT EXISTS가 그냥 지나치므로
// initDatabase()는 ALTER 경로로만 컬럼을 채워야 한다.
const LEGACY_PROJECTS_DDL = `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    dev_start_date TEXT NOT NULL,
    dev_end_date TEXT NOT NULL,
    qa_start_date TEXT NOT NULL,
    qa_end_date TEXT NOT NULL,
    deploy_date TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
}

function projectColumns(): ColumnInfo[] {
  return getDatabase().prepare('PRAGMA table_info(projects)').all() as unknown as ColumnInfo[]
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

describe('projects 우선순위 컬럼', () => {
  it('신규 설치는 CREATE로 priority·sort_order를 만든다', () => {
    initDatabase()

    const columns = projectColumns()
    const priority = columns.find((c) => c.name === 'priority')
    const sortOrder = columns.find((c) => c.name === 'sort_order')

    expect(priority).toBeDefined()
    expect(priority?.type).toBe('TEXT')
    // 미지정을 NULL로 표현하므로 NOT NULL이면 안 된다
    expect(priority?.notnull).toBe(0)

    expect(sortOrder).toBeDefined()
    expect(sortOrder?.type).toBe('INTEGER')
    expect(sortOrder?.notnull).toBe(1)
    expect(String(sortOrder?.dflt_value)).toBe('0')
  })

  it('구버전 DB는 ALTER로 두 컬럼이 붙고 기존 행은 미지정으로 남는다', () => {
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(LEGACY_PROJECTS_DDL)
    legacy
      .prepare(
        `INSERT INTO projects (name, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date, status)
         VALUES ('구버전 프로젝트', '2026-01-01', '2026-01-10', '2026-01-11', '2026-01-15', '2026-01-20', 'development')`
      )
      .run()
    legacy.close()

    initDatabase()

    const names = projectColumns().map((c) => c.name)
    expect(names).toContain('priority')
    expect(names).toContain('sort_order')

    const row = getDatabase()
      .prepare('SELECT name, priority, sort_order FROM projects WHERE name = ?')
      .get('구버전 프로젝트') as { name: string; priority: string | null; sort_order: number }

    expect(row.priority).toBeNull()
    expect(row.sort_order).toBe(0)
  })

  it('이미 마이그레이션된 DB를 다시 열어도 그대로다 (ALTER 재실행 없음)', () => {
    initDatabase()
    getDatabase()
      .prepare(
        `INSERT INTO projects (name, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date, priority, sort_order)
         VALUES ('우선순위 지정됨', '2026-01-01', '2026-01-10', '2026-01-11', '2026-01-15', '2026-01-20', 'now', 3)`
      )
      .run()
    closeDatabase()

    initDatabase()

    const row = getDatabase()
      .prepare('SELECT priority, sort_order FROM projects WHERE name = ?')
      .get('우선순위 지정됨') as { priority: string | null; sort_order: number }

    expect(row.priority).toBe('now')
    expect(row.sort_order).toBe(3)
  })
})
