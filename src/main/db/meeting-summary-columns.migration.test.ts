import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// meeting_summaries 의 요약 포맷 컬럼(topics, open_questions, keywords)이 신규 설치와 구버전 DB
// 업그레이드 두 경로에서 같은 모양으로 생기는지 확인한다. 방식은 todo-source-link.migration.test.ts 와
// 같다: better-sqlite3 는 Electron ABI 로 빌드돼 vitest 의 Node 에서 못 쓰므로 node:sqlite 로
// 갈아끼우고, initDatabase() 를 껐다 켜며 같은 파일 DB 를 다시 연다.
const testDir = vi.hoisted(() => `/tmp/linkwork-summary-columns-${process.pid}`)

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
import { migrateMeetingSummaryFormatColumns } from './schema'

const dbPath = join(testDir, 'linkwork.db')
const FORMAT_COLUMNS = ['topics', 'open_questions', 'keywords']

// 요약 포맷 개편 전 meeting_summaries (면접 4분류까지 있는 상태)
const LEGACY_DDL = `
  CREATE TABLE meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL
  );
  CREATE TABLE meeting_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL UNIQUE,
    tldr TEXT,
    key_points TEXT,
    decisions TEXT,
    action_items TEXT,
    next_steps TEXT,
    qa_pairs TEXT,
    competencies TEXT,
    follow_ups TEXT,
    fact_checks TEXT,
    model TEXT,
    generated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  );
`

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
}

function formatColumns(): ColumnInfo[] {
  const columns = getDatabase().prepare('PRAGMA table_info(meeting_summaries)').all() as unknown as ColumnInfo[]
  return columns.filter((c) => FORMAT_COLUMNS.includes(c.name))
}

function expectFormatColumns(): void {
  const cols = formatColumns()
  expect(cols.map((c) => c.name).sort()).toEqual([...FORMAT_COLUMNS].sort())
  for (const c of cols) {
    expect(c.type).toBe('TEXT')
    expect(c.notnull).toBe(0)
    expect(c.dflt_value).toBeNull()
  }
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

describe('meeting_summaries 요약 포맷 컬럼', () => {
  it('신규 설치에서 3컬럼이 nullable TEXT 로 생긴다', () => {
    initDatabase()
    expectFormatColumns()
  })

  it('구버전 DB 는 ALTER 로 3컬럼이 붙고 기존 요약 행은 값이 그대로, 새 컬럼은 null 이다', () => {
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(LEGACY_DDL)
    legacy.prepare("INSERT INTO meetings (title) VALUES ('구버전 회의')").run()
    legacy
      .prepare("INSERT INTO meeting_summaries (meeting_id, tldr, decisions) VALUES (1, '요약', '[\"금요일 배포\"]')")
      .run()
    legacy.close()

    initDatabase()
    expectFormatColumns()

    const row = getDatabase()
      .prepare('SELECT tldr, decisions, topics, open_questions, keywords FROM meeting_summaries WHERE meeting_id = 1')
      .get() as Record<string, string | null>
    expect(row).toEqual({
      tldr: '요약',
      decisions: '["금요일 배포"]',
      topics: null,
      open_questions: null,
      keywords: null
    })
  })

  it('다시 열거나 함수를 거듭 불러도 오류 없이 값이 그대로다 (멱등)', () => {
    initDatabase()
    const db = getDatabase()
    db.prepare("INSERT INTO meetings (title, started_at) VALUES ('회의', '2026-11-26 10:00:00')").run()
    db.prepare("INSERT INTO meeting_summaries (meeting_id, keywords) VALUES (1, '[\"결제\"]')").run()
    expect(() => migrateMeetingSummaryFormatColumns(db)).not.toThrow()
    closeDatabase()

    initDatabase()
    expectFormatColumns()
    const row = getDatabase().prepare('SELECT keywords FROM meeting_summaries WHERE meeting_id = 1').get() as {
      keywords: string | null
    }
    expect(row.keywords).toBe('["결제"]')
  })
})
