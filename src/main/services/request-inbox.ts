import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'
import { insertTodo, normalizeSourceLink } from '../utils/todo-helpers'
import {
  getJiraIssueUrl,
  getJiraMyAccountId,
  isJiraConnected,
  listAssignedRequests,
  listMentionRequests
} from './jira'
import { getBitbucketWorkspace, isBitbucketConnected, listReviewRequests } from './bitbucket'
import {
  getRequest,
  listOpenRequests,
  markRequest,
  mergeFetchedRequests,
  pruneHandledRequests,
  type FetchedRequest,
  type RequestInboxItem,
  type RequestSource
} from './request-inbox-store'

// 나에게 온 요청 모아보기 (docs/ASSISTANT.md §11.6).
// Jira(다른 사람이 한 할당·나를 멘션한 댓글)와 Bitbucket(나에게 온 리뷰 요청)을 읽어 request_inbox 에 모은다.
// 원본은 읽기만 한다. 할 일로 바꾸기·처리함은 로컬 DB 만 바꾼다.

/**
 * 자동 동기화 최소 간격. 화면 진입·창 focus 마다 원본을 부르지 않게 한다.
 * Bitbucket 은 동기화 1번에 수십 번 GET 하고 시간당 요청 한도를 AI 조회와 나눠 쓴다
 */
export const MIN_SYNC_INTERVAL_MS = 10 * 60_000
/** ↻(force)도 이 간격 안에서는 저장본을 돌려준다(연타 방지) */
export const FORCE_MIN_INTERVAL_MS = 30_000

export type InboxSourceState = 'ok' | 'not_connected' | 'no_workspace' | 'error'

export interface InboxSourceStatus {
  state: InboxSourceState
  /** state 가 error 일 때 사용자용 문구 */
  error: string | null
}

export interface RequestInboxSnapshot {
  items: RequestInboxItem[]
  jira: InboxSourceStatus
  bitbucket: InboxSourceStatus
  /** 마지막 동기화 시각(ISO). 이번 실행에서 아직 안 했으면 null */
  syncedAt: string | null
}

const IDLE: InboxSourceStatus = { state: 'ok', error: null }

let lastSyncMs = 0
let syncedAt: string | null = null
let statuses: { jira: InboxSourceStatus; bitbucket: InboxSourceStatus } = { jira: IDLE, bitbucket: IDLE }
let inflight: Promise<RequestInboxSnapshot> | null = null

/** 테스트용: 모듈 상태를 비운다 */
export function resetRequestInboxState(): void {
  lastSyncMs = 0
  syncedAt = null
  statuses = { jira: IDLE, bitbucket: IDLE }
  inflight = null
}

/** 다음 자동 동기화가 간격과 무관하게 원본을 부르게 한다(설정 변경 직후) */
export function markRequestInboxStale(): void {
  lastSyncMs = 0
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err)
}

