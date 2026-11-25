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
  app: { getPath: () => '/linkwork-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))

import type Database from 'better-sqlite3'
import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import { removeMember, upsertMember } from './recognition-aids'
import {
  AUTO_MATCH_MARGIN,
  AUTO_MATCH_MIN,
  PROFILE_MAX_SAMPLES,
  SUGGEST_MATCH_MIN,
  applyMeetingVoices,
  applyMeetingVoicesSafe,
  SHORT_VOICE_ERROR,
  speakersBelongToMeeting,
  buildMemberProfile,
  clearVoiceprint,
  combineCentroids,
  confirmSpeakerMatch,
  cosineSimilarity,
  decodeEmbedding,
  encodeEmbedding,
  enrollSpeakerVoice,
  listVoiceprints,
  loadMemberProfiles,
  mergeSpeakerVoices,
  planVoiceMatches,
  rejectSpeakerMatch,
  saveSpeakerVoice,
  syncSpeakerEnrollment,
  type MatchMember,
  type MatchSpeaker
} from './voiceprint'

const MODEL = 'test-model/w1.5h0.75'

/** 첫 축과 각도 θ를 이루는 2차원 단위 벡터 → 코사인 = cos θ */
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

function member(id: number, profile: Float32Array | null, extra: Partial<MatchMember> = {}): MatchMember {
  return { member_id: id, name: `구성원${id}`, enabled: true, profile, ...extra }
}

function speaker(key: string, embedding: Float32Array | null, extra: Partial<MatchSpeaker> = {}): MatchSpeaker {
  return { speaker_key: key, embedding, speech_ms: 60_000, display_name: null, rejected_member_ids: [], ...extra }
}

describe('encode/decodeEmbedding', () => {
  it('Float32 BLOB 왕복이 값을 보존한다(Buffer·Uint8Array 모두)', () => {
    const src = Float32Array.from([0.1, -0.25, 3.5, 1e-7, -0])
    const blob = encodeEmbedding(src)
    expect(blob.byteLength).toBe(src.length * 4)
    expect(Array.from(decodeEmbedding(blob) as Float32Array)).toEqual(Array.from(src))
    // 오프셋이 있는 뷰(SQLite 드라이버가 돌려주는 형태)도 읽는다
    const padded = new Uint8Array(blob.byteLength + 3)
    padded.set(blob, 3)
    const view = new Uint8Array(padded.buffer, 3, blob.byteLength)
    expect(Array.from(decodeEmbedding(view) as Float32Array)).toEqual(Array.from(src))
    expect(decodeEmbedding(new Uint8Array(5))).toBeNull()
    expect(decodeEmbedding(null)).toBeNull()
  })
})

describe('buildMemberProfile', () => {
  it('모델이 다른 표본은 빼고, 표본이 없으면 null', () => {
    expect(buildMemberProfile([{ embedding: axis(0), speech_ms: 30_000, model: 'other' }], MODEL)).toBeNull()
    const p = buildMemberProfile(
      [
        { embedding: axis(0), speech_ms: 30_000, model: 'other' },
        { embedding: axis(1), speech_ms: 30_000, model: MODEL }
      ],
      MODEL
    ) as Float32Array
    expect(cosineSimilarity(p, axis(1))).toBeCloseTo(1, 5)
  })

  it('가중치는 발화 300초에서 상한이 걸린다', () => {
    // 1000초 표본과 300초 표본은 같은 가중 → 두 축의 정확히 중간
    const p = buildMemberProfile(
      [
        { embedding: axis(0), speech_ms: 1_000_000, model: MODEL },
        { embedding: axis(1), speech_ms: 300_000, model: MODEL }
      ],
      MODEL
    ) as Float32Array
    expect(p[0]).toBeCloseTo(p[1], 5)
    // 상한 아래에서는 발화 길이에 비례
    const q = buildMemberProfile(
      [
        { embedding: axis(0), speech_ms: 200_000, model: MODEL },
        { embedding: axis(1), speech_ms: 100_000, model: MODEL }
      ],
      MODEL
    ) as Float32Array
    expect(q[0] / q[1]).toBeCloseTo(2, 4)
  })

  it('최근 20개 표본만 쓴다(앞이 최신)', () => {
    const recent = Array.from({ length: PROFILE_MAX_SAMPLES }, () => ({
      embedding: axis(0),
      speech_ms: 30_000,
      model: MODEL
    }))
    const old = Array.from({ length: 10 }, () => ({ embedding: axis(1), speech_ms: 300_000, model: MODEL }))
    const p = buildMemberProfile([...recent, ...old], MODEL) as Float32Array
    expect(p[1]).toBe(0)
    expect(p[0]).toBeCloseTo(1, 5)
  })
})

describe('combineCentroids', () => {
  it('speech_ms 가중 평균 후 L2 정규화, 발화 합산', () => {
    const c = combineCentroids({ embedding: axis(0), speech_ms: 30_000 }, { embedding: axis(1), speech_ms: 10_000 })
    expect(c.speech_ms).toBe(40_000)
    expect(c.embedding[0] / c.embedding[1]).toBeCloseTo(3, 4)
    let norm = 0
    for (const x of c.embedding) norm += x * x
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5)
  })
})

