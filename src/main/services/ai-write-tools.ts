import { z } from 'zod'
import { BrowserWindow } from 'electron'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'
import { calculateQaDates } from '../utils/project-dates'
import { saveTodoHistory, saveTodoTags } from '../utils/todo-helpers'
import { logAiAudit } from './ai-audit'

// LinkWork 데이터 생성(쓰기) 도구.
//
// [가드레일] — docs/AI_GUARDRAILS.md 7절
// 1. 이 모듈은 AI 도구 중 유일하게 쓰기 커넥션(getDatabase)을 사용한다.
//    실행 전 반드시 사용자 승인(HITL)을 거친다 — ai-agent.ts의 canUseTool에서 강제.
// 2. 생성(create)만 지원한다. update/delete 도구는 만들지 않는다.
// 3. 도구 호출 1회 = 논리적 1건 생성. 포맷은 zod 스키마가 호출 레벨에서 강제한다.
// 4. 실행 결과는 ai_audit_log에 write_executed로 기록한다.

export const LINKWORK_WRITE_TOOL_NAMES = [
  'create_project',
  'create_todo',
  'create_memo',
  'create_variable'
].map((name) => `mcp__linkwork__${name}`)

const dateField = (desc: string): z.ZodString =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식').describe(desc)

function jsonResult(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] }
}

// AI가 데이터를 생성하면 열려 있는 화면(store)이 갱신되도록 renderer에 알린다.
function notifyDataChanged(entity: 'project' | 'todo' | 'memo' | 'variable'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('ai:dataChanged', { entity })
    }
  }
}

