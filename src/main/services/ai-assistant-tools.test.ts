import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// better-sqlite3 → node:sqlite 교체. 이유는 assistant-store.test.ts 상단 주석과 같다.
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

// 도구가 쓰는 DB 와 실행한 SQL 을 기록한다.
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: [] as string[],
  networkCalls: [] as string[]
}))

// 읽기 전용 커넥션 자리에 인메모리 DB 를 넣는다. prepare 한 SQL 을 모두 기록한다.
vi.mock('../db/database', () => ({
  getAiReadOnlyDatabase: () => {
    const target = state.db as { prepare: (sql: string) => unknown }
    return new Proxy(target, {
      get(t, p) {
        if (p === 'prepare') {
          return (sql: string) => {
            state.sql.push(sql)
            return t.prepare(sql)
          }
        }
        const v = Reflect.get(t, p)
        return typeof v === 'function' ? v.bind(t) : v
      }
    })
  },
  getDatabase: () => {
    state.networkCalls.push('getDatabase')
    throw new Error('A31: getDatabase 를 부르면 안 된다')
  }
}))

// assistant-sources 가 끌어오는 네트워크 모듈이다 (부록 F.13 위험 4). 호출되면 기록한다.
vi.mock('./jira', () => {
  const record = (name: string) => () => {
    state.networkCalls.push(name)
    throw new Error(`A31: ${name} 를 부르면 안 된다`)
  }
  return {
    getDefaultJiraProjectKey: () => null,
    getJiraIssueUrl: (key: string) => `https://acme.atlassian.net/browse/${key}`,
    isJiraConnected: () => true,
    listMyOpenIssues: record('listMyOpenIssues'),
    listIssuesByKeys: record('listIssuesByKeys'),
    listMyRecentlyUpdatedIssues: record('listMyRecentlyUpdatedIssues'),
    getJiraMyAccountId: record('getJiraMyAccountId')
  }
})
vi.mock('./google-auth', () => ({ isConnected: () => true }))
vi.mock('./google-calendar', () => ({
  fetchEventsInRange: () => {
    state.networkCalls.push('fetchEventsInRange')
    throw new Error('A31: 캘린더를 부르면 안 된다')
  }
}))

import Database from 'better-sqlite3'
import { ASSISTANT_SCHEMA } from './assistant-schema'
import {
  ASSISTANT_LIST_MAX,
  ASSISTANT_TEXT_MAX,
  ASSISTANT_TITLE_MAX,
  ASSISTANT_TOOL_NAMES,
  buildAssistantTools
} from './ai-assistant-tools'

// 로컬 시각 기준. 기본 하루 경계 04:00 이후라 논리 날짜는 TODAY 다.
const NOW = new Date(2026, 10, 2, 10, 0)
const TODAY = '2026-11-02'

interface FakeToolDef {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: unknown, extra: unknown) => Promise<{ content: { type: string; text: string }[] }>
}

// SDK tool 대신 정의를 그대로 돌려준다. 테스트가 핸들러를 직접 부른다.
function fakeTool(
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  handler: FakeToolDef['handler']
): FakeToolDef {
  return { name, description, inputSchema, handler }
}

type SdkTool = Parameters<typeof buildAssistantTools>[0]
const tools = buildAssistantTools(fakeTool as unknown as SdkTool) as unknown as FakeToolDef[]

// SDK 처럼 zod 로 입력을 검증한 뒤 핸들러를 부른다. 결과 JSON 을 푼다.
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`도구 없음: ${name}`)
  const parsed = z.object(t.inputSchema).parse(args)
  const res = await t.handler(parsed, {})
  expect(res.content).toHaveLength(1)
  expect(res.content[0].type).toBe('text')
  return JSON.parse(res.content[0].text)
}

// 픽스처 행을 넣는다. A2 grep 이 원본 테이블 쓰기 문장을 찾지 않도록 테이블 이름을 인자로 받는다.
function seed(db: Database.Database, table: string, rows: string[]): void {
  for (const values of rows) db.exec(`INSERT INTO ${table} VALUES ${values}`)
}