describe('planVoiceMatches', () => {
  it('0.70 이상·2순위 차 0.08 이상이면 auto', () => {
    const res = planVoiceMatches({
      speakers: [speaker('s', vecWithCos(AUTO_MATCH_MIN + 0.001))],
      members: [member(1, axis(0))]
    })
    expect(res.get('s')).toMatchObject({ member_id: 1, source: 'auto' })
  })

  it('0.70 바로 아래는 suggested, 0.60 바로 아래는 없음', () => {
    const below = planVoiceMatches({
      speakers: [speaker('s', vecWithCos(AUTO_MATCH_MIN - 0.002))],
      members: [member(1, axis(0))]
    })
    expect(below.get('s')).toMatchObject({ member_id: 1, source: 'suggested' })
    const atSuggest = planVoiceMatches({
      speakers: [speaker('s', vecWithCos(SUGGEST_MATCH_MIN + 0.001))],
      members: [member(1, axis(0))]
    })
    expect(atSuggest.get('s')?.source).toBe('suggested')
    const none = planVoiceMatches({
      speakers: [speaker('s', vecWithCos(SUGGEST_MATCH_MIN - 0.002))],
      members: [member(1, axis(0))]
    })
    expect(none.size).toBe(0)
  })

  it('2순위와 차가 0.08 미만이면 auto가 아니라 suggested', () => {
    // 화자 = 축0, 구성원1 = 축0과 0.9, 구성원2 = 축0과 0.9-차
    const build = (gap: number): string | undefined =>
      planVoiceMatches({
        speakers: [speaker('s', axis(0))],
        members: [
          member(1, vecWithCos(0.9)),
          member(2, (() => {
            const v = new Float32Array(4)
            v[0] = 0.9 - gap
            v[2] = Math.sqrt(1 - v[0] * v[0])
            return v
          })())
        ]
      }).get('s')?.source
    expect(build(AUTO_MATCH_MARGIN + 0.002)).toBe('auto')
    expect(build(AUTO_MATCH_MARGIN - 0.002)).toBe('suggested')
  })

  it('점수 내림차순 탐욕 1:1 배정', () => {
    // 두 화자 모두 구성원1과 가장 비슷하지만 1:1 — 더 높은 쪽(b)이 1, a는 구성원2
    const res = planVoiceMatches({
      speakers: [speaker('a', vecWithCos(0.85)), speaker('b', axis(0))],
      members: [member(1, axis(0)), member(2, vecWithCos(0.8))]
    })
    expect(res.get('b')?.member_id).toBe(1)
    expect(res.get('a')?.member_id).toBe(2)
  })

  it('거부 목록·이미 연결된 구성원·꺼진 구성원·표본 없는 구성원은 후보가 아니다', () => {
    const res = planVoiceMatches({
      speakers: [speaker('s', axis(0), { rejected_member_ids: [1] })],
      members: [
        member(1, axis(0)),
        member(2, axis(0), { enabled: false }),
        member(3, axis(0)),
        member(4, null),
        member(5, vecWithCos(0.75))
      ],
      takenMemberIds: [3]
    })
    expect(res.get('s')?.member_id).toBe(5)
  })

  it('참석자가 지정돼 있으면 참석자로 좁힌다', () => {
    const res = planVoiceMatches({
      speakers: [speaker('s', axis(0))],
      members: [member(1, axis(0)), member(2, vecWithCos(0.8))],
      attendeeIds: [2]
    })
    expect(res.get('s')?.member_id).toBe(2)
  })

  it('이름이 있거나 발화 10초 미만이거나 centroid가 없는 화자는 대상이 아니다', () => {
    const res = planVoiceMatches({
      speakers: [
        speaker('named', axis(0), { display_name: '홍길동' }),
        speaker('short', axis(0), { speech_ms: 9_999 }),
        speaker('none', null)
      ],
      members: [member(1, axis(0))]
    })
    expect(res.size).toBe(0)
  })
})

