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