const PLAN_COLS = 'daily_plans (id, plan_date, status, started_at, closed_at, briefing_text, briefing_source, recovery_text, recovery_source, wrapup_note)'
const ITEM_COLS = 'plan_items (id, plan_id, candidate_id, source, title, score, rank, added_by, status, due_date, urgent)'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)`)
  db.exec(ASSISTANT_SCHEMA)
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT);
    CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT, is_completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT, due_date TEXT, priority TEXT, updated_at TEXT);
    CREATE TABLE meetings (id INTEGER PRIMARY KEY, title TEXT, started_at TEXT, project_id INTEGER);
    CREATE TABLE meeting_summaries (id INTEGER PRIMARY KEY, meeting_id INTEGER UNIQUE, tldr TEXT,
      action_items TEXT, generated_at TEXT);
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY, entity_type TEXT, entity_id INTEGER, entity_name TEXT,
      action TEXT, created_at TEXT);
  `)
  return db
}

let db: Database.Database

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  db = makeDb()
  state.db = db
  state.sql = []
  state.networkCalls = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('도구 목록', () => {
  it('3개 도구를 계약 이름으로 만든다', () => {
    expect(tools.map((t) => t.name)).toEqual([...ASSISTANT_TOOL_NAMES])
    expect(ASSISTANT_TOOL_NAMES).toEqual(['get_today_plan', 'get_recent_work', 'list_meeting_action_items'])
  })
})

describe('get_today_plan', () => {
  it('계획이 없으면 plan null 과 하루 시작 안내를 돌려준다', async () => {
    const r = await call('get_today_plan')
    expect(r).toEqual({
      date: TODAY,
      plan: null,
      items: [],
      suggested: [],
      hint: '이 날짜의 계획이 없다. 오늘이면 오늘 화면에서 하루 시작을 누른다.'
    })
  })

  it('date 를 생략하면 하루 경계를 적용한 논리 날짜를 쓴다', async () => {
    // 03:00 은 기본 경계 04:00 이전이라 전날이다.
    vi.setSystemTime(new Date(2026, 10, 2, 3, 0))
    const r = await call('get_today_plan')
    expect(r.date).toBe('2026-11-01')
  })

  it('계획과 항목을 계약 모양으로 돌려준다. suggested·dismissed 는 items 에서 뺀다', async () => {
    seed(db, PLAN_COLS, [
      `(1, '${TODAY}', 'active', '${TODAY} 09:40:00', NULL, '브리핑', 'llm', '복구 본문', 'rules', NULL)`
    ])
    seed(db, ITEM_COLS, [
      `(1, 1, 'todo:1', 'todo', '랭크 없음', 5, NULL, 'start', 'planned', NULL, 0)`,
      `(2, 1, 'todo:2', 'todo', '두 번째', 9, 2, 'start', 'in_progress', '2026-11-03', 1)`,
      `(3, 1, 'todo:3', 'todo', '첫 번째', 10, 1, 'start', 'done', NULL, 0)`,
      `(4, 1, 'jira:PROJ-1', 'jira', '제안', 8, NULL, 'refresh', 'suggested', '2026-11-04', 1)`,
      `(5, 1, 'todo:5', 'todo', '거절', 1, NULL, 'refresh', 'dismissed', NULL, 0)`
    ])
    const r = await call('get_today_plan', { date: TODAY })
    expect(r.date).toBe(TODAY)
    expect(r.plan).toEqual({
      status: 'active',
      started_at: `${TODAY} 09:40:00`,
      closed_at: null,
      wrapup_note: null,
      briefing_source: 'llm',
      briefing_text: '브리핑',
      recovery_source: 'rules',
      recovery_text: '복구 본문'
    })
    // rank 오름차순, null 은 뒤
    expect(r.items.map((i: { title: string }) => i.title)).toEqual(['첫 번째', '두 번째', '랭크 없음'])
    expect(Object.keys(r.items[0]).sort()).toEqual(
      [
        'id', 'candidate_id', 'title', 'source', 'link', 'jira_issue_key', 'due_date', 'rank', 'status',
        'status_note', 'urgent', 'first_planned_date'
      ].sort()
    )
    expect(r.items[1]).toMatchObject({ status: 'in_progress', urgent: true, due_date: '2026-11-03' })
    expect(r.suggested).toEqual([
      { id: 4, candidate_id: 'jira:PROJ-1', title: '제안', due_date: '2026-11-04', urgent: true }
    ])
    expect(r.hint).toBe('오늘 화면은 linkwork://view/today 다.')
  })

  it('본문은 4000자, 제목은 300자에서 자른다', async () => {
    const longBody = 'b'.repeat(ASSISTANT_TEXT_MAX + 50)
    const longTitle = 't'.repeat(ASSISTANT_TITLE_MAX + 50)
    seed(db, PLAN_COLS, [
      `(1, '${TODAY}', 'closed', '${TODAY} 09:40:00', '${TODAY} 18:00:00', '${longBody}', 'rules', '${longBody}', 'llm', '${longBody}')`
    ])
    seed(db, ITEM_COLS, [`(1, 1, 'todo:1', 'todo', '${longTitle}', 5, 1, 'start', 'planned', NULL, 0)`])
    const r = await call('get_today_plan', { date: TODAY })
    for (const text of [r.plan.briefing_text, r.plan.recovery_text, r.plan.wrapup_note]) {
      expect(text.startsWith('b'.repeat(ASSISTANT_TEXT_MAX))).toBe(true)
      expect(text.length).toBeLessThan(longBody.length)
    }
    expect(r.items[0].title.startsWith('t'.repeat(ASSISTANT_TITLE_MAX))).toBe(true)
    expect(r.items[0].title.length).toBeLessThan(longTitle.length)
  })

  it('date 형식이 틀리면 zod 가 거부한다', async () => {
    await expect(call('get_today_plan', { date: '2026/11/02' })).rejects.toThrow()
  })
})

