import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'

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

    CREATE TABLE IF NOT EXISTS memo_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#6B7280',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_important INTEGER NOT NULL DEFAULT 0,
      color TEXT DEFAULT 'default',
      category_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES memo_categories(id) ON DELETE SET NULL
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

    CREATE TABLE IF NOT EXISTS todo_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#6B7280',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      due_date TEXT,
      due_reminder INTEGER NOT NULL DEFAULT 0,
      is_completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS todo_tag_map (
      todo_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (todo_id, tag_id),
      FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES todo_tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS todo_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '새 대화',
      session_id TEXT,
      write_mode TEXT NOT NULL DEFAULT 'ask',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS ai_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      meta TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (chat_id) REFERENCES ai_chats(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      event TEXT NOT NULL,
      tool_name TEXT,
      input TEXT,
      detail TEXT,
      duration_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    -- ── 회의 녹음 (docs/MEETING_RECORDING.md) ──
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '제목 없는 회의',
      status TEXT NOT NULL DEFAULT 'recording',
      audio_path TEXT,
      audio_mime TEXT DEFAULT 'audio/webm',
      duration_ms INTEGER DEFAULT 0,
      language TEXT DEFAULT 'ko',
      source TEXT DEFAULT 'mic',
      expected_speakers INTEGER,
      project_id INTEGER,
      calendar_event_id TEXT,
      calendar_event_title TEXT,
      error TEXT,
      started_at TEXT DEFAULT (datetime('now', 'localtime')),
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS meeting_speakers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      speaker_key TEXT NOT NULL,
      label TEXT NOT NULL,
      display_name TEXT,
      color TEXT NOT NULL DEFAULT '#4F8EF7',
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS meeting_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      speaker_id INTEGER,
      text TEXT NOT NULL DEFAULT '',
      confidence REAL,
      speaker_corrected INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
      FOREIGN KEY (speaker_id) REFERENCES meeting_speakers(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS meeting_cuts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'silence',
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      auto INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS meeting_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL UNIQUE,
      tldr TEXT,
      key_points TEXT,
      decisions TEXT,
      action_items TEXT,
      next_steps TEXT,
      model TEXT,
      generated_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
  `)

  // Migrations for existing databases
  const memoColumns = db.prepare("PRAGMA table_info(memos)").all() as { name: string }[]
  const memoColumnNames = memoColumns.map((c) => c.name)
  if (memoColumns.length > 0 && !memoColumnNames.includes('is_important')) {
    db.exec("ALTER TABLE memos ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0")
  }
  if (memoColumns.length > 0 && !memoColumnNames.includes('category_id')) {
    // SQLite limitation: ALTER TABLE ADD COLUMN cannot add an FK to an existing column,
    // but the column can still be used as a logical FK; new DBs get the constraint via CREATE.
    db.exec("ALTER TABLE memos ADD COLUMN category_id INTEGER")
  }

  const todoColumns = db.prepare("PRAGMA table_info(todos)").all() as { name: string }[]
  const todoColumnNames = todoColumns.map((c) => c.name)
  if (todoColumns.length > 0 && !todoColumnNames.includes('notes')) {
    db.exec("ALTER TABLE todos ADD COLUMN notes TEXT")
  }

  // AI 채팅별 쓰기 모드: readonly(읽기 전용) | ask(승인 후 쓰기, 기본) | auto(자동 쓰기)
  const aiChatColumns = db.prepare("PRAGMA table_info(ai_chats)").all() as { name: string }[]
  if (aiChatColumns.length > 0 && !aiChatColumns.map((c) => c.name).includes('write_mode')) {
    db.exec("ALTER TABLE ai_chats ADD COLUMN write_mode TEXT NOT NULL DEFAULT 'ask'")
  }

  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]
  const projectColumnNames = projectColumns.map((c) => c.name)
  if (projectColumns.length > 0 && !projectColumnNames.includes('status_manual')) {
    db.exec("ALTER TABLE projects ADD COLUMN status_manual INTEGER NOT NULL DEFAULT 0")
  }
  if (projectColumns.length > 0 && !projectColumnNames.includes('deploy_version')) {
    db.exec("ALTER TABLE projects ADD COLUMN deploy_version TEXT")
  }

  // 회의: 참석 인원(지정 시 화자분리의 클러스터 수를 그 값으로 고정, null이면 자동 추정)
  const meetingColumns = db.prepare("PRAGMA table_info(meetings)").all() as { name: string }[]
  if (meetingColumns.length > 0 && !meetingColumns.map((c) => c.name).includes('expected_speakers')) {
    db.exec("ALTER TABLE meetings ADD COLUMN expected_speakers INTEGER")
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
