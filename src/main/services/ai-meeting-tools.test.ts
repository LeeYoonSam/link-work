import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3 → node:sqlite 교체(voiceprint.test.ts 와 같은 방식). initDatabase() 의 실제 스키마로 검증한다.
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

// 도구 핸들러는 읽기 전용 커넥션을 쓴다. 테스트에서는 같은 메모리 DB 를 읽게 한다
vi.mock('../db/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/database')>()
  return { ...actual, getAiReadOnlyDatabase: () => actual.getDatabase() }
})

import type Database from 'better-sqlite3'
import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import {
  EXCERPT_MAX_CHARS,
  QUERY_BUDGET_CHARS,
  meetingToolReserveChars,
  SEARCH_MAX_CHARS,
  buildMeetingTools,
  checkMeetingBudget,
  getMeetingExcerpt,
  recordingLink,
  searchMeetings
} from './ai-meeting-tools'

const NOW = new Date(2026, 10, 26, 12, 0, 0) // 2026-11-26 로컬

let db: Database.Database

beforeEach(() => {
  closeDatabase()
  initDatabase()
  db = getDatabase()
})

afterAll(() => {
  closeDatabase()
})

interface MeetingSeed {
  title?: string
  // 옛 녹음 종류 값. 코드가 더는 보지 않으므로 어떤 값이어도 결과가 같아야 한다.
  kind?: string
  status?: string
  started_at?: string
  project_id?: number | null
  audio_path?: string | null
}

function seedMeeting(m: MeetingSeed = {}): number {
  const r = db
    .prepare(
      `INSERT INTO meetings (title, kind, status, started_at, project_id, audio_path)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      m.title ?? '회의',
      m.kind ?? 'meeting',
      m.status ?? 'summarized',
      m.started_at ?? '2026-11-20 10:00:00',
      m.project_id ?? null,
      m.audio_path ?? null
    )
  return Number(r.lastInsertRowid)
}

function seedSpeaker(meetingId: number, label: string, displayName: string | null = null): number {
  const r = db
    .prepare('INSERT INTO meeting_speakers (meeting_id, speaker_key, label, display_name) VALUES (?, ?, ?, ?)')
    .run(meetingId, label, label, displayName)
  return Number(r.lastInsertRowid)
}

function seedSegment(meetingId: number, startMs: number, text: string, speakerId: number | null = null): void {
  db.prepare(
    'INSERT INTO meeting_segments (meeting_id, start_ms, end_ms, speaker_id, text) VALUES (?, ?, ?, ?, ?)'
  ).run(meetingId, startMs, startMs + 1000, speakerId, text)
}

function seedSummary(meetingId: number, cols: Record<string, string>): void {
  db.prepare(
    `INSERT INTO meeting_summaries (meeting_id, tldr, topics, decisions, action_items, open_questions, keywords)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    meetingId,
    cols.tldr ?? '',
    cols.topics ?? '[]',
    cols.decisions ?? '[]',
    cols.action_items ?? '[]',
    cols.open_questions ?? '[]',
    cols.keywords ?? '[]'
  )
}

function seedProject(name: string): number {
  const r = db
    .prepare(
      `INSERT INTO projects (name, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date)
       VALUES (?, '2026-08-01', '2026-08-20', '2026-08-21', '2026-08-25', '2026-09-01')`
    )
    .run(name)
  return Number(r.lastInsertRowid)
}

const search = (args: Parameters<typeof searchMeetings>[1]): ReturnType<typeof searchMeetings> =>
  searchMeetings(db, args, NOW)

describe('recordingLink', () => {
  it('회의 id 와 ms 로 녹음 시각 링크를 만든다', () => {
    expect(recordingLink(7, 754000)).toBe('linkwork://recording/7/at/754000')
    expect(recordingLink(7, -5)).toBe('linkwork://recording/7/at/0')
    expect(recordingLink(7, 1234.6)).toBe('linkwork://recording/7/at/1235')
  })
})

