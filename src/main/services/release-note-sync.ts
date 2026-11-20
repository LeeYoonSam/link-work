import { BrowserWindow } from 'electron'
import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'
import {
  getDefaultJiraProjectKey,
  getJiraVersion,
  listIssuesByFixVersion,
  listJiraVersions,
  listUpdatedReleaseIssues,
  MAX_UPDATED_MINUTES
} from './jira'
import type { JiraIssueSummary, JiraReleaseChangeIssue, JiraVersionSummary } from './jira'
import { compareVersionDesc } from '../utils/version-match'

/**
 * 릴리스 노트 = Jira 릴리스(Version)의 순수 미러다. 앱에서 문구를 편집하지 않으므로
 * 동기화는 "항목 전체 교체" 한 가지 동작으로 끝나고, 병합 규칙이 필요 없다.
 */

// DB 행 타입은 main 프로세스에서 쓰는 최소 형태로 로컬 정의한다
// renderer 쪽 타입은 types/index.ts에 따로 있다.
export interface ReleaseNoteRow {
  id: number
  jira_project_key: string
  jira_version_id: string
  version_name: string
  description: string | null
  released: number
  archived: number
  release_date: string | null
  start_date: string | null
  last_synced_at: string | null
  last_sync_error: string | null
  created_at: string
  updated_at: string
}

interface ReleaseNoteItemRow {
  id: number
  release_note_id: number
  issue_key: string
  issue_type: string | null
  status: string | null
  resolution: string | null
  summary: string
  parent_key: string | null
  sort_order: number
}

export interface ReleaseNoteSummary extends ReleaseNoteRow {
  item_count: number
}

export interface ReleaseNoteWithItems extends ReleaseNoteRow {
  items: ReleaseNoteItemRow[]
}

/**
 * 목록 정렬 — **릴리스일이 아니라 버전 번호 내림차순**이다.
 *
 * 릴리스일로 세우면 두 가지가 어긋난다. 날짜가 아직 안 잡힌 버전은 비교할 값이 없어 맨 끝이나
 * 맨 앞으로 튕기고(실제로 릴리스일이 빈 4.46.0이 목록 최상단에 앉았다), Jira에서 릴리스일을
 * 나중에 손보면 같은 목록이 다시 흔들린다. 버전 번호는 그런 흔들림이 없다.
 */
export function sortReleaseNotes<T extends ReleaseNoteRow>(notes: T[]): T[] {
  return [...notes].sort((a, b) => {
    const byVersion = compareVersionDesc(a.version_name, b.version_name)
    return byVersion !== 0 ? byVersion : b.id - a.id
  })
}

/** 저장된 릴리스 노트 전체(항목 수 포함). 버전 번호 내림차순 */
export function listReleaseNotes(): ReleaseNoteSummary[] {
  const db = getDatabase()
  // 정렬은 SQL이 아니라 sortReleaseNotes가 한다 — 버전 번호 비교는 마디를 숫자로 갈라
  // 앞에서부터 재야 해서(4.46.0 < 4.166.0) SQL 문자열 정렬로는 표현할 수 없다.
  const rows = db
    .prepare(
      `SELECT rn.*, COUNT(i.id) AS item_count
       FROM release_notes rn
       LEFT JOIN release_note_items i ON i.release_note_id = rn.id
       GROUP BY rn.id`
    )
    .all() as ReleaseNoteSummary[]

  return sortReleaseNotes(rows)
}

export function getReleaseNote(id: number): ReleaseNoteWithItems | null {
  const db = getDatabase()
  const note = db.prepare('SELECT * FROM release_notes WHERE id = ?').get(id) as
    | ReleaseNoteRow
    | undefined
  if (!note) return null
  const items = db
    .prepare('SELECT * FROM release_note_items WHERE release_note_id = ? ORDER BY sort_order, id')
    .all(id) as ReleaseNoteItemRow[]
  return { ...note, items }
}

/** 이 Jira 릴리스가 이미 저장돼 있는지 */
function findReleaseNote(jiraProjectKey: string, versionId: string): { id: number } | undefined {
  return getDatabase()
    .prepare('SELECT id FROM release_notes WHERE jira_project_key = ? AND jira_version_id = ?')
    .get(jiraProjectKey, versionId) as { id: number } | undefined
}

