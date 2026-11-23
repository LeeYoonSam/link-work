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
const audit = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('./ai-audit', () => ({ logAiAudit: audit.log }))

// 승인 카드의 변경 전 값 조회는 읽기 전용 커넥션을 쓴다. 테스트에서는 같은 메모리 DB 를 읽게 한다
vi.mock('../db/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/database')>()
  return { ...actual, getAiReadOnlyDatabase: () => actual.getDatabase() }
})

// 이력 저장을 감싸 중간 실패를 주입한다. 기본은 실제 함수를 그대로 부른다
const history = vi.hoisted(() => ({ failTitle: null as string | null }))
vi.mock('../utils/todo-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/todo-helpers')>()
  return {
    ...actual,
    saveTodoHistory: (...args: Parameters<typeof actual.saveTodoHistory>): void => {
      const [db, todoId] = args
      const row = db.prepare('SELECT title FROM todos WHERE id = ?').get(todoId) as
        | { title: string }
        | undefined
      if (history.failTitle !== null && row?.title === history.failTitle) {
        throw new Error('이력 저장 실패(주입)')
      }
      actual.saveTodoHistory(...args)
    }
  }
})

import { z } from 'zod'
import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import { buildWriteTools, getUpdatePreview, LINKWORK_WRITE_TOOL_NAMES } from './ai-write-tools'

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
  history.failTitle = null
  audit.log.mockReset()
})

// 도구의 zod 입력 규칙으로 args 를 검사한다. SDK 가 핸들러 전에 하는 검사와 같다
async function parseArgs(name: string, args: Record<string, unknown>): Promise<boolean> {
  const tools = (await buildWriteTools()) as unknown as Array<{
    name: string
    inputSchema: z.ZodRawShape
  }>
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`${name} 없음`)
  return z.object(t.inputSchema).safeParse(args).success
}

function countTodos(): number {
  return (getDatabase().prepare('SELECT COUNT(*) AS n FROM todos').get() as { n: number }).n
}

