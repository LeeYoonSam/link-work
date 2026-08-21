import { BrowserWindow } from 'electron'
import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'
import {
  getDefaultJiraProjectKey,
  getJiraVersion,
  listIssuesByFixVersion,
  listJiraVersions
} from './jira'
import type { JiraIssueSummary, JiraVersionSummary } from './jira'
import { compareVersionDesc, matchesDeployVersion } from '../utils/version-match'

/**
 * 릴리스 노트 = Jira 릴리스(Version)의 순수 미러다. 앱에서 문구를 편집하지 않으므로
 * 동기화는 "항목 전체 교체" 한 가지 동작으로 끝나고, 병합 규칙이 필요 없다.
 */

// DB 행 타입은 main 프로세스에서 쓰는 최소 형태로 로컬 정의한다
// (project.ipc.ts의 ProjectRow와 동일한 방식). renderer 쪽 타입은 types/index.ts에 따로 있다.
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

export interface ReleaseNoteItemRow {
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

/**
 * @param deployVersion 주면 이 배포 버전과 이름이 같은 릴리스만 돌려준다(프로젝트 상세 화면용).
 *   `2.8.1 , 4.155.0`처럼 한 칸에 여러 버전이 적힌 경우도 각각 맞춰 본다.
 *   릴리스 노트는 프로젝트와 저장된 연결을 갖지 않으므로, 이건 **조회 시점의 이름 대조**일 뿐이다.
 */
export function listReleaseNotes(deployVersion?: string): ReleaseNoteSummary[] {
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

  const filtered =
    deployVersion === undefined
      ? rows
      : rows.filter((note) => matchesDeployVersion(deployVersion, note.version_name))
  return sortReleaseNotes(filtered)
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
}

/**
 * 한 번의 전체 동기화에서 이슈까지 받아올 최대 릴리스 수.
 *
 * 릴리스 하나당 Jira 호출이 2회(버전 메타 + 이슈 검색)라 전부 받으면 릴리스 수에 비례해
 * 몇 분씩 걸린다. 버전이 높은 것부터 이만큼만 받고, 나머지는 목록에
 * "아직 동기화하지 않았습니다"로 남아 행의 동기화 버튼으로 언제든 개별로 받을 수 있다.
 */
export const MAX_ISSUE_FETCH_PER_SYNC = 40

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
export async function syncAllReleases(): Promise<SyncAllResult> {
  const defaultKey = getDefaultJiraProjectKey()
  if (!defaultKey) {
    throw new Error('Jira 기본 프로젝트가 설정되지 않았습니다. 연동 설정에서 선택해 주세요.')
  }

  // 버전 목록은 한 번만 받는다. Jira는 릴리스일 순으로 주지만 여기서 버전 내림차순으로 다시
  // 세운다 — 아래 이슈 조회 상한이 "가장 높은 버전부터"에 걸려야 목록 위쪽이 비지 않는다.
  // (릴리스일이 아직 안 잡힌 버전은 Jira 순서에서 어디에 오는지 보장되지 않는다.)
  const versions = [...(await listJiraVersions(defaultKey))].sort((a, b) =>
    compareVersionDesc(a.name, b.name)
  )

  const result: SyncAllResult = { synced: [], metaOnly: [], failed: [] }
  let linked = 0
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
        linked++
      }

      // 이미 받아 뒀는지는 상한 계산에 넣지 않는다 — 넣으면 받아 둔 릴리스가 쌓일수록
      // 전체 동기화가 계속 느려지고, 몇 건을 받을지도 실행할 때마다 달라진다.
      if (fetched >= MAX_ISSUE_FETCH_PER_SYNC) {
        result.metaOnly.push({ noteId, version: version.name })
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
    }
  }

  // 릴리스별로 남기면 활동 로그가 한 번에 수십 건씩 묻히므로 전체 1건으로 요약한다.
  logActivity(
    'release_note',
    'update',
    undefined,
    `Jira 일괄 동기화 (${defaultKey})`,
    `동기화 ${result.synced.length}건 · 신규 ${linked}건 · 이슈 보류 ${result.metaOnly.length}건 · 실패 ${result.failed.length}건`
  )

  // 실패해도 last_sync_error가 기록되고 릴리스 자체는 만들어졌을 수 있어 화면을 갱신해야 한다.
  if (result.synced.length > 0 || result.metaOnly.length > 0 || result.failed.length > 0) {
    notifyDataChanged()
  }

  return result
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
