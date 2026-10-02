import { BrowserWindow } from 'electron'
import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'
import { applyProjectAutoStatus, type ProjectStatusFields } from '../utils/project-dates'
import {
  getDefaultJiraProjectKey,
  getJiraMyAccountId,
  getJiraSiteUrl,
  listChildIssues,
  listIssuesByKeys,
  listMyTodoIssues,
  listRemoteLinks
} from './jira'
import type { JiraRemoteLink, JiraSyncIssue } from './jira'
import {
  buildProjectSyncPlan,
  localToday,
  parseProjectSyncSelection,
  resolveProjectRoots,
  selectProjectSyncOps,
  type DbSyncState,
  type JiraSyncSnapshot,
  type ProjectSyncPlan,
  type ProjectSyncResult,
  type ProjectSyncSelection,
  type SelectedProjectSyncOp
} from './project-sync-plan'

/**
 * Jira 프로젝트 싱크업 오케스트레이션 (docs/PROJECT_SYNC.md).
 *
 * 흐름: Jira 조회(읽기 전용) → 스냅샷 → 현재 DB와 비교해 계획(project-sync-plan.ts) → 한 트랜잭션으로 적용.
 * preview가 받은 스냅샷을 잠시 캐시해 두고, apply는 그 스냅샷으로 **현재 DB 기준 재계획**한 뒤 적용한다 —
 * 미리보기와 적용 사이에 사용자가 프로젝트를 고쳤어도 그 상태 위에서 다시 계산되므로 덮어쓰지 않는다.
 * apply는 **절대 Jira를 다시 조회하지 않는다.** 캐시가 없거나 만료됐으면 오류를 던진다 —
 * 새로 조회해 적용하면 사용자가 보지 않은 계획이 반영되기 때문이다.
 */

const SNAPSHOT_TTL_MS = 10 * 60 * 1000
// 조상 조회 깊이 — 하위 작업 → 작업 → 에픽이 최대 계층이다.
const MAX_ANCESTOR_DEPTH = 2

let cached: { snapshot: JiraSyncSnapshot; cachedAt: number } | null = null

/**
 * 캐시를 버린다. Jira 연결 해제·자격 저장·기본 프로젝트 변경 때 부른다(ipc/release-note.ipc.ts) —
 * 다른 계정·프로젝트의 미리보기가 적용되면 안 된다. 이후 apply는 미리보기를 다시 요구한다.
 */
export function clearProjectSyncCache(): void {
  cached = null
}