/** @param options.quiet 일괄 동기화용 — 활동 로그를 호출자가 전체 1건으로 묶어 남긴다 */
export function linkReleaseNote(
  jiraProjectKey: string,
  version: JiraVersionSummary,
  options: { quiet?: boolean } = {}
): { id: number } {
  const db = getDatabase()

  // UNIQUE 제약이 막아주긴 하지만, 그대로 두면 renderer에 SQLITE_CONSTRAINT 원문이 노출된다.
  // 사용자가 이해할 수 있는 문구로 바꾸기 위해 먼저 확인한다.
  if (findReleaseNote(jiraProjectKey, version.id)) {
    throw new Error('이미 목록에 있는 Jira 릴리스입니다.')
  }

  const result = db
    .prepare(
      `INSERT INTO release_notes
         (jira_project_key, jira_version_id, version_name, description,
          released, archived, release_date, start_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      jiraProjectKey,
      version.id,
      version.name,
      version.description ?? null,
      version.released ? 1 : 0,
      version.archived ? 1 : 0,
      version.releaseDate ?? null,
      version.startDate ?? null
    )

  const id = Number(result.lastInsertRowid)
  if (!options.quiet) {
    logActivity('release_note', 'create', id, version.name, jiraProjectKey)
  }
  return { id }
}

/**
 * Jira에서 릴리스 메타와 이슈를 가져와 항목을 전체 교체한다.
 *
 * 순서를 바꾸지 말 것 — 네트워크 조회(2~3)를 **모두 끝낸 뒤에** 쓰기(4)를 한다.
 * DELETE를 먼저 하고 조회하면, 토큰 만료(401)나 타임아웃처럼 흔한 실패에서
 * 이미 지운 항목을 되돌릴 수 없어 릴리스 노트가 통째로 사라진다.
 * 실패했을 때 남아 있어야 하는 것은 "직전 동기화 결과 그대로"이며,
 * last_synced_at도 갱신하지 않아 화면의 마지막 동기화 시각이 정확하게 유지된다.
 *
 * @param options.quiet 일괄 동기화용. 활동 로그와 renderer 알림을 호출자가 전체 1건으로
 *   묶어 처리한다 — 프로젝트 20개를 돌리면 로그 20건이 쏟아져 활동 로그가 묻히기 때문.
 *   위 안전장치(조회 완료 후 트랜잭션 쓰기)에는 영향을 주지 않는다.
 */
export async function syncReleaseNote(
  id: number,
  options: { quiet?: boolean } = {}
): Promise<{ itemCount: number; truncated: boolean }> {
  const db = getDatabase()

  // 1. 대상 확인
  const note = db.prepare('SELECT * FROM release_notes WHERE id = ?').get(id) as
    | ReleaseNoteRow
    | undefined
  if (!note) {
    throw new Error('릴리스 노트를 찾을 수 없습니다.')
  }

  // 2~3. 네트워크 조회 — 여기서 실패하면 항목(release_note_items)은 절대 건드리지 않는다.
  let version: JiraVersionSummary
  let issues: JiraIssueSummary[]
  let truncated: boolean
  try {
    version = await getJiraVersion(note.jira_version_id)
    const found = await listIssuesByFixVersion(note.jira_version_id)
    issues = found.issues
    truncated = found.truncated
  } catch (err) {
    // 사유는 남긴다 — 조용히 실패해서 "왜 동기화가 안 되지" 상태로 방치되는 것을 막는 것이 목적이다.
    // 갱신하는 것은 last_sync_error뿐이고 항목과 last_synced_at은 그대로 둔다.
    const message = err instanceof Error ? err.message : String(err)
    db.prepare(
      `UPDATE release_notes
         SET last_sync_error = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(message, id)
    throw err
  }

  // 4. 조회가 전부 끝난 뒤에야 쓴다. 부분 반영이 남지 않도록 한 트랜잭션으로 묶는다.
  const applySync = db.transaction(() => {
    db.prepare(
      `UPDATE release_notes
         SET version_name = ?, description = ?, released = ?, archived = ?,
             release_date = ?, start_date = ?,
             last_synced_at = datetime('now', 'localtime'),
             last_sync_error = NULL,
             updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(
      version.name,
      version.description ?? null,
      version.released ? 1 : 0,
      version.archived ? 1 : 0,
      version.releaseDate ?? null,
      version.startDate ?? null,
      id
    )

    db.prepare('DELETE FROM release_note_items WHERE release_note_id = ?').run(id)

    const insert = db.prepare(
      `INSERT INTO release_note_items
         (release_note_id, issue_key, issue_type, status, resolution, summary, parent_key, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    // sort_order는 Jira가 준 순서(JQL의 ORDER BY) 그대로 0..n-1로 매긴다.
    // 표시 그룹 순서가 Jira와 어긋나지 않게 하려면 이 순서가 유일한 기준이어야 한다.
    issues.forEach((issue, index) => {
      insert.run(
        id,
        issue.key,
        issue.issueType ?? null,
        issue.status ?? null,
        issue.resolution ?? null,
        issue.summary,
        issue.parentKey ?? null,
        index
      )
    })
  })
  applySync()

  if (!options.quiet) {
    logActivity('release_note', 'update', id, version.name, `이슈 ${issues.length}건 동기화`)
    notifyDataChanged()
  }

  // 0건은 실패가 아니라 "아직 릴리스에 이슈를 붙이지 않음"일 수 있다. 그대로 반환해 UI가 구분해 표시한다.
  return { itemCount: issues.length, truncated }
}

export interface SyncAllResult {
  /** 이슈까지 가져온 릴리스 */
  synced: Array<{ noteId: number; version: string; itemCount: number }>
  /** 릴리스는 가져왔지만 이슈 조회는 상한에 걸려 미룬 것. 행의 동기화 버튼으로 개별로 받을 수 있다 */
  metaOnly: Array<{ noteId: number; version: string }>
  failed: Array<{ version: string; error: string }>
  /** 이번 실행에서 목록에 새로 들어온 릴리스 수 */
  linked: number
}

/**
 * 한 번의 전체 동기화에서 이슈까지 받아올 최대 릴리스 수.
 *
 * 릴리스 하나당 Jira 호출이 2회(버전 메타 + 이슈 검색)라 전부 받으면 릴리스 수에 비례해
 * 몇 분씩 걸린다. 버전이 높은 것부터 이만큼만 받고, 나머지는 목록에
 * "아직 동기화하지 않았습니다"로 남아 행의 동기화 버튼으로 언제든 개별로 받을 수 있다.
 */
export const MAX_ISSUE_FETCH_PER_SYNC = 40

// 진행 중인 동기화. 전체 동기화(아침 자동·수동 버튼)와 변경분 동기화(화면 진입·새로고침)가
// 겹치지 않게 한다. 같은 종류는 같은 실행을 함께 기다리고, 다른 종류는 끝난 뒤에 돈다.
let syncAllInFlight: Promise<SyncAllResult> | null = null
let changesInFlight: Promise<ReleaseChangeSyncResult> | null = null

/**
 * 기본 Jira 프로젝트의 릴리스 전체를 가져와 릴리스 노트로 만들고 동기화한다.
 *
 * **LinkWork 프로젝트는 전혀 보지 않는다.** 예전에는 프로젝트의 배포 버전에서 출발해 릴리스를
 * 찾고 프로젝트마다 한 행을 만들었는데, 그러면 (1) 대응 프로젝트가 없는 릴리스는 Jira에 멀쩡히
 * 있어도 목록에 나타나지 않고, (2) 같은 배포 버전을 쓰는 프로젝트가 셋이면 같은 릴리스가 목록에
 * 세 번 떴다. 릴리스 노트는 Jira의 미러이므로 릴리스 하나당 한 행이면 충분하다.
 *
 * 동기화 자체는 반드시 syncReleaseNote를 거친다 — 거기에 "조회 완료 후 트랜잭션 쓰기"
 * 안전장치가 들어 있어서, 일괄 처리용 경로를 따로 만들면 그 보장이 조용히 사라진다.
 */
export function syncAllReleases(): Promise<SyncAllResult> {
  // 두 실행이 동시에 돌면 같은 릴리스를 두 번 만들려다 UNIQUE 오류가 failed 에 쌓인다.
  if (syncAllInFlight) return syncAllInFlight
  // 변경분 동기화가 돌고 있으면 끝난 뒤에 다시 판단한다. 그 사이 변경분이 전체로 넘어갔으면
  // 그 실행을 함께 쓴다. 그쪽 실패는 이 실행과 무관하다
  const waitChanges = changesInFlight
  if (waitChanges) {
    // 기다린 변경분이 이미 전체로 넘어가 끝났으면 그 결과를 그대로 쓴다(전체를 두 번 돌리지 않는다)
    return waitChanges.then(
      (r) => (r.mode === 'full' && r.full ? r.full : syncAllReleases()),
      () => syncAllReleases()
    )
  }
  return runFullShared()
}

/** 전체 동기화를 시작하고 syncAllInFlight 로 공유한다. 변경분이 전체로 넘어갈 때도 이것을 쓴다 */
function runFullShared(): Promise<SyncAllResult> {
  if (syncAllInFlight) return syncAllInFlight
  const run = runSyncAllReleases().finally(() => {
    if (syncAllInFlight === run) syncAllInFlight = null
  })
  syncAllInFlight = run
  return run
}

async function runSyncAllReleases(): Promise<SyncAllResult> {
  // 변경분 동기화의 기준점은 시작 시각이다. 도는 동안 바뀐 것을 다음 변경분 조회가 놓치지 않는다
  const startedAt = new Date()
  const checkpointGen = checkpointGeneration
  const defaultKey = getDefaultJiraProjectKey()
  if (!defaultKey) {
    throw new Error('Jira 기본 프로젝트가 설정되지 않았습니다. 연동 설정에서 선택해 주세요.')
  }
  // 이번 실행 전 기준 시각과, 이미 이슈까지 받아 둔 릴리스. 이 중 이번에 다시 받지 못한 것(실패·보류)은
  // 기준 시각을 옮기면 그 사이 변경을 놓친다. 끝난 뒤 fillSkippedReleases 가 그 구간을 메운다
  const oldCheckedAt = readReleaseSyncCheckedAt(defaultKey)
  const previouslySynced = new Map(
    (
      getDatabase()
        .prepare(
          'SELECT id, jira_version_id FROM release_notes WHERE jira_project_key = ? AND last_synced_at IS NOT NULL'
        )
        .all(defaultKey) as { id: number; jira_version_id: string }[]
    ).map((r) => [r.jira_version_id, r])
  )
  const missed: { id: number; jira_version_id: string }[] = []

  // 버전 목록은 한 번만 받는다. Jira는 릴리스일 순으로 주지만 여기서 버전 내림차순으로 다시
  // 세운다 — 아래 이슈 조회 상한이 "가장 높은 버전부터"에 걸려야 목록 위쪽이 비지 않는다.
  // (릴리스일이 아직 안 잡힌 버전은 Jira 순서에서 어디에 오는지 보장되지 않는다.)
  const versions = [...(await listJiraVersions(defaultKey))].sort((a, b) =>
    compareVersionDesc(a.name, b.name)
  )

  const result: SyncAllResult = { synced: [], metaOnly: [], failed: [], linked: 0 }
  let fetched = 0

  for (const version of versions) {
    const existing = findReleaseNote(defaultKey, version.id)

    // Jira에서 보관(archive)한 릴리스는 의도적으로 치운 것이라 새로 끌어오지 않는다.
    // 이미 목록에 있는 것은 사용자가 보고 있을 수 있으므로 그대로 두고 갱신한다.
    if (!existing && version.archived) continue

    try {
      let noteId: number
      if (existing) {
        noteId = existing.id
      } else {
        noteId = linkReleaseNote(defaultKey, version, { quiet: true }).id
        result.linked++
      }

      // 이미 받아 뒀는지는 상한 계산에 넣지 않는다 — 넣으면 받아 둔 릴리스가 쌓일수록
      // 전체 동기화가 계속 느려지고, 몇 건을 받을지도 실행할 때마다 달라진다.
      if (fetched >= MAX_ISSUE_FETCH_PER_SYNC) {
        result.metaOnly.push({ noteId, version: version.name })
        const prev = previouslySynced.get(version.id)
        if (prev) missed.push(prev)
        continue
      }
      fetched++

      const { itemCount } = await syncReleaseNote(noteId, { quiet: true })
      result.synced.push({ noteId, version: version.name, itemCount })
    } catch (err) {
      // 한 릴리스의 실패가 나머지를 막지 않는다. 200개 중 1개가 권한 없는 버전이라고 해서
      // 나머지를 못 받아오면 일괄 동기화의 의미가 없다.
      result.failed.push({
        version: version.name,
        error: err instanceof Error ? err.message : String(err)
      })
      const prev = previouslySynced.get(version.id)
      if (prev) missed.push(prev)
    }
  }

  // 다시 받지 못한 "이미 받아 둔 릴리스"의 건너뛴 구간을 메운다(메울 수 없으면 최신이 아님을 드러낸다)
  if (missed.length > 0) await fillSkippedReleases(defaultKey, oldCheckedAt, startedAt, missed)

  // 릴리스별로 남기면 활동 로그가 한 번에 수십 건씩 묻히므로 전체 1건으로 요약한다.
  logActivity(
    'release_note',
    'update',
    undefined,
    `Jira 일괄 동기화 (${defaultKey})`,
    `동기화 ${result.synced.length}건 · 신규 ${result.linked}건 · 이슈 보류 ${result.metaOnly.length}건 · 실패 ${result.failed.length}건`
  )

  // 실패해도 last_sync_error가 기록되고 릴리스 자체는 만들어졌을 수 있어 화면을 갱신해야 한다.
  if (result.synced.length > 0 || result.metaOnly.length > 0 || result.failed.length > 0) {
    notifyDataChanged()
  }

  // 끝까지 돌았으면 기준점을 항상 시작 시각으로 옮긴다. 다시 받지 못한 릴리스는 위에서 구간을 메웠거나
  // 변경분 대상에서 뺐다. 옮기지 않으면 권한 없는 버전 하나·상한 밖 릴리스 때문에 매번 전체로 돈다(고착)
  writeReleaseSyncCheckedAt(defaultKey, startedAt, checkpointGen)

  return result
}

// ── 변경분 동기화 (docs/RELEASE_NOTES.md) ──

export interface ReleaseChangeSyncResult {
  /** skipped = 10분 이내라 Jira를 부르지 않음. full = 전체 동기화로 넘어감 */
  mode: 'incremental' | 'full' | 'skipped'
  /** 항목이 바뀐 릴리스 */
  changed: Array<{ noteId: number; version: string; upserted: number; removed: number }>
  /** 새로 목록에 들어온 릴리스 수 */
  linked: number
  /** 이름·출시 여부·날짜 등 메타가 바뀐 릴리스 수 */
  metaUpdated: number
  /** mode가 'full'일 때 전체 동기화 결과 */
  full?: SyncAllResult
}

/** 변경분 동기화 기준 시각(ISO). 마지막 동기화(전체·변경분)의 시작 시각이다 */
export const RELEASE_SYNC_CHECKED_KEY = 'release_sync_checked_at'
/** force 가 아니면 마지막 확인 뒤 이만큼은 Jira를 부르지 않는다 */
const RELEASE_CHANGES_SKIP_MS = 10 * 60_000
/** 기준 시각이 이보다 오래됐으면 전체 동기화로 넘어간다 */
const RELEASE_CHANGES_MAX_AGE_MS = 7 * 24 * 60 * 60_000
/** 변경분 조회 기간 여유(분). 시계 차이와 경계 누락을 덮는다 */
const RELEASE_CHANGES_MARGIN_MIN = 10

// 기준 시각을 지운 뒤에 끝난 옛 실행이 기준 시각을 되살리지 않게 세대를 센다
let checkpointGeneration = 0

/**
 * 기준 시각을 읽는다. 값은 `{"projectKey":"PROJ","at":"ISO"}` 이고, 지금 기본 프로젝트와 다르거나
 * 형식이 틀리면(옛 형식 포함) 없는 것으로 본다.
 */
function readReleaseSyncCheckedAt(projectKey: string): number | null {
  const row = getDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(RELEASE_SYNC_CHECKED_KEY) as { value: string } | undefined
  if (!row) return null
  try {
    const v = JSON.parse(row.value) as { projectKey?: unknown; at?: unknown }
    if (v === null || typeof v !== 'object' || v.projectKey !== projectKey || typeof v.at !== 'string') {
      return null
    }
    const t = Date.parse(v.at)
    return Number.isNaN(t) ? null : t
  } catch {
    return null
  }
}

function writeReleaseSyncCheckedAt(projectKey: string, at: Date, gen: number): void {
  if (gen !== checkpointGeneration) return
  getDatabase()
    .prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    )
    .run(RELEASE_SYNC_CHECKED_KEY, JSON.stringify({ projectKey, at: at.toISOString() }))
}

/**
 * 변경분 기준 시각을 지운다. Jira 자격 증명 저장·연결 해제·기본 프로젝트 변경 때 부른다 —
 * 다른 계정·프로젝트의 기준으로 변경분을 묻지 않게, 다음 번은 전체 동기화로 넘어간다.
 * 그 전에 시작한 동기화는 끝나도 기준 시각을 다시 쓰지 않는다(세대 가드).
 */
export function clearReleaseSyncCheckpoint(): void {
  checkpointGeneration++
  getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(RELEASE_SYNC_CHECKED_KEY)
}

/** 변경분 반영 대상: 이슈까지 받아 둔 릴리스(last_synced_at 이 있다) */
interface ReleaseChangeTarget {
  noteId: number
  versionId: string
  items: Pick<
    ReleaseNoteItemRow,
    'issue_key' | 'issue_type' | 'status' | 'resolution' | 'summary' | 'parent_key'
  >[]
}

interface ReleaseChangePlan {
  noteId: number
  /** 추가하거나 갱신할 항목. 기존 항목과 값이 같으면 넣지 않는다 */
  upserts: JiraIssueSummary[]
  /** 지울 항목의 이슈 키 */
  removes: string[]
}

function sameItem(item: ReleaseChangeTarget['items'][number], issue: JiraIssueSummary): boolean {
  return (
    item.issue_type === (issue.issueType ?? null) &&
    item.status === (issue.status ?? null) &&
    item.resolution === (issue.resolution ?? null) &&
    item.summary === issue.summary &&
    item.parent_key === (issue.parentKey ?? null)
  )
}

/**
 * 순수 계산: 바뀐 이슈 + 대상 릴리스의 현재 항목 → 릴리스별 upsert·delete 계획. DB·네트워크를 쓰지 않는다.
 * - 이슈의 fixVersions 에 그 릴리스 버전이 있으면 upsert(값이 같으면 생략).
 * - 그 릴리스 항목인데 fixVersions 에 그 버전이 없으면 delete(다른 버전으로 옮김·fixVersion 비움).
 * - 같은 키가 여러 번 오면 처음 것(가장 최근 갱신)을 쓴다. 바뀐 것이 없는 릴리스는 결과에 없다.
 */
export function planReleaseChanges(
  changes: JiraReleaseChangeIssue[],
  targets: ReleaseChangeTarget[]
): ReleaseChangePlan[] {
  const seen = new Set<string>()
  const unique = changes.filter((c) => {
    if (!c.key || seen.has(c.key)) return false
    seen.add(c.key)
    return true
  })
  const plans: ReleaseChangePlan[] = []
  for (const target of targets) {
    const byKey = new Map(target.items.map((i) => [i.issue_key, i]))
    const plan: ReleaseChangePlan = { noteId: target.noteId, upserts: [], removes: [] }
    for (const issue of unique) {
      const existing = byKey.get(issue.key)
      if (issue.fixVersionIds.includes(target.versionId)) {
        if (!existing || !sameItem(existing, issue)) {
          plan.upserts.push({
            key: issue.key,
            issueType: issue.issueType,
            status: issue.status,
            resolution: issue.resolution,
            summary: issue.summary,
            parentKey: issue.parentKey
          })
        }
      } else if (existing) {
        plan.removes.push(issue.key)
      }
    }
    if (plan.upserts.length > 0 || plan.removes.length > 0) plans.push(plan)
  }
  return plans
}

/**
 * 변경 계획을 항목에 쓴다. 있으면 갱신, 없으면 그 릴리스 sort_order 최댓값 + 1 로 추가, removes 는 지운다.
 * 트랜잭션은 호출자가 연다(조회를 모두 끝낸 뒤 한 번에 쓰는 안전장치와 같은 이유).
 */
function writeItemPlans(db: ReturnType<typeof getDatabase>, plans: ReleaseChangePlan[]): void {
  const updateItem = db.prepare(
    `UPDATE release_note_items
       SET issue_type = ?, status = ?, resolution = ?, summary = ?, parent_key = ?
     WHERE release_note_id = ? AND issue_key = ?`
  )
  const insertItem = db.prepare(
    `INSERT INTO release_note_items
       (release_note_id, issue_key, issue_type, status, resolution, summary, parent_key, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const deleteItem = db.prepare(
    'DELETE FROM release_note_items WHERE release_note_id = ? AND issue_key = ?'
  )
  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM release_note_items WHERE release_note_id = ?'
  )
  for (const plan of plans) {
    let next = Number((maxOrder.get(plan.noteId) as { m: number }).m) + 1
    for (const issue of plan.upserts) {
      const res = updateItem.run(
        issue.issueType ?? null,
        issue.status ?? null,
        issue.resolution ?? null,
        issue.summary,
        issue.parentKey ?? null,
        plan.noteId,
        issue.key
      )
      if (Number(res.changes) === 0) {
        insertItem.run(
          plan.noteId,
          issue.key,
          issue.issueType ?? null,
          issue.status ?? null,
          issue.resolution ?? null,
          issue.summary,
          issue.parentKey ?? null,
          next++
        )
      }
    }
    for (const key of plan.removes) deleteItem.run(plan.noteId, key)
  }
}

/** 대상 릴리스의 현재 항목을 읽어 변경분 계획의 입력으로 만든다 */
function targetsOf(db: ReturnType<typeof getDatabase>, notes: { id: number; jira_version_id: string }[]): ReleaseChangeTarget[] {
  const itemsOf = db.prepare(
    `SELECT issue_key, issue_type, status, resolution, summary, parent_key
       FROM release_note_items WHERE release_note_id = ?`
  )
  return notes.map((n) => ({
    noteId: n.id,
    versionId: n.jira_version_id,
    items: itemsOf.all(n.id) as ReleaseChangeTarget['items']
  }))
}

/**
 * 전체 동기화가 다시 받지 못한 "이미 받아 둔 릴리스"(failed·metaOnly)의 건너뛴 구간을 메운다.
 * 전체 동기화는 끝나면 기준 시각을 항상 앞으로 옮기므로, 이 릴리스들은 옛 기준 시각 ~ 이번 시작 시각의
 * 변경을 따로 받아야 한다. 옛 기준이 쓸 만하면(있음·미래 아님·7일 이내) 변경 이슈 조회 1회로 그 릴리스에만
 * 계획을 적용하고, 오류가 없는 것은 최신으로 표시한다. 메울 수 없으면(옛 기준 없음·조회 실패·상한)
 * last_synced_at 을 비워 변경분 대상에서 빼고 목록에 "아직 동기화하지 않았습니다"로 드러낸다.
 * 항목과 last_sync_error 는 그대로 둔다. throw 하지 않는다.
 */
async function fillSkippedReleases(
  projectKey: string,
  oldCheckedAt: number | null,
  startedAt: Date,
  missed: { id: number; jira_version_id: string }[]
): Promise<'filled' | 'unsynced'> {
  const db = getDatabase()
  const age = oldCheckedAt === null ? null : startedAt.getTime() - oldCheckedAt
  if (age !== null && age >= 0 && age <= RELEASE_CHANGES_MAX_AGE_MS) {
    try {
      const minutes = Math.min(
        MAX_UPDATED_MINUTES,
        Math.max(1, Math.ceil(age / 60_000) + RELEASE_CHANGES_MARGIN_MIN)
      )
      const found = await listUpdatedReleaseIssues(projectKey, minutes)
      if (!found.truncated) {
        db.transaction(() => {
          writeItemPlans(db, planReleaseChanges(found.issues, targetsOf(db, missed)))
          const touch = db.prepare(
            `UPDATE release_notes SET last_synced_at = datetime('now', 'localtime')
             WHERE id = ? AND last_sync_error IS NULL`
          )
          for (const n of missed) touch.run(n.id)
        })()
        return 'filled'
      }
    } catch (err) {
      console.error('[release-note-sync] fill skipped releases', err)
    }
  }
  const unsync = db.prepare('UPDATE release_notes SET last_synced_at = NULL WHERE id = ?')
  db.transaction(() => {
    for (const n of missed) unsync.run(n.id)
  })()
  return 'unsynced'
}

function metaDiffers(note: ReleaseNoteRow, v: JiraVersionSummary): boolean {
  return (
    note.version_name !== v.name ||
    note.description !== (v.description ?? null) ||
    Number(note.released) !== (v.released ? 1 : 0) ||
    Number(note.archived) !== (v.archived ? 1 : 0) ||
    note.release_date !== (v.releaseDate ?? null) ||
    note.start_date !== (v.startDate ?? null)
  )
}

/**
 * 마지막 동기화 이후 바뀐 이슈만 받아 릴리스 항목에 반영한다. Jira는 GET만 한다.
 * 생략(10분 이내) → 전체 전환(기준 없음·7일 초과·조회 상한) → 버전 목록 1회 + 바뀐 이슈 1회 조회 →
 * 조회를 모두 끝낸 뒤 한 트랜잭션으로 쓴다(syncReleaseNote 와 같은 안전장치) → 새 버전만 개별 수신.
 * 조회 실패는 전체로 넘어가지 않고 throw 한다. DB 는 그대로다.
 *
 * 한계: Jira에서 삭제된 이슈와 다른 프로젝트로 옮겨진 이슈는 변경분 조회에 나오지 않는다.
 * 아침 전체 동기화와 행 단위 동기화가 정리한다.
 */
export function syncReleaseChanges(
  options: { force?: boolean } = {}
): Promise<ReleaseChangeSyncResult> {
  if (changesInFlight) return changesInFlight
  const waitAll = syncAllInFlight
  if (waitAll) {
    // 전체 동기화가 돌고 있으면 그 결과를 함께 쓴다. 끝나면 기준점도 이미 옮겨져 있다
    return waitAll.then((full) => fullResult(full))
  }
  const run = runSyncReleaseChanges(options.force === true).finally(() => {
    if (changesInFlight === run) changesInFlight = null
  })
  changesInFlight = run
  return run
}

function fullResult(full: SyncAllResult): ReleaseChangeSyncResult {
  return { mode: 'full', changed: [], linked: full.linked, metaUpdated: 0, full }
}

async function runSyncReleaseChanges(force: boolean): Promise<ReleaseChangeSyncResult> {
  const startedAt = new Date()
  const now = startedAt.getTime()
  const checkpointGen = checkpointGeneration
  const defaultKey = getDefaultJiraProjectKey()
  if (!defaultKey) {
    throw new Error('Jira 기본 프로젝트가 설정되지 않았습니다. 연동 설정에서 선택해 주세요.')
  }

  const checkedAt = readReleaseSyncCheckedAt(defaultKey)
  const age = checkedAt === null ? null : now - checkedAt
  if (!force && age !== null && age >= 0 && age < RELEASE_CHANGES_SKIP_MS) {
    return { mode: 'skipped', changed: [], linked: 0, metaUpdated: 0 }
  }
  // 기준 시각이 미래면 시계가 뒤로 갔다. 조회 기간을 믿을 수 없어 전체로 받는다
  if (age === null || age < 0 || age > RELEASE_CHANGES_MAX_AGE_MS) {
    return fullResult(await runFullShared())
  }

  // 1. 조회 — 여기서 실패하면 DB 는 건드리지 않는다. 기준은 지난 동기화의 시작 시각이다
  const minutes = Math.min(
    MAX_UPDATED_MINUTES,
    Math.max(1, Math.ceil(age / 60_000) + RELEASE_CHANGES_MARGIN_MIN)
  )
  const versions = await listJiraVersions(defaultKey)
  const found = await listUpdatedReleaseIssues(defaultKey, minutes)
  // 상한에 걸리면 무엇을 놓쳤는지 모른다. 전체로 다시 받는다
  if (found.truncated) return fullResult(await runFullShared())

  // 2. 계획 — 이슈까지 받아 둔 릴리스만 대상이다
  const db = getDatabase()
  const notes = db
    .prepare('SELECT * FROM release_notes WHERE jira_project_key = ?')
    .all(defaultKey) as ReleaseNoteRow[]
  const noteByVersion = new Map(notes.map((n) => [n.jira_version_id, n]))
  const targetNotes = notes.filter((n) => n.last_synced_at !== null)
  const plans = planReleaseChanges(found.issues, targetsOf(db, targetNotes))
  const metaChanges = versions.filter((v) => {
    const note = noteByVersion.get(v.id)
    return note !== undefined && metaDiffers(note, v)
  })

  // 3. 쓰기 — 조회가 전부 끝난 뒤 한 트랜잭션
  const changed: ReleaseChangeSyncResult['changed'] = []
  db.transaction(() => {
    const updateMeta = db.prepare(
      `UPDATE release_notes
         SET version_name = ?, description = ?, released = ?, archived = ?,
             release_date = ?, start_date = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    )
    for (const v of metaChanges) {
      updateMeta.run(
        v.name,
        v.description ?? null,
        v.released ? 1 : 0,
        v.archived ? 1 : 0,
        v.releaseDate ?? null,
        v.startDate ?? null,
        (noteByVersion.get(v.id) as ReleaseNoteRow).id
      )
    }

    writeItemPlans(db, plans)
    for (const plan of plans) {
      const note = targetNotes.find((n) => n.id === plan.noteId) as ReleaseNoteRow
      const renamed = metaChanges.find((v) => v.id === note.jira_version_id)
      changed.push({
        noteId: plan.noteId,
        version: renamed ? renamed.name : note.version_name,
        upserted: plan.upserts.length,
        removed: plan.removes.length
      })
    }

    // 바뀐 것이 없던 릴리스도 "지금 기준 최신"이다. 단 직전 동기화가 실패한(last_sync_error 가 있는)
    // 릴리스는 기준점 이전 변경을 못 받았을 수 있다. 오류와 시각을 그대로 두고 행 동기화·전체 동기화에 맡긴다
    const touch = db.prepare(
      `UPDATE release_notes
         SET last_synced_at = datetime('now', 'localtime'), last_sync_error = NULL
       WHERE id = ? AND last_sync_error IS NULL`
    )
    for (const n of targetNotes) touch.run(n.id)
  })()
  writeReleaseSyncCheckedAt(defaultKey, startedAt, checkpointGen)

  // 4. 목록에 없던 버전(보관 아님)만 연결하고 그 릴리스만 전체 수신한다. 버전이 높은 것부터 상한까지
  let linked = 0
  let fetched = 0
  const fresh = versions
    .filter((v) => !noteByVersion.has(v.id) && !v.archived)
    .sort((a, b) => compareVersionDesc(a.name, b.name))
  for (const version of fresh) {
    try {
      const { id } = linkReleaseNote(defaultKey, version, { quiet: true })
      linked++
      if (fetched >= MAX_ISSUE_FETCH_PER_SYNC) continue
      fetched++
      await syncReleaseNote(id, { quiet: true })
    } catch (err) {
      // 실패 사유는 그 행의 last_sync_error 에 남는다. 나머지 반영을 막지 않는다
      console.error('[release-note-sync] link new release', version.name, err)
    }
  }

  const upserted = changed.reduce((n, c) => n + c.upserted, 0)
  const removed = changed.reduce((n, c) => n + c.removed, 0)
  // 화면을 열 때마다 로그가 쌓이지 않게 변경이 있을 때만 남긴다
  if (changed.length > 0 || linked > 0 || metaChanges.length > 0) {
    logActivity(
      'release_note',
      'update',
      undefined,
      `Jira 변경분 동기화 (${defaultKey})`,
      `릴리스 ${changed.length}개 · 항목 갱신 ${upserted}건 · 삭제 ${removed}건 · 신규 릴리스 ${linked}건 · 메타 갱신 ${metaChanges.length}건`
    )
    notifyDataChanged()
  }

  return { mode: 'incremental', changed, linked, metaUpdated: metaChanges.length }
}

// 동기화가 끝났음을 열려 있는 창에 알린다 — AI 대화가 돌린 동기화도 화면에 반영돼야 한다.
function notifyDataChanged(): void {
  // 이미 커밋이 끝난 뒤라 여기서 throw하면 성공한 동기화가 실패로 보고된다.
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('ai:dataChanged', { entity: 'release_note' })
      }
    }
  } catch (e) {
    console.error('[release-note-sync] notify', e)
  }
}
