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

// ipcMain.handle 로 등록된 핸들러를 모아 직접 호출한다.
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { getPath: () => '/linkwork-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))

import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import { registerTaskIpc } from './task.ipc'

interface TaskRow {
  id: number
  name: string
  status: string
  end_date: string | null
  jira_issue_key: string | null
}

function invoke(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`핸들러 없음: ${channel}`)
  return fn({}, ...args)
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

function taskById(id: number): TaskRow {
  return getDatabase().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow
}

afterAll(() => {
  closeDatabase()
})

beforeEach(() => {
  closeDatabase()
  initDatabase()
  handlers.clear()
  registerTaskIpc()
})

describe('R12 task:update — Jira 연결 작업 상태 잠금', () => {
  it('R12: Jira 연결 작업은 status 를 무시하고 나머지 필드만 반영한다. 오류 없이 갱신된 행을 돌려준다', () => {
    const id = seedTask('배지 UI (PROJ-9053)', 'in_progress', 'PROJ-9053')

    const row = invoke('task:update', id, {
      status: 'done',
      name: '배지 UI 새 이름',
      end_date: '2026-12-01'
    }) as TaskRow

    expect(row).toMatchObject({
      id,
      name: '배지 UI 새 이름',
      end_date: '2026-12-01',
      status: 'in_progress',
      jira_issue_key: 'PROJ-9053'
    })
    expect(taskById(id).status).toBe('in_progress')
  })

  it("R12: status 만 보내면 아무것도 바꾸지 않고 현재 행을 돌려준다 ('원본 완료' 경로)", () => {
    const id = seedTask('배지 UI (PROJ-9053)', 'pending', 'PROJ-9053')

    const row = invoke('task:update', id, { status: 'done' }) as TaskRow

    expect(row).toMatchObject({ id, status: 'pending' })
    const logs = getDatabase()
      .prepare("SELECT COUNT(*) AS n FROM activity_log WHERE entity_type = 'task'")
      .get() as { n: number }
    expect(logs.n).toBe(0)
  })

  it('R12: 수동 작업(키 없음)은 기존처럼 status 를 바꾼다', () => {
    const id = seedTask('수동 작업', 'pending', null)

    const row = invoke('task:update', id, { status: 'done' }) as TaskRow

    expect(row.status).toBe('done')
    expect(taskById(id).status).toBe('done')
  })

  it('R12: 키가 빈 문자열이면 수동 작업으로 본다', () => {
    const id = seedTask('빈 키 작업', 'pending', '')

    invoke('task:update', id, { status: 'in_progress' })

    expect(taskById(id).status).toBe('in_progress')
  })
})