/** Jira에서 트리거와 그 조상·자손, 루트의 원격 링크까지 한 번에 모은다 */
export async function fetchJiraSyncSnapshot(): Promise<JiraSyncSnapshot> {
  const siteUrl = getJiraSiteUrl()
  if (!siteUrl) {
    throw new Error('Jira에 연결되어 있지 않습니다. 연동 설정에서 API 토큰을 등록해 주세요.')
  }
  const projectKey = getDefaultJiraProjectKey()
  if (!projectKey) {
    throw new Error('Jira 기본 프로젝트가 설정되지 않았습니다. 연동 설정에서 선택해 주세요.')
  }

  const fetchedAt = new Date().toISOString()
  const myAccountId = await getJiraMyAccountId()
  const triggers = await listMyTodoIssues(projectKey)

  const byKey = new Map<string, JiraSyncIssue>()
  const add = (issues: JiraSyncIssue[]): void => {
    for (const issue of issues) byKey.set(issue.key, issue)
  }
  add(triggers.issues)
  let truncated = triggers.truncated

  // 조상: 분류(Sustain/QA/에픽 없음)는 부모 작업과 에픽을 봐야 할 수 있다.
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    const missing = [...byKey.values()]
      .map((i) => i.parentKey)
      .filter((k): k is string => k !== null && !byKey.has(k))
    if (missing.length === 0) break
    const found = await listIssuesByKeys(missing)
    add(found.issues)
    truncated = truncated || found.truncated
  }

  const triggerKeys = triggers.issues.map((i) => i.key)
  const { roots } = resolveProjectRoots([...byKey.values()], triggerKeys)

  // 자손: 에픽 → 작업 → 하위 작업, Sustain 작업 → 하위 작업
  if (roots.length > 0) {
    const children = await listChildIssues(roots.map((r) => r.key))
    add(children.issues)
    truncated = truncated || children.truncated

    const epicKeys = new Set(roots.filter((r) => r.kind === 'epic').map((r) => r.key))
    const taskKeys = children.issues
      .filter((i) => i.level === 'standard' && i.parentKey !== null && epicKeys.has(i.parentKey))
      .map((i) => i.key)
    if (taskKeys.length > 0) {
      const grandchildren = await listChildIssues(taskKeys)
      add(grandchildren.issues)
      truncated = truncated || grandchildren.truncated
    }
  }

  const remoteLinks: Record<string, JiraRemoteLink[]> = {}
  for (const root of roots) {
    try {
      remoteLinks[root.key] = await listRemoteLinks(root.key)
    } catch (e) {
      // 원격 링크는 부가 문서일 뿐이다. 한 이슈의 권한 문제로 싱크업 전체를 막지 않는다.
      console.error('[project-sync] remotelink', root.key, e)
      remoteLinks[root.key] = []
    }
  }

  return {
    siteUrl,
    myAccountId,
    triggerKeys,
    issues: [...byKey.values()],
    remoteLinks,
    truncated,
    fetchedAt
  }
}

/** 계획에 필요한 DB 상태만 읽는다 */
export function readProjectSyncDbState(): DbSyncState {
  const db = getDatabase()
  const projectRows = db
    .prepare(
      `SELECT id, name, description, jira_issue_key, status, status_manual,
              dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date
       FROM projects ORDER BY id`
    )
    .all() as Array<DbSyncState['projects'][number] & ProjectStatusFields>
  return {
    // status는 **화면에 보이는 유효 상태**다. 자동 상태(status_manual=0) 프로젝트는 저장값이
    // 생성 시점 그대로라 project:list와 같은 applyProjectAutoStatus로 날짜에서 다시 계산해야
    // "끝난 프로젝트"(이름 매칭 제외 대상)를 알아볼 수 있다.
    projects: projectRows.map((row) => {
      const { id, name, description, jira_issue_key, status } = applyProjectAutoStatus(row)
      return { id, name, description, jira_issue_key, status }
    }),
    tasks: db
      .prepare(
        'SELECT id, project_id, parent_task_id, name, status, sort_order, jira_issue_key, end_date FROM tasks ORDER BY id'
      )
      .all() as DbSyncState['tasks'],
    documents: db
      .prepare(
        'SELECT id, project_id, name, url, sort_order FROM documents WHERE project_id IS NOT NULL ORDER BY id'
      )
      .all() as DbSyncState['documents']
  }
}

export const PREVIEW_EXPIRED_MESSAGE = '미리보기가 만료되었습니다. 다시 불러온 뒤 적용해 주세요.'

/** 미리보기 — 항상 Jira를 새로 조회하고 그 스냅샷을 apply용으로 캐시한다 */
export async function previewProjectSync(): Promise<ProjectSyncPlan> {
  const snapshot = await fetchJiraSyncSnapshot()
  cached = { snapshot, cachedAt: Date.now() }
  return buildProjectSyncPlan(snapshot, readProjectSyncDbState(), localToday()).plan
}

/**
 * 적용 — 미리보기 스냅샷으로 현재 DB 기준 재계획 후 **사용자가 고른 항목만**(R9) 쓴다.
 * 스냅샷이 없거나 10분 지났으면 거부한다. selection은 IPC에서 온 값이라 여기서 다시 검증한다.
 */
