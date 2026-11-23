import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// list_todos·get_todo 가 출처 링크(source_link)를 돌려주는지 고정한다.
// better-sqlite3 → node:sqlite 교체. initDatabase() 의 실제 스키마로 검증한다. 사용자 DB 를 쓰지 않는다.
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

// 조회 도구는 읽기 전용 커넥션을 쓴다. 테스트에서는 같은 메모리 DB 를 읽게 한다
vi.mock('../db/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/database')>()
  return { ...actual, getAiReadOnlyDatabase: () => actual.getDatabase() }
})

// SDK 의 tool() 은 정의를 그대로, createSdkMcpServer() 는 도구 목록을 돌려주게 한다
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema: schema,
    handler
  }),
  createSdkMcpServer: (config: { tools: unknown[] }) => ({ tools: config.tools })
}))

// 외부 연동 모듈은 경계에서 막는다. 이 테스트는 할 일 조회만 본다
vi.mock('./ai-audit', () => ({ logAiAudit: vi.fn() }))
vi.mock('./ai-assistant-tools', () => ({ buildAssistantTools: () => [] }))
vi.mock('./google-calendar', () => ({ getEventsInRange: vi.fn() }))
vi.mock('./bitbucket', () => ({
  BITBUCKET_NOT_CONNECTED_MESSAGE: '',
  isBitbucketConnected: () => false,
  readBitbucketSource: vi.fn()
}))
vi.mock('./bitbucket-url', () => ({ isBitbucketUrl: () => false }))
vi.mock('./notion', () => ({
  getNotionDatabaseEntries: vi.fn(),
  getNotionPageContent: vi.fn(),
  isNotionConnected: () => false
}))
vi.mock('./notion-markdown', () => ({ extractNotionPageId: () => null }))
vi.mock('./release-note-sync', () => ({ sortReleaseNotes: <T>(rows: T[]): T[] => rows }))
vi.mock('./web-fetch', () => ({ fetchUrlAsText: vi.fn() }))

import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import { getLinkworkMcpServer } from './ai-tools'

type ToolResult = { content: { type: 'text'; text: string }[] }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const server = (await getLinkworkMcpServer()) as unknown as {
    tools: Array<{ name: string; handler: Handler }>
  }
  const t = server.tools.find((x) => x.name === name)
  if (!t) throw new Error(`${name} 없음`)
  const res = await t.handler(args)
  return JSON.parse(res.content[0].text)
}

function insertTodo(title: string, sourceLink: string | null): number {
  const result = getDatabase()
    .prepare('INSERT INTO todos (title, source_link) VALUES (?, ?)')
    .run(title, sourceLink)
  return Number(result.lastInsertRowid)
}

afterAll(() => {
  closeDatabase()
})

beforeEach(() => {
  closeDatabase()
  initDatabase()
})

describe('list_todos', () => {
  it('각 할 일의 source_link 를 돌려준다', async () => {
    insertTodo('메모에서 온 일', 'linkwork://memo/12')
    insertTodo('직접 만든 일', null)
    const rows = (await callTool('list_todos', {})) as { title: string; source_link: string | null }[]
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.source_link]))
    expect(byTitle).toEqual({ '메모에서 온 일': 'linkwork://memo/12', '직접 만든 일': null })
  })
})

describe('get_todo', () => {
  it('source_link 와 항목 링크를 돌려준다', async () => {
    const id = insertTodo('티켓 후속', 'https://x.atlassian.net/browse/AB-1')
    const row = await callTool('get_todo', { todo_id: id })
    expect(row).toMatchObject({
      id,
      title: '티켓 후속',
      source_link: 'https://x.atlassian.net/browse/AB-1',
      link: `linkwork://todo/${id}`
    })
  })
})