describe('searchMeetings', () => {
  it('2음절 검색어가 원문 발언에 적중하고 snippet 에 시각·화자·링크·앞뒤 발언을 담는다', () => {
    const id = seedMeeting({ title: '주간 회의' })
    const sp = seedSpeaker(id, '화자 1', '김철수')
    seedSegment(id, 750_000, '앞 발언', sp)
    seedSegment(id, 754_000, '다음 주 배포 일정 확정', sp)
    seedSegment(id, 760_000, '뒤 발언', sp)
    const r = search({ terms: ['배포'] })
    expect(r.meetings).toHaveLength(1)
    const m = r.meetings[0]
    expect(m).toMatchObject({ meeting_id: id, title: '주간 회의', note_link: `linkwork://note/${id}` })
    expect(m.speakers).toEqual(['김철수'])
    expect(m.snippets).toEqual([
      {
        start_ms: 754_000,
        time: '12:34',
        speaker: '김철수',
        text: '앞 발언 다음 주 배포 일정 확정 뒤 발언',
        link: `linkwork://recording/${id}/at/754000`
      }
    ])
  })

  it('맞은 검색어 수·요약 적중·발언 적중 수로 점수를 매겨 정렬하고, 동점이면 최근 회의가 먼저다', () => {
    // A: 2개 검색어 적중(6) + 요약 적중(2) + 발언 1(1) = 9
    const a = seedMeeting({ title: 'A', started_at: '2026-11-01 10:00:00' })
    seedSummary(a, { tldr: '결제 개편 논의' })
    seedSegment(a, 0, '환불 정책')
    // B: 1개(3) + 발언 5개 상한(5) = 8
    const b = seedMeeting({ title: 'B', started_at: '2026-11-20 10:00:00' })
    for (let i = 0; i < 7; i++) seedSegment(b, i * 1000, `결제 ${i}`)
    // C·D: 1개(3) + 발언 1(1) = 4, 동점 → 최근(D) 먼저
    const c = seedMeeting({ title: 'C', started_at: '2026-11-02 10:00:00' })
    seedSegment(c, 0, '환불')
    const d = seedMeeting({ title: 'D', started_at: '2026-11-03 10:00:00' })
    seedSegment(d, 0, '환불')
    const r = search({ terms: ['결제', '환불'] })
    expect(r.meetings.map((m) => m.title)).toEqual(['A', 'B', 'D', 'C'])
  })

  it('기간: 기본은 최근 180일, from·to 는 그날 끝까지 포함한다', () => {
    seedSegment(seedMeeting({ title: '오래됨', started_at: '2026-03-01 10:00:00' }), 0, '배포')
    seedSegment(seedMeeting({ title: '최근', started_at: '2026-11-25 23:59:00' }), 0, '배포')
    expect(search({ terms: ['배포'] }).meetings.map((m) => m.title)).toEqual(['최근'])
    const r = search({ terms: ['배포'], from: '2026-03-01', to: '2026-03-01' })
    expect(r.meetings.map((m) => m.title)).toEqual(['오래됨'])
    expect(r.scope_applied).toMatchObject({ from: '2026-03-01', to: '2026-03-01' })
    expect(search({ terms: ['배포'], from: '2026-11-25', to: '2026-11-25' }).meetings.map((m) => m.title)).toEqual([
      '최근'
    ])
  })

  it('365일을 넘는 기간은 to 기준 365일로 좁히고 알린다', () => {
    seedSegment(seedMeeting({ title: '2년 전', started_at: '2024-12-01 10:00:00' }), 0, '배포')
    const r = search({ terms: ['배포'], from: '2024-01-01', to: '2026-11-26' })
    expect(r.scope_applied.from).toBe('2025-11-26')
    expect(r.meetings).toEqual([])
    expect(r.notice).toBe('기간이 길어 최근 365일로 좁혔습니다.')
    expect(r.hint).toBe('다른 표현·더 넓은 기간으로 다시 검색')
  })

  it('프로젝트로 거른다', () => {
    const p = seedProject('결제')
    seedSegment(seedMeeting({ title: 'P', project_id: p }), 0, '배포')
    seedSegment(seedMeeting({ title: 'X' }), 0, '배포')
    const r = search({ terms: ['배포'], project_id: p })
    expect(r.meetings.map((m) => [m.title, m.project])).toEqual([['P', '결제']])
  })

  it('person 은 화자 이름 또는 참석자 구성원 이름으로 거른다', () => {
    const bySpeaker = seedMeeting({ title: '화자' })
    seedSpeaker(bySpeaker, '화자 1', '이영희')
    seedSegment(bySpeaker, 0, '배포')
    const byAttendee = seedMeeting({ title: '참석자' })
    const member = Number(db.prepare("INSERT INTO meeting_members (name) VALUES ('이영희')").run().lastInsertRowid)
    db.prepare('INSERT INTO meeting_attendees (meeting_id, member_id) VALUES (?, ?)').run(byAttendee, member)
    seedSegment(byAttendee, 0, '배포')
    seedSegment(seedMeeting({ title: '무관' }), 0, '배포')
    const r = search({ terms: ['배포'], person: '영희' })
    expect(r.meetings.map((m) => m.title).sort()).toEqual(['참석자', '화자'])
  })

  it('녹음 종류 값과 무관하게 찾고, 결과·scope_applied 에 종류 필드를 싣지 않는다', () => {
    seedSegment(seedMeeting({ title: '옛 녹음', kind: 'legacy' }), 0, '배포 경험')
    const r = search({ terms: ['배포'] })
    expect(r.meetings.map((m) => m.title)).toEqual(['옛 녹음'])
    expect(r.meetings[0]).not.toHaveProperty('kind')
    expect(Object.keys(r.scope_applied).sort()).toEqual(['from', 'person', 'project_id', 'to'])
  })

  it('전사만 끝난 회의(transcribed)도 찾고, 녹음 중·처리 중 회의는 뺀다', () => {
    seedSegment(seedMeeting({ title: '전사됨', status: 'transcribed' }), 0, '배포')
    seedSegment(seedMeeting({ title: '녹음 중', status: 'recording' }), 0, '배포')
    expect(search({ terms: ['배포'] }).meetings.map((m) => m.title)).toEqual(['전사됨'])
  })

  it('meeting_ids 로 범위를 좁힌다', () => {
    const a = seedMeeting({ title: 'A' })
    seedSegment(a, 0, '배포')
    seedSegment(seedMeeting({ title: 'B' }), 0, '배포')
    expect(search({ terms: ['배포'], meeting_ids: [a] }).meetings.map((m) => m.title)).toEqual(['A'])
  })

  it('LIKE 와일드카드(%, _)를 글자 그대로 찾는다', () => {
    seedSegment(seedMeeting({ title: '퍼센트' }), 0, '달성률 100% 확인')
    seedSegment(seedMeeting({ title: '숫자' }), 0, '1000 확인')
    seedSegment(seedMeeting({ title: '밑줄' }), 0, 'user_id 컬럼')
    seedSegment(seedMeeting({ title: '밑줄 아님' }), 0, 'userxid 컬럼')
    expect(search({ terms: ['0%'] }).meetings.map((m) => m.title)).toEqual(['퍼센트'])
    expect(search({ terms: ['user_id'] }).meetings.map((m) => m.title)).toEqual(['밑줄'])
  })

  it('결과 JSON 이 8,000자를 넘으면 뒤 회의부터 빼고 알린다', () => {
    for (let i = 0; i < 8; i++) {
      const id = seedMeeting({ title: `회의 ${i}`, started_at: `2026-11-${String(10 + i).padStart(2, '0')} 10:00:00` })
      seedSummary(id, { tldr: '배포 '.repeat(200) })
      for (let k = 0; k < 6; k++) seedSegment(id, k * 1000, `배포 ${'가'.repeat(300)}`)
    }
    const r = search({ terms: ['배포'] })
    expect(JSON.stringify(r, null, 1).length).toBeLessThanOrEqual(SEARCH_MAX_CHARS)
    expect(r.meetings.length).toBeGreaterThan(0)
    expect(r.meetings.length).toBeLessThan(8)
    expect(r.notice).toBe('결과가 길어 일부 회의를 뺐습니다.')
    // 남은 것은 최근(점수 동점) 회의들이다
    expect(r.meetings[0].title).toBe('회의 7')
    for (const m of r.meetings) {
      expect(m.tldr.length).toBeLessThanOrEqual(301)
      expect(m.snippets.length).toBeLessThanOrEqual(4)
      for (const s of m.snippets) expect(s.text.length).toBeLessThanOrEqual(241)
    }
  })

  it('결과에 오디오 경로를 담지 않는다', () => {
    const id = seedMeeting({ title: '주간', audio_path: '/Users/x/secret-audio.webm' })
    seedSummary(id, { tldr: '배포 결정' })
    seedSegment(id, 0, '배포')
    const search_ = JSON.stringify(search({ terms: ['배포'] }))
    const excerpt = JSON.stringify(getMeetingExcerpt(db, { meeting_id: id }))
    const transcript = JSON.stringify(getMeetingExcerpt(db, { meeting_id: id, from_ms: 0 }))
    for (const json of [search_, excerpt, transcript]) {
      expect(json).not.toContain('audio_path')
      expect(json).not.toContain('secret-audio')
    }
  })
})