describe('get_recent_work', () => {
  it('기본 3일을 보고 jira·errors 섹션을 뺀다', async () => {
    seed(db, PLAN_COLS, [
      `(1, '2026-10-31', 'closed', '2026-10-31 09:00:00', '2026-10-31 18:00:00', NULL, NULL, NULL, NULL, '내일 배포 확인')`
    ])
    seed(db, ITEM_COLS, [`(1, 1, 'todo:9', 'todo', '남은 일', 5, 1, 'start', 'planned', NULL, 0)`])
    const r = await call('get_recent_work')
    expect(r.days).toBe(3)
    expect(r.since).toBe('2026-10-30 00:00:00')
    expect(r.last_plan_date).toBe('2026-10-31')
    expect(r.hint).toBe('Jira 변경은 Atlassian 도구로 조회한다.')
    const keys = r.sections.map((s: { key: string }) => s.key)
    expect(keys).toContain('last_day')
    expect(keys).toContain('unfinished')
    expect(keys).not.toContain('jira')
    expect(keys).not.toContain('errors')
    for (const s of r.sections) {
      expect(typeof s.title).toBe('string')
      expect(Array.isArray(s.lines)).toBe(true)
    }
  })

  it('이전 계획이 없으면 last_plan_date 는 null 이다', async () => {
    const r = await call('get_recent_work', { days: 7 })
    expect(r.days).toBe(7)
    expect(r.since).toBe('2026-10-26 00:00:00')
    expect(r.last_plan_date).toBeNull()
  })

  it('days 는 1~14 정수만 받는다', async () => {
    await expect(call('get_recent_work', { days: 0 })).rejects.toThrow()
    await expect(call('get_recent_work', { days: 15 })).rejects.toThrow()
    await expect(call('get_recent_work', { days: 1.5 })).rejects.toThrow()
  })
})

