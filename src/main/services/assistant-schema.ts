// 비서 테이블 DDL. database.ts 의 initDatabase() 와 테스트가 같은 정의를 쓴다 (docs/ASSISTANT.md §3.1).
// 이후 MVP 가 쓸 컬럼도 함께 만든다. 이유: ALTER TABLE 마이그레이션 수를 줄인다.
export const ASSISTANT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS daily_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_date TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL,
    closed_at TEXT,
    closed_by TEXT,
    source_snapshot TEXT,
    briefing_text TEXT,
    briefing_source TEXT,
    briefing_model TEXT,
    briefing_error TEXT,
    briefing_at TEXT,
    briefing_instruction TEXT,
    recovery_text TEXT,
    recovery_source TEXT,
    recovery_at TEXT,
    wrapup_note TEXT,
    wrapup_at TEXT,
    last_refresh_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- A17: active 계획은 동시에 1개다
  CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_plans_one_active
    ON daily_plans(status) WHERE status = 'active';

  CREATE TABLE IF NOT EXISTS plan_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL,
    candidate_id TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    link TEXT,
    jira_issue_key TEXT,
    project_id INTEGER,
    due_date TEXT,
    score INTEGER NOT NULL,
    rank INTEGER,
    slot_start TEXT,
    slot_end TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    added_by TEXT NOT NULL,
    urgent INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'planned',
    status_note TEXT,
    status_at TEXT,
    work_type TEXT NOT NULL DEFAULT 'etc',
    work_version TEXT,
    parent_key TEXT,
    group_name TEXT,
    FOREIGN KEY (plan_id) REFERENCES daily_plans(id) ON DELETE CASCADE,
    UNIQUE (plan_id, candidate_id)
  );

  CREATE TABLE IF NOT EXISTS assistant_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    plan_date TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    fired_at TEXT,
    status TEXT NOT NULL,
    ref_id TEXT,
    payload TEXT,
    response TEXT,
    responded_at TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_events_date ON assistant_events(plan_date, kind);

  -- 계속 제외 기록 (부록 M, A58). jira_key 로 같은 티켓의 다른 후보 id 도 맞춘다
  CREATE TABLE IF NOT EXISTS assistant_exclusions (
    candidate_id TEXT PRIMARY KEY,
    jira_key TEXT,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    excluded_at TEXT NOT NULL
  );
`

// 기존 DB 에 없는 비서 컬럼을 더한다. 여러 번 실행해도 결과가 같다 (부록 G.7.1).
// database.ts 가 db.exec(ASSISTANT_SCHEMA) 다음 줄에서 부른다. 새 DB 는 DDL 에 이미 컬럼이 있다.
const ADDED_DAILY_PLAN_COLUMNS: { name: string; ddl: string }[] = [
  { name: 'briefing_instruction', ddl: 'ALTER TABLE daily_plans ADD COLUMN briefing_instruction TEXT' }
]

// 업무 유형·묶음 컬럼 (부록 J.5, A50).
const ADDED_PLAN_ITEM_COLUMNS: { name: string; ddl: string }[] = [
  { name: 'work_type', ddl: "ALTER TABLE plan_items ADD COLUMN work_type TEXT NOT NULL DEFAULT 'etc'" },
  { name: 'work_version', ddl: 'ALTER TABLE plan_items ADD COLUMN work_version TEXT' },
  { name: 'parent_key', ddl: 'ALTER TABLE plan_items ADD COLUMN parent_key TEXT' },
  { name: 'group_name', ddl: 'ALTER TABLE plan_items ADD COLUMN group_name TEXT' }
]

type MigrateDb = {
  prepare(sql: string): { all(): unknown[] }
  exec(sql: string): void
}

// 테이블이 없으면 할 일이 없다. ASSISTANT_SCHEMA 가 먼저 만든다.
function addMissingColumns(db: MigrateDb, table: string, columns: { name: string; ddl: string }[]): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (rows.length === 0) return
  const existing = new Set(rows.map((r) => r.name))
  for (const col of columns) {
    if (!existing.has(col.name)) db.exec(col.ddl)
  }
}

export function migrateAssistantSchema(db: MigrateDb): void {
  addMissingColumns(db, 'daily_plans', ADDED_DAILY_PLAN_COLUMNS)
  addMissingColumns(db, 'plan_items', ADDED_PLAN_ITEM_COLUMNS)
}