export async function applyProjectSync(selection: unknown): Promise<ProjectSyncResult> {
  const parsed = parseProjectSyncSelection(selection)
  if (!cached || Date.now() - cached.cachedAt >= SNAPSHOT_TTL_MS) {
    cached = null
    throw new Error(PREVIEW_EXPIRED_MESSAGE)
  }
  return applyProjectSyncSnapshot(cached.snapshot, parsed)
}

/**
 * 스냅샷 하나를 현재 DB에 적용한다. 네트워크를 타지 않으므로 테스트도 이 함수로 돈다.
 * 계획과 쓰기 사이에 다른 쓰기가 끼지 않도록 DB 읽기부터 트랜잭션 안에서 한다.
 */
export function applyProjectSyncSnapshot(
  snapshot: JiraSyncSnapshot,
  selection: ProjectSyncSelection[],
  today: string = localToday()
): ProjectSyncResult {
  const db = getDatabase()
  const createdIds = new Map<string, number>()

  const run = db.transaction(() => {
    const computation = buildProjectSyncPlan(snapshot, readProjectSyncDbState(), today)
    const selected = selectProjectSyncOps(computation, selection)
    writeOps(selected, createdIds)
    return { plan: computation.plan, selected }
  })
  const { plan, selected } = run()
  const result: ProjectSyncResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    tasksAdded: 0,
    tasksUpdated: 0,
    documentsAdded: 0,
    skipped: plan.skipped
  }
  for (const { op, force, action, tasksUpdated } of selected) {
    const { item } = op
    if (action === 'create') result.created++
    else if (action === 'update') result.updated++
    else result.unchanged++
    result.tasksAdded += item.newTasks
    result.tasksUpdated += tasksUpdated
    result.documentsAdded += item.newDocuments

    // 활동 로그는 커밋이 끝난 뒤에 남긴다 — 롤백된 변경이 로그에 남지 않게.
    const mode = force ? '강제 업데이트' : 'Jira 싱크업'
    const detail = `${mode} (${item.jiraKey}): 작업 +${item.newTasks} · 작업 갱신 ${tasksUpdated} · 문서 +${item.newDocuments}`
    if (action === 'create') {
      logActivity('project', 'create', createdIds.get(item.jiraKey), item.projectName, detail)
    } else if (action === 'update') {
      logActivity('project', 'update', item.projectId ?? undefined, item.projectName, detail)
    }
  }

  if (result.created > 0 || result.updated > 0) notifyDataChanged()
  return result
}