// ── DB ──

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

function seedSpeaker(meetingId: number, key: string, displayName: string | null = null): number {
  return Number(
    db
      .prepare(
        'INSERT INTO meeting_speakers (meeting_id, speaker_key, label, display_name, color, sort_order) VALUES (?, ?, ?, ?, ?, 0)'
      )
      .run(meetingId, key, key, displayName, '#000000').lastInsertRowid
  )
}

function setName(speakerId: number, name: string | null): ReturnType<typeof syncSpeakerEnrollment> {
  db.prepare('UPDATE meeting_speakers SET display_name = ? WHERE id = ?').run(name, speakerId)
  return syncSpeakerEnrollment(db, speakerId)
}

function speakerRow(id: number): {
  display_name: string | null
  member_id: number | null
  member_source: string | null
  match_score: number | null
  rejected_member_ids: string
} {
  return db
    .prepare(
      'SELECT display_name, member_id, member_source, match_score, rejected_member_ids FROM meeting_speakers WHERE id = ?'
    )
    .get(id) as ReturnType<typeof speakerRow>
}

function sampleCount(memberId?: number): number {
  const row = (
    memberId === undefined
      ? db.prepare('SELECT COUNT(*) AS n FROM member_voice_samples').get()
      : db.prepare('SELECT COUNT(*) AS n FROM member_voice_samples WHERE member_id = ?').get(memberId)
  ) as { n: number }
  return row.n
}

describe('스키마', () => {
  it('meeting_speakers 연결 컬럼과 목소리 테이블을 만든다', () => {
    const cols = (db.prepare('PRAGMA table_info(meeting_speakers)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['member_id', 'member_source', 'match_score', 'rejected_member_ids']))
    for (const t of ['meeting_speaker_voices', 'member_voice_samples']) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t)).toBeTruthy()
    }
    const m = seedMeeting()
    const s = seedSpeaker(m, 'spk_0')
    expect(speakerRow(s).rejected_member_ids).toBe('[]')
  })
})

describe('수동 등록 → 이름 변경 → 표본 삭제', () => {
  it('구성원 이름(별칭 포함)이면 연결·표본 등록, 비구성원 이름·이름 삭제면 연결·표본 삭제', () => {
    const kim = upsertMember(db, { name: '김철수', aliases: ['철수'] }).id
    const m = seedMeeting()
    const s = seedSpeaker(m, 'spk_0')
    saveSpeakerVoice(db, s, m, { embedding: axis(0), speech_ms: 25_000, model: MODEL })

    expect(setName(s, '철수')).toEqual({ member_id: kim, enrolled: true })
    expect(speakerRow(s)).toMatchObject({ member_id: kim, member_source: 'manual' })
    expect(sampleCount(kim)).toBe(1)
    // BLOB이 DB를 거쳐도 그대로
    const blob = db.prepare('SELECT embedding FROM member_voice_samples').get() as { embedding: Uint8Array }
    expect(Array.from(decodeEmbedding(blob.embedding) as Float32Array)).toEqual(Array.from(axis(0)))

    // 다시 저장해도 중복되지 않는다(upsert)
    setName(s, '김철수')
    expect(sampleCount(kim)).toBe(1)

    // 비구성원 이름 → 연결·표본 삭제
    expect(setName(s, '외부 손님')).toEqual({ member_id: null, enrolled: false })
    expect(speakerRow(s)).toMatchObject({ member_id: null, member_source: null })
    expect(sampleCount(kim)).toBe(0)

    // 다시 붙였다가 이름 삭제
    setName(s, '김철수')
    expect(sampleCount(kim)).toBe(1)
    setName(s, null)
    expect(sampleCount(kim)).toBe(0)
  })

  it('발화 20초 미만은 연결만 하고 표본은 남기지 않는다', () => {
    const kim = upsertMember(db, { name: '김철수' }).id
    const m = seedMeeting()
    const s = seedSpeaker(m, 'spk_0')
    saveSpeakerVoice(db, s, m, { embedding: axis(0), speech_ms: 19_999, model: MODEL })
    expect(setName(s, '김철수')).toEqual({ member_id: kim, enrolled: false })
    expect(sampleCount()).toBe(0)
  })

  it('꺼진 구성원 이름은 연결하지 않는다', () => {
    upsertMember(db, { name: '김철수', enabled: false })
    const m = seedMeeting()
    const s = seedSpeaker(m, 'spk_0')
    saveSpeakerVoice(db, s, m, { embedding: axis(0), speech_ms: 30_000, model: MODEL })
    expect(setName(s, '김철수').member_id).toBeNull()
  })

  it('enrollSpeakerVoice: 구성원이 아니면 그 이름으로 만든 뒤 등록', () => {
    const m = seedMeeting()
    const s = seedSpeaker(m, 'spk_0', '박영희')
    saveSpeakerVoice(db, s, m, { embedding: axis(0), speech_ms: 30_000, model: MODEL })
    const r = enrollSpeakerVoice(db, s)
    expect(r.created).toBe(true)
    expect(r.enrolled).toBe(true)
    const row = db.prepare('SELECT name FROM meeting_members WHERE id = ?').get(r.member_id) as { name: string }
    expect(row.name).toBe('박영희')
    expect(listVoiceprints(db)).toEqual([
      expect.objectContaining({ member_id: r.member_id, sample_count: 1, total_speech_ms: 30_000 })
    ])
    expect(clearVoiceprint(db, r.member_id as number).removed).toBe(1)
    expect(listVoiceprints(db)).toEqual([])
  })
})

