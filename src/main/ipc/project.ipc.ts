import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'
import { addBusinessDays } from 'date-fns'

interface ProjectInput {
  name: string
  description?: string
  dev_start_date: string
  dev_end_date: string
  qa_start_date?: string
  qa_end_date?: string
  deploy_date?: string
  status?: string
}

function calculateQaDates(devEndDate: string): { qaStart: string; qaEnd: string; deployDate: string } {
  const devEnd = new Date(devEndDate)
  const qaStart = new Date(devEnd)
  qaStart.setDate(qaStart.getDate() + 1)

  const qaEnd = addBusinessDays(qaStart, 2)

  const deployDate = new Date(qaEnd)
  deployDate.setDate(deployDate.getDate() + 1)

  return {
    qaStart: qaStart.toISOString().split('T')[0],
    qaEnd: qaEnd.toISOString().split('T')[0],
    deployDate: deployDate.toISOString().split('T')[0]
  }
}

export function registerProjectIpc(): void {
  const db = getDatabase()

  ipcMain.handle('project:create', (_event, input: ProjectInput) => {
    const defaults = calculateQaDates(input.dev_end_date)
    const stmt = db.prepare(`
      INSERT INTO projects (name, description, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
      input.name,
      input.description || null,
      input.dev_start_date,
      input.dev_end_date,
      input.qa_start_date || defaults.qaStart,
      input.qa_end_date || defaults.qaEnd,
      input.deploy_date || defaults.deployDate,
      input.status || 'active'
    )
    return { id: result.lastInsertRowid }
  })

  ipcMain.handle('project:list', (_event, status?: string) => {
    if (status) {
      return db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY created_at DESC').all(status)
    }
    return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all()
  })

  ipcMain.handle('project:get', (_event, id: number) => {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
  })

  ipcMain.handle('project:update', (_event, id: number, input: Partial<ProjectInput>) => {
    const fields: string[] = []
    const values: unknown[] = []

    for (const [key, value] of Object.entries(input)) {
      fields.push(`${key} = ?`)
      values.push(value)
    }
    fields.push("updated_at = datetime('now')")
    values.push(id)

    db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
  })

  ipcMain.handle('project:delete', (_event, id: number) => {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    return { success: true }
  })

  ipcMain.handle('project:calculateDates', (_event, devEndDate: string) => {
    return calculateQaDates(devEndDate)
  })
}
