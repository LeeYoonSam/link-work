// 프로젝트 보드 로컬 캐시(jira_board_issues·jira_board_sync) 읽기·쓰기. SSOT: docs/PROJECT_BOARD.md
//
// [가드레일]
// - 이 모듈은 두 캐시 테이블에만 쓴다. 다른 테이블은 읽지도 쓰지도 않는다.
// - DB 핸들을 주입받는다. 테스트는 인메모리 SQLite 를 넣는다.
// - 저장된 data JSON 이 깨졌거나 모양이 틀린 행은 버리고 계속한다(throw 하지 않는다).
import type Database from 'better-sqlite3'
import type { JiraBoardIssue, JiraIssueLink } from './jira-board'

type Db = Database.Database

export interface JiraBoardSyncState {
  projectKey: string
  myAccountId: string | null
  /** 마지막 전체 동기화 시작 시각(ISO). 없으면 null */
  lastFullSyncAt: string | null
  /** 마지막 동기화(전체·증분) 시작 시각(ISO). 증분 기준점. 없으면 null */
  lastSyncAt: string | null
  truncated: boolean
  recentDoneDays: number
}

export interface StoredJiraBoard {
  sync: JiraBoardSyncState
  /** 저장 순서(행 생성 순) */
  issues: JiraBoardIssue[]
  /** links·fixVersions 가 없는 옛 형식 행 수. 1 이상이면 다음 auto 동기화가 전체로 채운다 */
  legacyRows: number
  /** 읽지 못해 버린 행 수 */
  brokenRows: number
}

const LEVELS = new Set(['epic', 'standard', 'subtask'])
const CATEGORIES = new Set(['new', 'indeterminate', 'done'])
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/

const LINK_KINDS = new Set(['web', 'attachment', 'description', 'issue'])

const isStr = (v: unknown): v is string => typeof v === 'string'
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

// 링크 하나를 읽는다. 모양이 틀리거나 http(s)가 아니면 null(그 링크만 버린다)
function parseLink(v: unknown): JiraIssueLink | null {
  if (!isRecord(v)) return null
  if (!isStr(v.kind) || !LINK_KINDS.has(v.kind)) return null
  if (!isStr(v.title) || !isStr(v.source) || !isStr(v.url) || !/^https?:\/\//i.test(v.url)) return null
  const link: JiraIssueLink = {
    kind: v.kind as JiraIssueLink['kind'],
    title: v.title,
    url: v.url,
    source: v.source
  }
  if (isStr(v.issueKey)) link.issueKey = v.issueKey
  if (isStr(v.relation)) link.relation = v.relation
  if (isStr(v.issueStatus)) link.issueStatus = v.issueStatus
  if (v.mimeType === null || isStr(v.mimeType)) link.mimeType = v.mimeType
  if (v.size === null || (typeof v.size === 'number' && Number.isFinite(v.size))) link.size = v.size
  if (v.createdAt === null || isStr(v.createdAt)) link.createdAt = v.createdAt
  return link
}

function parseFixVersions(v: unknown): { id: string; name: string }[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is { id: string; name: string } => isRecord(x) && isStr(x.id) && isStr(x.name))
    .map((x) => ({ id: x.id, name: x.name }))
}

/**
 * 저장된 data 를 JiraBoardIssue 로 읽는다. 필수 필드 모양이 틀리면 null.
 * links·fixVersions 는 나중에 붙은 필드라 없으면 빈 배열로 채우고 legacy 로 알린다.
 */
export function parseStoredIssueRow(
  raw: string,
  expectedKey: string
): { issue: JiraBoardIssue; legacy: boolean } | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const ok =
    isStr(o.key) &&
    ISSUE_KEY_RE.test(o.key) &&
    o.key === expectedKey &&
    isStr(o.summary) &&
    isStr(o.issueType) &&
    isStr(o.level) &&
    LEVELS.has(o.level) &&
    isStr(o.status) &&
    isStr(o.statusCategory) &&
    CATEGORIES.has(o.statusCategory) &&
    typeof o.inScope === 'boolean' &&
    isStrOrNull(o.priority) &&
    isStrOrNull(o.parentKey) &&
    isStrOrNull(o.parentSummary) &&
    isStrOrNull(o.assigneeAccountId) &&
    isStrOrNull(o.assigneeName) &&
    isStrOrNull(o.duedate) &&
    isStr(o.updated) &&
    isStrOrNull(o.resolvedAt) &&
    Array.isArray(o.labels) &&
    o.labels.every(isStr) &&
    isStrOrNull(o.excerpt)
  if (!ok) return null
  const legacy = !Array.isArray(o.links) || !Array.isArray(o.fixVersions)
  const links = Array.isArray(o.links)
    ? o.links.map(parseLink).filter((l): l is JiraIssueLink => l !== null)
    : []
  const issue: JiraBoardIssue = {
    key: o.key as string,
    summary: o.summary as string,
    issueType: o.issueType as string,
    level: o.level as JiraBoardIssue['level'],
    status: o.status as string,
    statusCategory: o.statusCategory as JiraBoardIssue['statusCategory'],
    inScope: o.inScope as boolean,
    priority: o.priority as string | null,
    parentKey: o.parentKey as string | null,
    parentSummary: o.parentSummary as string | null,
    assigneeAccountId: o.assigneeAccountId as string | null,
    assigneeName: o.assigneeName as string | null,
    duedate: o.duedate as string | null,
    updated: o.updated as string,
    resolvedAt: o.resolvedAt as string | null,
    labels: [...(o.labels as string[])],
    excerpt: o.excerpt as string | null,
    fixVersions: parseFixVersions(o.fixVersions),
    links
  }
  return { issue, legacy }
}