describe('쓰기 도구 목록', () => {
  it('프로젝트·작업·문서·변수 쓰기 도구는 없다', async () => {
    const tools = (await buildWriteTools()) as unknown as Array<{ name: string }>
    const names = tools.map((t) => t.name)
    // 문서 메뉴를 없앴다. 이름을 그대로 적지 않고 패턴으로 확인한다
    for (const name of names) expect(name).not.toMatch(/project|task|document|variable/)
    // 등록한 도구와 자동 허용 이름 목록이 어긋나지 않는다
    expect(LINKWORK_WRITE_TOOL_NAMES).toEqual(names.map((n) => `mcp__linkwork__${n}`))
    expect(names).toEqual(['create_todo', 'create_todos', 'create_memo', 'update_todo', 'update_memo'])
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

describe('create_todo', () => {
  it('source_link 를 저장한다', async () => {
    const result = await callTool('create_todo', {
      title: '회의 후속',
      source_link: ' linkwork://note/5 '
    })
    expect(result).toMatchObject({ created: true, title: '회의 후속' })
    const row = getDatabase()
      .prepare('SELECT source_link FROM todos WHERE id = ?')
      .get(result.todo_id as number) as { source_link: string | null }
    expect(row.source_link).toBe('linkwork://note/5')
  })

  it('source_link 가 없으면 null 로 저장한다', async () => {
    const result = await callTool('create_todo', { title: '그냥 할 일' })
    const row = getDatabase()
      .prepare('SELECT source_link FROM todos WHERE id = ?')
      .get(result.todo_id as number) as { source_link: string | null }
    expect(row.source_link).toBeNull()
  })

  it('형식이 틀린 source_link 는 저장하지 않고 오류를 돌려준다', async () => {
    const result = await callTool('create_todo', { title: 'x', source_link: 'javascript:alert(1)' })
    expect(result).toEqual({ error: '출처 링크 형식이 올바르지 않습니다.' })
    expect(countTodos()).toBe(0)
  })
})

describe('create_todos', () => {
  it('3건을 만들고 이력·태그 연결·링크를 남긴다', async () => {
    const result = await callTool('create_todos', {
      items: [
        { title: '자료 정리', priority: 'high', due_date: '2026-11-21', tags: ['회의'] },
        { title: '메일 회신', due_date: '2026-11-22 10:00' },
        { title: '리뷰 요청', tags: ['회의', '리뷰'] }
      ]
    })
    expect(result.created).toBe(3)
    const todos = result.todos as { todo_id: number; title: string; link: string }[]
    expect(todos.map((t) => t.title)).toEqual(['자료 정리', '메일 회신', '리뷰 요청'])
    for (const t of todos) {
      expect(t.todo_id).toBeGreaterThan(0)
      expect(t.link).toBe(`linkwork://todo/${t.todo_id}`)
    }
    expect(result.new_tags).toEqual(['회의', '리뷰'])

    const db = getDatabase()
    expect(countTodos()).toBe(3)
    const rows = db
      .prepare('SELECT title, priority, due_reminder FROM todos ORDER BY id')
      .all() as { title: string; priority: string; due_reminder: number }[]
    expect(rows.map((r) => r.priority)).toEqual(['high', 'medium', 'medium'])
    expect(rows.map((r) => r.due_reminder)).toEqual([0, 1, 0])
    const historyCount = db
      .prepare("SELECT COUNT(*) AS n FROM todo_history WHERE action = 'create'")
      .get() as { n: number }
    expect(historyCount.n).toBe(3)
    const tagNames = db
      .prepare(
        `SELECT g.name FROM todo_tag_map m JOIN todo_tags g ON g.id = m.tag_id
         WHERE m.todo_id = ? ORDER BY g.name`
      )
      .all(todos[2].todo_id) as { name: string }[]
    expect(tagNames.map((r) => r.name)).toEqual(['리뷰', '회의'])
    // 감사 로그는 1건이며 건수와 id 목록을 남긴다
    const executed = audit.log.mock.calls.filter(([e]) => e.event === 'write_executed')
    expect(executed).toHaveLength(1)
    expect(executed[0][0]).toMatchObject({
      toolName: 'create_todos',
      detail: `count=3, ids=${todos.map((t) => t.todo_id).join(',')}`
    })
  })

  it('source_link 를 모든 항목에 저장한다', async () => {
    await callTool('create_todos', {
      items: [{ title: 'a' }, { title: 'b' }],
      source_link: 'https://x.atlassian.net/browse/AB-1'
    })
    const rows = getDatabase().prepare('SELECT source_link FROM todos').all() as {
      source_link: string
    }[]
    expect(rows.map((r) => r.source_link)).toEqual([
      'https://x.atlassian.net/browse/AB-1',
      'https://x.atlassian.net/browse/AB-1'
    ])
  })

  it('형식이 틀린 source_link 는 아무것도 저장하지 않는다', async () => {
    const result = await callTool('create_todos', {
      items: [{ title: 'a' }],
      source_link: 'http://a'
    })
    expect(result).toEqual({ error: '출처 링크 형식이 올바르지 않습니다.' })
    expect(countTodos()).toBe(0)
  })

  it('빈 배열·21건·잘못된 due_date 는 입력 규칙에서 거부한다', async () => {
    expect(await parseArgs('create_todos', { items: [{ title: 'a' }] })).toBe(true)
    expect(await parseArgs('create_todos', { items: [] })).toBe(false)
    const many = Array.from({ length: 21 }, (_, i) => ({ title: `t${i}` }))
    expect(await parseArgs('create_todos', { items: many })).toBe(false)
    expect(await parseArgs('create_todos', { items: many.slice(0, 20) })).toBe(true)
    expect(
      await parseArgs('create_todos', { items: [{ title: 'a', due_date: '11월 21일' }] })
    ).toBe(false)
  })

  it('중간 항목이 실패하면 전부 되돌린다', async () => {
    history.failTitle = '두 번째'
    const result = await callTool('create_todos', {
      items: [{ title: '첫 번째', tags: ['새 태그'] }, { title: '두 번째' }, { title: '세 번째' }]
    })
    expect(String(result.error)).toContain('아무것도 저장하지 않았습니다')
    const db = getDatabase()
    expect(countTodos()).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM todo_history').get() as { n: number }).n).toBe(0)
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM todo_tags WHERE name = '새 태그'").get() as { n: number }).n
    ).toBe(0)
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'write_executed' }))
  })
})

describe('getUpdatePreview', () => {
  it('update_todo 의 변경 전 값에 source_link 가 있다', async () => {
    const created = await callTool('create_todo', { title: 'x', source_link: 'linkwork://memo/3' })
    const preview = getUpdatePreview('update_todo', { todo_id: created.todo_id })
    expect(preview).toMatchObject({ title: 'x', source_link: 'linkwork://memo/3' })
  })
})
