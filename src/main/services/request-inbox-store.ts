import type Database from 'better-sqlite3'

// 나에게 온 요청(request_inbox 테이블) 읽기·쓰기 (docs/ASSISTANT.md §11.6).
// electron 을 import 하지 않는다. db 를 받아 node:sqlite 테스트에서도 돈다.
//
// 규칙
// - 원본(Jira·Bitbucket) 조회에 새로 잡힌 요청은 open 으로 넣는다.
// - 이미 있는 행은 내용(제목·링크 등)과 last_seen_at 만 고친다. state 는 건드리지 않는다.
//   그래서 할 일로 바꾸거나(todo) 처리한(dismissed) 요청은 다시 잡혀도 보이지 않는다.
// - 조회가 끝까지 성공했을 때만(complete) 이번에 잡히지 않은 open 행을 지운다. 원본에서 사라진 요청
//   (PR 승인·머지, 이슈 완료, 담당 변경, 조회 기간 지남)이다. 실패·잘림이면 지우지 않는다.
// - open 이 아닌 행은 마지막으로 조회에 잡힌 뒤 HANDLED_KEEP_DAYS 가 지나면 지운다(다시 잡힐 일이 없다).
//   호출자는 그 원본 조회가 온전할 때만 부른다. 실패·잘림 동안에는 last_seen_at 이 낡아도 지우지 않는다.

export type RequestSource = 'jira' | 'bitbucket'
export type RequestKind = 'assigned' | 'mention' | 'review'
export type RequestState = 'open' | 'todo' | 'dismissed'

/** 원본 조회 한 건 */
export interface FetchedRequest {
  id: string
  source: RequestSource
  kind: RequestKind
  title: string
  /** 짧은 출처 표시. Jira 키 또는 'repo #12' */
  ref: string
  /** 요청한 사람. 모르면 null */
  actor: string | null
  /** 멘션 댓글 앞부분. 없으면 null */
  excerpt: string | null
  /** https 원본 주소 */
  url: string
  /** 요청 시각(UTC ISO). 모르면 null(목록 정렬은 처음 본 시각을 쓴다) */
  requestedAt: string | null
}

export interface RequestInboxItem extends FetchedRequest {
  firstSeenAt: string
}

interface Row {
  id: string
  source: string
  kind: string
  title: string
  ref: string
  actor: string | null
  excerpt: string | null
  url: string
  requested_at: string | null
  state: string
  todo_id: number | null
  first_seen_at: string
  last_seen_at: string
}

/** 처리한 행을 원본에서 사라진 뒤 남겨 두는 기간(일) */
export const HANDLED_KEEP_DAYS = 30

const SOURCES: readonly RequestSource[] = ['jira', 'bitbucket']
const KINDS: readonly RequestKind[] = ['assigned', 'mention', 'review']

function toItem(r: Row): RequestInboxItem | null {
  if (!(SOURCES as readonly string[]).includes(r.source)) return null
  if (!(KINDS as readonly string[]).includes(r.kind)) return null
  return {
    id: r.id,
    source: r.source as RequestSource,
    kind: r.kind as RequestKind,
    title: r.title,
    ref: r.ref,
    actor: r.actor,
    excerpt: r.excerpt,
    url: r.url,
    requestedAt: r.requested_at,
    firstSeenAt: r.first_seen_at
  }
}

/**
 * 한 원본의 조회 결과를 반영한다. complete 가 true 일 때만 이번에 없는 open 행을 지운다.
 * 반환: 새로 넣은 건수
 */
export function mergeFetchedRequests(
  db: Database.Database,
  source: RequestSource,
  fetched: FetchedRequest[],
  complete: boolean,
  nowIso: string
): number {
  const insert = db.prepare(
    `INSERT INTO request_inbox
       (id, source, kind, title, ref, actor, excerpt, url, requested_at, state, todo_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, ref = excluded.ref, actor = excluded.actor, excerpt = excluded.excerpt,
       url = excluded.url, requested_at = excluded.requested_at, last_seen_at = excluded.last_seen_at`
  )
  const exists = db.prepare('SELECT 1 FROM request_inbox WHERE id = ?')
  const run = db.transaction(() => {
    let added = 0
    const seen = new Set<string>()
    for (const f of fetched) {
      if (f.source !== source || seen.has(f.id)) continue
      seen.add(f.id)
      if (!exists.get(f.id)) added += 1
      insert.run(f.id, f.source, f.kind, f.title, f.ref, f.actor, f.excerpt, f.url, f.requestedAt, nowIso, nowIso)
    }
    if (complete) {
      const open = db
        .prepare("SELECT id FROM request_inbox WHERE source = ? AND state = 'open'")
        .all(source) as { id: string }[]
      const del = db.prepare('DELETE FROM request_inbox WHERE id = ?')
      for (const { id } of open) if (!seen.has(id)) del.run(id)
    }
    return added
  })
  return run()
}

/** 한 원본에서 마지막으로 조회에 잡힌 지 HANDLED_KEEP_DAYS 가 지난 처리 행을 지운다 */
export function pruneHandledRequests(db: Database.Database, now: Date, source: RequestSource): void {
  const before = new Date(now.getTime() - HANDLED_KEEP_DAYS * 86_400_000).toISOString()
  db.prepare("DELETE FROM request_inbox WHERE source = ? AND state <> 'open' AND last_seen_at < ?").run(source, before)
}

/** 보이는 요청(open). sources 에 든 원본만. 요청 시각(없으면 처음 본 시각) 최신순 */
export function listOpenRequests(
  db: Database.Database,
  sources: readonly RequestSource[] = SOURCES
): RequestInboxItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM request_inbox WHERE state = 'open'
       ORDER BY COALESCE(requested_at, first_seen_at) DESC, id`
    )
    .all() as Row[]
  return rows
    .map(toItem)
    .filter((x): x is RequestInboxItem => x !== null && sources.includes(x.source))
}

export function getRequest(db: Database.Database, id: string): (RequestInboxItem & { state: RequestState }) | null {
  const row = db.prepare('SELECT * FROM request_inbox WHERE id = ?').get(id) as Row | undefined
  if (!row) return null
  const item = toItem(row)
  if (!item) return null
  return { ...item, state: row.state as RequestState }
}

/** open 인 요청의 상태를 바꾼다. 바꿨으면 true(이미 처리됐거나 없으면 false) */
export function markRequest(
  db: Database.Database,
  id: string,
  state: Exclude<RequestState, 'open'>,
  todoId: number | null
): boolean {
  const res = db
    .prepare("UPDATE request_inbox SET state = ?, todo_id = ? WHERE id = ? AND state = 'open'")
    .run(state, todoId, id)
  return res.changes > 0
}
