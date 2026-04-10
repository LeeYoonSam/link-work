import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'

interface TodoTagInput {
  name: string
  color?: string
}

export function registerTodoTagIpc(): void {
  const db = getDatabase()

  ipcMain.handle('todoTag:create', (_event, input: TodoTagInput) => {
    const stmt = db.prepare('INSERT INTO todo_tags (name, color) VALUES (?, ?)')
    const result = stmt.run(input.name, input.color || '#6B7280')
    logActivity('todo_tag', 'create', result.lastInsertRowid, input.name)
    return { id: result.lastInsertRowid }
  })

  ipcMain.handle('todoTag:list', () => {
    return db.prepare('SELECT * FROM todo_tags ORDER BY name ASC').all()
  })

  ipcMain.handle('todoTag:update', (_event, id: number, input: Partial<TodoTagInput>) => {
    const fields: string[] = []
    const values: unknown[] = []

    if (input.name !== undefined) {
      fields.push('name = ?')
      values.push(input.name)
    }
    if (input.color !== undefined) {
      fields.push('color = ?')
      values.push(input.color)
    }
    fields.push("updated_at = datetime('now')")
    values.push(id)

    db.prepare(`UPDATE todo_tags SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    const row = db.prepare('SELECT * FROM todo_tags WHERE id = ?').get(id)
    logActivity('todo_tag', 'update', id)
    return row
  })

  ipcMain.handle('todoTag:delete', (_event, id: number) => {
    db.prepare('DELETE FROM todo_tags WHERE id = ?').run(id)
    logActivity('todo_tag', 'delete', id)
    return { success: true }
  })
}