// 선택된 op만 쓴다(R9). 삭제는 어디에도 없다(R4).
// 보수적 경로(R5)의 UPDATE는 전부 "비어 있을 때만" 조건을 WHERE에 한 번 더 건다 —
// 계획과 쓰기 사이에 값이 채워졌더라도 덮어쓰지 않게 하는 이중 안전장치다.
// 값을 덮어쓰는 UPDATE는 사용자가 확인한 강제 업데이트(R10)에서만 돌고, 대상 컬럼도
// Jira에 원본이 있는 것(프로젝트 name·description, 작업 name·status·end_date)으로 한정한다.
function writeOps(selected: SelectedProjectSyncOp[], createdIds: Map<string, number>): void {
  const db = getDatabase()
  const insertProject = db.prepare(
    `INSERT INTO projects
       (name, description, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date,
        status, priority, jira_issue_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const backfillProjectKey = db.prepare(
    `UPDATE projects SET jira_issue_key = ?, updated_at = datetime('now')
     WHERE id = ? AND (jira_issue_key IS NULL OR jira_issue_key = '')`
  )
  const fillProjectDescription = db.prepare(
    `UPDATE projects SET description = ?, updated_at = datetime('now')
     WHERE id = ? AND (description IS NULL OR TRIM(description) = '')`
  )
  const insertTask = db.prepare(
    `INSERT INTO tasks (project_id, name, start_date, end_date, status, sort_order, parent_task_id, jira_issue_key)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`
  )
  const advanceTaskStatus = db.prepare('UPDATE tasks SET status = ? WHERE id = ?')
  const backfillTaskKey = db.prepare(
    `UPDATE tasks SET jira_issue_key = ?
     WHERE id = ? AND (jira_issue_key IS NULL OR jira_issue_key = '')`
  )
  const overwriteProjectName = db.prepare(
    `UPDATE projects SET name = ?, updated_at = datetime('now') WHERE id = ?`
  )
  const overwriteProjectDescription = db.prepare(
    `UPDATE projects SET description = ?, updated_at = datetime('now') WHERE id = ?`
  )
  // end_date는 Jira에 마감일이 있을 때만 바꾼다(NULL이면 기존 값 유지).
  const overwriteTask = db.prepare(
    `UPDATE tasks SET name = ?, status = ?, end_date = COALESCE(?, end_date) WHERE id = ?`
  )
  const insertDocument = db.prepare(
    `INSERT INTO documents (name, url, type, description, project_id, sort_order)
     VALUES (?, ?, 'link', NULL, ?, ?)`
  )

  for (const { op, force, action } of selected) {
    if (action === 'unchanged') continue

    let projectId: number
    if (op.project.kind === 'create') {
      const v = op.project.values
      const res = insertProject.run(
        v.name,
        v.description,
        v.dev_start_date,
        v.dev_end_date,
        v.qa_start_date,
        v.qa_end_date,
        v.deploy_date,
        v.status,
        v.priority,
        v.jira_issue_key
      )
      projectId = Number(res.lastInsertRowid)
      createdIds.set(op.item.jiraKey, projectId)
    } else {
      projectId = op.project.id
      if (op.project.backfillKey) backfillProjectKey.run(op.item.jiraKey, projectId)
      if (force && op.force) {
        if (op.force.name !== null) overwriteProjectName.run(op.force.name, projectId)
        if (op.force.description !== null) {
          overwriteProjectDescription.run(op.force.description, projectId)
        }
      } else if (op.project.description !== null) {
        fillProjectDescription.run(op.project.description, projectId)
      }
    }

    // 계획이 상위 작업을 항상 하위보다 먼저 두므로 한 번의 순회로 새 상위 id를 이어 붙일 수 있다.
    const newTaskIds = new Map<string, number>()
    for (const task of op.newTasks) {
      const parentId =
        task.parentTaskId ??
        (task.parentJiraKey !== null ? (newTaskIds.get(task.parentJiraKey) ?? null) : null)
      const res = insertTask.run(
        projectId,
        task.name,
        task.endDate,
        task.status,
        task.sortOrder,
        parentId,
        task.jiraKey
      )
      newTaskIds.set(task.jiraKey, Number(res.lastInsertRowid))
    }

    if (force && op.force) {
      for (const t of op.force.taskOverwrites) {
        overwriteTask.run(t.name, t.status, t.endDate, t.taskId)
        if (t.backfillKey) backfillTaskKey.run(t.jiraKey, t.taskId)
      }
    } else {
      for (const update of op.taskUpdates) {
        if (update.status !== null) advanceTaskStatus.run(update.status, update.taskId)
        if (update.backfillKey) backfillTaskKey.run(update.jiraKey, update.taskId)
      }
    }

    for (const doc of op.newDocuments) {
      insertDocument.run(doc.name, doc.url, projectId, doc.sortOrder)
    }
  }
}

// 싱크업 결과를 열려 있는 창에 알린다 — 프로젝트 목록·상세가 새 데이터를 다시 읽게.
function notifyDataChanged(): void {
  // 이미 커밋이 끝난 뒤라 여기서 throw하면 성공한 적용이 실패로 보고된다.
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('ai:dataChanged', { entity: 'project' })
      }
    }
  } catch (e) {
    console.error('[project-sync] notify', e)
  }
}
