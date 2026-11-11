import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3 → node:sqlite 교체. project-sync.test.ts 와 같은 방식이다.
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
import { buildWriteTools } from './ai-write-tools'

type ToolResult = { content: { type: 'text'; text: string }[] }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

async function updateTask(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tools = (await buildWriteTools()) as unknown as Array<{ name: string; handler: Handler }>
  const t = tools.find((x) => x.name === 'update_task')
  if (!t) throw new Error('update_task 없음')
  const res = await t.handler(args)
  return JSON.parse(res.content[0].text) as Record<string, unknown>
}

function seedTask(name: string, status: string, key: string | null): number {
  const db = getDatabase()
  const project = db
    .prepare(
      `INSERT INTO projects (name, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date, status)
       VALUES ('P', '2026-11-01', '2026-11-20', '2026-11-21', '2026-11-25', '2026-12-01', 'in_progress')`
    )
    .run()
  const res = db
    .prepare('INSERT INTO tasks (project_id, name, status, jira_issue_key) VALUES (?, ?, ?, ?)')
    .run(Number(project.lastInsertRowid), name, status, key)
  return Number(res.lastInsertRowid)
}

function taskById(id: number): { name: string; status: string; end_date: string | null } {
  return getDatabase().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as {
    name: string
    status: string
    end_date: string | null
  }
}

const NOTICE = 'Jira 연결 작업(PROJ-9053)의 상태는 Jira 를 따릅니다. Jira 에서 바꿔 주세요.'

afterAll(() => {
  closeDatabase()
})

beforeEach(() => {
  closeDatabase()
  initDatabase()
})

describe('R12 update_task — Jira 연결 작업 상태 잠금', () => {
  it('R12: Jira 연결 작업의 status 요청은 반영하지 않고 안내를 담는다. 다른 필드는 반영한다', async () => {
    const id = seedTask('배지 UI (PROJ-9053)', 'in_progress', 'PROJ-9053')

    const result = await updateTask({ task_id: id, status: 'done', end_date: '2026-12-01' })

    expect(result).toMatchObject({ updated: true, task_id: id, updated_fields: ['end_date'], notice: NOTICE })
    expect(taskById(id)).toMatchObject({ status: 'in_progress', end_date: '2026-12-01' })
  })

  it('R12: Jira 연결 작업에 status 만 요청하면 아무것도 바꾸지 않고 안내를 오류로 돌려준다', async () => {
    const id = seedTask('배지 UI (PROJ-9053)', 'pending', 'PROJ-9053')

    const result = await updateTask({ task_id: id, status: 'done' })

    expect(result).toEqual({ error: NOTICE })
    expect(taskById(id).status).toBe('pending')
  })

  it('R12: 수동 작업(키 없음)은 기존처럼 status 를 바꾸고 안내가 없다', async () => {
    const id = seedTask('수동 작업', 'pending', null)

    const result = await updateTask({ task_id: id, status: 'done' })

    expect(result).toMatchObject({ updated: true, updated_fields: ['status'] })
    expect(result.notice).toBeUndefined()
    expect(taskById(id).status).toBe('done')
  })

  it('R12: Jira 연결 작업이라도 status 를 보내지 않으면 안내가 없다', async () => {
    const id = seedTask('배지 UI (PROJ-9053)', 'pending', 'PROJ-9053')

    const result = await updateTask({ task_id: id, name: '새 이름' })

    expect(result).toMatchObject({ updated: true, updated_fields: ['name'] })
    expect(result.notice).toBeUndefined()
    expect(taskById(id).name).toBe('새 이름')
  })
})
