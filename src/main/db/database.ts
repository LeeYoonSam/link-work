import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'

let db: Database.Database

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized')
  }
  return db
}

export function initDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'linkwork.db')
  db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      dev_start_date TEXT NOT NULL,
      dev_end_date TEXT NOT NULL,
      qa_start_date TEXT NOT NULL,
      qa_end_date TEXT NOT NULL,
      deploy_date TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      status TEXT DEFAULT 'pending',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'google',
      access_token TEXT,
      refresh_token TEXT,
      expiry_date TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'link',
      description TEXT,
      project_id INTEGER,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS variables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      description TEXT,
      view_type TEXT NOT NULL DEFAULT 'general',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_important INTEGER NOT NULL DEFAULT 0,
      color TEXT DEFAULT 'default',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      entity_name TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)

  // Migrations for existing databases
  const memoColumns = db.prepare("PRAGMA table_info(memos)").all() as { name: string }[]
  const memoColumnNames = memoColumns.map((c) => c.name)
  if (memoColumns.length > 0 && !memoColumnNames.includes('is_important')) {
    db.exec("ALTER TABLE memos ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0")
  }

  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]
  const projectColumnNames = projectColumns.map((c) => c.name)
  if (projectColumns.length > 0 && !projectColumnNames.includes('status_manual')) {
    db.exec("ALTER TABLE projects ADD COLUMN status_manual INTEGER NOT NULL DEFAULT 0")
  }
  if (projectColumns.length > 0 && !projectColumnNames.includes('deploy_version')) {
    db.exec("ALTER TABLE projects ADD COLUMN deploy_version TEXT")
  }

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
