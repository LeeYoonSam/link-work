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

/**
 * 릴리스 노트에서 project_id를 걷어낸다.
 *
 * 릴리스 노트는 Jira 릴리스의 미러라 LinkWork 프로젝트와 이어 둘 이유가 없었는데, 프로젝트마다
 * 한 행을 만들다 보니 **같은 배포 버전을 쓰는 프로젝트가 셋이면 같은 릴리스가 목록에 세 번** 떴다.
 * 이제 릴리스 하나당 한 행이고, 프로젝트 화면은 배포 버전으로 찾아 읽기만 한다.
 *
 * 남길 행은 **가져온 이슈가 가장 많은 행**이다. 중복 행들은 같은 Jira 릴리스를 가리키므로 내용이
 * 같아야 하지만, 이슈 조회 상한에 걸려 어떤 행은 메타만 있을 수 있다. 알맹이가 있는 쪽을 남긴다.
 *
 * initDatabase 안에 인라인으로 두지 않은 것은 테스트에서 직접 부르기 위해서다 —
 * 사용자의 릴리스 노트와 이슈를 통째로 옮기는 코드라 조용히 깨지면 데이터가 사라진다.
 */
export function migrateReleaseNotesDropProject(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(release_notes)').all() as { name: string }[]
  if (!columns.some((c) => c.name === 'project_id')) return

  // FK를 켠 채로 DROP하면 release_note_items가 CASCADE로 함께 지워진다. 반드시 꺼 두고,
  // PRAGMA는 트랜잭션 안에서 무시되므로 트랜잭션 밖에서 끄고 켠다.
  db.pragma('foreign_keys = OFF')
  try {
    db.exec(`
      BEGIN;

      -- 같은 릴리스를 가리키는 행 중 이슈가 가장 많은 것 하나만 남긴다
      CREATE TEMP TABLE release_notes_keep AS
        SELECT rn.id AS keep_id, rn.jira_project_key AS key, rn.jira_version_id AS version_id
        FROM release_notes rn
        WHERE rn.id = (
          SELECT r2.id FROM release_notes r2
          WHERE r2.jira_project_key = rn.jira_project_key
            AND r2.jira_version_id = rn.jira_version_id
          ORDER BY (SELECT COUNT(*) FROM release_note_items i WHERE i.release_note_id = r2.id) DESC,
                   r2.last_synced_at IS NULL,
                   r2.id
          LIMIT 1
        );

      -- 남기지 않는 행의 이슈부터 지운다 (FK를 꺼 뒀으므로 CASCADE에 기댈 수 없다)
      DELETE FROM release_note_items
      WHERE release_note_id NOT IN (SELECT keep_id FROM release_notes_keep);

      DELETE FROM release_notes
      WHERE id NOT IN (SELECT keep_id FROM release_notes_keep);

      DROP TABLE release_notes_keep;

      CREATE TABLE release_notes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jira_project_key TEXT NOT NULL,
        jira_version_id TEXT NOT NULL,
        version_name TEXT NOT NULL,
        description TEXT,
        released INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        release_date TEXT,
        start_date TEXT,
        last_synced_at TEXT,
        last_sync_error TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE (jira_project_key, jira_version_id)
      );
      INSERT INTO release_notes_new
        SELECT id, jira_project_key, jira_version_id, version_name, description,
               released, archived, release_date, start_date, last_synced_at, last_sync_error,
               created_at, updated_at
        FROM release_notes;
      DROP TABLE release_notes;
      ALTER TABLE release_notes_new RENAME TO release_notes;
      DROP INDEX IF EXISTS idx_release_notes_unlinked;
      COMMIT;
    `)
  } finally {
    db.pragma('foreign_keys = ON')
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
      -- 1단계 부모-자식 계층. NULL이면 최상위 작업, 값이 있으면 해당 작업의 하위.
      -- SQLite ALTER TABLE로는 FK 제약을 못 붙이므로 tasks.id에 대한 논리 FK로만 둔다.
      parent_task_id INTEGER,
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
      -- 'meeting' | 'interview'. 요약 스키마와 상세 UI가 이 값으로 갈린다.
      kind TEXT NOT NULL DEFAULT 'meeting',
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
      text_corrected INTEGER NOT NULL DEFAULT 0,
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
      -- 면접(kind='interview') 전용 4분류. 회의에서는 비어 있고, 면접에서는
      -- decisions/action_items/next_steps가 비어 있다 (meetings.kind로 분기).
      qa_pairs TEXT,
      competencies TEXT,
      follow_ups TEXT,
      fact_checks TEXT,
      model TEXT,
      generated_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );

    -- 릴리스 노트: Jira 릴리스(Version) 미러링.
    -- 매칭 키는 이름이 아니라 불변 ID(jira_version_id)다 — Jira에서 버전 이름을 바꿔도
    -- 연결이 끊기지 않아야 하기 때문. version_name 이하는 표시용 캐시라 동기화마다 갱신된다.
    -- 릴리스 노트는 Jira 릴리스의 순수 미러다. LinkWork 프로젝트와는 어떤 연결도 갖지 않는다 —
    -- 프로젝트에 묶어 두면 같은 배포 버전을 쓰는 프로젝트가 여럿일 때 같은 릴리스가 그 수만큼
    -- 목록에 중복으로 뜬다. 프로젝트 화면이 필요할 때 배포 버전으로 찾아 읽기만 한다.
    CREATE TABLE IF NOT EXISTS release_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jira_project_key TEXT NOT NULL,
      jira_version_id TEXT NOT NULL,
      version_name TEXT NOT NULL,
      description TEXT,
      released INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      release_date TEXT,
      start_date TEXT,
      -- NULL이면 아직 한 번도 동기화하지 않은 상태. 동기화가 실패하면 갱신하지 않아
      -- 화면의 "마지막 동기화" 시각이 실제 성공 시점을 계속 가리킨다.
      last_synced_at TEXT,
      last_sync_error TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      UNIQUE (jira_project_key, jira_version_id)
    );

    CREATE TABLE IF NOT EXISTS release_note_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      release_note_id INTEGER NOT NULL,
      issue_key TEXT NOT NULL,
      issue_type TEXT,
      status TEXT,
      resolution TEXT,
      summary TEXT NOT NULL,
      parent_key TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (release_note_id) REFERENCES release_notes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_release_note_items_note
      ON release_note_items(release_note_id);
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

  // 작업 1단계 계층: 부모 작업 참조 컬럼. 기존 행은 자동으로 NULL(최상위)이라 하위 호환.
  // SQLite ALTER TABLE ADD COLUMN은 FK 제약을 붙일 수 없어 tasks.id에 대한 논리 FK로만 둔다.
  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
  if (taskColumns.length > 0 && !taskColumns.map((c) => c.name).includes('parent_task_id')) {
    db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER")
  }

  // 회의: 참석 인원(지정 시 화자분리의 클러스터 수를 그 값으로 고정, null이면 자동 추정)
  const meetingColumns = db.prepare("PRAGMA table_info(meetings)").all() as { name: string }[]
  const meetingColumnNames = meetingColumns.map((c) => c.name)
  if (meetingColumns.length > 0 && !meetingColumnNames.includes('expected_speakers')) {
    db.exec("ALTER TABLE meetings ADD COLUMN expected_speakers INTEGER")
  }
  // 녹음 종류: 기존 녹음은 전부 회의로 간주(DEFAULT 'meeting')
  if (meetingColumns.length > 0 && !meetingColumnNames.includes('kind')) {
    db.exec("ALTER TABLE meetings ADD COLUMN kind TEXT NOT NULL DEFAULT 'meeting'")
  }

  // 면접 요약 4분류 (회의 요약 행에서는 NULL로 남는다)
  const summaryColumns = db.prepare("PRAGMA table_info(meeting_summaries)").all() as { name: string }[]
  const summaryColumnNames = summaryColumns.map((c) => c.name)
  if (summaryColumns.length > 0) {
    for (const col of ['qa_pairs', 'competencies', 'follow_ups', 'fact_checks']) {
      if (!summaryColumnNames.includes(col)) {
        db.exec(`ALTER TABLE meeting_summaries ADD COLUMN ${col} TEXT`)
      }
    }
  }

  // 회의 세그먼트: 사용자가 발언 텍스트를 수동 수정했는지 표시 (speaker_corrected와 동일한 패턴)
  const segmentColumns = db.prepare("PRAGMA table_info(meeting_segments)").all() as { name: string }[]
  if (segmentColumns.length > 0 && !segmentColumns.map((c) => c.name).includes('text_corrected')) {
    db.exec("ALTER TABLE meeting_segments ADD COLUMN text_corrected INTEGER NOT NULL DEFAULT 0")
  }

  migrateReleaseNotesDropProject(db)

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
