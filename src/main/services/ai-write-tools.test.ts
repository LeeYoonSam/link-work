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

function documentById(id: number): Record<string, unknown> {
  return getDatabase().prepare('SELECT * FROM documents WHERE id = ?').get(id) as Record<string, unknown>
}

afterAll(() => {
  closeDatabase()
})

beforeEach(() => {
  closeDatabase()
  initDatabase()
})

describe('쓰기 도구 목록', () => {
  it('프로젝트·작업 쓰기 도구는 없다', async () => {
    const tools = (await buildWriteTools()) as unknown as Array<{ name: string }>
    const names = tools.map((t) => t.name)
    for (const removed of ['create_project', 'create_task', 'update_project', 'update_task']) {
      expect(names).not.toContain(removed)
      expect(LINKWORK_WRITE_TOOL_NAMES).not.toContain(`mcp__linkwork__${removed}`)
    }
    // 등록한 도구와 자동 허용 이름 목록이 어긋나지 않는다
    expect(LINKWORK_WRITE_TOOL_NAMES).toEqual(names.map((n) => `mcp__linkwork__${n}`))
  })
})

describe('create_document / update_document', () => {
  it('문서는 프로젝트 연결 없이 만든다', async () => {
    const result = await callTool('create_document', { name: '스펙', url: 'https://example.com/spec' })

    expect(result).toMatchObject({ created: true, name: '스펙' })
    expect(result.project_id).toBeUndefined()
    expect(documentById(Number(result.document_id)).project_id).toBeNull()
  })

  it('같은 url 이 이미 있으면 기존 행의 project_id 와 관계없이 만들지 않는다', async () => {
    // 옛 데이터: 프로젝트에 연결된 문서. 테이블은 남아 있다
    const db = getDatabase()
    const project = db
      .prepare(
        `INSERT INTO projects (name, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date)
         VALUES ('P', '2026-11-01', '2026-11-20', '2026-11-21', '2026-11-25', '2026-12-01')`
      )
      .run()
    db.prepare("INSERT INTO documents (name, url, type, project_id) VALUES ('옛 문서', 'https://example.com/a', 'link', ?)")
      .run(Number(project.lastInsertRowid))

    const result = await callTool('create_document', { name: '새 문서', url: 'https://example.com/a' })

    expect(String(result.error)).toContain('같은 url의 문서가 이미 있습니다')
  })

  it('update_document 는 project_id 를 받아도 바꾸지 않는다', async () => {
    const created = await callTool('create_document', { name: '스펙', url: 'https://example.com/spec' })
    const id = Number(created.document_id)

    const result = await callTool('update_document', { document_id: id, name: '새 스펙', project_id: 3 })

    expect(result).toMatchObject({ updated: true, updated_fields: ['name'] })
    expect(documentById(id)).toMatchObject({ name: '새 스펙', project_id: null })
  })
})
