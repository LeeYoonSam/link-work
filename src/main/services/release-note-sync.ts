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
import { isSameVersion } from '../utils/version-match'

/**
 * 릴리스 노트 = Jira 릴리스(Version)의 순수 미러다. 앱에서 문구를 편집하지 않으므로
 * 동기화는 "항목 전체 교체" 한 가지 동작으로 끝나고, 병합 규칙이 필요 없다.
 */

// DB 행 타입은 main 프로세스에서 쓰는 최소 형태로 로컬 정의한다
// (project.ipc.ts의 ProjectRow와 동일한 방식). renderer 쪽 타입은 types/index.ts에 따로 있다.
export interface ReleaseNoteRow {
  id: number
  project_id: number
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
  project_name: string
  item_count: number
}

export interface ReleaseNoteWithItems extends ReleaseNoteRow {
  project_name: string
  items: ReleaseNoteItemRow[]
}

export function listReleaseNotes(projectId?: number): ReleaseNoteSummary[] {
  const db = getDatabase()
  const where = typeof projectId === 'number' ? 'WHERE rn.project_id = ?' : ''
  // project_id는 NOT NULL + FK CASCADE라 고아 행이 생길 수 없어 INNER JOIN이면 충분하다.
  //
  // 정렬은 프로젝트를 먼저 묶는다 — 전체 목록 화면이 프로젝트별로 그룹지어 보여주기 때문.
  // (project_id를 두 번째 키로 둔 것은 이름이 같은 프로젝트가 둘일 때도 블록이 쪼개지지 않게 하려는 것)
  // 프로젝트별 조회에서는 앞의 두 키가 상수라 릴리스일 내림차순이라는 기존 순서가 그대로 유지된다.
  // 릴리스일이 없는 버전(=아직 출시 예정)은 먼 미래 값으로 대체해 위로 올린다.
  const sql = `
    SELECT rn.*, p.name AS project_name, COUNT(i.id) AS item_count
    FROM release_notes rn
    JOIN projects p ON p.id = rn.project_id
    LEFT JOIN release_note_items i ON i.release_note_id = rn.id
    ${where}
    GROUP BY rn.id
    ORDER BY p.name, rn.project_id, COALESCE(rn.release_date, '9999-12-31') DESC, rn.id DESC
  `
  const stmt = db.prepare(sql)
  return (typeof projectId === 'number' ? stmt.all(projectId) : stmt.all()) as ReleaseNoteSummary[]
}

export function getReleaseNote(id: number): ReleaseNoteWithItems | null {
  const db = getDatabase()
  // 마크다운 내보내기 제목에 프로젝트명이 필요해 함께 돌려준다.
  const note = db
    .prepare(
      `SELECT rn.*, p.name AS project_name
       FROM release_notes rn
       JOIN projects p ON p.id = rn.project_id
       WHERE rn.id = ?`
    )
    .get(id) as (ReleaseNoteRow & { project_name: string }) | undefined
  if (!note) return null
  const items = db
    .prepare('SELECT * FROM release_note_items WHERE release_note_id = ? ORDER BY sort_order, id')
    .all(id) as ReleaseNoteItemRow[]
  return { ...note, items }
}

