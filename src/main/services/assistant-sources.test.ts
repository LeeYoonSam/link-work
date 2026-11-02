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
  assignee: {} as Record<string, string | null>
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
import type { Candidate } from './assistant-types'
import {
  clearJiraCache,
  collectSources,
  getSourceCheckTimes,
  resetSourceCheckTimes,
  resolveVanished,
  toCalendarRef
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
