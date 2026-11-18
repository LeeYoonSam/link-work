import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { applySchema } from './schema'

// 기존 테스트·호출부의 import 를 유지한다 (정의는 db/schema.ts)
export { migrateReleaseNotesDropProject } from './schema'

let db: Database.Database | null = null
let aiReadOnlyDb: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db
}

/**
 * AI 도구 전용 읽기 전용 커넥션 (가드레일).
 * SQLite 레벨에서 모든 쓰기를 차단하므로, AI 도구에 실수로 쓰기 SQL이
 * 추가되더라도 데이터가 변경/삭제될 수 없다.
 */
export function getAiReadOnlyDatabase(): Database.Database {
  if (!aiReadOnlyDb) {
    const dbPath = join(app.getPath('userData'), 'linkwork.db')
    aiReadOnlyDb = new Database(dbPath, { readonly: true })
  }
  return aiReadOnlyDb
}

export function closeDatabase(): void {
  if (aiReadOnlyDb) {
    aiReadOnlyDb.close()
    aiReadOnlyDb = null
  }
  if (db) {
    db.close()
    db = null
  }
}

export function initDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'linkwork.db')
  db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  applySchema(db)

  // Seed activity_log from existing data (one-time migration)
  const activityCount = (db.prepare('SELECT COUNT(*) as count FROM activity_log').get() as { count: number }).count
  if (activityCount === 0) {
    db.exec(`
      INSERT INTO activity_log (entity_type, entity_id, entity_name, action, created_at)
      SELECT 'project', id, name, 'create', created_at FROM projects;

      INSERT INTO activity_log (entity_type, entity_id, entity_name, action, created_at)
      SELECT 'task', id, name, 'create', created_at FROM tasks;

      INSERT INTO activity_log (entity_type, entity_id, entity_name, action, created_at)
      SELECT 'document', id, name, 'create', created_at FROM documents;

      INSERT INTO activity_log (entity_type, entity_id, entity_name, action, created_at)
      SELECT 'variable', id, key, 'create', created_at FROM variables;

      INSERT INTO activity_log (entity_type, entity_id, entity_name, action, created_at)
      SELECT 'memo', id, SUBSTR(content, 1, 50), 'create', created_at FROM memos;
    `)
  }
}