describe('getMeetingExcerpt', () => {
  it('없는 회의·처리 중 회의는 not_found, 옛 종류 값의 회의도 읽는다', () => {
    expect(getMeetingExcerpt(db, { meeting_id: 999 })).toEqual({ error: 'not_found' })
    const rec = seedMeeting({ status: 'recording' })
    expect(getMeetingExcerpt(db, { meeting_id: rec })).toEqual({ error: 'not_found' })
    const old = seedMeeting({ kind: 'legacy' })
    seedSegment(old, 0, '답변')
    const r = getMeetingExcerpt(db, { meeting_id: old })
    expect(r).toMatchObject({ meeting_id: old, mode: 'transcript' })
    expect(r).not.toHaveProperty('kind')
  })

  it('요약 발췌에 옛 4분류(qa_pairs)를 싣지 않는다', () => {
    const id = seedMeeting({ title: '옛 요약' })
    seedSummary(id, { tldr: '개요' })
    db.prepare('UPDATE meeting_summaries SET qa_pairs = ? WHERE meeting_id = ?').run(
      JSON.stringify([{ question: 'q', answer_summary: 'a', start_ms: 0 }]),
      id
    )
    const r = getMeetingExcerpt(db, { meeting_id: id })
    expect(r).toMatchObject({ mode: 'summary', summary: { tldr: '개요' } })
    expect((r as { summary: object }).summary).not.toHaveProperty('qa_pairs')
  })

  it('구간이 없고 요약이 있으면 항목마다 시각·링크를 붙인 요약을 준다', () => {
    const id = seedMeeting({ title: '주간' })
    seedSummary(id, {
      tldr: '결론',
      topics: JSON.stringify([{ title: '결제', start_ms: 754000, points: ['카드부터'] }]),
      decisions: JSON.stringify([{ text: '금요일 배포', at_ms: 95000 }, '구버전 결정']),
      action_items: JSON.stringify([{ text: '견적 요청', assignee: '이영희', due: null, at_ms: 1000, todo_id: 3 }]),
      open_questions: JSON.stringify([{ text: '수수료', at_ms: null }])
    })
    const r = getMeetingExcerpt(db, { meeting_id: id })
    expect(r).toMatchObject({
      mode: 'summary',
      summary: {
        tldr: '결론',
        topics: [
          { text: '결제', at_ms: 754000, time: '12:34', link: `linkwork://recording/${id}/at/754000`, points: ['카드부터'] }
        ],
        decisions: [
          { text: '금요일 배포', at_ms: 95000, time: '01:35', link: `linkwork://recording/${id}/at/95000` },
          { text: '구버전 결정', at_ms: null, time: null, link: null }
        ],
        action_items: [{ text: '견적 요청', assignee: '이영희', due: null, at_ms: 1000, time: '00:01' }],
        open_questions: [{ text: '수수료', at_ms: null, link: null }]
      }
    })
  })

  it('구간이 없고 요약도 없으면 처음 10분 원문을 준다', () => {
    const id = seedMeeting({ status: 'transcribed' })
    const sp = seedSpeaker(id, '화자 1', '김철수')
    seedSegment(id, 5000, '시작합니다', sp)
    seedSegment(id, 599_000, '9분 59초', null)
    seedSegment(id, 600_000, '10분', sp)
    const r = getMeetingExcerpt(db, { meeting_id: id })
    expect(r).toMatchObject({ mode: 'transcript', from_ms: 0, to_ms: 600_000, link: `linkwork://recording/${id}/at/0` })
    expect((r as { text: string }).text).toBe('[00:05 김철수] 시작합니다\n[09:59 화자] 9분 59초')
  })

  it('10분을 넘는 구간은 10분으로 줄이고 알린다', () => {
    const id = seedMeeting()
    seedSegment(id, 60_000, '안')
    seedSegment(id, 700_000, '밖')
    const r = getMeetingExcerpt(db, { meeting_id: id, from_ms: 60_000, to_ms: 1_800_000 }) as {
      to_ms: number
      text: string
      notice?: string
    }
    expect(r.to_ms).toBe(660_000)
    expect(r.text).toBe('[01:00 화자] 안')
    expect(r.notice).toContain('10분')
  })

  it('원문이 12,000자를 넘으면 줄 단위로 자르고 이어 볼 from_ms 를 알린다', () => {
    const id = seedMeeting()
    for (let i = 0; i < 60; i++) seedSegment(id, i * 5000, '가'.repeat(400))
    const r = getMeetingExcerpt(db, { meeting_id: id, from_ms: 0, to_ms: 600_000 }) as { text: string; notice?: string }
    expect(r.text.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS)
    const shown = r.text.split('\n').length
    expect(shown).toBeLessThan(60)
    expect(r.notice).toContain(`from_ms=${shown * 5000}`)
  })
})

