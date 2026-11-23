import type Database from 'better-sqlite3'

// TODO 태그 매핑/이력 저장 헬퍼.
// todo IPC와 AI 쓰기 도구(create_todo)가 공용으로 사용한다.

// 태그 이름을 콤마로 연결해 반환하는 상관 서브쿼리 (AS tags).
// 바깥 쿼리의 todos 별칭이 `t`임을 가정한다 — list_todos/get_todo/getUpdatePreview 공용.
export const TODO_TAGS_SUBQUERY =
  "(SELECT GROUP_CONCAT(g.name, ', ') FROM todo_tag_map m JOIN todo_tags g ON g.id = m.tag_id WHERE m.todo_id = t.id) AS tags"

// 완료/복원 상태 전이 SQL만 수행한다(이력·활동 로그는 호출자가 기록).
// completed_at은 로컬 시간으로 저장 — todo:listActive의 date('now','localtime') 비교 규약과 일치.
// 메뉴(todo:complete/restore)와 AI 수정 도구가 이 한 곳을 공용으로 사용해 규약 드리프트를 막는다.
// ── 출처 링크(todos.source_link) 검증 ──
// 허용: linkwork:// 앱 내 링크(예: linkwork://memo/12) 또는 https:// URL(Jira 티켓). 최대 500자.
// 그 밖의 스킴(javascript:, http: 등)은 거부한다. todo IPC 와 AI 쓰기 도구가 함께 쓴다.
export const SOURCE_LINK_MAX_LENGTH = 500
const SOURCE_LINK_RE = /^(linkwork|https):\/\/\S+$/

// 규칙에 맞으면 trim 한 문자열, undefined·null·빈 문자열이면 null, 위반이면 오류를 던진다
export function normalizeSourceLink(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('출처 링크 형식이 올바르지 않습니다.')
  const link = value.trim()
  if (link === '') return null
  if (link.length > SOURCE_LINK_MAX_LENGTH || !SOURCE_LINK_RE.test(link)) {
    throw new Error('출처 링크 형식이 올바르지 않습니다.')
  }
  return link
}

export function setTodoCompletion(
  db: Database.Database,
  todoId: number | bigint,
  completed: boolean
): void {
  if (completed) {
    db.prepare(
      "UPDATE todos SET is_completed = 1, completed_at = datetime('now', 'localtime'), updated_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(todoId)
  } else {
    db.prepare(
      "UPDATE todos SET is_completed = 0, completed_at = NULL, updated_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(todoId)
  }
}

export function saveTodoTags(
  db: Database.Database,
  todoId: number | bigint,
  tagIds: number[]
): void {
  db.prepare('DELETE FROM todo_tag_map WHERE todo_id = ?').run(todoId)
  const insert = db.prepare('INSERT OR IGNORE INTO todo_tag_map (todo_id, tag_id) VALUES (?, ?)')
  for (const tagId of tagIds) {
    insert.run(todoId, tagId)
  }
}

export function saveTodoHistory(
  db: Database.Database,
  todoId: number | bigint,
  action: string
): void {
  const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(todoId)
  if (!todo) return
  const tagIds = (
    db.prepare('SELECT tag_id FROM todo_tag_map WHERE todo_id = ?').all(todoId) as {
      tag_id: number
    }[]
  ).map((r) => r.tag_id)
  const snapshot = JSON.stringify({ ...todo, tag_ids: tagIds })
  db.prepare('INSERT INTO todo_history (todo_id, action, snapshot) VALUES (?, ?, ?)').run(
    todoId,
    action,
    snapshot
  )
}

// ── 할 일 추가 (todo:create 와 같은 INSERT·이력). 모바일 열람 서버가 쓴다 ──
// todo.ipc.ts 의 todo:create 와 같은 SQL 이다 — 한쪽을 바꾸면 다른 쪽도 바꾼다.
// 다만 출처 링크(source_link)는 받지 않는다. 모바일 추가는 출처 없이 만든다.
// 활동 로그·변경 알림은 호출자가 남긴다.

export interface TodoInsertInput {
  title: string
  priority?: 'low' | 'medium' | 'high'
  due_date?: string | null
  due_reminder?: number
  notes?: string | null
  tag_ids?: number[]
}

export function insertTodo(db: Database.Database, input: TodoInsertInput): number {
  const result = db
    .prepare('INSERT INTO todos (title, priority, due_date, due_reminder, notes) VALUES (?, ?, ?, ?, ?)')
    .run(input.title, input.priority || 'medium', input.due_date || null, input.due_reminder ?? 0, input.notes ?? null)
  const todoId = Number(result.lastInsertRowid)
  if (input.tag_ids && input.tag_ids.length > 0) saveTodoTags(db, todoId, input.tag_ids)
  saveTodoHistory(db, todoId, 'create')
  return todoId
}

// ── 목록 조회 (todo:list 와 같은 쿼리·정렬). 모바일 열람 서버가 쓴다 ──
// todo.ipc.ts 의 todo:list·attachTags 와 같은 SQL 이다 — 한쪽을 바꾸면 다른 쪽도 바꾼다.

interface TodoTagRow {
  id: number
  name: string
  color: string
  created_at: string
  updated_at: string
}

interface TodoListRow {
  id: number
  title: string
  priority: string
  due_date: string | null
  due_reminder: number
  is_completed: number
  completed_at: string | null
  notes: string | null
  source_link: string | null
  created_at: string
  updated_at: string
}

function attachTodoTags<T extends { id: number }>(
  db: Database.Database,
  todos: T[]
): (T & { tags: TodoTagRow[] })[] {
  if (todos.length === 0) return []
  const ids = todos.map((t) => t.id)
  const placeholders = ids.map(() => '?').join(',')
  const allTags = db
    .prepare(
      `SELECT m.todo_id, t.* FROM todo_tags t
       JOIN todo_tag_map m ON m.tag_id = t.id
       WHERE m.todo_id IN (${placeholders})`
    )
    .all(...ids) as (TodoTagRow & { todo_id: number })[]
  const tagMap = new Map<number, TodoTagRow[]>()
  for (const tag of allTags) {
    const list = tagMap.get(tag.todo_id) || []
    list.push({ id: tag.id, name: tag.name, color: tag.color, created_at: tag.created_at, updated_at: tag.updated_at })
    tagMap.set(tag.todo_id, list)
  }
  return todos.map((todo) => ({ ...todo, tags: tagMap.get(todo.id) || [] }))
}

export function listTodosByCompletion(
  db: Database.Database,
  completed: boolean
): (TodoListRow & { tags: TodoTagRow[] })[] {
  const todos = db
    .prepare(
      `SELECT * FROM todos WHERE is_completed = ?
       ORDER BY
         CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END,
         created_at ASC`
    )
    .all(completed ? 1 : 0) as TodoListRow[]
  return attachTodoTags(db, todos)
}
