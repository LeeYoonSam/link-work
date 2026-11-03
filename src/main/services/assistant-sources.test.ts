import { beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3 네이티브 모듈 대신 node:sqlite 로 인메모리 DB 를 쓴다 (project-sync.test.ts 관례).
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
  openCalls: [] as (string | null)[],
  openFail: false,
  keysCalls: [] as string[][],
  keysFail: false,
  rangeCalls: [] as [Date, Date][],
  rangeEvents: [] as unknown[],
  rangeFail: false,
  myAccountId: 'acc-me' as string | null,
  myCalls: 0,
  assignee: {} as Record<string, string | null>,
  recentCalls: [] as [number, string | null][],
  recentFail: false,
  recentIssues: [] as unknown[],
  recentTruncated: false
}))

vi.mock('./jira', () => ({
  getDefaultJiraProjectKey: () => state.defaultProjectKey,
  getJiraIssueUrl: (key: string) => `https://acme.atlassian.net/browse/${key}`,
  isJiraConnected: () => state.jiraConnected,
  listMyOpenIssues: async (projectKey: string | null) => {
    state.openCalls.push(projectKey)
    if (state.openFail) throw new Error('네트워크 오류')
    return {
      issues: [
        {
          key: 'PROJ-1',
          summary: 'Jira 이슈',
          status: 'Open',
          statusCategory: 'new',
          priority: 'High',
          duedate: '2026-11-03',
          updated: '2026-11-02T10:00:00.000+0900',
          issueType: 'Task'
        }
      ],
      truncated: projectKey === null
    }
  },
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
  listMyRecentlyUpdatedIssues: async (days: number, projectKey: string | null) => {
    state.recentCalls.push([days, projectKey])
    if (state.recentFail) throw new Error('401 Unauthorized')
    return { issues: state.recentIssues, truncated: state.recentTruncated }
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
import { DEFAULT_ASSISTANT_SETTINGS } from './assistant-settings'
import { toLocalDateTime } from './assistant-day'
import { RECOVERY_LIMITS } from './assistant-recovery'
import type { Candidate, MeetingRef, PlanItem, RecoveryContext } from './assistant-types'
import {
  clearJiraCache,
  collectMeetingContext,
  collectRecovery,
  collectSources,
  getSourceCheckTimes,
  resetSourceCheckTimes,
  readRecoveryLocal,
  MEETING_LIMITS,
  resolveVanished,
  toCalendarRef,
  toMeetingRef
} from './assistant-sources'

// 로컬 시각 기준. 테스트는 실행 기기의 시간대와 무관하게 동작한다.
const NOW = new Date(2026, 10, 2, 9, 40)
const TODAY = '2026-11-02'
// assistant-sources.ts 의 CALENDAR_FAILED 앞부분. 상수를 export 하지 않으므로 문구로 확인한다.
const CALENDAR_FAILED_PREFIX = 'Google 캘린더 조회에 실패해'

// 픽스처 행을 넣는다. 테이블 이름을 인자로 받는다.
// 이유: MVP1 조건 12 의 A2 grep 이 테스트 파일도 검사한다. 원본 테이블 쓰기 문장을 소스에 직접 쓰지 않는다.
function seed(db: Database.Database, table: string, rows: string[]): void {
  for (const values of rows) db.exec(`INSERT INTO ${table} VALUES ${values}`)
}

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, dev_start_date TEXT, dev_end_date TEXT,
      qa_start_date TEXT, qa_end_date TEXT, deploy_date TEXT, status TEXT, status_manual INTEGER, priority TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, status TEXT, end_date TEXT,
      jira_issue_key TEXT);
    CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT, priority TEXT, due_date TEXT, is_completed INTEGER,
      updated_at TEXT);
    CREATE TABLE meetings (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE meeting_summaries (id INTEGER PRIMARY KEY, meeting_id INTEGER UNIQUE, action_items TEXT,
      generated_at TEXT);
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY, entity_type TEXT, entity_id INTEGER, created_at TEXT);
  `)
  seed(db, 'projects', [
    `(1, '활성', '2026-10-01', '2026-12-01', '2026-12-02', '2026-12-04', '2026-12-05', 'development', 1, 'now')`,
    `(2, '중단', '2026-10-01', '2026-12-01', '2026-12-02', '2026-12-04', '2026-12-05', 'on_hold', 1, 'next')`,
    `(3, '자동 완료', '2026-01-01', '2026-01-10', '2026-01-11', '2026-01-13', '2026-01-14', 'development', 0, NULL)`
  ])
  seed(db, 'tasks', [
    `(10, 1, '진행 작업', 'in_progress', '2026-11-05', NULL)`,
    `(11, 1, '완료 작업', 'done', NULL, NULL)`,
    `(12, 2, '중단 프로젝트 작업', 'pending', NULL, NULL)`,
    `(13, 3, '지난 프로젝트 작업', 'pending', NULL, NULL)`
  ])
  seed(db, 'todos', [
    `(5, '할 일', 'high', '2026-11-02 15:00', 0, '2026-11-01 10:00:00')`,
    `(6, '끝난 할 일', 'low', NULL, 1, NULL)`
  ])
  seed(db, 'meetings', [
    `(7, '주간 회의')`,
    `(8, '오래된 회의')`
  ])
  seed(db, 'meeting_summaries', [
    `(1, 7,
      '[{"text":"액션 0"},{"text":"옮긴 항목","todo_id":5},{"text":"  "},{"text":"액션 3","due":"2026-11-04"}]',
      '2026-10-20 10:00:00')`,
    `(2, 8, '[{"text":"15일 전 액션"}]', '2026-10-18 09:00:00')`
  ])
  seed(db, 'activity_log', [
    `(1, 'task', 10, '2026-11-01 01:00:00')`,
    `(2, 'task', 10, '2026-11-01 02:00:00')`,
    `(3, 'task', 12, '2026-11-01 03:00:00')`,
    `(4, 'todo', 10, '2026-11-01 04:00:00')`
  ])
  return db
}

function ids(cands: Candidate[]): string[] {
  return cands.map((c) => c.id)
}

function localIso(h: number, m: number, day = 2): string {
  return new Date(2026, 10, day, h, m).toISOString()
}

beforeEach(() => {
  clearJiraCache()
  resetSourceCheckTimes()
  state.jiraConnected = true
  state.calendarConnected = true
  state.defaultProjectKey = 'PROJ'
  state.openCalls = []
  state.openFail = false
  state.keysCalls = []
  state.keysFail = false
  state.rangeCalls = []
  state.rangeEvents = []
  state.rangeFail = false
  state.myAccountId = 'acc-me'
  state.myCalls = 0
  state.assignee = {}
  state.recentCalls = []
  state.recentFail = false
  state.recentIssues = []
  state.recentTruncated = false
})

describe('collectSources 로컬 출처', () => {
  it('미완료 작업 중 활성 프로젝트 소속만 후보로 넣는다', async () => {
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'local', NOW)
    const list = ids(r.candidates)
    expect(list).toContain('task:10')
    expect(list).not.toContain('task:11')
    expect(list).not.toContain('task:12')
    expect(list).not.toContain('task:13')
    const task = r.candidates.find((c) => c.id === 'task:10')
    expect(task?.projectName).toBe('활성')
    expect(task?.priority).toBe('high')
  })

  it('미완료 todo 만 후보로 넣는다', async () => {
    const list = ids((await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'local', NOW)).candidates)
    expect(list).toContain('todo:5')
    expect(list).not.toContain('todo:6')
  })

  it('액션아이템은 todo_id 없는 항목과 14일 이내 요약만 넣고 index 는 배열 위치다', async () => {
    const list = ids((await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'local', NOW)).candidates)
    expect(list).toContain('action_item:7:0')
    expect(list).toContain('action_item:7:3')
    expect(list).not.toContain('action_item:7:1')
    expect(list).not.toContain('action_item:7:2')
    expect(list).not.toContain('action_item:8:0')
  })

  it('A12: 작업 최근 변경 시각은 activity_log 의 UTC 값을 로컬 datetime 으로 바꾼 값이다', async () => {
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'local', NOW)
    const expected = toLocalDateTime(new Date(Date.UTC(2026, 10, 1, 2, 0, 0)))
    expect(r.candidates.find((c) => c.id === 'task:10')?.lastTouchedAt).toBe(expected)
    expect(expected).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('A2: 수집은 원본 테이블을 바꾸지 않는다', async () => {
    const db = makeDb()
    const dump = (): string =>
      JSON.stringify(
        ['projects', 'tasks', 'todos', 'meetings', 'meeting_summaries', 'activity_log'].map((t) =>
          db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()
        )
      )
    const before = dump()
    const r = await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    await resolveVanished(db, ['task:11', 'todo:6', 'action_item:7:1', 'jira:PROJ-2'], r.candidates)
    expect(dump()).toBe(before)
  })
})

describe('collectSources 캘린더', () => {
  it('full 모드는 오늘 일정을 HH:mm 으로 바꾸고 종일 일정은 busy 에서 뺀다', async () => {
    state.rangeEvents = [
      { id: 'e1', summary: '회의', start: localIso(14, 0), end: localIso(15, 0), allDay: false },
      { id: 'e2', summary: '종일', start: TODAY, end: '2026-11-03', allDay: true }
    ]
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    expect(r.calendar).toEqual([
      { id: 'e1', title: '회의', start: '14:00', end: '15:00', allDay: false },
      { id: 'e2', title: '종일', start: '00:00', end: '23:59', allDay: true }
    ])
    expect(r.busy).toEqual([{ start: '14:00', end: '15:00' }])
    expect(r.calendarConnected).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('날짜 경계 전(00:00~04:00)에는 논리 날짜인 전날 일정을 본다', async () => {
    state.rangeEvents = [
      { id: 'late', summary: '어제 늦은 회의', start: localIso(22, 0, 1), end: localIso(23, 0, 1), allDay: false }
    ]
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', new Date(2026, 10, 2, 1, 30))
    expect(r.calendar).toEqual([{ id: 'late', title: '어제 늦은 회의', start: '22:00', end: '23:00', allDay: false }])
    expect(state.rangeCalls).toHaveLength(1)
    const [from, to] = state.rangeCalls[0]
    expect(toLocalDateTime(from)).toBe('2026-11-01 00:00:00')
    expect(toLocalDateTime(to)).toBe('2026-11-01 23:59:59')
  })

  it('날짜 경계가 지나면 오늘 일정을 본다', async () => {
    state.rangeEvents = [{ id: 'today', summary: '오늘 회의', start: localIso(10, 0), end: localIso(11, 0), allDay: false }]
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', new Date(2026, 10, 2, 4, 0))
    expect(r.calendar?.map((c) => c.id)).toEqual(['today'])
    expect(state.rangeCalls).toHaveLength(1)
    const [from, to] = state.rangeCalls[0]
    expect(toLocalDateTime(from)).toBe('2026-11-02 00:00:00')
    expect(toLocalDateTime(to)).toBe('2026-11-02 23:59:59')
  })

  it('§8.2: 낮 시간에 캘린더 조회가 실패하면 calendar 는 null 이고 errors 에 CALENDAR_FAILED 문구가 있다', async () => {
    state.rangeFail = true
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    expect(state.rangeCalls).toHaveLength(1)
    expect(toLocalDateTime(state.rangeCalls[0][0])).toBe('2026-11-02 00:00:00')
    expect(r.calendar).toBeNull()
    expect(r.busy).toEqual([])
    expect(r.calendarConnected).toBe(true)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].startsWith(CALENDAR_FAILED_PREFIX)).toBe(true)
    expect(r.errors[0]).toContain('503')
  })

  it('§8.2: 날짜 경계 전(02:00)에 캘린더 조회가 실패하면 calendar 는 null 이고 errors 에 CALENDAR_FAILED 문구가 있다', async () => {
    state.rangeFail = true
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', new Date(2026, 10, 2, 2, 0))
    expect(state.rangeCalls).toHaveLength(1)
    expect(toLocalDateTime(state.rangeCalls[0][0])).toBe('2026-11-01 00:00:00')
    expect(r.calendar).toBeNull()
    expect(r.busy).toEqual([])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].startsWith(CALENDAR_FAILED_PREFIX)).toBe(true)
  })

  it('조회에 성공한 일정 0건은 실패가 아니다. calendar 는 빈 배열이고 errors 는 비어 있다', async () => {
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    expect(r.calendar).toEqual([])
    expect(r.errors).toEqual([])
  })

  it('local 모드는 캘린더를 보지 않는다', async () => {
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'local', NOW)
    expect(r.calendar).toBeNull()
    expect(r.busy).toEqual([])
  })

  it('캘린더가 연결되어 있지 않으면 calendar 는 null 이고 errors 에 문구가 있다', async () => {
    state.calendarConnected = false
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    expect(r.calendar).toBeNull()
    expect(r.calendarConnected).toBe(false)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('캘린더')
  })

  it('A12: 하루 경계를 넘는 일정은 오늘 범위로 자르고 오늘 밖 일정은 뺀다', () => {
    const cross = { id: 'x', summary: 's', start: localIso(23, 0, 1), end: localIso(1, 0), allDay: false }
    expect(toCalendarRef(cross, TODAY)).toEqual({ id: 'x', title: 's', start: '00:00', end: '01:00', allDay: false })
    const late = { id: 'y', summary: 's', start: localIso(23, 0), end: localIso(1, 0, 3), allDay: false }
    expect(toCalendarRef(late, TODAY)?.end).toBe('23:59')
    const tomorrow = { id: 'z', summary: 's', start: localIso(1, 0, 3), end: localIso(2, 0, 3), allDay: false }
    expect(toCalendarRef(tomorrow, TODAY)).toBeNull()
  })
})

describe('collectSources Jira', () => {
  it('A12: Jira 이슈를 후보와 스냅샷으로 넣고 updated 는 로컬 datetime 이다', async () => {
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    expect(ids(r.candidates)).toContain('jira:PROJ-1')
    const expected = toLocalDateTime(new Date(Date.UTC(2026, 10, 2, 1, 0, 0)))
    expect(r.jira).toEqual([
      { key: 'PROJ-1', status: 'Open', priority: 'High', duedate: '2026-11-03', updated: expected }
    ])
    expect(r.candidates.find((c) => c.id === 'jira:PROJ-1')?.link).toBe(
      'https://acme.atlassian.net/browse/PROJ-1'
    )
    expect(r.jiraTruncated).toBe(true)
    expect(r.jiraConnected).toBe(true)
  })

  it('jiraScope 가 default_project 면 기본 프로젝트 키로 조회한다', async () => {
    const settings = { ...DEFAULT_ASSISTANT_SETTINGS, jiraScope: 'default_project' as const }
    const r = await collectSources(makeDb(), settings, 'full', NOW)
    expect(state.openCalls).toEqual(['PROJ'])
    expect(r.jiraTruncated).toBe(false)
  })

  it('full 모드는 마지막 호출 후 1분 안이면 캐시를 쓰고 1분이 지나면 다시 호출한다', async () => {
    const db = makeDb()
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'full', new Date(NOW.getTime() + 30_000))
    expect(state.openCalls).toHaveLength(1)
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'full', new Date(NOW.getTime() + 61_000))
    expect(state.openCalls).toHaveLength(2)
  })

  it('local 모드는 네트워크를 쓰지 않고 캐시가 있으면 캐시를 쓴다', async () => {
    const db = makeDb()
    const empty = await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'local', NOW)
    expect(empty.jira).toBeNull()
    expect(ids(empty.candidates)).not.toContain('jira:PROJ-1')

    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    const cached = await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'local', new Date(NOW.getTime() + 600_000))
    expect(state.openCalls).toHaveLength(1)
    expect(cached.jira).toHaveLength(1)
    expect(ids(cached.candidates)).toContain('jira:PROJ-1')
  })

  it('조회 범위가 바뀌면 이전 캐시를 쓰지 않는다', async () => {
    const db = makeDb()
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    const settings = { ...DEFAULT_ASSISTANT_SETTINGS, jiraScope: 'default_project' as const }
    expect((await collectSources(db, settings, 'local', NOW)).jira).toBeNull()
  })

  it('Jira 가 연결되어 있지 않으면 호출하지 않고 jira 는 null 이다', async () => {
    state.jiraConnected = false
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    expect(r.jira).toBeNull()
    expect(r.jiraConnected).toBe(false)
    expect(state.openCalls).toEqual([])
    expect(r.errors).toEqual([])
  })

  it('Jira 조회가 실패하면 throw 하지 않고 jira 는 null 이며 errors 에 문구가 있다', async () => {
    state.openFail = true
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    expect(r.jira).toBeNull()
    expect(r.errors).toEqual(['Jira 조회에 실패했습니다. 네트워크 오류'])
    expect(ids(r.candidates)).toContain('task:10')
  })
})

describe('collectSources mode 확장 (부록 E.2.6)', () => {
  const meeting = { id: 'e1', summary: '회의', start: localIso(14, 0), end: localIso(15, 0), allDay: false }

  it("'calendar' 모드는 캘린더를 조회하고 Jira 는 호출하지 않는다. 캐시가 없으면 jira 는 null 이다", async () => {
    state.rangeEvents = [meeting]
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'calendar', NOW)
    expect(state.rangeCalls).toHaveLength(1)
    expect(r.calendar?.map((c) => c.id)).toEqual(['e1'])
    expect(state.openCalls).toEqual([])
    // 위험 11: Jira 항목이 사라진 것으로 보이지 않는다. 스냅샷 jira 유지는 §8.2 규칙이 맡는다
    expect(r.jira).toBeNull()
    expect(ids(r.candidates)).not.toContain('jira:PROJ-1')
    expect(r.errors).toEqual([])
  })

  it("'calendar' 모드는 Jira 캐시가 60초를 넘었어도 호출하지 않고 캐시를 쓴다", async () => {
    const db = makeDb()
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    const r = await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'calendar', new Date(NOW.getTime() + 600_000))
    expect(state.openCalls).toHaveLength(1)
    expect(r.jira).toHaveLength(1)
    expect(ids(r.candidates)).toContain('jira:PROJ-1')
  })

  it("'jira' 모드는 캘린더를 조회하지 않고 calendar 는 null 이다. 미연결 문구도 넣지 않는다", async () => {
    state.calendarConnected = false
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'jira', NOW)
    expect(state.rangeCalls).toEqual([])
    expect(r.calendar).toBeNull()
    expect(r.busy).toEqual([])
    expect(r.errors).toEqual([])
    expect(state.openCalls).toHaveLength(1)
    expect(r.jira).toHaveLength(1)
  })

  it("'jira' 모드는 60초 안이면 캐시를 쓰고 60초가 지나면 다시 호출한다", async () => {
    const db = makeDb()
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'jira', NOW)
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'jira', new Date(NOW.getTime() + 30_000))
    expect(state.openCalls).toHaveLength(1)
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'jira', new Date(NOW.getTime() + 61_000))
    expect(state.openCalls).toHaveLength(2)
  })
})

describe('출처별 오류 (부록 E.2.6 갱신분)', () => {
  it('캘린더 오류와 Jira 오류를 따로 담고 errors 는 캘린더 다음 Jira 순서로 합친다', async () => {
    state.rangeFail = true
    state.openFail = true
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    expect(r.calendarErrors).toHaveLength(1)
    expect(r.calendarErrors[0].startsWith(CALENDAR_FAILED_PREFIX)).toBe(true)
    expect(r.jiraErrors).toEqual(['Jira 조회에 실패했습니다. 네트워크 오류'])
    expect(r.errors).toEqual([...r.calendarErrors, ...r.jiraErrors])
  })

  it("'jira' 모드는 캘린더 오류를 만들지 않고 'calendar' 모드는 Jira 오류를 만들지 않는다", async () => {
    state.rangeFail = true
    state.openFail = true
    const j = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'jira', NOW)
    expect(j.calendarErrors).toEqual([])
    expect(j.jiraErrors).toHaveLength(1)
    const c = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'calendar', NOW)
    expect(c.jiraErrors).toEqual([])
    expect(c.calendarErrors).toHaveLength(1)
  })
})

describe('SourceCheckTimes (부록 E.2.2)', () => {
  it('재시작 직후 두 값은 null 이다', () => {
    expect(getSourceCheckTimes()).toEqual({ calendarAt: null, jiraAt: null })
  })

  it("full 은 두 시각을, 'calendar' 는 캘린더만, 'jira' 는 Jira 만 기록한다. local 은 기록하지 않는다", async () => {
    const db = makeDb()
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'local', NOW)
    expect(getSourceCheckTimes()).toEqual({ calendarAt: null, jiraAt: null })

    const t1 = NOW.getTime() + 1_000
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'calendar', new Date(t1))
    expect(getSourceCheckTimes()).toEqual({ calendarAt: t1, jiraAt: null })

    const t2 = NOW.getTime() + 2_000
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'jira', new Date(t2))
    expect(getSourceCheckTimes()).toEqual({ calendarAt: t1, jiraAt: t2 })

    const t3 = NOW.getTime() + 3_000
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'full', new Date(t3))
    expect(getSourceCheckTimes()).toEqual({ calendarAt: t3, jiraAt: t3 })
  })

  it('Jira 60초 캐시를 써도 jiraAt 을 기록한다', async () => {
    const db = makeDb()
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    const t = NOW.getTime() + 30_000
    await collectSources(db, DEFAULT_ASSISTANT_SETTINGS, 'jira', new Date(t))
    expect(state.openCalls).toHaveLength(1)
    expect(getSourceCheckTimes().jiraAt).toBe(t)
  })

  it('위험 6: 미연결·조회 실패에도 확인 시각을 기록한다', async () => {
    state.calendarConnected = false
    state.jiraConnected = false
    await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    expect(getSourceCheckTimes()).toEqual({ calendarAt: NOW.getTime(), jiraAt: NOW.getTime() })

    state.calendarConnected = true
    state.jiraConnected = true
    state.rangeFail = true
    state.openFail = true
    const t = NOW.getTime() + 120_000
    const r = await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', new Date(t))
    expect(r.errors).toHaveLength(2)
    expect(getSourceCheckTimes()).toEqual({ calendarAt: t, jiraAt: t })
  })

  it('getSourceCheckTimes 는 사본을 돌려준다', async () => {
    await collectSources(makeDb(), DEFAULT_ASSISTANT_SETTINGS, 'full', NOW)
    const times = getSourceCheckTimes()
    times.calendarAt = 0
    expect(getSourceCheckTimes().calendarAt).toBe(NOW.getTime())
  })
})

describe('resolveVanished', () => {
  const todoCandidate = { id: 'todo:5', jiraKey: null } as Candidate
  const mergedTask = { id: 'task:99', jiraKey: 'PROJ-9' } as Candidate

  it('작업·todo: 완료면 done, 삭제면 dropped, 남아 있으면 해석하지 않는다', async () => {
    const r = await resolveVanished(makeDb(), ['task:11', 'task:10', 'task:404', 'todo:6', 'todo:5', 'todo:404'], [])
    expect(r).toEqual({
      'task:11': { kind: 'done' },
      'task:404': { kind: 'dropped', note: '원본 삭제' },
      'todo:6': { kind: 'done' },
      'todo:404': { kind: 'dropped', note: '원본 삭제' }
    })
  })

  it('액션아이템: todo 로 옮겨졌으면 그 todo 후보로 교체하고 없어졌으면 dropped 다', async () => {
    const r = await resolveVanished(
      makeDb(),
      ['action_item:7:1', 'action_item:7:0', 'action_item:7:9', 'action_item:99:0'],
      [todoCandidate]
    )
    expect(r).toEqual({
      'action_item:7:1': { kind: 'replace', candidate: todoCandidate },
      'action_item:7:9': { kind: 'dropped', note: '원본 삭제' },
      'action_item:99:0': { kind: 'dropped', note: '원본 삭제' }
    })
  })

  it('액션아이템: 옮긴 todo 가 후보에 없고 완료되었으면 done 이다', async () => {
    const db = makeDb()
    db.exec("UPDATE meeting_summaries SET action_items = '[{\"text\":\"a\",\"todo_id\":6}]' WHERE meeting_id = 7")
    expect(await resolveVanished(db, ['action_item:7:0'], [])).toEqual({ 'action_item:7:0': { kind: 'done' } })
  })

  it('Jira: 완료면 done, 그 외는 담당 변경, 같은 키의 작업이 있으면 교체, 조회 못 한 키는 뺀다', async () => {
    const r = await resolveVanished(
      makeDb(),
      ['jira:PROJ-2', 'jira:PROJ-3', 'jira:PROJ-404', 'jira:PROJ-9', 'jira:bad key'],
      [mergedTask]
    )
    expect(r).toEqual({
      'jira:PROJ-2': { kind: 'done' },
      'jira:PROJ-3': { kind: 'dropped', note: '담당 변경' },
      'jira:PROJ-9': { kind: 'replace', candidate: mergedTask }
    })
    expect(state.keysCalls).toEqual([['PROJ-2', 'PROJ-3', 'PROJ-404']])
  })

  it('Jira: 완료가 아니어도 아직 내 담당이면 해석하지 않는다 (상한으로 잘린 이슈 보호)', async () => {
    state.assignee = { 'PROJ-3': 'acc-me', 'PROJ-5': null }
    const r = await resolveVanished(makeDb(), ['jira:PROJ-3', 'jira:PROJ-5', 'jira:PROJ-6'], [])
    expect(r).toEqual({
      'jira:PROJ-5': { kind: 'dropped', note: '담당 변경' },
      'jira:PROJ-6': { kind: 'dropped', note: '담당 변경' }
    })
    expect(state.myCalls).toBe(1)
  })

  it('Jira: 내 accountId 를 모르면 담당 변경으로 판정하지 않는다', async () => {
    state.myAccountId = null
    const r = await resolveVanished(makeDb(), ['jira:PROJ-2', 'jira:PROJ-3'], [])
    expect(r).toEqual({ 'jira:PROJ-2': { kind: 'done' } })
  })

  it('Jira: network false 면 Jira 를 호출하지 않고 같은 키 교체만 한다', async () => {
    const r = await resolveVanished(makeDb(), ['jira:PROJ-2', 'jira:PROJ-9', 'todo:6'], [mergedTask], {
      network: false
    })
    expect(r).toEqual({ 'jira:PROJ-9': { kind: 'replace', candidate: mergedTask }, 'todo:6': { kind: 'done' } })
    expect(state.keysCalls).toEqual([])
    expect(state.myCalls).toBe(0)
  })

  it('Jira: 조회가 실패하면 throw 하지 않고 Jira 항목을 결과에 넣지 않는다', async () => {
    state.keysFail = true
    const r = await resolveVanished(makeDb(), ['jira:PROJ-2', 'todo:6'], [])
    expect(r).toEqual({ 'todo:6': { kind: 'done' } })
  })

  it('Jira: 연결되어 있지 않으면 조회하지 않는다', async () => {
    state.jiraConnected = false
    expect(await resolveVanished(makeDb(), ['jira:PROJ-2'], [])).toEqual({})
    expect(state.keysCalls).toEqual([])
  })

  it('형식이 틀린 ID 는 무시한다', async () => {
    expect(await resolveVanished(makeDb(), ['weird', 'task:abc', 'action_item:7'], [])).toEqual({})
  })
})

// ── 맥락 복구 수집 (부록 F.3) ──

// 복구 쿼리가 읽는 컬럼을 가진 스키마. 실제 database.ts 의 해당 컬럼과 같다.
function makeRecoveryDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT);
    CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT, is_completed INTEGER, completed_at TEXT);
    CREATE TABLE meetings (id INTEGER PRIMARY KEY, title TEXT, started_at TEXT, project_id INTEGER);
    CREATE TABLE meeting_summaries (id INTEGER PRIMARY KEY, meeting_id INTEGER UNIQUE, tldr TEXT,
      action_items TEXT, generated_at TEXT);
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT, entity_id INTEGER,
      entity_name TEXT, action TEXT, details TEXT, created_at TEXT);
  `)
  return db
}