/** @param options.quiet 일괄 동기화용 — 활동 로그를 호출자가 전체 1건으로 묶어 남긴다 */
export function linkReleaseNote(
  projectId: number,
  jiraProjectKey: string,
  version: JiraVersionSummary,
  options: { quiet?: boolean } = {}
): { id: number } {
  const db = getDatabase()

  // UNIQUE 제약이 막아주긴 하지만, 그대로 두면 renderer에 SQLITE_CONSTRAINT 원문이 노출된다.
  // 사용자가 이해할 수 있는 문구로 바꾸기 위해 먼저 확인한다.
  const existing = db
    .prepare('SELECT id FROM release_notes WHERE project_id = ? AND jira_version_id = ?')
    .get(projectId, version.id) as { id: number } | undefined
  if (existing) {
    throw new Error('이미 이 프로젝트에 연결된 Jira 릴리스입니다.')
  }

  const result = db
    .prepare(
      `INSERT INTO release_notes
         (project_id, jira_project_key, jira_version_id, version_name, description,
          released, archived, release_date, start_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      projectId,
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

export function unlinkReleaseNote(id: number): void {
  const db = getDatabase()
  const row = db.prepare('SELECT version_name FROM release_notes WHERE id = ?').get(id) as
    | { version_name: string }
    | undefined
  db.prepare('DELETE FROM release_notes WHERE id = ?').run(id)
  logActivity('release_note', 'delete', id, row?.version_name)
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
  synced: Array<{ projectId: number; projectName: string; version: string; itemCount: number }>
  unmatched: Array<{ projectId: number; projectName: string; version: string }>
  failed: Array<{ projectId: number; projectName: string; version: string; error: string }>
  /** deploy_version이 비어 있어 대상에서 빠진 프로젝트 수 */
  skipped: number
}

/**
 * deploy_version과 이름이 같은 Jira 릴리스를 찾아 연결하고 한 번에 동기화한다.
 * 프로젝트를 하나씩 손으로 연결하지 않아도 되게 하는 것이 목적이다.
 *
 * 동기화 자체는 반드시 syncReleaseNote를 거친다 — 거기에 "조회 완료 후 트랜잭션 쓰기"
 * 안전장치가 들어 있어서, 일괄 처리용 경로를 따로 만들면 그 보장이 조용히 사라진다.
 */
export async function syncAllByDeployVersion(): Promise<SyncAllResult> {
  const db = getDatabase()

  const defaultKey = getDefaultJiraProjectKey()
  if (!defaultKey) {
    throw new Error('Jira 기본 프로젝트가 설정되지 않았습니다. 연동 설정에서 선택해 주세요.')
  }

  // 버전 목록은 프로젝트 수와 무관하게 한 번만 받는다 — 프로젝트마다 부르면 같은 응답을 20번 받는다.
  const versions = await listJiraVersions(defaultKey)

  const projects = db
    .prepare('SELECT id, name, deploy_version FROM projects ORDER BY name')
    .all() as { id: number; name: string; deploy_version: string | null }[]

  const result: SyncAllResult = { synced: [], unmatched: [], failed: [], skipped: 0 }
  let linked = 0

  for (const project of projects) {
    const deployVersion = project.deploy_version?.trim() ?? ''
    if (!deployVersion) {
      result.skipped++
      continue
    }

    const match = versions.find((v) => isSameVersion(deployVersion, v.name))
    if (!match) {
      result.unmatched.push({
        projectId: project.id,
        projectName: project.name,
        version: deployVersion
      })
      continue
    }

    try {
      // 이미 연결돼 있으면 그대로 쓴다. 연결은 이름이 아니라 버전 ID로 저장되므로
      // 이후 Jira에서 버전 이름이 바뀌어도 추적이 끊기지 않는다 — 이름 매칭은 최초 1회뿐이다.
      const existing = db
        .prepare('SELECT id FROM release_notes WHERE project_id = ? AND jira_version_id = ?')
        .get(project.id, match.id) as { id: number } | undefined
      let noteId: number
      if (existing) {
        noteId = existing.id
      } else {
        noteId = linkReleaseNote(project.id, defaultKey, match, { quiet: true }).id
        linked++
      }

      const { itemCount } = await syncReleaseNote(noteId, { quiet: true })
      result.synced.push({
        projectId: project.id,
        projectName: project.name,
        version: deployVersion,
        itemCount
      })
    } catch (err) {
      // 한 프로젝트의 실패가 나머지를 막지 않는다. 20개 중 1개가 삭제된 버전이라고 해서
      // 나머지 19개를 못 받아오면 일괄 동기화의 의미가 없다.
      result.failed.push({
        projectId: project.id,
        projectName: project.name,
        version: deployVersion,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  // 프로젝트별로 남기면 활동 로그가 한 번에 20건씩 묻히므로 전체 1건으로 요약한다.
  logActivity(
    'release_note',
    'update',
    undefined,
    `Jira 일괄 동기화 (${defaultKey})`,
    `동기화 ${result.synced.length}건 · 신규 연결 ${linked}건 · 미매칭 ${result.unmatched.length}건 · 실패 ${result.failed.length}건 · 버전 없음 ${result.skipped}건`
  )

  // 실패해도 last_sync_error가 기록되고 연결 자체는 만들어졌을 수 있어 화면을 갱신해야 한다.
  if (result.synced.length > 0 || result.failed.length > 0) {
    notifyDataChanged()
  }

  return result
}

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
