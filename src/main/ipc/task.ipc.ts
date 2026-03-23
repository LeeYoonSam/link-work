import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'

interface TaskInput {
  project_id: number
  name: string
  start_date?: string
  end_date?: string
  status?: string
  sort_order?: number
}

export function registerTaskIpc(): void {
  const db = getDatabase()

  ipcMain.handle('task:create', (_event, input: TaskInput) => {
    const maxOrder = db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM tasks WHERE project_id = ?'
    ).get(input.project_id) as { next_order: number }

    const stmt = db.prepare(`
      INSERT INTO tasks (project_id, name, start_date, end_date, status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
      input.project_id,
      input.name,
      input.start_date || null,
      input.end_date || null,
      input.status || 'pending',
      input.sort_order ?? maxOrder.next_order
    )
    return { id: result.lastInsertRowid }
  })

  ipcMain.handle('task:list', (_event, projectId: number) => {
    return db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY sort_order ASC').all(projectId)
  })

  ipcMain.handle('task:update', (_event, id: number, input: Partial<TaskInput>) => {
    const fields: string[] = []
    const values: unknown[] = []

    for (const [key, value] of Object.entries(input)) {
      fields.push(`${key} = ?`)
      values.push(value)
    }
    values.push(id)

    db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  })

  ipcMain.handle('task:delete', (_event, id: number) => {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return { success: true }
  })
}
