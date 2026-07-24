import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'

interface TaskInput {
  project_id: number
  name: string
  start_date?: string
  end_date?: string
  status?: string
  sort_order?: number
  // 1단계 부모-자식 계층. null(또는 미지정)이면 최상위 작업.
  parent_task_id?: number | null
}

export function registerTaskIpc(): void {
  const db = getDatabase()

  /**
   * parent_task_id 지정을 검증한다. 실패 시 한국어 메시지로 throw.
   * 계층은 1단계만 허용: 부모로 지정 가능한 대상은 최상위 작업(parent_task_id IS NULL)뿐.
   * @param parentId 부모로 지정하려는 작업 id
   * @param projectId 하위가 될 작업의 project_id (부모는 같은 프로젝트여야 함)
   * @param childId 하위가 될 작업 id (create 시엔 아직 없으므로 null). 자기 참조 검사용.
   */
  const validateParentAssignment = (
    parentId: number,
    projectId: number,
    childId: number | null
  ): void => {
    if (childId != null && parentId === childId) {
      throw new Error('작업을 자기 자신의 하위로 지정할 수 없습니다.')
    }
    const parent = db
      .prepare('SELECT project_id, parent_task_id FROM tasks WHERE id = ?')
      .get(parentId) as { project_id: number; parent_task_id: number | null } | undefined
    if (!parent) {
      throw new Error('상위 작업을 찾을 수 없습니다.')
    }
    if (parent.project_id !== projectId) {
      throw new Error('같은 프로젝트의 작업만 상위 작업으로 지정할 수 있습니다.')
    }
    if (parent.parent_task_id != null) {
      throw new Error('하위 작업은 상위 작업으로 지정할 수 없습니다. 작업 계층은 1단계까지만 가능합니다.')
    }
  }

  ipcMain.handle('task:create', (_event, input: TaskInput) => {
    const parentId = input.parent_task_id ?? null
    if (parentId != null) {
      validateParentAssignment(parentId, input.project_id, null)
    }

    const maxOrder = db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM tasks WHERE project_id = ?'
    ).get(input.project_id) as { next_order: number }

    const stmt = db.prepare(`
      INSERT INTO tasks (project_id, name, start_date, end_date, status, sort_order, parent_task_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
      input.project_id,
      input.name,
      input.start_date || null,
      input.end_date || null,
      input.status || 'pending',
      input.sort_order ?? maxOrder.next_order,
      parentId
    )
    logActivity('task', 'create', result.lastInsertRowid, input.name)
    return { id: result.lastInsertRowid }
  })

  ipcMain.handle('task:list', (_event, projectId: number) => {
    return db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY sort_order ASC').all(projectId)
  })

  ipcMain.handle('task:listByProjectIds', (_event, projectIds: number[]) => {
    const grouped: Record<number, unknown[]> = {}
    if (!Array.isArray(projectIds) || projectIds.length === 0) return grouped

    const placeholders = projectIds.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT * FROM tasks WHERE project_id IN (${placeholders}) ORDER BY project_id ASC, sort_order ASC`
      )
      .all(...projectIds) as { project_id: number }[]

    for (const id of projectIds) grouped[id] = []
    for (const row of rows) {
      if (!grouped[row.project_id]) grouped[row.project_id] = []
      grouped[row.project_id].push(row)
    }
    return grouped
  })

  const ALLOWED_TASK_FIELDS = new Set([
    'name',
    'start_date',
    'end_date',
    'status',
    'sort_order',
    'parent_task_id'
  ])

  ipcMain.handle('task:update', (_event, id: number, input: Partial<TaskInput>) => {
    // parent_task_id 재배치: null은 최상위로 이동(항상 허용), 값이 있으면 계층 규칙 검증.
    if ('parent_task_id' in input) {
      const newParent = input.parent_task_id ?? null
      if (newParent != null) {
        const self = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(id) as
          | { project_id: number }
          | undefined
        if (!self) {
          throw new Error('작업을 찾을 수 없습니다.')
        }
        // 자신이 하위를 가진 경우(즉 부모 작업)면 다른 작업의 하위가 될 수 없다.
        const childCount = db
          .prepare('SELECT COUNT(*) as c FROM tasks WHERE parent_task_id = ?')
          .get(id) as { c: number }
        if (childCount.c > 0) {
          throw new Error(
            '하위 작업을 가진 작업은 다른 작업의 하위로 지정할 수 없습니다. 작업 계층은 1단계까지만 가능합니다.'
          )
        }
        validateParentAssignment(newParent, self.project_id, id)
      }
    }

    const fields: string[] = []
    const values: unknown[] = []

    for (const [key, value] of Object.entries(input)) {
      if (!ALLOWED_TASK_FIELDS.has(key)) continue
      fields.push(`${key} = ?`)
      values.push(value)
    }

    // 허용된 필드가 하나도 없으면 SET 절이 비어 SQL syntax error가 나므로 조기 반환
    if (fields.length === 0) {
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as { name: string }
    }

    values.push(id)

    db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as { name: string }
    logActivity('task', 'update', id, row.name, Object.keys(input).join(', '))
    return row
  })

  ipcMain.handle('task:delete', (_event, id: number) => {
    const row = db.prepare('SELECT name FROM tasks WHERE id = ?').get(id) as { name: string } | undefined
    // 하위는 함께 지우지 않고 최상위로 승격시킨 뒤 부모만 삭제한다.
    db.prepare('UPDATE tasks SET parent_task_id = NULL WHERE parent_task_id = ?').run(id)
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    logActivity('task', 'delete', id, row?.name)
    return { success: true }
  })
}