/** Jira 원본 ISO(+0900 등) → UTC ISO. 깨졌으면 null */
export function toUtcIso(value: string | null | undefined): string | null {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

function connectionStatus(): { jira: InboxSourceStatus; bitbucket: InboxSourceStatus } {
  const jira = isJiraConnected() ? statuses.jira : { state: 'not_connected' as const, error: null }
  let bitbucket = statuses.bitbucket
  if (!isBitbucketConnected()) bitbucket = { state: 'not_connected', error: null }
  else if (!getBitbucketWorkspace()) bitbucket = { state: 'no_workspace', error: null }
  return { jira, bitbucket }
}

/** 지금 쓸 수 있는 원본. 연결을 끊었거나 워크스페이스를 지운 원본의 저장 행은 보이지 않는다 */
function activeSources(conn: { jira: InboxSourceStatus; bitbucket: InboxSourceStatus }): RequestSource[] {
  const out: RequestSource[] = []
  if (conn.jira.state !== 'not_connected') out.push('jira')
  if (conn.bitbucket.state !== 'not_connected' && conn.bitbucket.state !== 'no_workspace') out.push('bitbucket')
  return out
}

/** DB 저장본만 읽는다. 원본을 부르지 않는다 */
export function cachedRequestInbox(): RequestInboxSnapshot {
  const conn = connectionStatus()
  return { items: listOpenRequests(getDatabase(), activeSources(conn)), ...conn, syncedAt }
}

async function fetchJira(accountId: string | null): Promise<{ fetched: FetchedRequest[]; complete: boolean }> {
  const [assigned, mentions] = await Promise.all([
    listAssignedRequests(),
    accountId ? listMentionRequests(accountId) : Promise.resolve({ mentions: [], truncated: false })
  ])
  const fetched: FetchedRequest[] = []
  for (const a of assigned.issues) {
    const url = getJiraIssueUrl(a.key)
    if (!url) continue
    fetched.push({
      id: `jira:assigned:${a.key}`,
      source: 'jira',
      kind: 'assigned',
      title: a.summary || a.key,
      ref: a.key,
      actor: a.reporterName,
      excerpt: null,
      url,
      requestedAt: null
    })
  }
  for (const m of mentions.mentions) {
    const base = getJiraIssueUrl(m.key)
    if (!base) continue
    fetched.push({
      id: `jira:mention:${m.key}:${m.commentId}`,
      source: 'jira',
      kind: 'mention',
      title: m.summary || m.key,
      ref: m.key,
      actor: m.authorName,
      excerpt: m.excerpt,
      url: `${base}?focusedCommentId=${encodeURIComponent(m.commentId)}`,
      requestedAt: toUtcIso(m.created)
    })
  }
  return { fetched, complete: !assigned.truncated && !mentions.truncated && accountId !== null }
}

async function fetchBitbucket(
  fallbackAccountId: string | null,
  isHandled: (id: string) => boolean
): Promise<{ fetched: FetchedRequest[]; complete: boolean }> {
  // read:user 스코프가 없으면 Atlassian accountId(Jira 와 같은 값)로 리뷰어를 찾는다.
  // 이미 처리한 PR 은 승인 여부(상세 GET)를 다시 보지 않는다
  const { requests, complete } = await listReviewRequests(fallbackAccountId, (ws, repo, n) =>
    isHandled(reviewId(ws, repo, n))
  )
  const fetched: FetchedRequest[] = requests.map((r) => ({
    id: reviewId(r.workspace, r.repo, r.id),
    source: 'bitbucket',
    kind: 'review',
    title: r.title || `PR #${r.id}`,
    ref: `${r.repo} #${r.id}`,
    actor: r.authorName,
    excerpt: null,
    url: r.url,
    requestedAt: toUtcIso(r.createdOn)
  }))
  return { fetched, complete }
}

function reviewId(workspace: string, repo: string, n: number): string {
  return `bitbucket:review:${workspace}/${repo}#${n}`
}

async function runSync(): Promise<RequestInboxSnapshot> {
  const db = getDatabase()
  const now = new Date()
  const nowIso = now.toISOString()
  const conn = connectionStatus()

  // 내 Jira accountId 는 동기화마다 다시 읽는다. 앱을 끄지 않고 다른 계정으로 다시 연결해도 옛 값을 쓰지 않는다
  let accountId: string | null = null
  let jira: InboxSourceStatus = conn.jira
  if (conn.jira.state !== 'not_connected') {
    try {
      accountId = await getJiraMyAccountId()
      const { fetched, complete } = await fetchJira(accountId)
      mergeFetchedRequests(db, 'jira', fetched, complete, nowIso)
      // 조회가 온전할 때만 정리한다. 실패·잘림이면 last_seen_at 이 낡아 원본에 남은 처리 행까지 지울 수 있다
      if (complete) pruneHandledRequests(db, now, 'jira')
      jira = IDLE
    } catch (err) {
      jira = { state: 'error', error: errorText(err) }
    }
  }

  // Bitbucket 은 Jira accountId 를 대신 쓸 수 있어 Jira 다음에 돈다
  let bitbucket: InboxSourceStatus = conn.bitbucket
  if (conn.bitbucket.state !== 'not_connected' && conn.bitbucket.state !== 'no_workspace') {
    try {
      const isHandled = (id: string): boolean => {
        const r = getRequest(db, id)
        return r !== null && r.state !== 'open'
      }
      const { fetched, complete } = await fetchBitbucket(accountId, isHandled)
      mergeFetchedRequests(db, 'bitbucket', fetched, complete, nowIso)
      if (complete) pruneHandledRequests(db, now, 'bitbucket')
      bitbucket = IDLE
    } catch (err) {
      bitbucket = { state: 'error', error: errorText(err) }
    }
  }

  statuses = { jira, bitbucket }
  syncedAt = nowIso
  return { items: listOpenRequests(db, activeSources({ jira, bitbucket })), jira, bitbucket, syncedAt }
}

/**
 * 원본과 동기화한다. 마지막 동기화에서 MIN_SYNC_INTERVAL_MS(force 면 FORCE_MIN_INTERVAL_MS) 안의
 * 재호출은 저장본만 돌려준다. 실행 중이면 그 결과를 함께 기다린다.
 */
export async function syncRequestInbox(force: boolean, nowMs: number = Date.now()): Promise<RequestInboxSnapshot> {
  if (inflight) return inflight
  const interval = force ? FORCE_MIN_INTERVAL_MS : MIN_SYNC_INTERVAL_MS
  if (lastSyncMs > 0 && nowMs - lastSyncMs < interval) return cachedRequestInbox()
  lastSyncMs = nowMs
  inflight = runSync().finally(() => {
    inflight = null
  })
  return inflight
}

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** 'YYYY-MM-DD' 이고 실제로 있는 날짜인가(2026-02-31 거부) */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = DATE_KEY_RE.exec(value)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.toISOString().slice(0, 10) === value
}

