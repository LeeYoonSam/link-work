import type Database from 'better-sqlite3'

// TODO 태그 매핑/이력 저장 헬퍼.
// todo IPC와 AI 쓰기 도구(create_todo)가 공용으로 사용한다.

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