/** parseStoredIssueRow 의 이슈만. 모양이 틀리면 null */
export function parseStoredIssue(raw: string, expectedKey: string): JiraBoardIssue | null {
  return parseStoredIssueRow(raw, expectedKey)?.issue ?? null
}

interface SyncRow {
  project_key: string
  my_account_id: string | null
  last_full_sync_at: string | null
  last_sync_at: string | null
  truncated: number
  recent_done_days: number
}

/** 프로젝트 하나의 저장본. 동기화 기록이 없으면 null */
export function readStoredBoard(db: Db, projectKey: string): StoredJiraBoard | null {
  const sync = db
    .prepare(
      `SELECT project_key, my_account_id, last_full_sync_at, last_sync_at, truncated, recent_done_days
         FROM jira_board_sync WHERE project_key = ?`
    )
    .get(projectKey) as SyncRow | undefined
  if (!sync) return null
  const rows = db
    .prepare(
      'SELECT issue_key, data FROM jira_board_issues WHERE project_key = ? ORDER BY rowid'
    )
    .all(projectKey) as { issue_key: string; data: string }[]
  const issues: JiraBoardIssue[] = []
  let legacyRows = 0
  let brokenRows = 0
  for (const row of rows) {
    const parsed = parseStoredIssueRow(row.data, row.issue_key)
    if (!parsed) {
      console.error('[jira-board-store] 깨진 행을 건너뜀', projectKey, row.issue_key)
      brokenRows++
      continue
    }
    issues.push(parsed.issue)
    if (parsed.legacy) legacyRows++
  }
  return {
    sync: {
      projectKey: sync.project_key,
      myAccountId: sync.my_account_id,
      lastFullSyncAt: sync.last_full_sync_at,
      lastSyncAt: sync.last_sync_at,
      truncated: Number(sync.truncated) === 1,
      recentDoneDays: Number(sync.recent_done_days)
    },
    issues,
    legacyRows,
    brokenRows
  }
}

export interface StoreWriteMeta {
  myAccountId: string | null
  truncated: boolean
  recentDoneDays: number
  /** 동기화 시작 시각(ISO). last_sync_at 과 각 행의 synced_at 이 된다 */
  syncedAt: string
}

function insertIssueStmt(db: Db): Database.Statement {
  // ON CONFLICT DO UPDATE 는 rowid 를 유지한다. 저장 순서가 증분마다 섞이지 않는다
  return db.prepare(
    `INSERT INTO jira_board_issues (project_key, issue_key, data, updated, synced_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_key, issue_key) DO UPDATE SET
       data = excluded.data, updated = excluded.updated, synced_at = excluded.synced_at`
  )
}

function writeSync(db: Db, projectKey: string, meta: StoreWriteMeta, full: boolean): void {
  db.prepare(
    `INSERT INTO jira_board_sync
       (project_key, my_account_id, last_full_sync_at, last_sync_at, truncated, recent_done_days)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_key) DO UPDATE SET
       my_account_id = excluded.my_account_id,
       last_full_sync_at = ${full ? 'excluded.last_full_sync_at' : 'jira_board_sync.last_full_sync_at'},
       last_sync_at = excluded.last_sync_at,
       truncated = excluded.truncated,
       recent_done_days = excluded.recent_done_days`
  ).run(
    projectKey,
    meta.myAccountId,
    full ? meta.syncedAt : null,
    meta.syncedAt,
    meta.truncated ? 1 : 0,
    meta.recentDoneDays
  )
}

/** 전체 동기화 결과로 그 프로젝트의 행을 통째로 바꾼다. 결과에 없는 행은 지운다 */
export function replaceStoredBoard(
  db: Db,
  projectKey: string,
  issues: JiraBoardIssue[],
  meta: StoreWriteMeta
): void {
  db.transaction(() => {
    db.prepare('DELETE FROM jira_board_issues WHERE project_key = ?').run(projectKey)
    const insert = insertIssueStmt(db)
    for (const issue of issues) {
      insert.run(projectKey, issue.key, JSON.stringify(issue), issue.updated, meta.syncedAt)
    }
    writeSync(db, projectKey, meta, true)
  })()
}

/** 증분 동기화 결과를 덮어쓴다. 없는 행은 추가한다. last_full_sync_at 은 그대로 둔다 */
export function upsertStoredIssues(
  db: Db,
  projectKey: string,
  issues: JiraBoardIssue[],
  meta: StoreWriteMeta
): void {
  db.transaction(() => {
    const insert = insertIssueStmt(db)
    for (const issue of issues) {
      insert.run(projectKey, issue.key, JSON.stringify(issue), issue.updated, meta.syncedAt)
    }
    writeSync(db, projectKey, meta, false)
  })()
}

/** 두 캐시 테이블의 모든 행을 지운다(계정이 바뀌면 볼 수 있는 이슈가 다르다) */
export function clearStoredBoards(db: Db): void {
  db.transaction(() => {
    db.prepare('DELETE FROM jira_board_issues').run()
    db.prepare('DELETE FROM jira_board_sync').run()
  })()
}
