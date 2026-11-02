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
`
