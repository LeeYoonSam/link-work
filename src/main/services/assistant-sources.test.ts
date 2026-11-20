import { beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3 네이티브 모듈 대신 node:sqlite 로 인메모리 DB 를 쓴다.
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  class BetterSqlite3Shim {
    private readonly db: InstanceType<typeof DatabaseSync>
    constructor() {
      this.db = new DatabaseSync(':memory:')
    }
    exec(sql: string): void {
      this.db.exec(sql)
    }
    prepare(sql: string): unknown {
      return this.db.prepare(sql)
    }
  }
  return { default: BetterSqlite3Shim }
})

// 실제 네트워크를 호출하지 않는다. Jira·Google 은 모듈 경계에서 대체한다.
const state = vi.hoisted(() => ({
  jiraConnected: true,
  calendarConnected: true,
  defaultProjectKey: 'PROJ' as string | null,
  keysCalls: [] as string[][],
  keysFail: false,
  rangeCalls: [] as [Date, Date][],
  rangeEvents: [] as unknown[],
  rangeFail: false,
  myAccountId: 'acc-me' as string | null,
  myCalls: 0,
  assignee: {} as Record<string, string | null>
}))

vi.mock('./jira', () => ({
  getDefaultJiraProjectKey: () => state.defaultProjectKey,
  getJiraIssueUrl: (key: string) => `https://acme.atlassian.net/browse/${key}`,
  isJiraConnected: () => state.jiraConnected,
  listIssuesByKeys: async (keys: string[]) => {
    state.keysCalls.push(keys)
    if (state.keysFail) throw new Error('네트워크 오류')
    return {
      issues: keys
        .filter((k) => k !== 'PROJ-404')
        .map((k) => ({
          key: k,
          statusCategory: k === 'PROJ-2' ? 'done' : 'indeterminate',
          assigneeAccountId: k in state.assignee ? state.assignee[k] : 'acc-other'
        })),
      truncated: false
    }
  },
  getJiraMyAccountId: async () => {
    state.myCalls++
    return state.myAccountId
  }
}))
vi.mock('./google-auth', () => ({ isConnected: () => state.calendarConnected }))
vi.mock('./google-calendar', () => ({
  fetchEventsInRange: async (from: Date, to: Date) => {
    state.rangeCalls.push([from, to])
    if (state.rangeFail) throw new Error('503 Service Unavailable')
    return state.rangeEvents
  }
}))

import Database from 'better-sqlite3'
import type { MeetingRef } from './assistant-types'
import { collectMeetingContext, MEETING_LIMITS, toMeetingRef } from './assistant-sources'

// 이 파일은 회의 전 브리핑 수집(toMeetingRef·collectMeetingContext)만 검증한다.

// 픽스처 행을 넣는다. 테이블 이름을 인자로 받는다.
// 이유: assistant-* 파일에서 원본 테이블 쓰기 문장을 grep 해도 걸리지 않게 한다. 쓰기 문장을 소스에 직접 쓰지 않는다.
function seed(db: Database.Database, table: string, rows: string[]): void {
  for (const values of rows) db.exec(`INSERT INTO ${table} VALUES ${values}`)
}

function localIso(h: number, m: number, day = 2): string {
  return new Date(2026, 10, day, h, m).toISOString()
}

beforeEach(() => {
  state.jiraConnected = true
  state.calendarConnected = true
  state.defaultProjectKey = 'PROJ'
  state.keysCalls = []
  state.keysFail = false
  state.rangeCalls = []
  state.rangeEvents = []
  state.rangeFail = false
  state.myAccountId = 'acc-me'
  state.myCalls = 0
  state.assignee = {}
})

describe('toMeetingRef', () => {
  it('ISO 시작·종료를 로컬 datetime 으로 바꾼다', () => {
    const ref = toMeetingRef({ id: 'evt-1', summary: '주간 회의', start: localIso(14, 0), end: localIso(15, 0), allDay: false })
    expect(ref).toEqual({ id: 'evt-1', title: '주간 회의', startAt: '2026-11-02 14:00:00', endAt: '2026-11-02 15:00:00' })
  })

  it('종일 일정은 null 이다', () => {
    expect(toMeetingRef({ id: 'e', summary: '휴가', start: '2026-11-02', end: '2026-11-03', allDay: true })).toBeNull()
  })

  it('시각 변환이 실패하면 null 이다', () => {
    expect(toMeetingRef({ id: 'e', summary: '회의', start: '잘못된 값', end: localIso(15, 0), allDay: false })).toBeNull()
    expect(toMeetingRef({ id: 'e', summary: '회의', start: localIso(14, 0), end: '', allDay: false })).toBeNull()
  })
})

