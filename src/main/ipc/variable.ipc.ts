import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'

interface VariableInput {
  key: string
  value: string
  description?: string
  view_type?: string
  sort_order?: number
}

export function registerVariableIpc(): void {
  const db = getDatabase()

  ipcMain.handle('variable:create', (_event, input: VariableInput) => {
    const stmt = db.prepare(`
      INSERT INTO variables (key, value, description, view_type, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
      input.key,
      input.value,
      input.description || null,
      input.view_type || 'general',
      input.sort_order ?? 0
    )
    return { id: result.lastInsertRowid }
  })

  ipcMain.handle('variable:list', () => {
    return db.prepare('SELECT * FROM variables ORDER BY sort_order ASC, created_at DESC').all()
  })

  const ALLOWED_VARIABLE_FIELDS = new Set([
    'key', 'value', 'description', 'view_type', 'sort_order'
  ])

  ipcMain.handle('variable:update', (_event, id: number, input: Partial<VariableInput>) => {
    const fields: string[] = []
    const values: unknown[] = []

    for (const [key, value] of Object.entries(input)) {
      if (!ALLOWED_VARIABLE_FIELDS.has(key)) continue
      fields.push(`${key} = ?`)
      values.push(value)
    }
    fields.push("updated_at = datetime('now')")
    values.push(id)

    db.prepare(`UPDATE variables SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return db.prepare('SELECT * FROM variables WHERE id = ?').get(id)
  })

  ipcMain.handle('variable:reorder', (_event, items: { id: number; sort_order: number }[]) => {
    const stmt = db.prepare('UPDATE variables SET sort_order = ? WHERE id = ?')
    const transaction = db.transaction((list: { id: number; sort_order: number }[]) => {
      for (const item of list) {
        stmt.run(item.sort_order, item.id)
      }
    })
    transaction(items)
    return { success: true }
  })

  ipcMain.handle('variable:delete', (_event, id: number) => {
    db.prepare('DELETE FROM variables WHERE id = ?').run(id)
    return { success: true }
  })
}
