import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'
import { applyProjectAutoStatus, calculateQaDates } from '../utils/project-dates'

interface ProjectInput {
  name: string
  description?: string
  dev_start_date: string
  dev_end_date: string
  qa_start_date?: string
  qa_end_date?: string
  deploy_date?: string
  deploy_version?: string
  status?: string
  status_manual?: number
}

interface ProjectRow {
  id: number
  name: string
  description: string | null
  dev_start_date: string
  dev_end_date: string
  qa_start_date: string
  qa_end_date: string
  deploy_date: string
  status: string
  status_manual: number
  created_at: string
  updated_at: string
}

export function registerProjectIpc(): void {
  const db = getDatabase()

  ipcMain.handle('project:create', (_event, input: ProjectInput) => {
    const defaults = calculateQaDates(input.dev_end_date)
    const stmt = db.prepare(`
      INSERT INTO projects (name, description, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date, deploy_version, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
      input.name,
      input.description || null,
      input.dev_start_date,
      input.dev_end_date,
      input.qa_start_date || defaults.qaStart,
      input.qa_end_date || defaults.qaEnd,
      input.deploy_date || defaults.deployDate,
      input.deploy_version || null,
      input.status || 'scheduled'
    )
    logActivity('project', 'create', result.lastInsertRowid, input.name)
    return { id: result.lastInsertRowid }
  })

  ipcMain.handle('project:lastDates', () => {
    const row = db.prepare('SELECT dev_start_date, dev_end_date FROM projects ORDER BY created_at DESC LIMIT 1').get() as { dev_start_date: string; dev_end_date: string } | undefined
    if (!row) return null
    return { devStartDate: row.dev_start_date, devEndDate: row.dev_end_date }
  })

  ipcMain.handle('project:list', (_event, status?: string) => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[]
    const projects = rows.map(applyProjectAutoStatus)
    if (status) {
      return projects.filter((p) => p.status === status)
    }
    return projects
  })

  ipcMain.handle('project:get', (_event, id: number) => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    if (!row) return null
    return applyProjectAutoStatus(row)
  })

  const ALLOWED_PROJECT_FIELDS = new Set([
    'name', 'description', 'dev_start_date', 'dev_end_date',
    'qa_start_date', 'qa_end_date', 'deploy_date', 'deploy_version', 'status', 'status_manual'
  ])

  ipcMain.handle('project:update', (_event, id: number, input: Partial<ProjectInput>) => {
    const fields: string[] = []
    const values: unknown[] = []

    for (const [key, value] of Object.entries(input)) {
      if (!ALLOWED_PROJECT_FIELDS.has(key)) continue
      fields.push(`${key} = ?`)
      values.push(value)
    }
    fields.push("updated_at = datetime('now')")
    values.push(id)

    db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow
    logActivity('project', 'update', id, row.name, Object.keys(input).join(', '))
    return applyProjectAutoStatus(row)
  })

  ipcMain.handle('project:delete', (_event, id: number) => {
    const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as { name: string } | undefined
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    logActivity('project', 'delete', id, row?.name)
    return { success: true }
  })

  ipcMain.handle('project:calculateDates', (_event, devEndDate: string) => {
    return calculateQaDates(devEndDate)
  })
}
