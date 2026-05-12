import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'

interface MemoCategoryInput {
  name: string
  color?: string
  sort_order?: number
}

export function registerMemoCategoryIpc(): void {
  const db = getDatabase()

  ipcMain.handle('memoCategory:create', (_event, input: MemoCategoryInput) => {
    const maxRow = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS max FROM memo_categories')
      .get() as { max: number }
    const nextOrder = input.sort_order ?? maxRow.max + 1
    const stmt = db.prepare(
      'INSERT INTO memo_categories (name, color, sort_order) VALUES (?, ?, ?)'
    )
    const result = stmt.run(input.name, input.color || '#6B7280', nextOrder)
    logActivity('memo_category', 'create', result.lastInsertRowid, input.name)
    return { id: result.lastInsertRowid }
  })

  ipcMain.handle('memoCategory:list', () => {
    return db
      .prepare('SELECT * FROM memo_categories ORDER BY sort_order ASC, name ASC')
      .all()
  })

  ipcMain.handle(
    'memoCategory:update',
    (_event, id: number, input: Partial<MemoCategoryInput>) => {
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
      if (input.sort_order !== undefined) {
        fields.push('sort_order = ?')
        values.push(input.sort_order)
      }
      fields.push("updated_at = datetime('now')")
      values.push(id)

      db.prepare(`UPDATE memo_categories SET ${fields.join(', ')} WHERE id = ?`).run(...values)
      const row = db.prepare('SELECT * FROM memo_categories WHERE id = ?').get(id) as
        | { name: string }
        | undefined
      logActivity('memo_category', 'update', id, row?.name)
      return row
    }
  )

  ipcMain.handle('memoCategory:delete', (_event, id: number) => {
    // FK is ON DELETE SET NULL — memos keep existing, category_id becomes NULL.
    // For migrated DBs without FK enforcement on the added column, do it explicitly.
    db.prepare('UPDATE memos SET category_id = NULL WHERE category_id = ?').run(id)
    db.prepare('DELETE FROM memo_categories WHERE id = ?').run(id)
    logActivity('memo_category', 'delete', id)
    return { success: true }
  })
}