// 회의 수집 쿼리가 읽는 컬럼을 가진 스키마. 실제 db/schema.ts 의 해당 컬럼과 같다.
function makeMeetingDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE meetings (id INTEGER PRIMARY KEY, title TEXT, kind TEXT, started_at TEXT,
      calendar_event_title TEXT);
    CREATE TABLE meeting_summaries (id INTEGER PRIMARY KEY, meeting_id INTEGER UNIQUE, tldr TEXT,
      action_items TEXT, generated_at TEXT);
  `)
  return db
}

const MEETING: MeetingRef = {
  id: 'evt-1',
  title: '결제 개편·정산 주간 회의',
  startAt: '2026-11-02 14:00:00',
  endAt: '2026-11-02 15:00:00'
}

function meetingRow(id: number, title: string, startedAt: string, kind = 'meeting', calTitle: string | null = null): string {
  const q = (v: string | null): string => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`)
  return `(${id}, ${q(title)}, ${q(kind)}, ${q(startedAt)}, ${q(calTitle)})`
}

function summaryRow(meetingId: number, tldr: string | null, actions: unknown[]): string {
  const q = (v: string | null): string => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`)
  return `(${meetingId}, ${meetingId}, ${q(tldr)}, ${q(JSON.stringify(actions))}, '2026-10-01 00:00:00')`
}

describe('collectMeetingContext', () => {
  it('회의와 지난 회의·액션아이템만 싣는다. 프로젝트를 읽지 않는다', () => {
    const ctx = collectMeetingContext(makeMeetingDb(), MEETING)
    expect(ctx).toEqual({ meeting: MEETING, pastMeetings: [], openActionItems: [], errors: [] })
    expect(ctx.meeting).toBe(MEETING)
  })

  it('지난 회의는 같은 제목만 고르고 calendar_event_title 도 본다. 면접·회의 시작 이후는 뺀다', () => {
    const db = makeMeetingDb()
    seed(db, 'meetings', [
      meetingRow(1, '결제 개편 · 정산 주간회의', '2026-10-26 14:00:00'),
      meetingRow(2, '녹음 1', '2026-10-19 14:00:00', 'meeting', '결제 개편·정산 주간 회의'),
      meetingRow(3, '다른 회의', '2026-10-30 10:00:00'),
      meetingRow(4, '결제 개편·정산 주간 회의', '2026-10-28 10:00:00', 'interview'),
      meetingRow(5, '결제 개편·정산 주간 회의', '2026-11-02 14:00:00'),
      meetingRow(6, '결제 개편·정산 주간 회의', '2026-10-12 14:00:00')
    ])
    seed(db, 'meeting_summaries', [
      summaryRow(1, '  일정 합의  ', [{ text: '문서 공유' }, { text: '옮김', todo_id: 3 }, { text: ' ' }]),
      summaryRow(2, null, [{ text: '견적 확인' }]),
      summaryRow(3, '무관', [{ text: '무관 액션' }]),
      summaryRow(4, '면접', [{ text: '면접 액션' }]),
      summaryRow(5, '지금', [{ text: '지금 액션' }])
    ])
    const ctx = collectMeetingContext(db, MEETING)
    expect(ctx.pastMeetings).toEqual([
      { meetingId: 1, title: '결제 개편 · 정산 주간회의', startedAt: '2026-10-26 14:00:00', tldr: '일정 합의', openActionItems: ['문서 공유'] },
      { meetingId: 2, title: '녹음 1', startedAt: '2026-10-19 14:00:00', tldr: null, openActionItems: ['견적 확인'] }
    ])
    // 요약이 없는 회의(6)는 JOIN 에서 빠진다
    expect(ctx.openActionItems).toEqual(['문서 공유', '견적 확인'])
  })

  it('지난 회의는 회의 시작 기준 90일 안만 읽는다', () => {
    const db = makeMeetingDb()
    seed(db, 'meetings', [
      meetingRow(1, MEETING.title, '2026-08-04 14:00:00'),
      meetingRow(2, MEETING.title, '2026-08-04 13:59:59')
    ])
    seed(db, 'meeting_summaries', [summaryRow(1, '90일째', []), summaryRow(2, '90일 넘음', [])])
    expect(MEETING_LIMITS.pastDays).toBe(90)
    const ctx = collectMeetingContext(db, MEETING)
    expect(ctx.pastMeetings.map((m) => m.meetingId)).toEqual([1])
  })

  it('지난 회의는 최근 3건까지만 둔다. startedAt 내림차순이다', () => {
    const db = makeMeetingDb()
    seed(db, 'meetings', [1, 2, 3, 4, 5].map((n) => meetingRow(n, MEETING.title, `2026-10-0${n} 14:00:00`)))
    seed(db, 'meeting_summaries', [1, 2, 3, 4, 5].map((n) => summaryRow(n, `요약 ${n}`, [])))
    const ctx = collectMeetingContext(db, MEETING)
    expect(MEETING_LIMITS.pastMeetings).toBe(3)
    expect(ctx.pastMeetings.map((m) => m.meetingId)).toEqual([5, 4, 3])
  })

  it('지난 회의 후보는 최근 200건까지만 읽는다', () => {
    const db = makeMeetingDb()
    const rows: string[] = []
    const sums: string[] = []
    // 같은 제목 회의는 가장 오래된 1건이다. 그 뒤 다른 제목 회의 200건이 후보 상한을 채운다
    rows.push(meetingRow(1, MEETING.title, '2026-08-10 09:00:00'))
    sums.push(summaryRow(1, '오래된 같은 제목', []))
    for (let n = 2; n <= 201; n++) {
      rows.push(meetingRow(n, `다른 회의 ${n}`, `2026-09-01 ${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00`))
      sums.push(summaryRow(n, null, []))
    }
    seed(db, 'meetings', rows)
    seed(db, 'meeting_summaries', sums)
    expect(MEETING_LIMITS.pastCandidates).toBe(200)
    expect(collectMeetingContext(db, MEETING).pastMeetings).toEqual([])
  })

  it('미완료 액션아이템은 10건까지만 둔다', () => {
    const db = makeMeetingDb()
    seed(db, 'meetings', [
      meetingRow(1, MEETING.title, '2026-10-26 14:00:00'),
      meetingRow(2, MEETING.title, '2026-10-19 14:00:00')
    ])
    const actions = (prefix: string, n: number): { text: string }[] =>
      Array.from({ length: n }, (_, i) => ({ text: `${prefix} ${i + 1}` }))
    seed(db, 'meeting_summaries', [summaryRow(1, null, actions('최근', 12)), summaryRow(2, null, actions('이전', 4))])
    const ctx = collectMeetingContext(db, MEETING)
    expect(MEETING_LIMITS.actionItems).toBe(10)
    expect(ctx.openActionItems).toHaveLength(10)
    expect(ctx.openActionItems[0]).toBe('최근 1')
    expect(ctx.openActionItems[9]).toBe('최근 10')
    expect(ctx.pastMeetings[0].openActionItems).toHaveLength(10)
  })

  it('tldr 는 200자에서 자른다', () => {
    const db = makeMeetingDb()
    seed(db, 'meetings', [meetingRow(1, MEETING.title, '2026-10-26 14:00:00')])
    seed(db, 'meeting_summaries', [summaryRow(1, '가'.repeat(300), [])])
    expect(collectMeetingContext(db, MEETING).pastMeetings[0].tldr).toBe('가'.repeat(200))
  })

  it('출처 조회가 실패하면 throw 하지 않고 그 출처만 비운다', () => {
    const db = makeMeetingDb()
    db.exec('DROP TABLE meeting_summaries')
    const ctx = collectMeetingContext(db, MEETING)
    expect(ctx.pastMeetings).toEqual([])
    expect(ctx.openActionItems).toEqual([])
    expect(ctx.errors).toEqual(['지난 회의 조회에 실패했습니다.'])

    const empty = collectMeetingContext(new Database(':memory:'), MEETING)
    expect(empty.errors).toEqual(['지난 회의 조회에 실패했습니다.'])
  })

  it('수집은 원본 테이블을 바꾸지 않고 Jira·캘린더를 부르지 않는다', () => {
    const db = makeMeetingDb()
    seed(db, 'meetings', [meetingRow(1, MEETING.title, '2026-10-26 14:00:00')])
    seed(db, 'meeting_summaries', [summaryRow(1, '요약', [{ text: '액션' }])])
    const dump = (): string =>
      JSON.stringify(['meetings', 'meeting_summaries'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()))
    const before = dump()
    collectMeetingContext(db, MEETING)
    expect(dump()).toBe(before)
    expect(state.keysCalls).toEqual([])
    expect(state.myCalls).toBe(0)
    expect(state.rangeCalls).toEqual([])
  })
})