/**
 * 요청을 할 일로 바꾼다. 제목은 '[출처] 제목', 출처 링크는 원본 주소, 마감은 dueDate(YYYY-MM-DD, 없으면 없음).
 * 같은 트랜잭션에서 요청을 todo 상태로 둔다. 이미 처리된 요청이면 실패한다.
 */
export function convertRequestToTodo(
  id: unknown,
  dueDate: unknown
): { success: true; todoId: number } | { success: false; error: string } {
  if (typeof id !== 'string' || id.length > 300) return { success: false, error: '잘못된 요청입니다.' }
  if (dueDate !== null && dueDate !== undefined && !isDateKey(dueDate)) {
    return { success: false, error: '잘못된 마감일입니다.' }
  }
  const db = getDatabase()
  const req = getRequest(db, id)
  if (!req || req.state !== 'open') return { success: false, error: '이미 처리했거나 사라진 요청입니다.' }

  const title = todoTitleFor(req)
  let sourceLink: string | null
  try {
    sourceLink = normalizeSourceLink(req.url)
  } catch {
    sourceLink = null
  }
  const run = db.transaction(() => {
    const todoId = insertTodo(db, { title, due_date: dueDate ?? null, source_link: sourceLink })
    markRequest(db, id, 'todo', todoId)
    return todoId
  })
  const todoId = run()
  logActivity('todo', 'create', todoId, title)
  return { success: true, todoId }
}

/** 할 일 제목. 출처가 앞에 붙는다 */
export function todoTitleFor(req: Pick<RequestInboxItem, 'kind' | 'ref' | 'title'>): string {
  if (req.kind === 'review') return `[리뷰] ${req.ref} ${req.title}`.trim()
  if (req.kind === 'mention') return `[${req.ref}] ${req.title} 댓글 답하기`
  return `[${req.ref}] ${req.title}`
}

/** 처리함. 다시 보이지 않는다 */
export function dismissRequest(id: unknown): { success: true } | { success: false; error: string } {
  if (typeof id !== 'string' || id.length > 300) return { success: false, error: '잘못된 요청입니다.' }
  if (!markRequest(getDatabase(), id, 'dismissed', null)) {
    return { success: false, error: '이미 처리했거나 사라진 요청입니다.' }
  }
  return { success: true }
}

/** 저장된 요청의 원본 주소. 렌더러가 보낸 URL 을 믿지 않고 id 로 찾는다 */
export function requestUrl(id: unknown): string | null {
  if (typeof id !== 'string' || id.length > 300) return null
  const req = getRequest(getDatabase(), id)
  return req && /^https:\/\//.test(req.url) ? req.url : null
}
