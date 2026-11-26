import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3는 Electron ABI로 빌드돼 vitest(Node)에서 로드할 수 없다. node:sqlite로 갈아끼워
// initDatabase()의 실제 스키마(applyVoiceprintSchema 포함)를 그대로 돌린다(recognition-aids.test.ts와 같은 방식).
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
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/linkwork-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))

import type Database from 'better-sqlite3'
import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import { applyRematch, encodeEmbedding, planRematch, saveSpeakerVoice } from './voiceprint'
import { sanitizeRematchOptions } from '../ipc/recognition-aids.ipc'

const MODEL = 'test-model/w1.5h0.75'

function vecWithCos(cos: number, dim = 4): Float32Array {
  const v = new Float32Array(dim)
  v[0] = cos
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos))
  return v
}

function axis(i: number, dim = 4): Float32Array {
  const v = new Float32Array(dim)
  v[i] = 1
  return v
}

let db: Database.Database

beforeEach(() => {
  closeDatabase()
  initDatabase()
  db = getDatabase()
})

afterAll(() => {
  closeDatabase()
})

function seedMeeting(status = 'transcribed', startedAt = '2026-01-01 10:00:00'): number {
  return Number(
    db
      .prepare('INSERT INTO meetings (title, status, started_at) VALUES (?, ?, ?)')
      .run(`회의-${status}`, status, startedAt).lastInsertRowid
  )
}

