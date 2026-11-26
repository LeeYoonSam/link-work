import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const testDir = vi.hoisted(() => `/tmp/linkwork-meeting-p1-${process.pid}`)

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

// 요약 형식·화자 확인·메모 도입(P1) 전 DB. 회의와 요약 행이 하나씩 있다.
// better-sqlite3 는 Electron ABI 라 node:sqlite 로 갈아끼우고, 같은 파일 DB 를 다시 연다
// (meeting-summary-columns.migration.test.ts 와 같은 방식).
const dbPath = join(testDir, 'linkwork.db')

const LEGACY_DDL = `
  CREATE TABLE meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '제목 없는 회의',
    status TEXT NOT NULL DEFAULT 'recording'
  );
  CREATE TABLE meeting_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL UNIQUE,
    tldr TEXT,
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

function column(table: string, name: string): ColumnInfo | undefined {
  const cols = getDatabase().prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[]
  return cols.find((c) => c.name === name)
}

function expectP1Shape(): void {
  expect(column('meetings', 'summary_template')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
  expect(column('meetings', 'speakers_confirmed')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' })
  expect(column('meeting_summaries', 'template_id')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
  const marks = (getDatabase().prepare('PRAGMA table_info(meeting_marks)').all() as unknown as ColumnInfo[]).map(
    (c) => c.name
  )
  expect(marks).toEqual(['id', 'meeting_id', 'raw_ms', 'at_ms', 'text', 'origin', 'created_at', 'updated_at'])
  const idx = getDatabase()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_meeting_marks_meeting'")
    .get()
  expect(idx).toBeTruthy()
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

describe('P1 회의 스키마(요약 형식·화자 확인·메모)', () => {
  it('신규 설치에서 같은 열·테이블이 생기고 새 회의는 speakers_confirmed=0', () => {
    initDatabase()
    expectP1Shape()
    const id = Number(getDatabase().prepare("INSERT INTO meetings (title) VALUES ('새 회의')").run().lastInsertRowid)
    const row = getDatabase().prepare('SELECT speakers_confirmed, summary_template FROM meetings WHERE id = ?').get(id)
    expect(row).toEqual({ speakers_confirmed: 0, summary_template: null })
  })

  it('구버전 DB는 ALTER로 열이 붙고 기존 회의는 speakers_confirmed=1, 이후 넣은 회의는 0', () => {
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(LEGACY_DDL)
    legacy.prepare("INSERT INTO meetings (title, status) VALUES ('구버전 회의', 'summarized')").run()
    legacy.prepare("INSERT INTO meeting_summaries (meeting_id, tldr) VALUES (1, '요약')").run()
    legacy.close()

    initDatabase()
    expectP1Shape()
    const db = getDatabase()
    expect(db.prepare('SELECT speakers_confirmed, summary_template FROM meetings WHERE id = 1').get()).toEqual({
      speakers_confirmed: 1,
      summary_template: null
    })
    expect(db.prepare('SELECT tldr, template_id FROM meeting_summaries WHERE meeting_id = 1').get()).toEqual({
      tldr: '요약',
      template_id: null
    })
    const id = Number(db.prepare("INSERT INTO meetings (title) VALUES ('새 회의')").run().lastInsertRowid)
    expect(db.prepare('SELECT speakers_confirmed FROM meetings WHERE id = ?').get(id)).toEqual({ speakers_confirmed: 0 })
  })

  it('다시 열어도(멱등) 기존 값이 바뀌지 않는다', () => {
    initDatabase()
    const db = getDatabase()
    db.prepare("INSERT INTO meetings (title) VALUES ('회의')").run()
    closeDatabase()
    initDatabase()
    expectP1Shape()
    expect(getDatabase().prepare('SELECT speakers_confirmed FROM meetings WHERE id = 1').get()).toEqual({
      speakers_confirmed: 0
    })
  })
})
