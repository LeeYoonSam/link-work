import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3는 Electron ABI로 빌드돼 vitest(Node)에서 로드할 수 없다. node:sqlite로 갈아끼워
// initDatabase()의 실제 스키마를 그대로 돌린다(voiceprint.test.ts와 같은 방식).
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

import type Database from 'better-sqlite3'
import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import { MARK_TEXT_MAX, addMark, deleteMark, listMarks, remapLiveMarks, updateMark } from './meeting-marks'

let db: Database.Database

beforeEach(() => {
  closeDatabase()
  initDatabase()
  db = getDatabase()
})

afterAll(() => {
  closeDatabase()
})

function seedMeeting(): number {
  return Number(db.prepare("INSERT INTO meetings (title, status) VALUES ('회의', 'recording')").run().lastInsertRowid)
}

describe('addMark', () => {
  it('없는 회의면 던진다', () => {
    expect(() => addMark(db, { meetingId: 999, raw_ms: 0 })).toThrow('존재하지 않는 회의입니다.')
  })

  it('raw_ms를 0 이상 정수로, text를 trim·500자로 자르고 origin 기본은 live', () => {
    const m = seedMeeting()
    const a = addMark(db, { meetingId: m, raw_ms: -50 })
    const b = addMark(db, { meetingId: m, raw_ms: 1234.6, text: `  ${'가'.repeat(600)}  ` })
    const c = addMark(db, { meetingId: m, raw_ms: Number.NaN, origin: 'post' })
    const rows = listMarks(db, m)
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(a.id)).toMatchObject({ raw_ms: 0, at_ms: 0, text: '', origin: 'live' })
    expect(byId.get(b.id)).toMatchObject({ raw_ms: 1235, at_ms: 1235, origin: 'live' })
    expect(byId.get(b.id)!.text.length).toBe(MARK_TEXT_MAX)
    expect(byId.get(c.id)).toMatchObject({ raw_ms: 0, origin: 'post' })
  })

  it('목록은 at_ms, id 순', () => {
    const m = seedMeeting()
    const x = addMark(db, { meetingId: m, raw_ms: 5000, text: 'x' })
    const y = addMark(db, { meetingId: m, raw_ms: 1000, text: 'y' })
    const z = addMark(db, { meetingId: m, raw_ms: 5000, text: 'z' })
    expect(listMarks(db, m).map((r) => r.id)).toEqual([y.id, x.id, z.id])
  })
})

describe('updateMark·deleteMark', () => {
  it('수정은 trim하고 없는 id는 false', () => {
    const m = seedMeeting()
    const { id } = addMark(db, { meetingId: m, raw_ms: 0, text: 'a' })
    expect(updateMark(db, { id, text: '  고친 메모 ' })).toEqual({ success: true })
    expect(listMarks(db, m)[0].text).toBe('고친 메모')
    expect(updateMark(db, { id: 9999, text: 'x' })).toEqual({ success: false })
  })

  it('삭제는 지운 행이 있을 때만 true', () => {
    const m = seedMeeting()
    const { id } = addMark(db, { meetingId: m, raw_ms: 0 })
    expect(deleteMark(db, id)).toEqual({ success: true })
    expect(deleteMark(db, id)).toEqual({ success: false })
    expect(listMarks(db, m)).toEqual([])
  })
})

describe('remapLiveMarks', () => {
  const map = (ms: number): number => Math.floor(ms / 2)

  it('live 메모만 at_ms = map(raw_ms)로 바꾸고 멱등이다', () => {
    const m = seedMeeting()
    addMark(db, { meetingId: m, raw_ms: 10000, text: 'live1' })
    addMark(db, { meetingId: m, raw_ms: 4000, text: 'live2' })
    const post = addMark(db, { meetingId: m, raw_ms: 3000, text: 'post', origin: 'post' })
    expect(remapLiveMarks(db, m, map)).toBe(2)
    const first = listMarks(db, m)
    for (const r of first) {
      if (r.origin === 'live') expect(r.at_ms).toBe(map(r.raw_ms))
    }
    expect(first.find((r) => r.id === post.id)).toMatchObject({ raw_ms: 3000, at_ms: 3000 })
    expect(remapLiveMarks(db, m, map)).toBe(0)
    expect(listMarks(db, m)).toEqual(first)
  })

  it('다른 회의의 메모는 건드리지 않는다', () => {
    const a = seedMeeting()
    const b = seedMeeting()
    addMark(db, { meetingId: b, raw_ms: 8000 })
    remapLiveMarks(db, a, map)
    expect(listMarks(db, b)[0].at_ms).toBe(8000)
  })
})

describe('CASCADE', () => {
  it('회의를 지우면 메모도 지워진다', () => {
    const m = seedMeeting()
    addMark(db, { meetingId: m, raw_ms: 0, text: 'a' })
    db.prepare('DELETE FROM meetings WHERE id = ?').run(m)
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM meeting_marks').get() as { n: number }
    expect(n).toBe(0)
  })
})