function logWriteExecuted(toolName: string, detail: string): void {
  logAiAudit({ event: 'write_executed', toolName, detail })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildWriteTools(): Promise<SdkMcpToolDefinition<any>[]> {
  const { tool } = await import('@anthropic-ai/claude-agent-sdk')

  const createProject = tool(
    'create_project',
    '새 프로젝트를 생성한다. tasks로 세부 작업(WBS)을 함께 등록할 수 있다. QA/배포 일정을 생략하면 개발 종료일 기준으로 자동 계산된다(QA: 개발종료 다음날부터 영업일 2일, 배포: QA 종료 다음날). 실행 전 사용자 승인이 필요하다.',
    {
      name: z.string().min(1).max(200).describe('프로젝트 이름'),
      description: z.string().max(2000).optional().describe('프로젝트 설명'),
      dev_start_date: dateField('개발 시작일'),
      dev_end_date: dateField('개발 종료일'),
      qa_start_date: dateField('QA 시작일 (생략 시 자동 계산)').optional(),
      qa_end_date: dateField('QA 종료일 (생략 시 자동 계산)').optional(),
      deploy_date: dateField('배포일 (생략 시 자동 계산)').optional(),
      deploy_version: z.string().max(50).optional().describe('배포 버전 (예: 1.2.0)'),
      tasks: z
        .array(
          z.object({
            name: z.string().min(1).max(200).describe('세부 작업 이름'),
            start_date: dateField('작업 시작일').optional(),
            end_date: dateField('작업 종료일').optional()
          })
        )
        .max(30)
        .optional()
        .describe('세부 작업(WBS) 목록 — 표시 순서대로 전달')
    },
    async (args) => {
      if (args.dev_start_date > args.dev_end_date) {
        return jsonResult({ error: '개발 시작일이 종료일보다 늦습니다.' })
      }
      const db = getDatabase()
      const defaults = calculateQaDates(args.dev_end_date)
      const tasks = args.tasks ?? []
      const insertProject = db.transaction(() => {
        const result = db
          .prepare(
            `INSERT INTO projects (name, description, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date, deploy_version, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`
          )
          .run(
            args.name,
            args.description ?? null,
            args.dev_start_date,
            args.dev_end_date,
            args.qa_start_date ?? defaults.qaStart,
            args.qa_end_date ?? defaults.qaEnd,
            args.deploy_date ?? defaults.deployDate,
            args.deploy_version ?? null
          )
        const projectId = result.lastInsertRowid
        logActivity('project', 'create', projectId, args.name, 'AI 생성')
        tasks.forEach((t, index) => {
          const taskResult = db
            .prepare(
              `INSERT INTO tasks (project_id, name, start_date, end_date, status, sort_order)
               VALUES (?, ?, ?, ?, 'pending', ?)`
            )
            .run(projectId, t.name, t.start_date ?? null, t.end_date ?? null, index)
          logActivity('task', 'create', taskResult.lastInsertRowid, t.name, 'AI 생성')
        })
        return projectId
      })
      const projectId = insertProject()
      logWriteExecuted('create_project', `id=${projectId}, name=${args.name}, tasks=${tasks.length}`)
      notifyDataChanged('project')
      return jsonResult({
        created: true,
        project_id: Number(projectId),
        name: args.name,
        task_count: tasks.length,
        link: `linkwork://project/${projectId}`
      })
    }
  )

  const createTodo = tool(
    'create_todo',
    '새 TODO를 생성한다. tags에 태그 이름을 전달하면 기존 태그는 연결하고 없는 태그는 새로 만든다. 실행 전 사용자 승인이 필요하다.',
    {
      title: z.string().min(1).max(200).describe('TODO 제목'),
      priority: z.enum(['high', 'medium', 'low']).optional().describe('우선순위 (기본 medium)'),
      due_date: dateField('마감일').optional(),
      notes: z.string().max(2000).optional().describe('노트 (마크다운 가능)'),
      tags: z
        .array(z.string().min(1).max(30))
        .max(5)
        .optional()
        .describe('태그 이름 목록 — 기존 태그와 정확히 같은 이름이면 연결, 없으면 생성')
    },
    async (args) => {
      const db = getDatabase()
      const tagNames = args.tags ?? []
      const createdTags: string[] = []
      const insertTodo = db.transaction(() => {
        const result = db
          .prepare(
            `INSERT INTO todos (title, priority, due_date, due_reminder, notes)
             VALUES (?, ?, ?, 0, ?)`
          )
          .run(args.title, args.priority ?? 'medium', args.due_date ?? null, args.notes ?? null)
        const todoId = result.lastInsertRowid
        const tagIds: number[] = []
        for (const name of tagNames) {
          const existing = db.prepare('SELECT id FROM todo_tags WHERE name = ?').get(name) as
            | { id: number }
            | undefined
          if (existing) {
            tagIds.push(existing.id)
          } else {
            const tagResult = db
              .prepare('INSERT INTO todo_tags (name, color) VALUES (?, ?)')
              .run(name, '#6B7280')
            tagIds.push(Number(tagResult.lastInsertRowid))
            createdTags.push(name)
            logActivity('todo_tag', 'create', tagResult.lastInsertRowid, name, 'AI 생성')
          }
        }
        if (tagIds.length > 0) saveTodoTags(db, todoId, tagIds)
        saveTodoHistory(db, todoId, 'create')
        logActivity('todo', 'create', todoId, args.title, 'AI 생성')
        return todoId
      })
      const todoId = insertTodo()
      logWriteExecuted('create_todo', `id=${todoId}, title=${args.title.slice(0, 50)}`)
      notifyDataChanged('todo')
      return jsonResult({
        created: true,
        todo_id: Number(todoId),
        title: args.title,
        new_tags: createdTags,
        link: 'linkwork://view/todos'
      })
    }
  )

  const createMemo = tool(
    'create_memo',
    '새 메모를 생성한다. 내용은 마크다운 형식. category에 카테고리 이름을 전달하면 기존 카테고리는 연결하고 없으면 새로 만든다. 실행 전 사용자 승인이 필요하다.',
    {
      content: z.string().min(1).max(10000).describe('메모 내용 (마크다운)'),
      is_important: z.boolean().optional().describe('중요 표시 여부'),
      category: z
        .string()
        .min(1)
        .max(50)
        .optional()
        .describe('카테고리 이름 — 기존 카테고리와 정확히 같은 이름이면 연결, 없으면 생성')
    },
    async (args) => {
      const db = getDatabase()
      let createdCategory: string | null = null
      const insertMemo = db.transaction(() => {
        let categoryId: number | null = null
        if (args.category) {
          const existing = db
            .prepare('SELECT id FROM memo_categories WHERE name = ?')
            .get(args.category) as { id: number } | undefined
          if (existing) {
            categoryId = existing.id
          } else {
            const maxRow = db
              .prepare('SELECT COALESCE(MAX(sort_order), -1) AS max FROM memo_categories')
              .get() as { max: number }
            const categoryResult = db
              .prepare('INSERT INTO memo_categories (name, color, sort_order) VALUES (?, ?, ?)')
              .run(args.category, '#6B7280', maxRow.max + 1)
            categoryId = Number(categoryResult.lastInsertRowid)
            createdCategory = args.category
            logActivity('memo_category', 'create', categoryResult.lastInsertRowid, args.category, 'AI 생성')
          }
        }
        const result = db
          .prepare(
            `INSERT INTO memos (content, color, is_important, category_id)
             VALUES (?, 'default', ?, ?)`
          )
          .run(args.content, args.is_important ? 1 : 0, categoryId)
        logActivity('memo', 'create', result.lastInsertRowid, args.content.slice(0, 50), 'AI 생성')
        return result.lastInsertRowid
      })
      const memoId = insertMemo()
      logWriteExecuted('create_memo', `id=${memoId}, length=${args.content.length}`)
      notifyDataChanged('memo')
      return jsonResult({
        created: true,
        memo_id: Number(memoId),
        new_category: createdCategory,
        link: 'linkwork://view/memos'
      })
    }
  )

  const createVariable = tool(
    'create_variable',
    '새 변수(key-value)를 생성한다. 같은 key가 이미 있으면 생성하지 않고 오류를 반환한다(수정은 변수 메뉴에서만 가능). 실행 전 사용자 승인이 필요하다.',
    {
      key: z.string().min(1).max(100).describe('변수 key'),
      value: z.string().min(1).max(2000).describe('변수 값'),
      description: z.string().max(500).optional().describe('변수 설명'),
      view_type: z
        .enum(['general', 'secret'])
        .optional()
        .describe('표시 방식 — secret이면 값이 마스킹됨 (기본 general)')
    },
    async (args) => {
      const db = getDatabase()
      const existing = db.prepare('SELECT id FROM variables WHERE key = ?').get(args.key) as
        | { id: number }
        | undefined
      if (existing) {
        return jsonResult({
          error: `key '${args.key}' 변수가 이미 존재합니다(id=${existing.id}). 값 수정은 변수 메뉴(linkwork://view/variables)에서 직접 해야 합니다.`
        })
      }
      const result = db
        .prepare(
          `INSERT INTO variables (key, value, description, view_type, sort_order)
           VALUES (?, ?, ?, ?, 0)`
        )
        .run(args.key, args.value, args.description ?? null, args.view_type ?? 'general')
      logActivity('variable', 'create', result.lastInsertRowid, args.key, 'AI 생성')
      logWriteExecuted('create_variable', `id=${result.lastInsertRowid}, key=${args.key}`)
      notifyDataChanged('variable')
      return jsonResult({
        created: true,
        variable_id: Number(result.lastInsertRowid),
        key: args.key,
        link: 'linkwork://view/variables'
      })
    }
  )

  return [createProject, createTodo, createMemo, createVariable]
}
