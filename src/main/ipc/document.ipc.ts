import { ipcMain, shell } from 'electron'
import { getDatabase } from '../db/database'

interface DocumentInput {
  name: string
  url: string
  type?: string
  description?: string
  project_id?: number | null
  sort_order?: number
}

export function registerDocumentIpc(): void {
  const db = getDatabase()

  ipcMain.handle('document:create', (_event, input: DocumentInput) => {
    const stmt = db.prepare(`
      INSERT INTO documents (name, url, type, description, project_id, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
      input.name,
      input.url,
      input.type || 'link',
      input.description || null,
      input.project_id ?? null,
      input.sort_order ?? 0
    )
    return { id: result.lastInsertRowid }
  })

  ipcMain.handle('document:list', (_event, projectId?: number | null) => {
    if (projectId === null) {
      return db.prepare('SELECT * FROM documents WHERE project_id IS NULL ORDER BY sort_order ASC, created_at DESC').all()
    }
    if (projectId !== undefined) {
      return db.prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY sort_order ASC, created_at DESC').all(projectId)
    }
    return db.prepare('SELECT * FROM documents ORDER BY sort_order ASC, created_at DESC').all()
  })

  ipcMain.handle('document:listAll', () => {
    return db.prepare(`
      SELECT d.*, p.name AS project_name
      FROM documents d
      LEFT JOIN projects p ON d.project_id = p.id
      ORDER BY d.sort_order ASC, d.created_at DESC
    `).all()
  })

  const ALLOWED_DOCUMENT_FIELDS = new Set([
    'name', 'url', 'type', 'description', 'project_id', 'sort_order'
  ])

  ipcMain.handle('document:update', (_event, id: number, input: Partial<DocumentInput>) => {
    const fields: string[] = []
    const values: unknown[] = []

    for (const [key, value] of Object.entries(input)) {
      if (!ALLOWED_DOCUMENT_FIELDS.has(key)) continue
      fields.push(`${key} = ?`)
      values.push(value)
    }
    fields.push("updated_at = datetime('now')")
    values.push(id)

    db.prepare(`UPDATE documents SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return db.prepare('SELECT * FROM documents WHERE id = ?').get(id)
  })

  ipcMain.handle('document:delete', (_event, id: number) => {
    db.prepare('DELETE FROM documents WHERE id = ?').run(id)
    return { success: true }
  })

  ipcMain.handle('document:open', async (_event, url: string, type: string) => {
    try {
      if (type === 'file') {
        await shell.openPath(url)
      } else {
        await shell.openExternal(url)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}
