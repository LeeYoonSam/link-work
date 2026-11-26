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
import {
  isReassignScope,
  mergeSpeakersInMeeting,
  planReassign,
  reassignSegments,
  type ScopeSegment
} from './speaker-correction'

describe('planReassign', () => {
  // 정렬 전 순서를 섞어 둔다. 같은 start_ms(3000)는 sort_order로 갈린다.
  const segs: ScopeSegment[] = [
    { id: 5, start_ms: 5000, sort_order: 0, speaker_id: 1 },
    { id: 1, start_ms: 1000, sort_order: 0, speaker_id: 1 },
    { id: 4, start_ms: 3000, sort_order: 1, speaker_id: 1 },
    { id: 3, start_ms: 3000, sort_order: 0, speaker_id: 2 },
    { id: 2, start_ms: 2000, sort_order: 0, speaker_id: null },
    { id: 6, start_ms: 6000, sort_order: 0, speaker_id: null },
    { id: 7, start_ms: 7000, sort_order: 0, speaker_id: 2 }
  ]

  it.each([
    ['one', 4, [4]],
    ['forward', 4, [4, 5]],
    ['forward', 1, [1, 4, 5]],
    ['all', 5, [1, 4, 5]],
    ['forward', 2, [2, 6]],
    ['forward', 6, [6]],
    ['all', 6, [2, 6]],
    ['forward', 3, [3, 7]],
    ['one', 99, []],
    ['all', 99, []]
  ] as const)('%s 기준 %i → %j', (scope, id, expected) => {
    expect(planReassign(segs, id, scope)).toEqual(expected)
  })

  it('isReassignScope', () => {
    expect(isReassignScope('one')).toBe(true)
    expect(isReassignScope('forward')).toBe(true)
    expect(isReassignScope('all')).toBe(true)
    expect(isReassignScope('bogus')).toBe(false)
    expect(isReassignScope(undefined)).toBe(false)
  })
})