describe('구성원 삭제 연쇄', () => {
  it('removeMember는 표본을 지우고 화자 연결을 끊는다', () => {
    const kim = upsertMember(db, { name: '김철수' }).id
    const m = seedMeeting()
    const s = seedSpeaker(m, 'spk_0')
    saveSpeakerVoice(db, s, m, { embedding: axis(0), speech_ms: 30_000, model: MODEL })
    setName(s, '김철수')
    expect(sampleCount(kim)).toBe(1)
    removeMember(db, kim)
    expect(sampleCount()).toBe(0)
    expect(speakerRow(s)).toMatchObject({ member_id: null, member_source: null, display_name: '김철수' })
  })

  it('회의를 지워도 표본은 남는다(meeting_id NULL), 화자 목소리는 지워진다', () => {
    const kim = upsertMember(db, { name: '김철수' }).id
    const m = seedMeeting()
    const s = seedSpeaker(m, 'spk_0')
    saveSpeakerVoice(db, s, m, { embedding: axis(0), speech_ms: 30_000, model: MODEL })
    setName(s, '김철수')
    db.prepare('DELETE FROM meetings WHERE id = ?').run(m)
    const row = db.prepare('SELECT meeting_id FROM member_voice_samples WHERE member_id = ?').get(kim) as {
      meeting_id: number | null
    }
    expect(row.meeting_id).toBeNull()
    expect((db.prepare('SELECT COUNT(*) AS n FROM meeting_speaker_voices').get() as { n: number }).n).toBe(0)
  })
})