function seedSpeaker(
  meetingId: number,
  key: string,
  voice: Float32Array | null,
  extra: { display_name?: string | null; member_id?: number | null; member_source?: string | null; rejected?: number[]; model?: string } = {}
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO meeting_speakers (meeting_id, speaker_key, label, display_name, color, sort_order)
         VALUES (?, ?, ?, ?, '#000000', 0)`
      )
      .run(meetingId, key, `화자 ${key}`, extra.display_name ?? null).lastInsertRowid
  )
  db.prepare('UPDATE meeting_speakers SET member_id = ?, member_source = ?, rejected_member_ids = ? WHERE id = ?').run(
    extra.member_id ?? null,
    extra.member_source ?? null,
    JSON.stringify(extra.rejected ?? []),
    id
  )
  if (voice) saveSpeakerVoice(db, id, meetingId, { embedding: voice, speech_ms: 60_000, model: extra.model ?? MODEL })
  return id
}

function seedMember(name: string, profile: Float32Array, model = MODEL): number {
  const id = Number(db.prepare('INSERT INTO meeting_members (name) VALUES (?)').run(name).lastInsertRowid)
  const src = seedMeeting('summarized', '2025-01-01 09:00:00')
  db.prepare(
    `INSERT INTO member_voice_samples (member_id, meeting_id, speaker_key, embedding, model, dim, speech_ms)
     VALUES (?, ?, 'S0', ?, ?, ?, 60000)`
  ).run(id, src, encodeEmbedding(profile), model, profile.length)
  return id
}

function row(id: number): { display_name: string | null; member_id: number | null; member_source: string | null; match_score: number | null } {
  return db
    .prepare('SELECT display_name, member_id, member_source, match_score FROM meeting_speakers WHERE id = ?')
    .get(id) as ReturnType<typeof row>
}

function sampleCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM member_voice_samples').get() as { n: number }).n
}

function snapshot(): string {
  return JSON.stringify(
    db.prepare('SELECT id, display_name, member_id, member_source, match_score FROM meeting_speakers ORDER BY id').all()
  )
}

describe('planRematch / applyRematch', () => {
  it('(a) 이름 없는 화자 + 가까운 프로필 → auto, apply가 display_name을 채운다', () => {
    const kim = seedMember('김철수', axis(0))
    const m = seedMeeting()
    const sp = seedSpeaker(m, 'S0', vecWithCos(0.9))
    const plan = planRematch(db)
    expect(plan).toHaveLength(1)
    expect(plan[0].meeting_id).toBe(m)
    expect(plan[0].speakers).toEqual([
      expect.objectContaining({ speaker_id: sp, speaker_label: '화자 S0', member_id: kim, member_name: '김철수', source: 'auto' })
    ])
    expect(plan[0].speakers[0].score).toBeCloseTo(0.9, 5)
    const res = applyRematch(db, plan)
    expect(res).toEqual({ meetings: 1, auto: 1, suggested: 0 })
    expect(row(sp)).toMatchObject({ display_name: '김철수', member_id: kim, member_source: 'auto' })
  })

  it('(b) 이름이 있는 화자는 대상이 아니다', () => {
    seedMember('김철수', axis(0))
    const m = seedMeeting()
    seedSpeaker(m, 'S0', vecWithCos(0.95), { display_name: '누군가' })
    seedSpeaker(m, 'S1', vecWithCos(0.95), { display_name: '   ' })
    const plan = planRematch(db)
    expect(plan).toHaveLength(1)
    expect(plan[0].speakers.map((s) => s.speaker_label)).toEqual(['화자 S1'])
  })

  it('(c) 같은 회의 다른 화자(대상 아님)에 연결된 구성원은 후보가 아니다', () => {
    const kim = seedMember('김철수', axis(0))
    const m = seedMeeting()
    seedSpeaker(m, 'S0', axis(0), { display_name: '김철수', member_id: kim, member_source: 'manual' })
    seedSpeaker(m, 'S1', vecWithCos(0.9))
    expect(planRematch(db)).toEqual([])
  })

  it('(d) rejected_member_ids를 존중한다', () => {
    const kim = seedMember('김철수', axis(0))
    const m = seedMeeting()
    seedSpeaker(m, 'S0', vecWithCos(0.9), { rejected: [kim] })
    expect(planRematch(db)).toEqual([])
  })

  it('(e) memberIds로 걸러도 2순위 차는 전체 구성원 기준이다', () => {
    const kim = seedMember('김철수', axis(0))
    // 둘째 구성원: 화자와 0.85 근처 — 1순위(0.9)와 차가 0.08 미만
    const second = new Float32Array([0.552, 0.834, 0, 0])
    const lee = seedMember('이영희', second)
    const m = seedMeeting()
    seedSpeaker(m, 'S0', vecWithCos(0.9))
    const all = planRematch(db)
    expect(all[0].speakers[0]).toMatchObject({ member_id: kim, source: 'suggested' })
    const onlyKim = planRematch(db, { memberIds: [kim] })
    expect(onlyKim[0].speakers[0]).toMatchObject({ member_id: kim, source: 'suggested' })
    expect(planRematch(db, { memberIds: [lee] })).toEqual([])
  })

  it('(f) 목소리 model이 다르면 매칭하지 않는다', () => {
    seedMember('김철수', axis(0), 'other-model')
    const m = seedMeeting()
    seedSpeaker(m, 'S0', vecWithCos(0.95))
    expect(planRematch(db)).toEqual([])
  })

  it('(g) preview는 DB를 바꾸지 않고, apply 뒤 preview는 빈 배열(멱등)', () => {
    seedMember('김철수', axis(0))
    seedMember('이영희', axis(2))
    const m = seedMeeting()
    seedSpeaker(m, 'S0', vecWithCos(0.9))
    // 이영희(axis 2)와 코사인 0.65 → suggested
    seedSpeaker(m, 'S1', new Float32Array([0, Math.sqrt(1 - 0.65 * 0.65), 0.65, 0]))
    const before = snapshot()
    const plan = planRematch(db)
    expect(snapshot()).toBe(before)
    expect(plan[0].speakers.map((s) => s.source).sort()).toEqual(['auto', 'suggested'])
    applyRematch(db, plan)
    expect(planRematch(db)).toEqual([])
  })

  it('(h) member_voice_samples 행 수가 apply 전후 같다', () => {
    seedMember('김철수', axis(0))
    const m = seedMeeting()
    seedSpeaker(m, 'S0', vecWithCos(0.9))
    const n = sampleCount()
    const res = applyRematch(db, planRematch(db))
    expect(res.auto).toBe(1)
    expect(sampleCount()).toBe(n)
  })

  it("(i) status 'processing'·'recording' 회의는 제외한다", () => {
    seedMember('김철수', axis(0))
    seedSpeaker(seedMeeting('processing'), 'S0', vecWithCos(0.9))
    seedSpeaker(seedMeeting('recording'), 'S0', vecWithCos(0.9))
    expect(planRematch(db)).toEqual([])
  })

  it('(j) 참석자가 있으면 그 안에서만 고른다', () => {
    seedMember('김철수', axis(0))
    const lee = seedMember('이영희', axis(2))
    const m = seedMeeting()
    db.prepare('INSERT INTO meeting_attendees (meeting_id, member_id) VALUES (?, ?)').run(m, lee)
    seedSpeaker(m, 'S0', vecWithCos(0.9))
    expect(planRematch(db)).toEqual([])
  })

  it('회의는 started_at 내림차순, meetingIds로 좁힌다, 이미 같은 suggested는 뺀다', () => {
    const kim = seedMember('김철수', axis(0))
    const old = seedMeeting('transcribed', '2026-01-01 10:00:00')
    const recent = seedMeeting('summarized', '2026-03-01 10:00:00')
    seedSpeaker(old, 'S0', vecWithCos(0.9))
    seedSpeaker(recent, 'S0', vecWithCos(0.9))
    expect(planRematch(db).map((p) => p.meeting_id)).toEqual([recent, old])
    expect(planRematch(db, { meetingIds: [old] }).map((p) => p.meeting_id)).toEqual([old])
    const m3 = seedMeeting()
    seedSpeaker(m3, 'S0', vecWithCos(0.65), { member_id: kim, member_source: 'suggested' })
    expect(planRematch(db, { meetingIds: [m3] })).toEqual([])
  })

  it('지금 suggested인 화자가 auto가 되면 계획에 들어가고, 계획에 없는 suggested는 그대로', () => {
    const kim = seedMember('김철수', axis(0))
    const m = seedMeeting()
    const up = seedSpeaker(m, 'S0', vecWithCos(0.95), { member_id: kim, member_source: 'suggested' })
    const plan = planRematch(db)
    expect(plan[0].speakers).toEqual([expect.objectContaining({ speaker_id: up, source: 'auto' })])
  })

  it('다른 화자에게 간 구성원을 suggested로 가리키던 매칭 없는 화자는 제안을 지운다', () => {
    const kim = seedMember('김철수', axis(0))
    const m = seedMeeting()
    // A: 예전에 김철수로 제안됐지만 지금 프로필과는 멀어 매칭 없음
    const a = seedSpeaker(m, 'S0', axis(3), { member_id: kim, member_source: 'suggested' })
    const b = seedSpeaker(m, 'S1', vecWithCos(0.9))
    const plan = planRematch(db)
    expect(plan[0].speakers).toEqual([expect.objectContaining({ speaker_id: b, member_id: kim, source: 'auto' })])
    applyRematch(db, plan)
    expect(row(b)).toMatchObject({ member_id: kim, member_source: 'auto', display_name: '김철수' })
    expect(row(a)).toMatchObject({ member_id: null, member_source: null, match_score: null })
    const linked = db
      .prepare('SELECT COUNT(*) AS n FROM meeting_speakers WHERE meeting_id = ? AND member_id = ?')
      .get(m, kim) as { n: number }
    expect(linked.n).toBe(1)
  })

  it('sanitizeRematchOptions:양의 안전 정수만, 중복 제거, 최대 500개, 배열이 아니면 없음', () => {
    expect(sanitizeRematchOptions(null)).toEqual({})
    expect(sanitizeRematchOptions({ meetingIds: 'x', memberIds: 3 })).toEqual({})
    expect(sanitizeRematchOptions({ meetingIds: [1, 1, 2, -1, 0, 1.5, '3', Number.MAX_SAFE_INTEGER + 2] })).toEqual({
      meetingIds: [1, 2]
    })
    const many = Array.from({ length: 800 }, (_, i) => i + 1)
    expect(sanitizeRematchOptions({ memberIds: many }).memberIds).toHaveLength(500)
  })
})
