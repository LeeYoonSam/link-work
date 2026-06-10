import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'
import { saveTodoHistory, saveTodoTags } from '../utils/todo-helpers'

interface TodoInput {
  title: string
  priority?: string
  due_date?: string | null
  due_reminder?: number
  notes?: string | null
  tag_ids?: number[]
}

interface TodoRow {
  id: number
  title: string
  priority: string
  due_date: string | null
  due_reminder: number
  is_completed: number
  completed_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

interface TagRow {
  id: number
  name: string
  color: string
  created_at: string
  updated_at: string
}

function attachTags(db: ReturnType<typeof getDatabase>, todos: TodoRow[]): (TodoRow & { tags: TagRow[] })[] {
  if (todos.length === 0) return []
  const ids = todos.map((t) => t.id)
  const placeholders = ids.map(() => '?').join(',')
  const allTags = db.prepare(`
    SELECT m.todo_id, t.* FROM todo_tags t
    JOIN todo_tag_map m ON m.tag_id = t.id
    WHERE m.todo_id IN (${placeholders})
  `).all(...ids) as (TagRow & { todo_id: number })[]

  const tagMap = new Map<number, TagRow[]>()
  for (const tag of allTags) {
    const list = tagMap.get(tag.todo_id) || []
    list.push({ id: tag.id, name: tag.name, color: tag.color, created_at: tag.created_at, updated_at: tag.updated_at })
    tagMap.set(tag.todo_id, list)
  }
  return todos.map((todo) => ({ ...todo, tags: tagMap.get(todo.id) || [] }))
}

const saveTags = saveTodoTags
const saveHistory = saveTodoHistory

export function registerTodoIpc(): void {
  const db = getDatabase()

  ipcMain.handle('todo:create', (_event, input: TodoInput) => {
    const stmt = db.prepare(`
      INSERT INTO todos (title, priority, due_date, due_reminder, notes)
      VALUES (?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
      input.title,
      input.priority || 'medium',
      input.due_date || null,
      input.due_reminder ?? 0,
      input.notes ?? null
    )
    const todoId = result.lastInsertRowid
    if (input.tag_ids && input.tag_ids.length > 0) {
      saveTags(db, todoId, input.tag_ids)
    }
    saveHistory(db, todoId, 'create')
    logActivity('todo', 'create', todoId, input.title)
    return { id: todoId }
  })

  ipcMain.handle('todo:list', (_event, completed?: boolean) => {
    const isCompleted = completed ? 1 : 0
    const todos = db
      .prepare(`
        SELECT * FROM todos WHERE is_completed = ?
        ORDER BY
          CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END,
          created_at ASC
      `)
      .all(isCompleted) as TodoRow[]
    return attachTags(db, todos)
  })

  ipcMain.handle('todo:listByTag', (_event, tagId: number, completed?: boolean) => {
    const isCompleted = completed ? 1 : 0
    const todos = db
      .prepare(`
        SELECT t.* FROM todos t
        JOIN todo_tag_map m ON m.todo_id = t.id
        WHERE m.tag_id = ? AND t.is_completed = ?
        ORDER BY
          CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END,
          t.created_at ASC
      `)
      .all(tagId, isCompleted) as TodoRow[]
    return attachTags(db, todos)
  })

  ipcMain.handle('todo:update', (_event, id: number, input: Partial<TodoInput>) => {
    const fields: string[] = []
    const values: unknown[] = []

    if (input.title !== undefined) {
      fields.push('title = ?')
      values.push(input.title)
    }
    if (input.priority !== undefined) {
      fields.push('priority = ?')
      values.push(input.priority)
    }
    if (input.due_date !== undefined) {
      fields.push('due_date = ?')
      values.push(input.due_date)
    }
    if (input.due_reminder !== undefined) {
      fields.push('due_reminder = ?')
      values.push(input.due_reminder)
    }
    if (input.notes !== undefined) {
      fields.push('notes = ?')
      values.push(input.notes)
    }
    fields.push("updated_at = datetime('now', 'localtime')")
    values.push(id)

    if (fields.length > 1) {
      db.prepare(`UPDATE todos SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }

    if (input.tag_ids !== undefined) {
      saveTags(db, id, input.tag_ids)
    }

    saveHistory(db, id, 'update')
    const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as TodoRow
    logActivity('todo', 'update', id, row.title)
    return { ...row, tags: (attachTags(db, [row]))[0].tags }
  })

  ipcMain.handle('todo:complete', (_event, id: number) => {
    db.prepare("UPDATE todos SET is_completed = 1, completed_at = datetime('now', 'localtime'), updated_at = datetime('now', 'localtime') WHERE id = ?").run(id)
    saveHistory(db, id, 'complete')
    logActivity('todo', 'complete', id)
    return { success: true }
  })

  ipcMain.handle('todo:restore', (_event, id: number) => {
    db.prepare("UPDATE todos SET is_completed = 0, completed_at = NULL, updated_at = datetime('now', 'localtime') WHERE id = ?").run(id)
    saveHistory(db, id, 'restore')
    logActivity('todo', 'restore', id)
    return { success: true }
  })

  // Adjust the completion date of an already-completed todo.
  // completedAt must be a local-time string 'YYYY-MM-DD HH:MM:SS' to stay
  // consistent with datetime('now', 'localtime') used elsewhere.
  ipcMain.handle('todo:setCompletedAt', (_event, id: number, completedAt: string) => {
    db.prepare(
      "UPDATE todos SET completed_at = ?, updated_at = datetime('now', 'localtime') WHERE id = ? AND is_completed = 1"
    ).run(completedAt, id)
    saveHistory(db, id, 'update')
    logActivity('todo', 'update', id)
    return { success: true }
  })

  ipcMain.handle('todo:delete', (_event, id: number) => {
    saveHistory(db, id, 'delete')
    db.prepare('DELETE FROM todos WHERE id = ?').run(id)
    logActivity('todo', 'delete', id)
    return { success: true }
  })

  ipcMain.handle('todo:history', (_event, todoId: number) => {
    return db.prepare('SELECT * FROM todo_history WHERE todo_id = ? ORDER BY created_at DESC').all(todoId)
  })

  ipcMain.handle('todo:listActive', () => {
    // Return active todos + todos completed today
    // completed_at is stored in local time, so compare directly with date('now', 'localtime')
    const todos = db
      .prepare(`
        SELECT * FROM todos
        WHERE is_completed = 0
           OR (is_completed = 1 AND date(completed_at) = date('now', 'localtime'))
        ORDER BY
          is_completed ASC,
          CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END,
          CASE WHEN is_completed = 0 THEN created_at ELSE NULL END ASC,
          completed_at DESC
      `)
      .all() as TodoRow[]
    return attachTags(db, todos)
  })
}
