import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3 → node:sqlite 교체.
// initDatabase() 의 실제 스키마로 검증한다. 사용자 DB 를 쓰지 않는다.
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

// SDK 의 tool() 은 정의를 그대로 돌려주게 한다. 핸들러를 직접 부르기 위해서다.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema: schema,
    handler
  })
}))
vi.mock('./ai-audit', () => ({ logAiAudit: vi.fn() }))

import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import { buildWriteTools, LINKWORK_WRITE_TOOL_NAMES } from './ai-write-tools'

type ToolResult = { content: { type: 'text'; text: string }[] }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tools = (await buildWriteTools()) as unknown as Array<{ name: string; handler: Handler }>
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`${name} 없음`)
  const res = await t.handler(args)
  return JSON.parse(res.content[0].text) as Record<string, unknown>
}


afterAll(() => {
  closeDatabase()
})

beforeEach(() => {
  closeDatabase()
  initDatabase()
})

describe('쓰기 도구 목록', () => {
  it('프로젝트·작업·문서 쓰기 도구는 없다', async () => {
    const tools = (await buildWriteTools()) as unknown as Array<{ name: string }>
    const names = tools.map((t) => t.name)
    // 문서 메뉴를 없앴다. 이름을 그대로 적지 않고 패턴으로 확인한다
    for (const name of names) expect(name).not.toMatch(/project|task|document/)
    // 등록한 도구와 자동 허용 이름 목록이 어긋나지 않는다
    expect(LINKWORK_WRITE_TOOL_NAMES).toEqual(names.map((n) => `mcp__linkwork__${n}`))
    expect(names).toEqual([
      'create_todo',
      'create_memo',
      'create_variable',
      'update_todo',
      'update_memo',
      'update_variable'
    ])
  })
})

describe('create_memo', () => {
  it('메모를 만들고 앱 내 링크를 돌려준다', async () => {
    const result = await callTool('create_memo', { content: '# 회의 메모' })

    expect(result).toMatchObject({ created: true })
    const row = getDatabase().prepare('SELECT content FROM memos ORDER BY id DESC LIMIT 1').get() as {
      content: string
    }
    expect(row.content).toBe('# 회의 메모')
  })
})