describe('자동 매칭(applyMeetingVoices)·확정·거부', () => {
  function enrollKim(): number {
    const kim = upsertMember(db, { name: '김철수' }).id
    const m = seedMeeting()
    const s = seedSpeaker(m, 'spk_0')
    saveSpeakerVoice(db, s, m, { embedding: axis(0), speech_ms: 60_000, model: MODEL })
    setName(s, '김철수')
    return kim
  }

  it('새 회의의 비슷한 목소리를 auto로 지정하고 이름을 붙인다(표본으로는 등록하지 않음)', () => {
    const kim = enrollKim()
    const m2 = seedMeeting()
    const a = seedSpeaker(m2, 'spk_0')
    const b = seedSpeaker(m2, 'spk_1')
    const res = applyMeetingVoices(db, {
      meetingId: m2,
      speakers: [
        { id: a, speaker_key: 'spk_0', display_name: null, oldSpeakerId: null },
        { id: b, speaker_key: 'spk_1', display_name: null, oldSpeakerId: null }
      ],
      voices: [
        { speaker_key: 'spk_0', embedding: vecWithCos(0.9), speech_ms: 40_000 },
        { speaker_key: 'spk_1', embedding: axis(2), speech_ms: 40_000 }
      ],
      model: MODEL,
      oldLinks: new Map(),
      attendeeIds: []
    })
    expect(res).toEqual({ auto: 1, suggested: 0 })
    expect(speakerRow(a)).toMatchObject({ member_id: kim, member_source: 'auto', display_name: '김철수' })
    expect(speakerRow(a).match_score).toBeCloseTo(0.9, 4)
    expect(speakerRow(b).member_id).toBeNull()
    expect(sampleCount(kim)).toBe(1)

    // 맞음 → manual + 표본 등록
    expect(confirmSpeakerMatch(db, a)).toEqual({ member_id: kim, enrolled: true })
    expect(speakerRow(a).member_source).toBe('manual')
    expect(sampleCount(kim)).toBe(2)
  })

  it('후처리로 흡수돼 화자 행이 없는 키의 voice는 저장하지 않는다', () => {
    const m = seedMeeting()
    const a = seedSpeaker(m, 'spk_0')
    applyMeetingVoices(db, {
      meetingId: m,
      speakers: [{ id: a, speaker_key: 'spk_0', display_name: null, oldSpeakerId: null }],
      voices: [
        { speaker_key: 'spk_0', embedding: axis(0), speech_ms: 40_000 },
        { speaker_key: 'spk_2', embedding: axis(1), speech_ms: 5_000 }
      ],
      model: MODEL,
      oldLinks: new Map(),
      attendeeIds: []
    })
    const rows = db.prepare('SELECT speaker_id FROM meeting_speaker_voices WHERE meeting_id = ?').all(m) as {
      speaker_id: number
    }[]
    expect(rows.map((r) => r.speaker_id)).toEqual([a])
  })

  it('모델이 다른 표본은 매칭에 쓰지 않는다', () => {
    enrollKim()
    expect(loadMemberProfiles(db, 'other-model').every((m) => m.profile === null)).toBe(true)
    const m2 = seedMeeting()
    const a = seedSpeaker(m2, 'spk_0')
    const res = applyMeetingVoices(db, {
      meetingId: m2,
      speakers: [{ id: a, speaker_key: 'spk_0', display_name: null, oldSpeakerId: null }],
      voices: [{ speaker_key: 'spk_0', embedding: axis(0), speech_ms: 40_000 }],
      model: 'other-model',
      oldLinks: new Map(),
      attendeeIds: []
    })
    expect(res).toEqual({ auto: 0, suggested: 0 })
    expect(speakerRow(a).member_id).toBeNull()
  })

  it('거부하면 연결·자동 이름을 지우고 거부 목록이 재처리에도 승계된다', () => {
    const kim = enrollKim()
    const m2 = seedMeeting()
    const a = seedSpeaker(m2, 'spk_0')
    const voices = [{ speaker_key: 'spk_0', embedding: axis(0), speech_ms: 40_000 }]
    applyMeetingVoices(db, {
      meetingId: m2,
      speakers: [{ id: a, speaker_key: 'spk_0', display_name: null, oldSpeakerId: null }],
      voices,
      model: MODEL,
      oldLinks: new Map(),
      attendeeIds: []
    })
    expect(speakerRow(a).member_source).toBe('auto')
    expect(rejectSpeakerMatch(db, a)).toEqual({ success: true })
    expect(speakerRow(a)).toMatchObject({ member_id: null, member_source: null, display_name: null })
    expect(JSON.parse(speakerRow(a).rejected_member_ids)).toEqual([kim])

    // 재처리: 옛 행을 지우고 다시 넣는다 → 거부 목록 승계로 다시 지정되지 않는다
    const oldLinks = new Map([[a, { ...speakerRow(a) }]])
    db.prepare('DELETE FROM meeting_speakers WHERE meeting_id = ?').run(m2)
    const a2 = seedSpeaker(m2, 'spk_0')
    applyMeetingVoices(db, {
      meetingId: m2,
      speakers: [{ id: a2, speaker_key: 'spk_0', display_name: null, oldSpeakerId: a }],
      voices,
      model: MODEL,
      oldLinks: oldLinks as never,
      attendeeIds: []
    })
    expect(speakerRow(a2).member_id).toBeNull()
    expect(JSON.parse(speakerRow(a2).rejected_member_ids)).toEqual([kim])
  })

  it('승계 이름이 구성원이면 manual 연결 + 그 회의 표본을 새 centroid로 교체', () => {
    const kim = upsertMember(db, { name: '김철수' }).id
    const m = seedMeeting()
    const s = seedSpeaker(m, 'spk_0')
    saveSpeakerVoice(db, s, m, { embedding: axis(0), speech_ms: 60_000, model: MODEL })
    setName(s, '김철수')
    const oldLinks = new Map([[s, speakerRow(s)]])
    db.prepare('DELETE FROM meeting_speakers WHERE meeting_id = ?').run(m)
    const s2 = seedSpeaker(m, 'spk_3', '김철수')
    applyMeetingVoices(db, {
      meetingId: m,
      speakers: [{ id: s2, speaker_key: 'spk_3', display_name: '김철수', oldSpeakerId: s }],
      voices: [{ speaker_key: 'spk_3', embedding: axis(1), speech_ms: 50_000 }],
      model: MODEL,
      oldLinks: oldLinks as never,
      attendeeIds: []
    })
    expect(speakerRow(s2)).toMatchObject({ member_id: kim, member_source: 'manual' })
    const rows = db.prepare('SELECT speaker_key, embedding FROM member_voice_samples WHERE member_id = ?').all(kim) as {
      speaker_key: string
      embedding: Uint8Array
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].speaker_key).toBe('spk_3')
    expect(Array.from(decodeEmbedding(rows[0].embedding) as Float32Array)).toEqual(Array.from(axis(1)))
  })

  it('수동 병합은 centroid를 가중 평균하고 from의 목소리·표본을 정리한다', () => {
    const kim = upsertMember(db, { name: '김철수' }).id
    const m = seedMeeting()
    const into = seedSpeaker(m, 'spk_0')
    const from = seedSpeaker(m, 'spk_1')
    saveSpeakerVoice(db, into, m, { embedding: axis(0), speech_ms: 30_000, model: MODEL })
    saveSpeakerVoice(db, from, m, { embedding: axis(1), speech_ms: 10_000, model: MODEL })
    setName(into, '김철수')
    expect(mergeSpeakerVoices(db, m, from, into)).toBe(true)
    const v = db.prepare('SELECT embedding, speech_ms FROM meeting_speaker_voices WHERE speaker_id = ?').get(into) as {
      embedding: Uint8Array
      speech_ms: number
    }
    expect(v.speech_ms).toBe(40_000)
    const e = decodeEmbedding(v.embedding) as Float32Array
    expect(e[0] / e[1]).toBeCloseTo(3, 4)
    expect(db.prepare('SELECT 1 FROM meeting_speaker_voices WHERE speaker_id = ?').get(from)).toBeUndefined()
    const sample = db.prepare('SELECT speech_ms FROM member_voice_samples WHERE member_id = ?').get(kim) as {
      speech_ms: number
    }
    expect(sample.speech_ms).toBe(40_000)
  })

  it('수동 병합은 같은 회의의 서로 다른 화자만 받는다', () => {
    const m = seedMeeting()
    const m2 = seedMeeting()
    const a = seedSpeaker(m, 'spk_0')
    const b = seedSpeaker(m, 'spk_1')
    const c = seedSpeaker(m2, 'spk_0')
    saveSpeakerVoice(db, c, m2, { embedding: axis(1), speech_ms: 30_000, model: MODEL })
    expect(speakersBelongToMeeting(db, m, [a, b])).toBe(true)
    expect(speakersBelongToMeeting(db, m, [a, c])).toBe(false)
    expect(speakersBelongToMeeting(db, m, [a, a])).toBe(false)
    expect(mergeSpeakerVoices(db, m, c, a)).toBe(false)
    // 다른 회의 화자의 목소리는 손대지 않는다
    expect(db.prepare('SELECT 1 FROM meeting_speaker_voices WHERE speaker_id = ?').get(c)).toBeTruthy()
    expect(db.prepare('SELECT 1 FROM meeting_speaker_voices WHERE speaker_id = ?').get(a)).toBeUndefined()
  })
})

