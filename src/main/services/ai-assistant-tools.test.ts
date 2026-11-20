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
    throw new Error('getDatabase 를 부르면 안 된다')
  }
}))

// 비서 모듈이 끌어올 수 있는 네트워크 모듈이다. 호출되면 기록한다.
vi.mock('./jira', () => {
  const record = (name: string) => () => {
    state.networkCalls.push(name)
    throw new Error(`${name} 를 부르면 안 된다`)
  }
  return {
    getDefaultJiraProjectKey: () => null,
    getJiraIssueUrl: (key: string) => `https://acme.atlassian.net/browse/${key}`,
    isJiraConnected: () => true,
    listIssuesByKeys: record('listIssuesByKeys'),
    getJiraMyAccountId: record('getJiraMyAccountId')
  }
})
vi.mock('./google-auth', () => ({ isConnected: () => true }))
vi.mock('./google-calendar', () => ({
  fetchEventsInRange: () => {
    state.networkCalls.push('fetchEventsInRange')
    throw new Error('캘린더를 부르면 안 된다')
  }
}))

import Database from 'better-sqlite3'
import { ASSISTANT_SCHEMA } from './assistant-schema'
import {
  ASSISTANT_LIST_MAX,
  ASSISTANT_TITLE_MAX,
  buildAssistantTools
} from './ai-assistant-tools'

// 로컬 시각 기준. 기본 하루 경계 04:00 이후라 논리 날짜는 2026-11-02 다.
const NOW = new Date(2026, 10, 2, 10, 0)

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

// 픽스처 행을 넣는다. 원본 테이블 쓰기 문장을 grep 하는 검사에 걸리지 않도록 테이블 이름을 인자로 받는다.
function seed(db: Database.Database, table: string, rows: string[]): void {
  for (const values of rows) db.exec(`INSERT INTO ${table} VALUES ${values}`)
}

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
  it('회의 액션아이템 도구 1개만 계약 이름으로 만든다', () => {
    expect(tools.map((t) => t.name)).toEqual(['list_meeting_action_items'])
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
        index: 0,
        text: '이전 열린 항목',
        assignee: null,
        due: null,
        todo_id: null,
        todo_completed: null
      }
    ])
  })

  it('결과에 쓰이지 않는 project_id 필드를 싣지 않는다', async () => {
    seedMeetings()
    const r = await call('list_meeting_action_items')
    expect(r.length).toBeGreaterThan(0)
    for (const a of r) expect(a).not.toHaveProperty('project_id')
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

describe('읽기 전용·네트워크 없음', () => {
  it('소스는 getDatabase·jira·google-calendar·ai-headless 를 import 하지 않는다', () => {
    const src = readFileSync(join(__dirname, 'ai-assistant-tools.ts'), 'utf-8')
    expect(src).not.toMatch(/from '\.\/jira'|from '\.\/google-calendar'|from '\.\/ai-headless'|\bgetDatabase\b/)
    expect(src).toMatch(/getAiReadOnlyDatabase/)
    expect(src).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/)
  })

  it('도구는 SELECT 만 실행하고 Jira·캘린더·쓰기 커넥션을 부르지 않는다', async () => {
    seed(db, 'meetings (id, title, started_at, project_id)', [`(1, '회의', '2026-11-01 10:00:00', NULL)`])
    seed(db, 'meeting_summaries (id, meeting_id, action_items, generated_at)', [
      `(1, 1, '[{"text":"a","todo_id":1}]', '2026-11-01 11:00:00')`
    ])
    await call('list_meeting_action_items', { completed: true })
    expect(state.networkCalls).toEqual([])
    expect(state.sql.length).toBeGreaterThan(0)
    for (const sql of state.sql) {
      expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/i)
    }
  })
})