// 로컬 'YYYY-MM-DD HH:mm:ss' 를 activity_log 기본값과 같은 UTC 문자열로 바꾼다.
function utcOf(local: string): string {
  const [d, t] = local.split(' ')
  const [y, mo, da] = d.split('-').map(Number)
  const [h, mi, se] = t.split(':').map(Number)
  return new Date(y, mo - 1, da, h, mi, se).toISOString().slice(0, 19).replace('T', ' ')
}

function logRow(type: string, id: number | null, name: string | null, action: string, local: string): string {
  const q = (v: string | null): string => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`)
  return `(NULL, ${q(type)}, ${id === null ? 'NULL' : id}, ${q(name)}, ${q(action)}, NULL, ${q(utcOf(local))})`
}

const LAST_PLAN = {
  id: 1,
  plan_date: '2026-10-30',
  started_at: '2026-10-30 09:00:00',
  closed_at: '2026-10-30 18:00:00',
  wrapup_note: '결제 API 검토 이어서',
  wrapup_at: '2026-10-30 18:00:00'
}

function recoveryCtx(patch: Partial<RecoveryContext> = {}): RecoveryContext {
  return {
    today: TODAY,
    weekday: 1,
    lastPlan: LAST_PLAN,
    gapDays: 3,
    since: LAST_PLAN.started_at,
    sinceDate: LAST_PLAN.plan_date,
    jiraDays: 4,
    ...patch
  }
}

function planItem(id: number, patch: Partial<PlanItem> = {}): PlanItem {
  return {
    id,
    plan_id: 1,
    candidate_id: `todo:${id}`,
    source: 'todo',
    title: `항목 ${id}`,
    link: null,
    jira_issue_key: null,
    project_id: null,
    due_date: null,
    score: 0,
    rank: id,
    slot_start: null,
    slot_end: null,
    pinned: false,
    added_by: 'start',
    urgent: false,
    status: 'planned',
    status_note: null,
    status_at: null,
    first_planned_date: '2026-10-30',
    work_type: 'etc',
    work_version: null,
    parent_key: null,
    group_name: null,
    ...patch
  }
}

function recentIssue(n: number): Record<string, unknown> {
  return {
    key: `PROJ-${n}`,
    summary: `변경 ${n}`,
    status: '진행 중',
    statusCategory: 'indeterminate',
    priority: null,
    duedate: null,
    updated: new Date(2026, 10, 1, 10, 0).toISOString(),
    issueType: 'Task'
  }
}

describe('readRecoveryLocal', () => {
  it('A33: 소스별 건수 상한을 지킨다', () => {
    const db = makeRecoveryDb()
    seed(db, 'todos', Array.from({ length: 60 }, (_, i) =>
      `(${i + 1}, '완료 ${i + 1}', 1, '2026-10-31 ${String(10 + (i % 10)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00')`))
    seed(db, 'meetings', Array.from({ length: 15 }, (_, i) =>
      `(${i + 1}, '회의 ${i + 1}', '2026-10-31 ${String(i + 8).padStart(2, '0')}:00:00', NULL)`))
    const manyActions = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ text: `액션 ${i}` })))
    seed(db, 'meeting_summaries', Array.from({ length: 15 }, (_, i) =>
      `(${i + 1}, ${i + 1}, '${'가'.repeat(500)}', '${manyActions}', '2026-10-31 20:00:00')`))
    seed(db, 'activity_log', Array.from({ length: 60 }, (_, i) =>
      logRow('task', i + 1, `작업 ${i + 1}`, 'update', `2026-10-31 ${String(10 + (i % 10)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00`)))
    const items = Array.from({ length: 25 }, (_, i) => planItem(i + 1))
    const ctx = recoveryCtx({ lastPlan: { ...LAST_PLAN, wrapup_note: '메'.repeat(3000) } })

    const r = readRecoveryLocal(db, ctx, items)

    expect(r.completedTodos).toHaveLength(RECOVERY_LIMITS.todos)
    expect(r.meetings).toHaveLength(RECOVERY_LIMITS.meetings)
    expect(r.activity).toHaveLength(RECOVERY_LIMITS.activity)
    expect(r.unfinishedItems).toHaveLength(RECOVERY_LIMITS.unfinished)
    expect(r.wrapupNote).toHaveLength(2000)
    expect(r.meetings[0].tldr).toHaveLength(300)
    expect(r.meetings[0].openActionItems).toHaveLength(RECOVERY_LIMITS.actionItemsPerMeeting)
    expect(r.meetings[0].openActionCount).toBe(8)
    // 정렬: 완료 todo·회의는 최신순이다
    expect(r.completedTodos[0].completedAt >= r.completedTodos[1].completedAt).toBe(true)
    expect(r.meetings[0].title).toBe('회의 15')
  })

  it('A33: activity_log 는 최근 500행만 읽는다', () => {
    const db = makeRecoveryDb()
    seed(db, 'activity_log', Array.from({ length: 600 }, (_, i) => {
      const at = new Date(2026, 9, 31, 0, 0, i)
      const local = `2026-10-31 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`
      return logRow('task', 1, '큰 작업', 'update', local)
    }))
    const [g] = readRecoveryLocal(db, recoveryCtx({ since: '2026-10-30 00:00:00' }), []).activity
    expect(g.count).toBe(RECOVERY_LIMITS.activityRows)
    // 가장 오래된 100행(00:00:00~00:01:39)이 빠진다
    expect(g.firstAt).toBe('2026-10-31 00:01:40')
    expect(g.lastAt).toBe('2026-10-31 00:09:59')
  })

  it('activity_log 의 UTC created_at 을 로컬로 바꿔 since 와 비교한다', () => {
    const db = makeRecoveryDb()
    seed(db, 'activity_log', [
      logRow('task', 1, '기준 전', 'update', '2026-10-30 08:59:59'),
      logRow('task', 2, '기준 직후', 'update', '2026-10-30 09:00:00'),
      logRow('todo', 3, '오전', 'create', '2026-10-30 10:00:00')
    ])
    const r = readRecoveryLocal(db, recoveryCtx(), [])
    expect(r.activity.map((g) => g.name)).toEqual(['오전', '기준 직후'])
    // firstAt·lastAt 은 로컬 시각이다
    expect(r.activity[0].firstAt).toBe('2026-10-30 10:00:00')
    expect(r.activity[1].lastAt).toBe('2026-10-30 09:00:00')
  })

  it('activity_log 를 엔티티별로 묶고 삭제된 엔티티도 남긴다', () => {
    const db = makeRecoveryDb()
    seed(db, 'projects', [`(1, '원본 프로젝트')`])
    seed(db, 'todos', [`(9, '원본 할 일', 1, NULL)`])
    seed(db, 'activity_log', [
      // 작업 5: 이름이 바뀐 뒤 삭제됐다. 마지막 행은 이름이 없다
      logRow('task', 5, '옛 이름', 'create', '2026-10-31 09:00:00'),
      logRow('task', 5, '새 이름', 'update', '2026-10-31 10:00:00'),
      logRow('task', 5, null, 'update', '2026-10-31 10:30:00'),
      logRow('task', 5, null, 'delete', '2026-10-31 11:00:00'),
      // 할 일 9: 이름이 없다. 원본 테이블에서 읽는다
      logRow('todo', 9, null, 'complete', '2026-10-31 12:00:00'),
      // 프로젝트 1: 원본 이름
      logRow('project', 1, null, 'update', '2026-10-31 08:00:00'),
      // 작업 77: 이름도 원본도 없다
      logRow('task', 77, null, 'delete', '2026-10-31 07:00:00'),
      // entity_id 가 없으면 이름으로 묶는다
      logRow('todo', null, '아이디 없음', 'create', '2026-10-31 06:00:00'),
      logRow('todo', null, '아이디 없음', 'update', '2026-10-31 06:30:00'),
      // 대상이 아닌 종류는 뺀다
      logRow('meeting', 3, '회의', 'create', '2026-10-31 13:00:00')
    ])

    const groups = readRecoveryLocal(db, recoveryCtx(), []).activity

    expect(groups.map((g) => g.name)).toEqual([
      '원본 할 일', '새 이름', '원본 프로젝트', '(이름 없음)', '아이디 없음'
    ])
    const task = groups[1]
    expect(task).toEqual({
      entityType: 'task',
      entityId: 5,
      name: '새 이름',
      actions: ['create', 'update', 'delete'],
      count: 4,
      firstAt: '2026-10-31 09:00:00',
      lastAt: '2026-10-31 11:00:00',
      deleted: true
    })
    expect(groups[0].deleted).toBe(false)
    expect(groups[3]).toMatchObject({ entityId: 77, deleted: true })
    expect(groups[4]).toMatchObject({ entityType: 'todo', entityId: null, count: 2, actions: ['create', 'update'] })
  })

  it('남은 작업은 planned·in_progress·deferred 만 rank 순으로 둔다. null 은 뒤다', () => {
    const items = [
      planItem(1, { rank: 3 }),
      planItem(2, { rank: null, status: 'in_progress' }),
      planItem(3, { rank: 1, status: 'done' }),
      planItem(4, { rank: 2, status: 'deferred' }),
      planItem(5, { rank: null, status: 'suggested' }),
      planItem(6, { rank: 4, status: 'dropped' })
    ]
    const r = readRecoveryLocal(makeRecoveryDb(), recoveryCtx(), items)
    expect(r.unfinishedItems.map((i) => i.id)).toEqual([4, 1, 2])
  })

  it('퇴근 메모는 공백 7일 이하일 때만 쓴다. 이전 계획이 없으면 남은 작업도 없다', () => {
    const db = makeRecoveryDb()
    expect(readRecoveryLocal(db, recoveryCtx({ gapDays: 7 }), []).wrapupNote).toBe('결제 API 검토 이어서')
    expect(readRecoveryLocal(db, recoveryCtx({ gapDays: 8 }), []).wrapupNote).toBeNull()
    const none = readRecoveryLocal(db, recoveryCtx({ lastPlan: null, gapDays: null }), [planItem(1)])
    expect(none.wrapupNote).toBeNull()
    expect(none.unfinishedItems).toEqual([])
  })

  it('회의 요약은 since 이후 생성분만 읽고 프로젝트 이름과 미완료 액션을 붙인다', () => {
    const db = makeRecoveryDb()
    seed(db, 'projects', [`(1, '결제 개편')`])
    seed(db, 'meetings', [
      `(1, '주간 회의', '2026-10-31 10:00:00', 1)`,
      `(2, '지난 회의', '2026-10-29 10:00:00', NULL)`,
      `(3, '요약 없음', '2026-10-31 11:00:00', 99)`
    ])
    seed(db, 'meeting_summaries', [
      `(1, 1, '  ', '[{"text":"남은 액션"},{"text":"옮긴 액션","todo_id":4},{"text":" "}]', '2026-10-31 11:00:00')`,
      `(2, 2, '오래됨', '[]', '2026-10-29 11:00:00')`,
      `(3, 3, '요약', NULL, '2026-10-31 12:00:00')`
    ])
    const r = readRecoveryLocal(db, recoveryCtx(), [])
    expect(r.meetings).toEqual([
      { meetingId: 3, title: '요약 없음', startedAt: '2026-10-31 11:00:00', projectName: null, tldr: '요약', openActionItems: [], openActionCount: 0 },
      { meetingId: 1, title: '주간 회의', startedAt: '2026-10-31 10:00:00', projectName: '결제 개편', tldr: null, openActionItems: ['남은 액션'], openActionCount: 1 }
    ])
  })

  it('완료 todo 는 since 이후 완료분만 읽는다', () => {
    const db = makeRecoveryDb()
    seed(db, 'todos', [
      `(1, '전', 1, '2026-10-30 08:00:00')`,
      `(2, '후', 1, '2026-10-30 09:30:00')`,
      `(3, '미완료', 0, NULL)`
    ])
    expect(readRecoveryLocal(db, recoveryCtx(), []).completedTodos).toEqual([
      { id: 2, title: '후', completedAt: '2026-10-30 09:30:00' }
    ])
  })

  it('로컬 출처 조회가 실패하면 readRecoveryLocal 은 throw 한다', () => {
    const db = new Database(':memory:')
    expect(() => readRecoveryLocal(db, recoveryCtx(), [])).toThrow()
  })
})

describe('collectRecovery', () => {
  it('Jira 미연결이면 jira 는 null 이고 errors 에 넣지 않는다', async () => {
    state.jiraConnected = false
    const r = await collectRecovery(makeRecoveryDb(), DEFAULT_ASSISTANT_SETTINGS, recoveryCtx(), [planItem(1)])
    expect(r.jira).toBeNull()
    expect(r.jiraConnected).toBe(false)
    expect(r.errors).toEqual([])
    expect(r.unfinishedItems).toHaveLength(1)
    expect(state.recentCalls).toEqual([])
  })

  it('Jira 조회가 실패하면 jira 는 null 이고 errors 에 문구를 넣는다. throw 하지 않는다', async () => {
    state.recentFail = true
    const r = await collectRecovery(makeRecoveryDb(), DEFAULT_ASSISTANT_SETTINGS, recoveryCtx(), [])
    expect(r.jira).toBeNull()
    expect(r.jiraConnected).toBe(true)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain('Jira 조회에 실패했습니다.')
    expect(r.errors[0]).toContain('401')
  })

  it('jiraDays 와 범위 키로 조회하고 50건까지 변환한다. 캐시·확인 시각을 건드리지 않는다', async () => {
    state.recentIssues = Array.from({ length: 60 }, (_, i) => recentIssue(i + 1))
    const settings = { ...DEFAULT_ASSISTANT_SETTINGS, jiraScope: 'default_project' as const }
    const ctx = recoveryCtx({ jiraDays: 4 })

    const r = await collectRecovery(makeRecoveryDb(), settings, ctx, [])

    expect(state.recentCalls).toEqual([[4, 'PROJ']])
    expect(r.jira).toHaveLength(RECOVERY_LIMITS.jira)
    expect(r.jiraTruncated).toBe(true)
    expect(r.jira?.[0]).toEqual({
      key: 'PROJ-1',
      summary: '변경 1',
      status: '진행 중',
      statusCategory: 'indeterminate',
      priority: null,
      duedate: null,
      updatedLocal: '2026-11-01 10:00:00',
      url: 'https://acme.atlassian.net/browse/PROJ-1'
    })
    expect(r.ctx).toBe(ctx)
    expect(r.errors).toEqual([])
    expect(getSourceCheckTimes()).toEqual({ calendarAt: null, jiraAt: null })
    expect(state.openCalls).toEqual([])
  })

  it('전체 범위면 프로젝트 키 없이 조회한다. 조회 truncated 를 그대로 전한다', async () => {
    state.recentIssues = [recentIssue(1)]
    state.recentTruncated = true
    const r = await collectRecovery(makeRecoveryDb(), DEFAULT_ASSISTANT_SETTINGS, recoveryCtx({ jiraDays: 14 }), [])
    expect(state.recentCalls).toEqual([[14, null]])
    expect(r.jira).toHaveLength(1)
    expect(r.jiraTruncated).toBe(true)
  })

  it('로컬 출처 하나가 실패해도 throw 하지 않고 그 출처만 비운다', async () => {
    const db = makeRecoveryDb()
    db.exec('DROP TABLE meeting_summaries')
    seed(db, 'todos', [`(1, '후', 1, '2026-10-30 09:30:00')`])
    const r = await collectRecovery(db, DEFAULT_ASSISTANT_SETTINGS, recoveryCtx(), [])
    expect(r.meetings).toEqual([])
    expect(r.completedTodos).toHaveLength(1)
    expect(r.errors).toEqual(['회의 요약 조회에 실패했습니다.'])
  })
})

// ── 회의 전 브리핑 수집 (부록 I.3.1, I.5) ──

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

// 회의 수집 쿼리가 읽는 컬럼을 가진 스키마. 실제 database.ts 의 해당 컬럼과 같다.
function makeMeetingDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, dev_start_date TEXT, dev_end_date TEXT,
      qa_start_date TEXT, qa_end_date TEXT, deploy_date TEXT, status TEXT, status_manual INTEGER, priority TEXT);
    CREATE TABLE meetings (id INTEGER PRIMARY KEY, title TEXT, kind TEXT, started_at TEXT,
      calendar_event_title TEXT);
    CREATE TABLE meeting_summaries (id INTEGER PRIMARY KEY, meeting_id INTEGER UNIQUE, tldr TEXT,
      action_items TEXT, generated_at TEXT);
  `)
  seed(db, 'projects', [
    `(1, '결제 개편', '2026-10-01', '2026-12-01', '2026-12-02', '2026-12-04', '2026-12-05', 'development', 1, 'now')`,
    `(2, '정산', '2026-10-01', '2026-12-01', '2026-12-02', '2026-12-04', '2026-12-05', 'development', 1, NULL)`,
    `(3, '주간', '2026-10-01', '2026-12-01', '2026-12-02', '2026-12-04', '2026-12-05', 'on_hold', 1, NULL)`,
    `(4, 'A', '2026-10-01', '2026-12-01', '2026-12-02', '2026-12-04', '2026-12-05', 'development', 1, NULL)`
  ])
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
  it('활성 프로젝트만 매칭한다. 중단 프로젝트와 1자 이름은 빠진다', () => {
    const ctx = collectMeetingContext(makeMeetingDb(), MEETING, [])
    expect(ctx.projects).toEqual([
      { id: 1, name: '결제 개편' },
      { id: 2, name: '정산' }
    ])
    expect(ctx.meeting).toBe(MEETING)
    expect(ctx.errors).toEqual([])
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
    const ctx = collectMeetingContext(db, MEETING, [])
    expect(ctx.pastMeetings).toEqual([
      { meetingId: 1, title: '결제 개편 · 정산 주간회의', startedAt: '2026-10-26 14:00:00', tldr: '일정 합의', openActionItems: ['문서 공유'] },
      { meetingId: 2, title: '녹음 1', startedAt: '2026-10-19 14:00:00', tldr: null, openActionItems: ['견적 확인'] }
    ])
    // 요약이 없는 회의(6)는 JOIN 에서 빠진다
    expect(ctx.openActionItems).toEqual(['문서 공유', '견적 확인'])
  })

  it('A46: 지난 회의는 회의 시작 기준 90일 안만 읽는다', () => {
    const db = makeMeetingDb()
    seed(db, 'meetings', [
      meetingRow(1, MEETING.title, '2026-08-04 14:00:00'),
      meetingRow(2, MEETING.title, '2026-08-04 13:59:59')
    ])
    seed(db, 'meeting_summaries', [summaryRow(1, '90일째', []), summaryRow(2, '90일 넘음', [])])
    expect(MEETING_LIMITS.pastDays).toBe(90)
    const ctx = collectMeetingContext(db, MEETING, [])
    expect(ctx.pastMeetings.map((m) => m.meetingId)).toEqual([1])
  })

  it('A46: 지난 회의는 최근 3건까지만 둔다. startedAt 내림차순이다', () => {
    const db = makeMeetingDb()
    seed(db, 'meetings', [1, 2, 3, 4, 5].map((n) => meetingRow(n, MEETING.title, `2026-10-0${n} 14:00:00`)))
    seed(db, 'meeting_summaries', [1, 2, 3, 4, 5].map((n) => summaryRow(n, `요약 ${n}`, [])))
    const ctx = collectMeetingContext(db, MEETING, [])
    expect(MEETING_LIMITS.pastMeetings).toBe(3)
    expect(ctx.pastMeetings.map((m) => m.meetingId)).toEqual([5, 4, 3])
  })

  it('A46: 지난 회의 후보는 최근 200건까지만 읽는다', () => {
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
    expect(collectMeetingContext(db, MEETING, []).pastMeetings).toEqual([])
  })

  it('A46: 미완료 액션아이템은 10건까지만 둔다', () => {
    const db = makeMeetingDb()
    seed(db, 'meetings', [
      meetingRow(1, MEETING.title, '2026-10-26 14:00:00'),
      meetingRow(2, MEETING.title, '2026-10-19 14:00:00')
    ])
    const actions = (prefix: string, n: number): { text: string }[] =>
      Array.from({ length: n }, (_, i) => ({ text: `${prefix} ${i + 1}` }))
    seed(db, 'meeting_summaries', [summaryRow(1, null, actions('최근', 12)), summaryRow(2, null, actions('이전', 4))])
    const ctx = collectMeetingContext(db, MEETING, [])
    expect(MEETING_LIMITS.actionItems).toBe(10)
    expect(ctx.openActionItems).toHaveLength(10)
    expect(ctx.openActionItems[0]).toBe('최근 1')
    expect(ctx.openActionItems[9]).toBe('최근 10')
    expect(ctx.pastMeetings[0].openActionItems).toHaveLength(10)
  })

  it('A46: tldr 는 200자에서 자른다', () => {
    const db = makeMeetingDb()
    seed(db, 'meetings', [meetingRow(1, MEETING.title, '2026-10-26 14:00:00')])
    seed(db, 'meeting_summaries', [summaryRow(1, '가'.repeat(300), [])])
    expect(collectMeetingContext(db, MEETING, []).pastMeetings[0].tldr).toBe('가'.repeat(200))
  })

  it('A46: 관련 항목은 매칭 프로젝트의 planned·in_progress 항목을 순위 순으로 5건까지 둔다', () => {
    const items: PlanItem[] = [
      planItem(1, { project_id: 1, rank: 3 }),
      planItem(2, { project_id: 2, rank: 1, status: 'in_progress' }),
      planItem(3, { project_id: 1, rank: null }),
      planItem(4, { project_id: 1, rank: 2, status: 'done' }),
      planItem(5, { project_id: 1, rank: 4, status: 'suggested' }),
      planItem(6, { project_id: 3, rank: 1 }),
      planItem(7, { project_id: null, rank: 1 }),
      planItem(8, { project_id: 2, rank: 5 }),
      planItem(9, { project_id: 2, rank: 6 }),
      planItem(10, { project_id: 1, rank: 7, status: 'deferred' }),
      planItem(11, { project_id: 1, rank: 8 })
    ]
    const ctx = collectMeetingContext(makeMeetingDb(), MEETING, items)
    expect(MEETING_LIMITS.relatedItems).toBe(5)
    expect(ctx.relatedItems).toEqual([
      { id: 2, title: '항목 2', status: 'in_progress' },
      { id: 1, title: '항목 1', status: 'planned' },
      { id: 8, title: '항목 8', status: 'planned' },
      { id: 9, title: '항목 9', status: 'planned' },
      { id: 11, title: '항목 11', status: 'planned' }
    ])
  })

  it('매칭 프로젝트가 없으면 관련 항목도 없다', () => {
    const ctx = collectMeetingContext(makeMeetingDb(), { ...MEETING, title: '1:1' }, [planItem(1, { project_id: 1 })])
    expect(ctx.projects).toEqual([])
    expect(ctx.relatedItems).toEqual([])
  })

  it('출처 조회가 실패하면 throw 하지 않고 그 출처만 비운다', () => {
    const db = makeMeetingDb()
    db.exec('DROP TABLE meeting_summaries')
    const ctx = collectMeetingContext(db, MEETING, [planItem(1, { project_id: 1 })])
    expect(ctx.pastMeetings).toEqual([])
    expect(ctx.openActionItems).toEqual([])
    expect(ctx.projects).toHaveLength(2)
    expect(ctx.relatedItems).toHaveLength(1)
    expect(ctx.errors).toEqual(['지난 회의 조회에 실패했습니다.'])

    const empty = collectMeetingContext(new Database(':memory:'), MEETING, [planItem(1, { project_id: 1 })])
    expect(empty.projects).toEqual([])
    expect(empty.relatedItems).toEqual([])
    expect(empty.errors).toEqual(['프로젝트 조회에 실패했습니다.', '지난 회의 조회에 실패했습니다.'])
  })

  it('A2·A46: 수집은 원본 테이블을 바꾸지 않고 Jira·캘린더를 부르지 않는다', () => {
    const db = makeMeetingDb()
    seed(db, 'meetings', [meetingRow(1, MEETING.title, '2026-10-26 14:00:00')])
    seed(db, 'meeting_summaries', [summaryRow(1, '요약', [{ text: '액션' }])])
    const dump = (): string =>
      JSON.stringify(['projects', 'meetings', 'meeting_summaries'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()))
    const before = dump()
    collectMeetingContext(db, MEETING, [])
    expect(dump()).toBe(before)
    expect(state.openCalls).toEqual([])
    expect(state.keysCalls).toEqual([])
    expect(state.recentCalls).toEqual([])
    expect(state.myCalls).toBe(0)
    expect(state.rangeCalls).toEqual([])
  })
})
