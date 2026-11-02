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

export interface ActivityEvent {
  entityType: EntityType
  action: ActionType
  entityId: number | null
}

// 비서가 앱 내부 변경을 감지하는 구독 지점이다. 리스너 예외는 기록 동작에 영향을 주지 않게 삼킨다.
const activityListeners = new Set<(e: ActivityEvent) => void>()

export function onActivity(listener: (e: ActivityEvent) => void): () => void {
  activityListeners.add(listener)
  return () => {
    activityListeners.delete(listener)
  }
}

function notifyActivity(e: ActivityEvent): void {
  for (const listener of activityListeners) {
    try {
      listener(e)
    } catch (err) {
      console.error('[activity-logger] listener', err)
    }
  }
}

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
    return
  }
  notifyActivity({
    entityType,
    action,
    entityId: entityId === undefined ? null : Number(entityId)
  })
}
