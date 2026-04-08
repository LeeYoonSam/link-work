import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'

interface MemoInput {
  content: string
  color?: string
  is_important?: number
}

export function registerMemoIpc(): void {
  const db = getDatabase()

  ipcMain.handle('memo:create', (_event, input: MemoInput) => {
    const stmt = db.prepare(`
      INSERT INTO memos (content, color, is_important)
      VALUES (?, ?, ?)
    `)
    const result = stmt.run(input.content, input.color || 'default', input.is_important ?? 0)
    logActivity('memo', 'create', result.lastInsertRowid, input.content.slice(0, 50))
    return { id: result.lastInsertRowid }
  })

  ipcMain.handle('memo:list', (_event, archived?: boolean) => {
    const isArchived = archived ? 1 : 0
    return db
      .prepare('SELECT * FROM memos WHERE is_archived = ? ORDER BY created_at ASC')
      .all(isArchived)
  })

  ipcMain.handle('memo:update', (_event, id: number, input: Partial<MemoInput>) => {
    const fields: string[] = []
    const values: unknown[] = []

    if (input.content !== undefined) {
      fields.push('content = ?')
      values.push(input.content)
    }
    if (input.color !== undefined) {
      fields.push('color = ?')
      values.push(input.color)
    }
    if (input.is_important !== undefined) {
      fields.push('is_important = ?')
      values.push(input.is_important)
    }
    fields.push("updated_at = datetime('now')")
    values.push(id)

    db.prepare(`UPDATE memos SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    const row = db.prepare('SELECT * FROM memos WHERE id = ?').get(id) as { content: string }
    logActivity('memo', 'update', id, row.content.slice(0, 50))
    return row
  })

  ipcMain.handle('memo:archive', (_event, id: number) => {
    db.prepare("UPDATE memos SET is_archived = 1, updated_at = datetime('now') WHERE id = ?").run(
      id
    )
    logActivity('memo', 'archive', id)
    return { success: true }
  })

  ipcMain.handle('memo:restore', (_event, id: number) => {
    db.prepare("UPDATE memos SET is_archived = 0, updated_at = datetime('now') WHERE id = ?").run(
      id
    )
    logActivity('memo', 'restore', id)
    return { success: true }
  })

  ipcMain.handle('memo:toggleImportant', (_event, id: number) => {
    const memo = db.prepare('SELECT is_important FROM memos WHERE id = ?').get(id) as
      | { is_important: number }
      | undefined
    if (!memo) return { success: false }
    const newValue = memo.is_important ? 0 : 1
    db.prepare("UPDATE memos SET is_important = ?, updated_at = datetime('now') WHERE id = ?").run(
      newValue,
      id
    )
    return { success: true, is_important: newValue }
  })

  ipcMain.handle('memo:listImportant', () => {
    return db
      .prepare(
        'SELECT * FROM memos WHERE is_important = 1 AND is_archived = 0 ORDER BY created_at ASC'
      )
      .all()
  })

  ipcMain.handle('memo:delete', (_event, id: number) => {
    db.prepare('DELETE FROM memos WHERE id = ?').run(id)
    logActivity('memo', 'delete', id)
    return { success: true }
  })
}
