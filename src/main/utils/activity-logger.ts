import { getDatabase } from '../db/database'

export type EntityType =
  | 'project'
  | 'task'
  | 'document'
  | 'variable'
  | 'memo'
  | 'memo_category'
  | 'todo'
  | 'todo_tag'
  | 'meeting'
  | 'release_note'
export type ActionType = 'create' | 'update' | 'delete' | 'archive' | 'restore' | 'complete'

export function logActivity(
  entityType: EntityType,
  action: ActionType,
  entityId?: number | bigint,
  entityName?: string,
  details?: string
): void {
  try {
    const db = getDatabase()
    db.prepare(
      'INSERT INTO activity_log (entity_type, entity_id, entity_name, action, details) VALUES (?, ?, ?, ?, ?)'
    ).run(entityType, entityId ?? null, entityName ?? null, action, details ?? null)
  } catch (e) {
    console.error('[activity-logger]', e)
  }
}
