import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const testDir = vi.hoisted(() => `/tmp/linkwork-meeting-unify-${process.pid}`)

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

// 녹음 일원화(면접 제거)·자동 제목 플래그·요약 형식 선택 메타 도입 전 DB.
// 배포 DB와 같이 kind·옛 면접 4분류는 있고 title_auto·template_source·template_reason은 없다.
const dbPath = join(testDir, 'linkwork.db')

const LEGACY_DDL = `
  CREATE TABLE meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '제목 없는 회의',
    kind TEXT NOT NULL DEFAULT 'meeting',
    status TEXT NOT NULL DEFAULT 'recording'
  );
  CREATE TABLE meeting_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL UNIQUE,
    tldr TEXT,
    qa_pairs TEXT,
    competencies TEXT,
    follow_ups TEXT,
    fact_checks TEXT,
    model TEXT,
    generated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  );
`

const QA = '[{"question":"q"}]'

function seedLegacy(): void {
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(LEGACY_DDL)
  const ins = legacy.prepare('INSERT INTO meetings (title, kind, status) VALUES (?, ?, ?)')
  ins.run('1차 인터뷰 - A', 'interview', 'summarized')
  ins.run('제목 없는 면접', 'interview', 'transcribed')
  ins.run('제목 없는 회의', 'meeting', 'summarized')
  ins.run('형태 윤삼 1on1', 'meeting', 'summarized')
  legacy.prepare('INSERT INTO meeting_summaries (meeting_id, tldr, qa_pairs) VALUES (1, ?, ?)').run('개요', QA)
  legacy.close()
}

interface Row {
  id: number
  title: string
  kind: string
  title_auto: number
}

function meetings(): Row[] {
  return getDatabase()
    .prepare('SELECT id, title, kind, title_auto FROM meetings ORDER BY id')
    .all() as unknown as Row[]
}

function summaryColumnNames(): string[] {
  return (getDatabase().prepare('PRAGMA table_info(meeting_summaries)').all() as unknown as { name: string }[]).map(
    (c) => c.name
  )
}

function expectUnified(): void {
  const rows = meetings()
  expect(rows.map((r) => r.kind)).toEqual(['meeting', 'meeting', 'meeting', 'meeting'])
  expect(rows.map((r) => r.title_auto)).toEqual([0, 1, 1, 0])
  expect(rows.map((r) => r.title)).toEqual(['1차 인터뷰 - A', '제목 없는 회의', '제목 없는 회의', '형태 윤삼 1on1'])
  // 전사·요약은 지우지 않는다. 옛 4분류 값은 컬럼째 그대로 남는다(백업 호환).
  expect(getDatabase().prepare('SELECT tldr, qa_pairs FROM meeting_summaries WHERE meeting_id = 1').get()).toEqual({
    tldr: '개요',
    qa_pairs: QA
  })
  const cols = summaryColumnNames()
  expect(cols).toContain('template_source')
  expect(cols).toContain('template_reason')
  expect(cols).toContain('qa_pairs')
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

describe('녹음 일원화 마이그레이션(migrateMeetingUnify)', () => {
  it('옛 면접 행을 회의로 바꾸고 기본 제목만 title_auto=1로 둔다', () => {
    seedLegacy()
    initDatabase()
    expectUnified()
  })

  it('다시 열어도(멱등) 값이 같다', () => {
    seedLegacy()
    initDatabase()
    closeDatabase()
    initDatabase()
    expectUnified()
  })

  it('재실행은 사용자가 쓴 기본 제목 문자열(title_auto=0)을 자동 제목으로 바꾸지 않는다', () => {
    seedLegacy()
    initDatabase()
    // 사용자가 직접 '제목 없는 회의'라고 이름을 붙인 경우(rename은 title_auto=0)
    getDatabase().prepare("UPDATE meetings SET title = '제목 없는 회의', title_auto = 0 WHERE id = 4").run()
    closeDatabase()
    initDatabase()
    expect(getDatabase().prepare('SELECT title, title_auto FROM meetings WHERE id = 4').get()).toEqual({
      title: '제목 없는 회의',
      title_auto: 0
    })
  })

  it('재실행은 사용자가 붙인 제목 \'제목 없는 면접\'(title_auto=0)을 바꾸지 않는다', () => {
    seedLegacy()
    initDatabase()
    getDatabase().prepare("UPDATE meetings SET title = '제목 없는 면접', title_auto = 0 WHERE id = 4").run()
    closeDatabase()
    initDatabase()
    expect(getDatabase().prepare('SELECT title, title_auto FROM meetings WHERE id = 4').get()).toEqual({
      title: '제목 없는 면접',
      title_auto: 0
    })
  })

  it('옛 백업처럼 재실행 사이에 다시 들어온 옛 종류 값도 회의로 바꾼다', () => {
    seedLegacy()
    initDatabase()
    getDatabase().prepare("UPDATE meetings SET kind = 'interview' WHERE id = 3").run()
    closeDatabase()
    initDatabase()
    expect(meetings().every((r) => r.kind === 'meeting')).toBe(true)
  })

  it('신규 설치에서는 title_auto 기본 0, 요약 메타 컬럼은 NULL 허용 TEXT', () => {
    initDatabase()
    const db = getDatabase()
    const id = Number(db.prepare("INSERT INTO meetings (title) VALUES ('새 회의')").run().lastInsertRowid)
    expect(db.prepare('SELECT title_auto, kind FROM meetings WHERE id = ?').get(id)).toEqual({
      title_auto: 0,
      kind: 'meeting'
    })
    const cols = db.prepare('PRAGMA table_info(meeting_summaries)').all() as unknown as {
      name: string
      type: string
      notnull: number
    }[]
    for (const name of ['template_source', 'template_reason']) {
      expect(cols.find((c) => c.name === name)).toMatchObject({ type: 'TEXT', notnull: 0 })
    }
  })
})