describe('질의 단위 예산', () => {
  it('누적이 예산을 넘으면 budget_exceeded 를 돌려준다', () => {
    expect(checkMeetingBudget(QUERY_BUDGET_CHARS)).toBeNull()
    expect(checkMeetingBudget(QUERY_BUDGET_CHARS + 1)).toEqual({
      error: 'budget_exceeded',
      hint: '지금까지 찾은 근거로 답하라'
    })
  })

  it('이번 호출의 예약분까지 더해 판정하고, 도구별 예약 상한은 결과 상한과 같다', () => {
    expect(meetingToolReserveChars('mcp__linkwork__search_meetings')).toBe(SEARCH_MAX_CHARS)
    expect(meetingToolReserveChars('mcp__linkwork__get_meeting_excerpt')).toBe(EXCERPT_MAX_CHARS)
    expect(checkMeetingBudget(QUERY_BUDGET_CHARS - EXCERPT_MAX_CHARS, EXCERPT_MAX_CHARS)).toBeNull()
    expect(checkMeetingBudget(QUERY_BUDGET_CHARS - EXCERPT_MAX_CHARS + 1, EXCERPT_MAX_CHARS)).not.toBeNull()
  })
})

describe('buildMeetingTools', () => {
  type Def = { name: string; handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }
  const fakeTool = ((name: string, _d: string, _s: unknown, handler: unknown) => ({ name, handler })) as never

  it('search_meetings·get_meeting_excerpt 2종을 만들고 핸들러는 JSON 결과를 준다', async () => {
    const tools = buildMeetingTools(fakeTool) as unknown as Def[]
    expect(tools.map((t) => t.name)).toEqual(['search_meetings', 'get_meeting_excerpt'])
    const id = seedMeeting({ started_at: '2026-11-25 10:00:00' })
    seedSegment(id, 0, '배포')
    const excerpt = await tools[1].handler({ meeting_id: id, from_ms: 0 })
    expect(JSON.parse(excerpt.content[0].text)).toMatchObject({ meeting_id: id, text: '[00:00 화자] 배포' })
  })
})