describe('reassignSegments·mergeSpeakersInMeeting', () => {
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
    return Number(db.prepare("INSERT INTO meetings (title, status) VALUES ('회의', 'transcribed')").run().lastInsertRowid)
  }
  function seedSpeaker(meetingId: number, key: string): number {
    return Number(
      db
        .prepare('INSERT INTO meeting_speakers (meeting_id, speaker_key, label) VALUES (?, ?, ?)')
        .run(meetingId, key, key).lastInsertRowid
    )
  }
  function seedSegment(meetingId: number, startMs: number, speakerId: number | null): number {
    return Number(
      db
        .prepare('INSERT INTO meeting_segments (meeting_id, start_ms, end_ms, speaker_id, text) VALUES (?, ?, ?, ?, ?)')
        .run(meetingId, startMs, startMs + 1000, speakerId, 't').lastInsertRowid
    )
  }
  function seg(id: number): { speaker_id: number | null; speaker_corrected: number } {
    return db.prepare('SELECT speaker_id, speaker_corrected FROM meeting_segments WHERE id = ?').get(id) as {
      speaker_id: number | null
      speaker_corrected: number
    }
  }
  function speakerExists(id: number): boolean {
    return !!db.prepare('SELECT 1 FROM meeting_speakers WHERE id = ?').get(id)
  }

  it('없는 발언이면 실패', () => {
    expect(reassignSegments(db, { segmentId: 999, speakerId: null })).toEqual({
      success: false,
      changed: 0,
      merged: false,
      error: '존재하지 않는 발언입니다.'
    })
  })

  it('다른 회의의 화자는 거부한다', () => {
    const m1 = seedMeeting()
    const m2 = seedMeeting()
    const a = seedSpeaker(m1, 'A')
    const other = seedSpeaker(m2, 'X')
    const s = seedSegment(m1, 0, a)
    const r = reassignSegments(db, { segmentId: s, speakerId: other, scope: 'one' })
    expect(r).toMatchObject({ success: false, changed: 0, merged: false, error: '같은 회의의 화자만 지정할 수 있습니다.' })
    expect(seg(s).speaker_id).toBe(a)
  })

  it('같은 화자로 바꾸면 changed 0', () => {
    const m = seedMeeting()
    const a = seedSpeaker(m, 'A')
    const s = seedSegment(m, 0, a)
    expect(reassignSegments(db, { segmentId: s, speakerId: a, scope: 'all' })).toEqual({
      success: true,
      changed: 0,
      merged: false
    })
    expect(seg(s).speaker_corrected).toBe(0)
  })

  it('scope가 없거나 알 수 없으면 one', () => {
    const m = seedMeeting()
    const a = seedSpeaker(m, 'A')
    const b = seedSpeaker(m, 'B')
    const s1 = seedSegment(m, 0, a)
    const s2 = seedSegment(m, 1000, a)
    const r = reassignSegments(db, { segmentId: s1, speakerId: b, scope: 'bogus' as never })
    expect(r).toEqual({ success: true, changed: 1, merged: false })
    expect(seg(s1).speaker_id).toBe(b)
    expect(seg(s2).speaker_id).toBe(a)
  })

  it('forward는 기준과 그 뒤의 같은 화자 발언만 바꾸고 speaker_corrected=1', () => {
    const m = seedMeeting()
    const a = seedSpeaker(m, 'A')
    const b = seedSpeaker(m, 'B')
    const s1 = seedSegment(m, 0, a)
    const s2 = seedSegment(m, 1000, b)
    const s3 = seedSegment(m, 2000, a)
    const s4 = seedSegment(m, 3000, a)
    const r = reassignSegments(db, { segmentId: s3, speakerId: b, scope: 'forward' })
    expect(r).toEqual({ success: true, changed: 2, merged: false })
    expect(seg(s1)).toEqual({ speaker_id: a, speaker_corrected: 0 })
    expect(seg(s2)).toEqual({ speaker_id: b, speaker_corrected: 0 })
    expect(seg(s3)).toEqual({ speaker_id: b, speaker_corrected: 1 })
    expect(seg(s4)).toEqual({ speaker_id: b, speaker_corrected: 1 })
    expect(speakerExists(a)).toBe(true)
  })

  it('all + 두 화자 모두 있으면 병합하고 원래 화자 행을 지운다', () => {
    const m = seedMeeting()
    const a = seedSpeaker(m, 'A')
    const b = seedSpeaker(m, 'B')
    const s1 = seedSegment(m, 0, a)
    const s2 = seedSegment(m, 1000, b)
    const s3 = seedSegment(m, 2000, a)
    const r = reassignSegments(db, { segmentId: s3, speakerId: b, scope: 'all' })
    expect(r).toEqual({ success: true, changed: 2, merged: true })
    expect(seg(s1)).toEqual({ speaker_id: b, speaker_corrected: 1 })
    expect(seg(s2).speaker_id).toBe(b)
    expect(seg(s3)).toEqual({ speaker_id: b, speaker_corrected: 1 })
    expect(speakerExists(a)).toBe(false)
  })

  it('all + 대상 null이면 미지정으로 옮기고 화자 행은 남긴다', () => {
    const m = seedMeeting()
    const a = seedSpeaker(m, 'A')
    const s1 = seedSegment(m, 0, a)
    const s2 = seedSegment(m, 1000, a)
    const r = reassignSegments(db, { segmentId: s2, speakerId: null, scope: 'all' })
    expect(r).toEqual({ success: true, changed: 2, merged: false })
    expect(seg(s1)).toEqual({ speaker_id: null, speaker_corrected: 1 })
    expect(seg(s2)).toEqual({ speaker_id: null, speaker_corrected: 1 })
    expect(speakerExists(a)).toBe(true)
  })

  it('all + 기준이 미지정이면 미지정 발언 전부를 대상 화자로', () => {
    const m = seedMeeting()
    const a = seedSpeaker(m, 'A')
    const s1 = seedSegment(m, 0, null)
    const s2 = seedSegment(m, 1000, a)
    const s3 = seedSegment(m, 2000, null)
    const r = reassignSegments(db, { segmentId: s3, speakerId: a, scope: 'all' })
    expect(r).toEqual({ success: true, changed: 2, merged: false })
    expect(seg(s1).speaker_id).toBe(a)
    expect(seg(s2).speaker_corrected).toBe(0)
  })

  it('mergeSpeakersInMeeting은 같은 회의의 서로 다른 화자만 합친다', () => {
    const m1 = seedMeeting()
    const m2 = seedMeeting()
    const a = seedSpeaker(m1, 'A')
    const x = seedSpeaker(m2, 'X')
    const err = { success: false, error: '같은 회의의 서로 다른 화자만 합칠 수 있습니다.' }
    expect(mergeSpeakersInMeeting(db, m1, a, a)).toEqual(err)
    expect(mergeSpeakersInMeeting(db, m1, a, x)).toEqual(err)
    const b = seedSpeaker(m1, 'B')
    const s = seedSegment(m1, 0, a)
    expect(mergeSpeakersInMeeting(db, m1, a, b)).toEqual({ success: true })
    expect(seg(s)).toEqual({ speaker_id: b, speaker_corrected: 1 })
    expect(speakerExists(a)).toBe(false)
  })
})
