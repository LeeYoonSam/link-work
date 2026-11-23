import { z } from 'zod'
import { BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { getAiReadOnlyDatabase, getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'
import { MEMO_WITH_CATEGORY_SELECT, setMemoArchived } from '../utils/memo-helpers'
import {
  normalizeSourceLink,
  saveTodoHistory,
  saveTodoTags,
  setTodoCompletion,
  TODO_TAGS_SUBQUERY
} from '../utils/todo-helpers'
import { logAiAudit } from './ai-audit'

// LinkWork 데이터 생성·수정(쓰기) 도구.
//
// [가드레일] — docs/AI_GUARDRAILS.md 7절
// 1. 이 모듈은 AI 도구 중 유일하게 쓰기 커넥션(getDatabase)을 사용한다.
//    실행 전 반드시 사용자 승인(HITL)을 거친다 — ai-agent.ts의 canUseTool에서 강제.
// 2. 생성(create)·수정(update)만 지원한다. delete 도구는 만들지 않는다
//    (메모 보관/TODO 완료 같은 가역적 상태 변경은 update로 허용).
// 3. 도구 호출 1회 = 논리적 1건 변경. 포맷은 zod 스키마가 호출 레벨에서 강제한다.
//    수정은 전달된 필드만 부분 업데이트하며, 대상 id가 없으면 오류를 반환한다.
//    예외는 create_todos 하나다. 생성만 하고, 최대 20건을 한 트랜잭션으로 넣는다.
//    승인 카드가 전 항목을 보여 주므로 승인 1회가 목록 전체를 승인한다.
//    일괄 수정·삭제 도구는 만들지 않는다.
// 4. 실행 결과는 ai_audit_log에 write_executed로 기록한다.
// 5. 변수(Variables)는 쓰기 도구를 두지 않는다. 사용자가 변수 메뉴에서 직접 관리한다.

export const LINKWORK_WRITE_TOOL_NAMES = [
  'create_todo',
  'create_todos',
  'create_memo',
  'update_todo',
  'update_memo'
].map((name) => `mcp__linkwork__${name}`)

// TODO 마감일은 알람 시각을 포함할 수 있다: 'YYYY-MM-DD' 또는 'YYYY-MM-DD HH:mm'.
// 시각이 포함되면 알람(due_reminder)이 켜진 것으로 간주한다 (할 일 화면과 todoModel.shiftDueDate 가 따르는 규약).
// 초(:ss)는 레거시 데이터를 그대로 되돌려 쓸 수 있도록 선택적으로 허용한다.
const todoDueField = (desc: string): z.ZodString =>
  z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/,
      "YYYY-MM-DD 또는 'YYYY-MM-DD HH:mm' 형식"
    )
    .describe(desc)

// due_date에 'HH:mm' 시각이 포함되어 있는지 — 알람 활성 여부 판별 (notification.ts와 동일 규약)
function dueDateHasTime(due: string | null): boolean {
  return due !== null && / \d{2}:\d{2}/.test(due)
}

// 잘림 표시 마커. 조회 도구가 본문을 자를 때 덧붙이며(ai-tools.ts truncate),
// 쓰기 도구는 이 마커가 섞인 본문을 거부해 "잘린 내용 되쓰기"로 인한 데이터 유실을 막는다.
export const TRUNCATION_MARKER = '…(생략)'

// create_todos 한 번에 만들 수 있는 최대 건수 (docs/AI_GUARDRAILS.md 7절)
export const CREATE_TODOS_MAX = 20

// 할 일 1건의 입력 규칙. create_todo 와 create_todos 의 각 원소가 같이 쓴다
const todoItemShape = {
  title: z.string().min(1).max(200).describe('TODO 제목'),
  priority: z.enum(['high', 'medium', 'low']).optional().describe('우선순위 (기본 medium)'),
  due_date: todoDueField("마감일 — 시각을 넣으면 알람 설정('YYYY-MM-DD HH:mm')").optional(),
  notes: z.string().max(2000).optional().describe('노트 (마크다운 가능)'),
  tags: z
    .array(z.string().min(1).max(30))
    .max(5)
    .optional()
    .describe('태그 이름 목록 — 기존 태그와 정확히 같은 이름이면 연결, 없으면 생성')
}

interface TodoItemInput {
  title: string
  priority?: 'high' | 'medium' | 'low'
  due_date?: string
  notes?: string
  tags?: string[]
}

const sourceLinkField = z
  .string()
  .max(500)
  .optional()
  .describe(
    '출처 링크 — 메모·회의록 등에서 나온 할 일이면 그 앱 내 링크(예: linkwork://memo/12, linkwork://note/5), Jira 티켓이면 https URL'
  )

// 할 일 1건을 INSERT 한다(태그 연결·이력·활동 로그 포함). 트랜잭션은 호출자가 연다.
// create_todo 와 create_todos 가 함께 쓴다
function insertTodo(
  db: Database.Database,
  item: TodoItemInput,
  sourceLink: string | null
): { todoId: number; createdTags: string[] } {
  const due = item.due_date ?? null
  const reminder = dueDateHasTime(due) ? 1 : 0
  const result = db
    .prepare(
      `INSERT INTO todos (title, priority, due_date, due_reminder, notes, source_link)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(item.title, item.priority ?? 'medium', due, reminder, item.notes ?? null, sourceLink)
  const todoId = Number(result.lastInsertRowid)
  const resolved = resolveTodoTagIds(db, item.tags ?? [])
  if (resolved.tagIds.length > 0) saveTodoTags(db, todoId, resolved.tagIds)
  saveTodoHistory(db, todoId, 'create')
  logActivity('todo', 'create', todoId, item.title, 'AI 생성')
  return { todoId, createdTags: resolved.createdTags }
}

// 출처 링크 검증. 형식이 틀리면 오류 문구를 돌려준다
function parseSourceLink(value: unknown): { link: string | null } | { error: string } {
  try {
    return { link: normalizeSourceLink(value) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

function jsonResult(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] }
}

// AI가 데이터를 생성하면 열려 있는 화면(store)이 갱신되도록 renderer에 알린다.
function notifyDataChanged(entity: 'todo' | 'memo'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('ai:dataChanged', { entity })
    }
  }
}

function logWriteExecuted(toolName: string, detail: string): void {
  logAiAudit({ event: 'write_executed', toolName, detail })
}

// 전달된(undefined가 아닌) 필드만 SET 절로 변환한다. null은 "값 비우기"로 허용.
function buildSetClause(
  args: Record<string, unknown>,
  columns: string[]
): { set: string[]; values: unknown[]; keys: string[] } {
  const set: string[] = []
  const values: unknown[] = []
  const keys: string[] = []
  for (const col of columns) {
    if (args[col] !== undefined) {
      set.push(`${col} = ?`)
      values.push(args[col])
      keys.push(col)
    }
  }
  return { set, values, keys }
}

// 태그 이름 목록 → 태그 id 변환. 기존 태그는 연결, 없는 태그는 생성 (create/update 공용)
function resolveTodoTagIds(
  db: Database.Database,
  tagNames: string[]
): { tagIds: number[]; createdTags: string[] } {
  const tagIds: number[] = []
  const createdTags: string[] = []
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
  return { tagIds, createdTags }
}

// 카테고리 이름 → 카테고리 id 변환. 없으면 생성 (create/update 공용)
function resolveMemoCategory(
  db: Database.Database,
  name: string
): { categoryId: number; created: boolean } {
  const existing = db.prepare('SELECT id FROM memo_categories WHERE name = ?').get(name) as
    | { id: number }
    | undefined
  if (existing) return { categoryId: existing.id, created: false }
  const maxRow = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS max FROM memo_categories')
    .get() as { max: number }
  const categoryResult = db
    .prepare('INSERT INTO memo_categories (name, color, sort_order) VALUES (?, ?, ?)')
    .run(name, '#6B7280', maxRow.max + 1)
  logActivity('memo_category', 'create', categoryResult.lastInsertRowid, name, 'AI 생성')
  return { categoryId: Number(categoryResult.lastInsertRowid), created: true }
}

// 수정 도구 승인 카드에 "변경 전 현재 값"을 표시하기 위한 조회.
// 승인 전 단계의 조회이므로 읽기 전용 커넥션을 사용한다 (가드레일 1절).
// 조회 실패가 승인 흐름을 막지 않도록 항상 null 폴백.
export function getUpdatePreview(
  shortName: string,
  input: unknown
): Record<string, unknown> | null {
  const args = (input ?? {}) as Record<string, unknown>
  try {
    const db = getAiReadOnlyDatabase()
    switch (shortName) {
      case 'update_todo': {
        const row = db
          .prepare(
            `SELECT t.id, t.title, t.priority, t.due_date, t.due_reminder, t.is_completed, t.notes,
                    t.source_link, ${TODO_TAGS_SUBQUERY}
             FROM todos t WHERE t.id = ?`
          )
          .get(args.todo_id) as ({ notes: string | null } & Record<string, unknown>) | undefined
        if (!row) return null
        const notes =
          row.notes && row.notes.length > 300 ? row.notes.slice(0, 300) + TRUNCATION_MARKER : row.notes
        return { ...row, notes }
      }
      case 'update_memo': {
        const row = db
          .prepare(
            `${MEMO_WITH_CATEGORY_SELECT} WHERE m.id = ?`
          )
          .get(args.memo_id) as ({ content: string } & Record<string, unknown>) | undefined
        if (!row) return null
        const content =
          row.content.length > 500 ? row.content.slice(0, 500) + TRUNCATION_MARKER : row.content
        return { ...row, content }
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildWriteTools(): Promise<SdkMcpToolDefinition<any>[]> {
  const { tool } = await import('@anthropic-ai/claude-agent-sdk')

  const createTodo = tool(
    'create_todo',
    '새 TODO를 생성한다. tags에 태그 이름을 전달하면 기존 태그는 연결하고 없는 태그는 새로 만든다. due_date에 시각(HH:mm)을 포함하면 마감 알람이 켜진다. 메모·회의록 등에서 나온 할 일이면 source_link에 그 링크를 넣는다. 여러 건이면 create_todos를 쓴다. 실행 전 사용자 승인이 필요하다.',
    { ...todoItemShape, source_link: sourceLinkField },
    async (args) => {
      const parsed = parseSourceLink(args.source_link)
      if ('error' in parsed) return jsonResult({ error: parsed.error })
      const sourceLink = parsed.link
      const db = getDatabase()
      const run = db.transaction(() => insertTodo(db, args, sourceLink))
      const { todoId, createdTags } = run()
      logWriteExecuted('create_todo', `id=${todoId}, title=${args.title.slice(0, 50)}`)
      notifyDataChanged('todo')
      return jsonResult({
        created: true,
        todo_id: todoId,
        title: args.title,
        new_tags: createdTags,
        link: `linkwork://todo/${todoId}`
      })
    }
  )

  // 할 일 여러 건 생성 — 쓰기 도구 중 유일한 다건 도구다(가드레일 7절 3번의 예외).
  // 생성만 하고, 최대 20건을 한 트랜잭션으로 넣는다. 하나라도 실패하면 전부 되돌린다
  const createTodos = tool(
    'create_todos',
    `할 일을 여러 건 한 번에 생성한다(1~${CREATE_TODOS_MAX}건). 사용자가 여러 할 일을 한 번에 요청하거나 글·회의 내용을 할 일로 나눠 달라고 할 때 쓴다. 1건이면 create_todo를 쓴다. 각 항목의 규칙은 create_todo와 같다. source_link는 모든 항목에 같이 저장된다. 승인 카드에 전 항목이 표시되고 승인 1회로 모두 실행된다. 하나라도 실패하면 아무것도 저장하지 않는다.`,
    {
      items: z
        .array(z.object(todoItemShape))
        .min(1)
        .max(CREATE_TODOS_MAX)
        .describe(`만들 할 일 목록 (1~${CREATE_TODOS_MAX}건)`),
      source_link: sourceLinkField
    },
    async (args) => {
      const parsed = parseSourceLink(args.source_link)
      if ('error' in parsed) return jsonResult({ error: parsed.error })
      const sourceLink = parsed.link
      const db = getDatabase()
      const run = db.transaction(() => {
        const created: { todo_id: number; title: string; link: string }[] = []
        const newTags: string[] = []
        for (const item of args.items) {
          const { todoId, createdTags } = insertTodo(db, item, sourceLink)
          created.push({ todo_id: todoId, title: item.title, link: `linkwork://todo/${todoId}` })
          newTags.push(...createdTags)
        }
        return { created, newTags }
      })
      let outcome: ReturnType<typeof run>
      try {
        outcome = run()
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return jsonResult({ error: `할 일을 만들지 못했습니다. 아무것도 저장하지 않았습니다: ${message}` })
      }
      const ids = outcome.created.map((t) => t.todo_id)
      logWriteExecuted('create_todos', `count=${ids.length}, ids=${ids.join(',')}`)
      notifyDataChanged('todo')
      return jsonResult({
        created: outcome.created.length,
        todos: outcome.created,
        new_tags: outcome.newTags
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
          const resolved = resolveMemoCategory(db, args.category)
          categoryId = resolved.categoryId
          if (resolved.created) createdCategory = args.category
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
        link: `linkwork://memo/${memoId}`
      })
    }
  )

  // ── 수정(update) 도구 — 전달된 필드만 부분 업데이트, 대상 미존재 시 오류 ──

  const updateTodo = tool(
    'update_todo',
    "기존 TODO를 수정한다. todo_id로 대상을 지정하고 변경할 필드만 전달한다. notes는 전체 교체되므로 부분 수정 시 get_todo로 기존 내용을 확인해 수정된 전체 내용을 전달할 것. completed로 완료 처리/완료 취소가 가능하다. 마감일을 옮길 때 기존에 알람이 설정돼 있었다면(get_todo의 due_reminder=1) 시각을 유지하려면 'YYYY-MM-DD HH:mm'으로 전달해야 한다 — 날짜만 전달하면 알람이 해제된다. 실행 전 사용자 승인이 필요하다.",
    {
      todo_id: z.number().int().positive().describe('수정할 TODO id (조회 도구로 먼저 확인)'),
      title: z.string().min(1).max(200).optional().describe('TODO 제목'),
      priority: z.enum(['high', 'medium', 'low']).optional().describe('우선순위'),
      due_date: todoDueField(
        "마감일 (null이면 비움). 시각을 포함하면('YYYY-MM-DD HH:mm') 알람 설정, 날짜만이면 알람 해제"
      )
        .nullable()
        .optional(),
      notes: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe('노트 (마크다운) — 전체 교체됨. null이면 비움'),
      completed: z.boolean().optional().describe('true면 완료 처리, false면 완료 취소(복원)'),
      tags: z
        .array(z.string().min(1).max(30))
        .max(5)
        .optional()
        .describe('태그 이름 목록 — 기존 태그를 전부 이 목록으로 교체. 빈 배열이면 태그 모두 해제')
    },
    async (args) => {
      const db = getDatabase()
      const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(args.todo_id) as
        | { title: string; is_completed: number }
        | undefined
      if (!row) {
        return jsonResult({
          error: `TODO id=${args.todo_id}를 찾지 못했습니다. 조회 도구로 id를 확인하세요.`
        })
      }
      if (args.notes != null && args.notes.includes(TRUNCATION_MARKER)) {
        return jsonResult({
          error: `노트에 잘림 표시("${TRUNCATION_MARKER}")가 포함되어 있습니다. list_todos의 잘린 노트를 그대로 되쓰면 내용이 유실됩니다. get_todo로 전문을 조회한 뒤 수정된 전체 노트를 전달하세요.`
        })
      }
      const createdTags: string[] = []
      const applyUpdate = db.transaction((): string[] | null => {
        // 실제 완료 상태 전이 여부 — 활동 로그/이력 action을 정확히 기록하기 위해 추적
        let completionChange: 'complete' | 'restore' | null = null
        if (args.completed === true && !row.is_completed) completionChange = 'complete'
        else if (args.completed === false && row.is_completed) completionChange = 'restore'

        const { set, values, keys } = buildSetClause(args, ['title', 'priority', 'due_date', 'notes'])
        // due_date에 시각이 있으면 알람 on, 날짜만/비움이면 off — 할 일 화면(todoModel.shiftDueDate) 규약과 같다
        if (args.due_date !== undefined) {
          set.push('due_reminder = ?')
          values.push(dueDateHasTime(args.due_date ?? null) ? 1 : 0)
        }
        if (set.length > 0) {
          set.push("updated_at = datetime('now', 'localtime')")
          db.prepare(`UPDATE todos SET ${set.join(', ')} WHERE id = ?`).run(...values, args.todo_id)
        }
        // 완료/복원 전이는 메뉴(todo:complete/restore)와 동일한 공용 헬퍼로 처리 — SQL 규약 단일화
        if (completionChange) {
          setTodoCompletion(db, args.todo_id, completionChange === 'complete')
          keys.push('completed')
        }
        if (args.tags !== undefined) {
          const resolved = resolveTodoTagIds(db, args.tags)
          saveTodoTags(db, args.todo_id, resolved.tagIds)
          createdTags.push(...resolved.createdTags)
          keys.push('tags')
        }
        if (keys.length === 0) return null
        // 전이가 있으면 활동 로그·이력에 complete/restore로 기록한다 — 메뉴와 같은 기록이다
        const action = completionChange ?? 'update'
        saveTodoHistory(db, args.todo_id, action)
        logActivity('todo', action, args.todo_id, args.title ?? row.title, `AI 수정: ${keys.join(', ')}`)
        return keys
      })
      const keys = applyUpdate()
      if (!keys) {
        return jsonResult({ error: '변경 사항이 없습니다 (필드 미전달 또는 이미 해당 상태).' })
      }
      logWriteExecuted('update_todo', `id=${args.todo_id}, fields=${keys.join(',')}`)
      notifyDataChanged('todo')
      return jsonResult({
        updated: true,
        todo_id: args.todo_id,
        updated_fields: keys,
        new_tags: createdTags,
        link: `linkwork://todo/${args.todo_id}`
      })
    }
  )

  const updateMemo = tool(
    'update_memo',
    '기존 메모를 수정한다. memo_id로 대상을 지정하고 변경할 필드만 전달한다. content는 전체 교체되므로 부분 수정 시 반드시 get_memo로 전체 내용을 확인해 수정된 전체 내용을 전달할 것. is_archived로 보관/보관 해제가 가능하다. 실행 전 사용자 승인이 필요하다.',
    {
      memo_id: z.number().int().positive().describe('수정할 메모 id (조회 도구로 먼저 확인)'),
      content: z
        .string()
        .min(1)
        .max(10000)
        .optional()
        .describe('메모 내용 (마크다운) — 전체 교체됨'),
      is_important: z.boolean().optional().describe('중요 표시 여부'),
      is_archived: z.boolean().optional().describe('true면 보관(아카이브), false면 보관 해제'),
      category: z
        .string()
        .min(1)
        .max(50)
        .nullable()
        .optional()
        .describe('카테고리 이름 — 기존 카테고리는 연결, 없으면 생성. null이면 카테고리 해제')
    },
    async (args) => {
      const db = getDatabase()
      const row = db.prepare('SELECT * FROM memos WHERE id = ?').get(args.memo_id) as
        | { content: string; is_archived: number }
        | undefined
      if (!row) {
        return jsonResult({
          error: `메모 id=${args.memo_id}를 찾지 못했습니다. 조회 도구로 id를 확인하세요.`
        })
      }
      if (args.content !== undefined && args.content.includes(TRUNCATION_MARKER)) {
        return jsonResult({
          error: `내용에 잘림 표시("${TRUNCATION_MARKER}")가 포함되어 있습니다. search_memos의 잘린 내용을 그대로 되쓰면 뒷부분이 유실됩니다. get_memo로 전문을 조회한 뒤 수정된 전체 내용을 전달하세요.`
        })
      }
      let createdCategory: string | null = null
      const applyUpdate = db.transaction((): string[] | null => {
        // 실제 보관 전이 추적 — 활동 로그 action을 메뉴와 같게 기록한다
        let archiveChange: 'archive' | 'restore' | null = null
        if (args.is_archived === true && !row.is_archived) archiveChange = 'archive'
        else if (args.is_archived === false && row.is_archived) archiveChange = 'restore'

        const set: string[] = []
        const values: unknown[] = []
        const keys: string[] = []
        if (args.content !== undefined) {
          set.push('content = ?')
          values.push(args.content)
          keys.push('content')
        }
        if (args.is_important !== undefined) {
          set.push('is_important = ?')
          values.push(args.is_important ? 1 : 0)
          keys.push('is_important')
        }
        if (args.category !== undefined) {
          if (args.category === null) {
            set.push('category_id = NULL')
          } else {
            const resolved = resolveMemoCategory(db, args.category)
            set.push('category_id = ?')
            values.push(resolved.categoryId)
            if (resolved.created) createdCategory = args.category
          }
          keys.push('category')
        }
        if (set.length > 0) {
          set.push("updated_at = datetime('now')")
          db.prepare(`UPDATE memos SET ${set.join(', ')} WHERE id = ?`).run(...values, args.memo_id)
        }
        // 보관/해제 전이는 메뉴(memo:archive/restore)와 동일한 공용 헬퍼로 처리 — SQL 규약 단일화
        if (args.is_archived !== undefined) {
          setMemoArchived(db, args.memo_id, args.is_archived)
          keys.push('is_archived')
        }
        if (keys.length === 0) return null
        logActivity(
          'memo',
          archiveChange ?? 'update',
          args.memo_id,
          (args.content ?? row.content).slice(0, 50),
          `AI 수정: ${keys.join(', ')}`
        )
        return keys
      })
      const keys = applyUpdate()
      if (!keys) return jsonResult({ error: '변경할 필드가 없습니다.' })
      logWriteExecuted('update_memo', `id=${args.memo_id}, fields=${keys.join(',')}`)
      notifyDataChanged('memo')
      return jsonResult({
        updated: true,
        memo_id: args.memo_id,
        updated_fields: keys,
        new_category: createdCategory,
        link: `linkwork://memo/${args.memo_id}`
      })
    }
  )

  return [createTodo, createTodos, createMemo, updateTodo, updateMemo]
}