describe('리뷰 보강', () => {
  it('enrollSpeakerVoice: 발화 20초 미만·목소리 없음이면 구성원 생성·연결 없이 오류', () => {
    const m = seedMeeting()
    const s = seedSpeaker(m, 'spk_0', '박영희')
    saveSpeakerVoice(db, s, m, { embedding: axis(0), speech_ms: 19_000, model: MODEL })
    expect(() => enrollSpeakerVoice(db, s)).toThrow(SHORT_VOICE_ERROR)
    const t = seedSpeaker(m, 'spk_1', '이민수')
    expect(() => enrollSpeakerVoice(db, t)).toThrow(SHORT_VOICE_ERROR)
    expect((db.prepare('SELECT COUNT(*) AS n FROM meeting_members').get() as { n: number }).n).toBe(0)
    expect(speakerRow(s).member_id).toBeNull()
  })

  it('confirmSpeakerMatch: 발화가 짧으면 확정은 하되 enrolled=false', () => {
    const kim = upsertMember(db, { name: '김철수' }).id
    const m = seedMeeting()
    const s = seedSpeaker(m, 'spk_0')
    saveSpeakerVoice(db, s, m, { embedding: axis(0), speech_ms: 15_000, model: MODEL })
    db.prepare("UPDATE meeting_speakers SET member_id = ?, member_source = 'suggested', match_score = 0.65 WHERE id = ?").run(kim, s)
    expect(confirmSpeakerMatch(db, s)).toEqual({ member_id: kim, enrolled: false })
    expect(speakerRow(s)).toMatchObject({ member_id: kim, member_source: 'manual', display_name: '김철수' })
    expect(sampleCount()).toBe(0)
  })

  it('재처리에서 새 centroid가 짧아 옛 표본을 유지하면 출처 키를 새 화자 키로 옮긴다', () => {
    const kim = upsertMember(db, { name: '김철수' }).id
    const m = seedMeeting()
    const s = seedSpeaker(m, 'spk_0')
    saveSpeakerVoice(db, s, m, { embedding: axis(0), speech_ms: 60_000, model: MODEL })
    setName(s, '김철수')
    const oldLinks = new Map([[s, { speaker_key: 'spk_0', ...speakerRow(s) }]])
    db.prepare('DELETE FROM meeting_speakers WHERE meeting_id = ?').run(m)
    const s2 = seedSpeaker(m, 'spk_2', '김철수')
    applyMeetingVoices(db, {
      meetingId: m,
      speakers: [{ id: s2, speaker_key: 'spk_2', display_name: '김철수', oldSpeakerId: s }],
      voices: [{ speaker_key: 'spk_2', embedding: axis(1), speech_ms: 5_000 }],
      model: MODEL,
      oldLinks: oldLinks as never,
      attendeeIds: []
    })
    const rows = db.prepare('SELECT speaker_key, embedding FROM member_voice_samples WHERE member_id = ?').all(kim) as {
      speaker_key: string
      embedding: Uint8Array
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].speaker_key).toBe('spk_2')
    // 옛 centroid 유지
    expect(Array.from(decodeEmbedding(rows[0].embedding) as Float32Array)).toEqual(Array.from(axis(0)))
    // 이후 이름을 지우면 현재 키로 지워진다
    setName(s2, null)
    expect(sampleCount(kim)).toBe(0)
  })

  it('applyMeetingVoicesSafe: 목소리 단계가 실패하면 그 단계만 되돌리고 바깥 트랜잭션은 계속', () => {
    const m = seedMeeting()
    const a = seedSpeaker(m, 'spk_0')
    const tx = db.transaction(() => {
      const r = applyMeetingVoicesSafe(db, {
        meetingId: m,
        speakers: [
          { id: a, speaker_key: 'spk_0', display_name: null, oldSpeakerId: null },
          // 없는 화자 id → FK 위반으로 실패
          { id: 999_999, speaker_key: 'spk_1', display_name: null, oldSpeakerId: null }
        ],
        voices: [
          { speaker_key: 'spk_0', embedding: axis(0), speech_ms: 30_000 },
          { speaker_key: 'spk_1', embedding: axis(1), speech_ms: 30_000 }
        ],
        model: MODEL,
        oldLinks: new Map(),
        attendeeIds: []
      })
      db.prepare("UPDATE meetings SET title = '계속됨' WHERE id = ?").run(m)
      return r
    })
    const r = tx()
    expect(r.error).toBeTruthy()
    expect(r).toMatchObject({ auto: 0, suggested: 0 })
    expect((db.prepare('SELECT COUNT(*) AS n FROM meeting_speaker_voices').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT title FROM meetings WHERE id = ?').get(m) as { title: string }).title).toBe('계속됨')
  })
})