describe('list_meeting_action_items', () => {
  function seedMeetings(): void {
    seed(db, 'todos (id, title, is_completed)', [`(1, '미완료 할 일', 0)`, `(2, '완료 할 일', 1)`])
    seed(db, 'meetings (id, title, started_at, project_id)', [
      `(10, '최근 회의', '2026-11-01 10:00:00', 3)`,
      `(11, '이전 회의', '2026-10-28 10:00:00', NULL)`,
      `(12, '오래된 회의', '2026-09-01 10:00:00', NULL)`
    ])
    seed(db, 'meeting_summaries (id, meeting_id, action_items, generated_at)', [
      `(1, 10, '[{"text":"열린 항목","assignee":"김","due":"2026-11-05"},{"text":"미완료 todo","todo_id":1},{"text":"완료 todo","todo_id":2},{"text":"삭제된 todo","todo_id":99},{"text":"  "}]', '2026-11-01 11:00:00')`,
      `(2, 11, '[{"text":"이전 열린 항목"}]', '2026-10-28 11:00:00')`,
      `(3, 12, '[{"text":"60일 전 항목"}]', '2026-09-01 11:00:00')`
    ])
  }

  it('completed 기본값 false: todo 가 없거나 미완료인 항목만 돌려준다', async () => {
    seedMeetings()
    const r = await call('list_meeting_action_items')
    expect(r).toEqual([
      {
        meeting_id: 10,
        meeting_title: '최근 회의',
        meeting_started_at: '2026-11-01 10:00:00',
        project_id: 3,
        index: 0,
        text: '열린 항목',
        assignee: '김',
        due: '2026-11-05',
        todo_id: null,
        todo_completed: null
      },
      {
        meeting_id: 10,
        meeting_title: '최근 회의',
        meeting_started_at: '2026-11-01 10:00:00',
        project_id: 3,
        index: 1,
        text: '미완료 todo',
        assignee: null,
        due: null,
        todo_id: 1,
        todo_completed: false
      },
      {
        meeting_id: 11,
        meeting_title: '이전 회의',
        meeting_started_at: '2026-10-28 10:00:00',
        project_id: null,
        index: 0,
        text: '이전 열린 항목',
        assignee: null,
        due: null,
        todo_id: null,
        todo_completed: null
      }
    ])
  })

  it('completed true: 완료된 todo 항목만 돌려준다. 삭제된 todo 는 빠진다', async () => {
    seedMeetings()
    const r = await call('list_meeting_action_items', { completed: true })
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ meeting_id: 10, index: 2, text: '완료 todo', todo_id: 2, todo_completed: true })
  })

  it('days 는 요약 생성일 기준으로 거른다', async () => {
    seedMeetings()
    const r = await call('list_meeting_action_items', { days: 90 })
    expect(r.map((a: { text: string }) => a.text)).toContain('60일 전 항목')
    await expect(call('list_meeting_action_items', { days: 91 })).rejects.toThrow()
  })

  it('목록은 200건, text 는 300자에서 자른다', async () => {
    const longText = 'x'.repeat(ASSISTANT_TITLE_MAX + 20)
    const items = Array.from({ length: ASSISTANT_LIST_MAX + 50 }, () => ({ text: longText }))
    seed(db, 'meetings (id, title, started_at, project_id)', [`(1, '큰 회의', '2026-11-01 10:00:00', NULL)`])
    seed(db, 'meeting_summaries (id, meeting_id, action_items, generated_at)', [
      `(1, 1, '${JSON.stringify(items)}', '2026-11-01 11:00:00')`
    ])
    const r = await call('list_meeting_action_items')
    expect(r).toHaveLength(ASSISTANT_LIST_MAX)
    expect(r[0].text.startsWith('x'.repeat(ASSISTANT_TITLE_MAX))).toBe(true)
    expect(r[0].text.length).toBeLessThan(longText.length)
    expect(r[ASSISTANT_LIST_MAX - 1].index).toBe(ASSISTANT_LIST_MAX - 1)
  })
})

describe('A31 읽기 전용·네트워크 없음', () => {
  it('A31: 소스는 getDatabase·jira·google-calendar·ai-headless 를 import 하지 않는다', () => {
    const src = readFileSync(join(__dirname, 'ai-assistant-tools.ts'), 'utf-8')
    expect(src).not.toMatch(/from '\.\/jira'|from '\.\/google-calendar'|from '\.\/ai-headless'|\bgetDatabase\b/)
    expect(src).toMatch(/getAiReadOnlyDatabase/)
    expect(src).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/)
  })

  it('A31: 세 도구는 SELECT 만 실행하고 Jira·캘린더·쓰기 커넥션을 부르지 않는다', async () => {
    seed(db, PLAN_COLS, [
      `(1, '2026-10-31', 'closed', '2026-10-31 09:00:00', NULL, NULL, NULL, NULL, NULL, NULL)`,
      `(2, '${TODAY}', 'active', '${TODAY} 09:40:00', NULL, NULL, NULL, NULL, NULL, NULL)`
    ])
    seed(db, 'meetings (id, title, started_at, project_id)', [`(1, '회의', '2026-11-01 10:00:00', NULL)`])
    seed(db, 'meeting_summaries (id, meeting_id, action_items, generated_at)', [
      `(1, 1, '[{"text":"a","todo_id":1}]', '2026-11-01 11:00:00')`
    ])
    await call('get_today_plan')
    await call('get_recent_work', { days: 14 })
    await call('list_meeting_action_items', { completed: true })
    expect(state.networkCalls).toEqual([])
    expect(state.sql.length).toBeGreaterThan(0)
    for (const sql of state.sql) {
      expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/i)
    }
  })
})
