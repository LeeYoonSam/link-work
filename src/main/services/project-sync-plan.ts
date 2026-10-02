import type { JiraRemoteLink, JiraStatusCategory, JiraSyncIssue } from './jira'
import { calculateQaDates } from '../utils/project-dates'
import { adfToPlainText, extractAdfLinks } from './project-sync-adf'

/**
 * Jira 프로젝트 싱크업의 계획 단계 — **순수 함수만** 둔다(electron·DB import 금지).
 *
 * Jira 스냅샷 + 현재 DB 스냅샷 → 무엇을 만들고/채우고/건너뛸지. 규칙(R1~R10)은
 * docs/PROJECT_SYNC.md에 있고, 이 파일의 주석은 규칙 ID로 그 문서를 가리킨다.
 * 기본 계획은 "추가"와 "빈 칸 채우기"만 만든다. 덮어쓰기는 사용자가 기존 프로젝트를 골라
 * 강제 업데이트를 확인했을 때(R10)만 쓰이는 별도 op(force)이고, 삭제 op는 어디에도 없다(R4).
 */

// ── IPC 계약 (renderer의 types/index.ts와 같은 형태를 유지할 것) ──

export type ProjectSyncSkipReason = 'qa' | 'no_epic' | 'tracked_in_project'

export interface ProjectSyncPlanItem {
  jiraKey: string
  summary: string
  kind: 'epic' | 'sustain'
  action: 'create' | 'update' | 'unchanged'
  /** create면 null */
  projectId: number | null
  /** 기존 프로젝트 이름 또는 생성될 이름 */
  projectName: string
  matchedBy: 'jira_key' | 'document_url' | 'name' | null
  newTasks: number
  /** status 전진 또는 키 백필이 일어나는 기존 작업 수 */
  updatedTasks: number
  newDocuments: number
  /**
   * R10: 강제 업데이트 시 덮어써질 것의 수 — 프로젝트 name·description 변경 여부 각 1 +
   * 이름 또는 상태가 바뀔 기존 작업 수. create 항목은 0.
   */
  forceChanges: number
  /**
   * R10: 강제 적용 시 이름·상태·마감일 중 하나라도 바뀌는 기존 작업 — 현재 이름(before)과
   * Jira 기준 이름(after). 사용자가 덮어쓰기 대상을 미리 보고 확인하게 한다. create 항목은 빈 배열.
   */
  forceTasks: ProjectSyncForceTask[]
}

export interface ProjectSyncForceTask {
  before: string
  after: string
}

/** R9·R10: apply에 넘기는 사용자 선택. force는 기존 프로젝트 항목에만 의미가 있다 */
export interface ProjectSyncSelection {
  jiraKey: string
  force: boolean
  /**
   * 미리보기 항목의 projectId 그대로. 적용 시 재계획 결과와 다르면 거부한다 —
   * 사용자가 확인한 것과 다른 프로젝트에 쓰지 않기 위해서다.
   */
  projectId: number | null
}

export interface ProjectSyncSkipped {
  jiraKey: string
  summary: string
  reason: ProjectSyncSkipReason
  detail: string | null
}

export interface ProjectSyncPlan {
  items: ProjectSyncPlanItem[]
  skipped: ProjectSyncSkipped[]
  /** Jira 조회 상한에 걸림 */
  truncated: boolean
  /**
   * Jira에서 찾은 트리거(내게 할당된 "할 일") 이슈 수 — 0건이면 조회 자체가 비었다는 뜻.
   * 미리보기는 프로젝트 단위라 하위 작업 트리거는 세지 않는다.
   */
  triggerCount: number
  /** ISO */
  fetchedAt: string
}

export interface ProjectSyncResult {
  created: number
  updated: number
  unchanged: number
  tasksAdded: number
  tasksUpdated: number
  documentsAdded: number
  skipped: ProjectSyncSkipped[]
}

// ── 입력 스냅샷 ──

export interface JiraSyncSnapshot {
  siteUrl: string
  /** 연결 계정. null이면 "내게 할당" 판정은 트리거·미할당만 남는다 */
  myAccountId: string | null
  /** 내게 할당된 "할 일" 이슈 키 (Jira 응답 순서) */
  triggerKeys: string[]
  /** 트리거와 그 조상·자손까지 조회한 이슈 전부 */
  issues: JiraSyncIssue[]
  /** 프로젝트가 되는 이슈의 원격 링크 */
  remoteLinks: Record<string, JiraRemoteLink[]>
  truncated: boolean
  fetchedAt: string
}

export type TaskStatus = 'pending' | 'in_progress' | 'done'

export interface DbProjectRow {
  id: number
  name: string
  description: string | null
  jira_issue_key: string | null
  /**
   * 화면에 보이는 유효 상태(자동 상태면 날짜로 계산한 값 — project-sync.ts가 채운다).
   * 이름 매칭에서 끝난(completed/cancelled) 프로젝트를 거르는 데만 쓴다.
   */
  status: string | null
}

export interface DbTaskRow {
  id: number
  project_id: number
  parent_task_id: number | null
  name: string
  status: string
  sort_order: number
  jira_issue_key: string | null
  end_date: string | null
}

export interface DbDocumentRow {
  id: number
  project_id: number | null
  name: string
  url: string
  sort_order: number
}

export interface DbSyncState {
  projects: DbProjectRow[]
  tasks: DbTaskRow[]
  documents: DbDocumentRow[]
}

// ── 출력 op ──

export interface NewProjectValues {
  name: string
  description: string | null
  jira_issue_key: string
  dev_start_date: string
  dev_end_date: string
  qa_start_date: string
  qa_end_date: string
  deploy_date: string
  status: 'scheduled'
  priority: null
}

export type PlannedProject =
  | { kind: 'create'; values: NewProjectValues }
  | {
      kind: 'existing'
      id: number
      /** jira_issue_key가 비어 있어 채운다 */
      backfillKey: boolean
      /** description이 비어 있을 때만 채울 값. 채울 게 없으면 null */
      description: string | null
    }

export interface PlannedTask {
  jiraKey: string
  name: string
  status: TaskStatus
  endDate: string | null
  /** 이번에 함께 만들어지는 상위 작업의 Jira 키. 적용 시 새 id로 바꾼다 */
  parentJiraKey: string | null
  /** 이미 있는 상위 작업 id */
  parentTaskId: number | null
  sortOrder: number
}

export interface PlannedTaskUpdate {
  taskId: number
  jiraKey: string
  /** 앞으로만 이동한 새 상태. 바뀌지 않으면 null */
  status: TaskStatus | null
  backfillKey: boolean
}

export interface PlannedDocument {
  name: string
  url: string
  sortOrder: number
}

/** R10: 강제 업데이트로 덮어쓰는 기존 작업 */
export interface PlannedTaskOverwrite {
  taskId: number
  jiraKey: string
  name: string
  /** Jira 상태 매핑값 그대로 — 뒤로 가는 것도 허용 */
  status: TaskStatus
  /** Jira duedate. 없으면 null이고 기존 end_date를 유지한다 */
  endDate: string | null
  backfillKey: boolean
}

/** R10: 기존 프로젝트를 강제 업데이트할 때만 쓰는 덮어쓰기 내용. 바뀌는 것만 담는다 */
export interface PlannedForce {
  /** 바뀔 이름. 같으면 null */
  name: string | null
  /** 바뀔 설명. Jira 본문이 비었거나 같으면 null(기존 유지) */
  description: string | null
  taskOverwrites: PlannedTaskOverwrite[]
}

export interface ProjectSyncOp {
  item: ProjectSyncPlanItem
  project: PlannedProject
  newTasks: PlannedTask[]
  taskUpdates: PlannedTaskUpdate[]
  newDocuments: PlannedDocument[]
  /** 기존 프로젝트 항목의 강제 업데이트 내용. create 항목은 null */
  force: PlannedForce | null
}

export interface ProjectSyncComputation {
  plan: ProjectSyncPlan
  ops: ProjectSyncOp[]
}

// ── 분류 (R1~R3) ──

/** R2: Sustain 에픽 요약 패턴 (예: `[Android/Sus] Sprint 10`) */
export const SUSTAIN_EPIC_PATTERN = /\bsus(tain(ing)?)?\b/i
/** R3: QA 에픽 요약 패턴 — 대소문자 구분 (예: `안드로이드QA-2099`) */
export const QA_EPIC_PATTERN = /QA/

const isSustainEpic = (epic: JiraSyncIssue): boolean => SUSTAIN_EPIC_PATTERN.test(epic.summary)
const isQaEpic = (epic: JiraSyncIssue): boolean => QA_EPIC_PATTERN.test(epic.summary)
const hasQaType = (issue: JiraSyncIssue): boolean => /qa/i.test(issue.issueType)
const hasQaLabel = (issue: JiraSyncIssue): boolean =>
  issue.labels.some((l) => l.trim().toLowerCase() === 'qa')

// R3 작업 레벨 QA 판정. 요약에 QA가 있다는 것만으로는 QA 티켓이 아니다
// (일반 에픽 아래 `[포인트] 셀프 QA`는 개발 작업이다).
function isQaTask(task: JiraSyncIssue, epic: JiraSyncIssue | null): boolean {
  return (epic !== null && isQaEpic(epic)) || hasQaType(task) || hasQaLabel(task)
}

export interface ProjectRoot {
  key: string
  kind: 'epic' | 'sustain'
}

function issueMap(issues: JiraSyncIssue[]): Map<string, JiraSyncIssue> {
  return new Map(issues.map((i) => [i.key, i]))
}

function epicOf(task: JiraSyncIssue, byKey: Map<string, JiraSyncIssue>): JiraSyncIssue | null {
  const parent = task.parentKey ? byKey.get(task.parentKey) : undefined
  return parent && parent.level === 'epic' ? parent : null
}

type Classification =
  | { type: 'root'; root: ProjectRoot }
  | { type: 'skip'; reason: ProjectSyncSkipReason; detail: string | null }
  | { type: 'ignore' }

function classifyTrigger(t: JiraSyncIssue, byKey: Map<string, JiraSyncIssue>): Classification {
  if (hasQaType(t)) return { type: 'skip', reason: 'qa', detail: `이슈 타입: ${t.issueType}` }

  if (t.level === 'epic') {
    if (isQaEpic(t)) return { type: 'skip', reason: 'qa', detail: null }
    // R2: Sustain 에픽 자체는 프로젝트가 아니다. 그 아래 할 일 작업이 각각 프로젝트가 된다.
    if (isSustainEpic(t)) return { type: 'ignore' }
    return { type: 'root', root: { key: t.key, kind: 'epic' } }
  }

  // 하위 작업이면 부모 작업을 기준으로 판정한다.
  const task = t.level === 'subtask' ? (t.parentKey ? byKey.get(t.parentKey) : undefined) : t
  if (!task)
    return {
      type: 'skip',
      reason: 'no_epic',
      detail: '부모 작업을 찾을 수 없습니다'
    }

  const epic = epicOf(task, byKey)
  if (isQaTask(task, epic)) {
    return {
      type: 'skip',
      reason: 'qa',
      detail: epic && isQaEpic(epic) ? epic.summary : null
    }
  }
  if (!epic) return { type: 'skip', reason: 'no_epic', detail: null }
  if (isSustainEpic(epic)) return { type: 'root', root: { key: task.key, kind: 'sustain' } }
  return { type: 'root', root: { key: epic.key, kind: 'epic' } }
}

/**
 * 트리거 → 프로젝트가 될 이슈(루트) 목록. 같은 루트는 한 번만 나온다(R1).
 * 오케스트레이터가 자식 이슈를 어디까지 가져올지 정할 때도 이 함수를 쓴다.
 */
export function resolveProjectRoots(
  issues: JiraSyncIssue[],
  triggerKeys: string[]
): { roots: ProjectRoot[]; skipped: ProjectSyncSkipped[] } {
  const byKey = issueMap(issues)
  const roots: ProjectRoot[] = []
  const skipped: ProjectSyncSkipped[] = []
  const seenRoots = new Set<string>()
  const seenSkips = new Set<string>()

  for (const key of triggerKeys) {
    const t = byKey.get(key)
    if (!t) continue
    const c = classifyTrigger(t, byKey)
    if (c.type === 'root' && !seenRoots.has(c.root.key)) {
      seenRoots.add(c.root.key)
      roots.push(c.root)
    } else if (c.type === 'skip' && t.level !== 'subtask' && !seenSkips.has(t.key)) {
      // 미리보기는 프로젝트 단위 정보만 보여 준다 — 하위 작업 단위 건너뜀은 보고하지 않는다.
      // (하위 작업은 부모 작업 판정을 따르므로 부모가 트리거면 부모로 이미 보고된다.)
      seenSkips.add(t.key)
      skipped.push({
        jiraKey: t.key,
        summary: t.summary,
        reason: c.reason,
        detail: c.detail
      })
    }
  }
  return { roots, skipped }
}

// ── 매칭 유틸 (R5) ──

const normalizeText = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ')

/** 이름을 선두 `[태그]`들과 제목으로 나눈다. 둘 다 trim·소문자·공백 축약으로 정규화한다 */
export function splitProjectName(name: string): {
  tags: string[]
  title: string
} {
  let rest = name.trim()
  const tags: string[] = []
  for (;;) {
    const m = /^\[([^\]]*)\]\s*/.exec(rest)
    if (!m) break
    const tag = normalizeText(m[1])
    if (tag !== '') tags.push(tag)
    rest = rest.slice(m[0].length)
  }
  return { tags, title: normalizeText(rest) }
}

/** 선두 `[태그]`들 제거 + trim + 소문자 + 공백 축약 */
export function normalizeProjectName(name: string): string {
  return splitProjectName(name).title
}

/**
 * 이름 매칭(R5 3순위). 제목이 같아야 하고, **양쪽 모두** 선두 태그가 있으면 태그 집합도 같아야 한다 —
 * `[Android] 크래시 수정`이 `[iOS] 크래시 수정`에 붙으면 안 된다. 한쪽만 태그가 있으면
 * (`[구매자] d+머니 충전` ↔ `d+머니 충전`) 사람이 붙인 분류 태그로 보고 제목만 본다.
 */
export function projectNamesMatch(a: string, b: string): boolean {
  const x = splitProjectName(a)
  const y = splitProjectName(b)
  if (x.title === '' || x.title !== y.title) return false
  if (x.tags.length === 0 || y.tags.length === 0) return true
  const xs = new Set(x.tags)
  const ys = new Set(y.tags)
  return xs.size === ys.size && [...xs].every((t) => ys.has(t))
}

/** 끝 슬래시 제거 — 문서 중복 판정용 */
export function normalizeDocUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/**
 * 문서 중복 판정 키. 같은 Jira 사이트의 browse URL은 이슈 키로 비교한다 —
 * `…/browse/PROJ-50?atlOrigin=abc`와 `…/browse/PROJ-50`은 같은 문서다. 그 외는 끝 슬래시만 무시.
 */
export function documentIdentity(url: string, siteUrl: string): string {
  const key = browseKeyOf(url)
  if (key !== null && hostOf(url) !== null && hostOf(url) === hostOf(siteUrl)) {
    return `jira-browse:${key}`
  }
  return normalizeDocUrl(url)
}

function hostOf(url: string): string | null {
  try {
    return new URL(url.trim()).host.toLowerCase()
  } catch {
    return null
  }
}

/** URL이 `/browse/<KEY>`로 끝나면 그 키 (쿼리·해시·끝 슬래시 무시) */
export function browseKeyOf(url: string): string | null {
  const path = url.trim().split(/[?#]/)[0].replace(/\/+$/, '')
  const m = /\/browse\/([^/]+)$/.exec(path)
  return m ? m[1] : null
}

/** 작업명에 `(KEY)` 또는 `[KEY]`로 키가 들어 있는지 */
export function taskNameHasKey(name: string, key: string): boolean {
  return name.includes(`(${key})`) || name.includes(`[${key}]`)
}

const STATUS_RANK: Record<TaskStatus, number> = {
  pending: 0,
  in_progress: 1,
  done: 2
}

export function statusFromCategory(category: JiraStatusCategory): TaskStatus {
  if (category === 'done') return 'done'
  if (category === 'indeterminate') return 'in_progress'
  return 'pending'
}

function rankOf(status: string): number {
  return status in STATUS_RANK ? STATUS_RANK[status as TaskStatus] : 0
}

function keyNumber(key: string): number {
  const n = Number(key.slice(key.lastIndexOf('-') + 1))
  return Number.isFinite(n) ? n : 0
}

const byKeyNumber = (a: JiraSyncIssue, b: JiraSyncIssue): number =>
  keyNumber(a.key) - keyNumber(b.key)

// ── 날짜 (R7) ──

function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatYmd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 개발 기본 기간 — 오늘 포함 2주 */
export const DEFAULT_DEV_DAYS = 13

function addDays(ymd: string, days: number): string {
  const date = parseYmd(ymd)
  date.setDate(date.getDate() + days)
  return formatYmd(date)
}

/** 로컬 시간대 기준 오늘 (YYYY-MM-DD) */
export function localToday(now: Date = new Date()): string {
  return formatYmd(now)
}

function newProjectValues(issue: JiraSyncIssue, today: string): NewProjectValues {
  const due = issue.duedate && /^\d{4}-\d{2}-\d{2}$/.test(issue.duedate) ? issue.duedate : null
  const devEnd = due && due > today ? due : addDays(today, DEFAULT_DEV_DAYS)
  const qa = calculateQaDates(devEnd)
  return {
    name: issue.summary,
    description: adfToPlainText(issue.description),
    jira_issue_key: issue.key,
    dev_start_date: today,
    dev_end_date: devEnd,
    qa_start_date: qa.qaStart,
    qa_end_date: qa.qaEnd,
    deploy_date: qa.deployDate,
    status: 'scheduled',
    priority: null
  }
}

// ── 가져올 작업·문서 (R6) ──

interface DesiredTask {
  issue: JiraSyncIssue
  parentKey: string | null
}

function collectDesiredTasks(
  root: ProjectRoot,
  issues: JiraSyncIssue[],
  isWanted: (issue: JiraSyncIssue) => boolean
): DesiredTask[] {
  const subtasksOf = (key: string): JiraSyncIssue[] =>
    issues
      .filter((i) => i.parentKey === key && i.level === 'subtask' && !hasQaType(i))
      .sort(byKeyNumber)

  // Sustain: 그 작업의 하위 작업이 곧 최상위 작업이다.
  if (root.kind === 'sustain') {
    return subtasksOf(root.key)
      .filter(isWanted)
      .map((issue) => ({ issue, parentKey: null }))
  }

  const desired: DesiredTask[] = []
  const tasks = issues
    .filter((i) => i.parentKey === root.key && i.level === 'standard' && !isQaTask(i, null))
    .sort(byKeyNumber)
  for (const task of tasks) {
    const subtasks = subtasksOf(task.key).filter(isWanted)
    // 남의 작업이라도 그 아래 내 하위 작업이 있으면 부모가 있어야 계층이 산다.
    if (!isWanted(task) && subtasks.length === 0) continue
    desired.push({ issue: task, parentKey: null })
    for (const sub of subtasks) desired.push({ issue: sub, parentKey: task.key })
  }
  return desired
}

function collectDesiredDocuments(
  root: ProjectRoot,
  issue: JiraSyncIssue,
  snapshot: JiraSyncSnapshot
): Array<{ name: string; url: string }> {
  const browse = (key: string): string => `${snapshot.siteUrl}/browse/${key}`
  const docs: Array<{ name: string; url: string }> = []

  // (a) 프로젝트가 된 이슈 자신
  docs.push({
    name:
      root.kind === 'epic' ? `Epic (${issue.key}) ${issue.summary}` : `Jira 티켓 (${issue.key})`,
    url: browse(issue.key)
  })
  // (b) 원격 링크
  for (const link of snapshot.remoteLinks[issue.key] ?? []) {
    docs.push({ name: link.title, url: link.url })
  }
  // (c) 이슈 링크
  for (const link of issue.issueLinks) {
    docs.push({
      name: `${link.type} (${link.key}) ${link.summary}`.trim(),
      url: browse(link.key)
    })
  }
  // (d) 설명 본문 속 링크
  docs.push(...extractAdfLinks(issue.description))

  return docs.filter((d) => /^https?:\/\//i.test(d.url))
}

// ── 계획 ──

type ProjectMatch = {
  project: DbProjectRow
  matchedBy: 'jira_key' | 'document_url' | 'name'
}

// 이름이 같아도 끝난 프로젝트는 다른 회차의 동명 작업일 가능성이 높아 이름 매칭에서 뺀다.
// 키·문서 URL은 같은 이슈라는 명시적 증거라 상태와 무관하게 매칭한다.
const CLOSED_PROJECT_STATUSES = new Set(['completed', 'cancelled'])

/** R5 1순위 */
function matchProjectByKey(
  issue: JiraSyncIssue,
  db: DbSyncState,
  claimed: Set<number>
): ProjectMatch | null {
  const byKey = db.projects.find((p) => p.jira_issue_key === issue.key && !claimed.has(p.id))
  return byKey ? { project: byKey, matchedBy: 'jira_key' } : null
}

/** R5 2·3순위 */
function matchProjectByDocOrName(
  issue: JiraSyncIssue,
  db: DbSyncState,
  claimed: Set<number>
): ProjectMatch | null {
  // 다른 Jira 이슈에 이미 묶인 프로젝트는 문서·이름으로 다시 붙잡지 않는다.
  const candidates = db.projects.filter((p) => !p.jira_issue_key && !claimed.has(p.id))

  const byDoc = candidates.find((p) =>
    db.documents.some((d) => d.project_id === p.id && browseKeyOf(d.url) === issue.key)
  )
  if (byDoc) return { project: byDoc, matchedBy: 'document_url' }

  const byName = candidates.find(
    (p) => !CLOSED_PROJECT_STATUSES.has(p.status ?? '') && projectNamesMatch(p.name, issue.summary)
  )
  return byName ? { project: byName, matchedBy: 'name' } : null
}

// R5: Sustain 작업이 이미 묶음 Sus 프로젝트의 작업으로 추적되고 있는지
function findTrackingProject(key: string, db: DbSyncState): DbProjectRow | null {
  const task = db.tasks.find((t) => t.jira_issue_key === key || taskNameHasKey(t.name, key))
  if (!task) return null
  return db.projects.find((p) => p.id === task.project_id) ?? null
}

function nextSortOrder(rows: Array<{ sort_order: number }>): number {
  return rows.reduce((max, r) => Math.max(max, r.sort_order ?? 0), -1) + 1
}

export function buildProjectSyncPlan(
  snapshot: JiraSyncSnapshot,
  db: DbSyncState,
  today: string
): ProjectSyncComputation {
  const byKey = issueMap(snapshot.issues)
  const triggerSet = new Set(snapshot.triggerKeys)
  const { roots, skipped } = resolveProjectRoots(snapshot.issues, snapshot.triggerKeys)

  // R6: 내게 할당 + 미할당 + (담당자가 바뀌었더라도) 트리거 자신
  const isWanted = (i: JiraSyncIssue): boolean =>
    triggerSet.has(i.key) ||
    i.assigneeAccountId === null ||
    (snapshot.myAccountId !== null && i.assigneeAccountId === snapshot.myAccountId)

  const ops: ProjectSyncOp[] = []
  const claimed = new Set<number>()

  for (const root of roots) {
    const issue = byKey.get(root.key)
    if (!issue) continue

    const keyMatch = matchProjectByKey(issue, db, claimed)
    // Sustain은 키 매칭 다음에 "묶음 Sus 프로젝트에서 이미 추적 중"을 문서·이름 매칭보다 먼저 본다.
    // 묶음 프로젝트에는 그 작업의 browse 문서도 붙어 있기 마련이라, 문서 매칭이 먼저 돌면
    // 묶음 프로젝트 전체가 작업 하나의 키로 백필돼 버린다.
    if (!keyMatch && root.kind === 'sustain') {
      const tracking = findTrackingProject(issue.key, db)
      if (tracking) {
        skipped.push({
          jiraKey: issue.key,
          summary: issue.summary,
          reason: 'tracked_in_project',
          detail: tracking.name
        })
        continue
      }
    }
    const match = keyMatch ?? matchProjectByDocOrName(issue, db, claimed)
    if (match) claimed.add(match.project.id)

    const projectId = match?.project.id ?? null
    const projectTasks =
      projectId === null ? [] : db.tasks.filter((t) => t.project_id === projectId)
    const projectDocs =
      projectId === null ? [] : db.documents.filter((d) => d.project_id === projectId)

    // 작업 diff — 없는 것만 추가, 기존 것은 키 백필과 상태 전진만
    const newTasks: PlannedTask[] = []
    const taskUpdates: PlannedTaskUpdate[] = []
    const taskOverwrites: PlannedTaskOverwrite[] = []
    const forceTasks: ProjectSyncForceTask[] = []
    const existingByJiraKey = new Map<string, DbTaskRow>()
    const usedTaskIds = new Set<number>()
    let taskOrder = nextSortOrder(projectTasks)

    for (const d of collectDesiredTasks(root, snapshot.issues, isWanted)) {
      const key = d.issue.key
      const existing =
        projectTasks.find((t) => t.jira_issue_key === key && !usedTaskIds.has(t.id)) ??
        projectTasks.find(
          (t) => !t.jira_issue_key && !usedTaskIds.has(t.id) && taskNameHasKey(t.name, key)
        )
      const status = statusFromCategory(d.issue.statusCategory)

      if (existing) {
        usedTaskIds.add(existing.id)
        existingByJiraKey.set(key, existing)
        const backfillKey = !existing.jira_issue_key
        // 상태는 앞으로만 — 앱에서 완료 처리한 작업을 Jira가 늦다고 되돌리지 않는다.
        const forward = STATUS_RANK[status] > rankOf(existing.status) ? status : null
        if (backfillKey || forward) {
          taskUpdates.push({
            taskId: existing.id,
            jiraKey: key,
            status: forward,
            backfillKey
          })
        }

        // R10 강제 업데이트용: 이름·상태(역행 허용)·마감일(있을 때만)을 Jira 값으로.
        const name = `${d.issue.summary} (${key})`
        const endDate = d.issue.duedate ?? null
        const renamed = existing.name !== name
        const restatused = existing.status !== status
        const redated = endDate !== null && existing.end_date !== endDate
        if (renamed || restatused || redated || backfillKey) {
          taskOverwrites.push({
            taskId: existing.id,
            jiraKey: key,
            name,
            status,
            endDate,
            backfillKey
          })
        }
        // 키 백필만 일어나는 작업은 사용자에게 보이는 변화가 없어 목록에 넣지 않는다.
        if (renamed || restatused || redated)
          forceTasks.push({ before: existing.name, after: name })
        continue
      }

      // 상위가 기존 작업이면 그 id로, 새 작업이면 적용 시 키로 이어 붙인다.
      // 기존 상위가 이미 누군가의 하위라면 1단계 계층을 지키려고 그 최상위 아래에 둔다.
      const parentExisting = d.parentKey ? existingByJiraKey.get(d.parentKey) : undefined
      newTasks.push({
        jiraKey: key,
        name: `${d.issue.summary} (${key})`,
        status,
        endDate: d.issue.duedate ?? null,
        parentJiraKey: d.parentKey && !parentExisting ? d.parentKey : null,
        parentTaskId: parentExisting ? (parentExisting.parent_task_id ?? parentExisting.id) : null,
        sortOrder: taskOrder++
      })
    }

    // 문서 diff — URL(끝 슬래시 무시, 같은 사이트 browse는 키) 기준으로 없는 것만
    const knownUrls = new Set(projectDocs.map((d) => documentIdentity(d.url, snapshot.siteUrl)))
    const newDocuments: PlannedDocument[] = []
    let docOrder = nextSortOrder(projectDocs)
    for (const doc of collectDesiredDocuments(root, issue, snapshot)) {
      const norm = documentIdentity(doc.url, snapshot.siteUrl)
      if (knownUrls.has(norm)) continue
      knownUrls.add(norm)
      newDocuments.push({
        name: doc.name,
        url: doc.url,
        sortOrder: docOrder++
      })
    }

    let project: PlannedProject
    let action: ProjectSyncPlanItem['action']
    let force: PlannedForce | null = null
    if (match) {
      const p = match.project
      const backfillKey = !p.jira_issue_key
      const text = adfToPlainText(issue.description)
      const description = (p.description ?? '').trim() === '' && text ? text : null
      project = { kind: 'existing', id: p.id, backfillKey, description }
      force = {
        name: p.name !== issue.summary ? issue.summary : null,
        // Jira 본문이 비어 있으면 기존 설명을 지우지 않는다.
        description: text !== null && p.description !== text ? text : null,
        taskOverwrites
      }
      const changed =
        backfillKey ||
        description !== null ||
        newTasks.length > 0 ||
        taskUpdates.length > 0 ||
        newDocuments.length > 0
      action = changed ? 'update' : 'unchanged'
    } else {
      project = { kind: 'create', values: newProjectValues(issue, today) }
      action = 'create'
    }

    ops.push({
      item: {
        jiraKey: issue.key,
        summary: issue.summary,
        kind: root.kind,
        action,
        projectId,
        projectName: match ? match.project.name : issue.summary,
        matchedBy: match?.matchedBy ?? null,
        newTasks: newTasks.length,
        updatedTasks: taskUpdates.length,
        newDocuments: newDocuments.length,
        forceChanges: force
          ? (force.name !== null ? 1 : 0) + (force.description !== null ? 1 : 0) + forceTasks.length
          : 0,
        forceTasks: force ? forceTasks : []
      },
      project,
      newTasks,
      taskUpdates,
      newDocuments,
      force
    })
  }

  return {
    plan: {
      items: ops.map((op) => op.item),
      skipped,
      truncated: snapshot.truncated,
      triggerCount: snapshot.triggerKeys.filter((k) => byKey.get(k)?.level !== 'subtask').length,
      fetchedAt: snapshot.fetchedAt
    },
    ops
  }
}

// ── 선택 적용 (R9·R10) ──

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/

export const EMPTY_SELECTION_MESSAGE = '적용할 항목을 선택해 주세요.'
export const INVALID_SELECTION_MESSAGE = '잘못된 선택 형식입니다. 다시 불러와 주세요.'
export const UNKNOWN_SELECTION_MESSAGE = '미리보기에 없는 항목입니다. 다시 불러와 주세요.'
export const PROJECT_CHANGED_MESSAGE =
  '미리보기 이후 프로젝트가 바뀌었습니다. 다시 불러온 뒤 적용해 주세요.'

/** IPC로 들어온 선택을 검증한다. renderer 값은 신뢰하지 않는다 */
export function parseProjectSyncSelection(input: unknown): ProjectSyncSelection[] {
  if (!Array.isArray(input)) throw new Error(INVALID_SELECTION_MESSAGE)
  if (input.length === 0) throw new Error(EMPTY_SELECTION_MESSAGE)
  const out = new Map<string, ProjectSyncSelection>()
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) throw new Error(INVALID_SELECTION_MESSAGE)
    const { jiraKey, force, projectId } = raw as Record<string, unknown>
    if (typeof jiraKey !== 'string' || !ISSUE_KEY_PATTERN.test(jiraKey)) {
      throw new Error(INVALID_SELECTION_MESSAGE)
    }
    if (typeof force !== 'boolean') throw new Error(INVALID_SELECTION_MESSAGE)
    if (projectId !== null && !(Number.isInteger(projectId) && (projectId as number) > 0)) {
      throw new Error(INVALID_SELECTION_MESSAGE)
    }
    out.set(jiraKey, { jiraKey, force, projectId: projectId as number | null })
  }
  return [...out.values()]
}

/** 선택된 op 하나를 실제로 어떻게 쓸지 */
export interface SelectedProjectSyncOp {
  op: ProjectSyncOp
  /** 기존 프로젝트를 강제 업데이트(R10)한다. create 항목은 항상 false */
  force: boolean
  /** 이 선택으로 실제 일어나는 일 */
  action: ProjectSyncPlanItem['action']
  tasksUpdated: number
}

/**
 * R9: 계획 중 사용자가 고른 항목만 남긴다. 선택에 없는 항목은 어떤 쓰기도 하지 않는다.
 * 계획 전체를 먼저 세운 뒤 거르는 것은 의도적이다 — 미선택 항목도 프로젝트를 "차지"해야
 * 미리보기에서 본 매칭이 적용 때도 그대로 유지된다.
 */
export function selectProjectSyncOps(
  computation: ProjectSyncComputation,
  selection: ProjectSyncSelection[]
): SelectedProjectSyncOp[] {
  if (selection.length === 0) throw new Error(EMPTY_SELECTION_MESSAGE)
  const projectIdByKey = new Map(computation.ops.map((op) => [op.item.jiraKey, op.item.projectId]))
  for (const s of selection) {
    if (!projectIdByKey.has(s.jiraKey)) throw new Error(UNKNOWN_SELECTION_MESSAGE)
    // 미리보기 이후 매칭이 바뀌었으면(새로 만들 항목이 기존 프로젝트에 붙었거나 그 반대) 하나도 쓰지 않는다.
    if (projectIdByKey.get(s.jiraKey) !== s.projectId) throw new Error(PROJECT_CHANGED_MESSAGE)
  }
  const forceByKey = new Map(selection.map((s) => [s.jiraKey, s.force]))

  // 쓰기 순서는 선택 순서가 아니라 계획 순서를 따른다 — 같은 선택이면 결과가 늘 같다.
  return computation.ops
    .filter((op) => forceByKey.has(op.item.jiraKey))
    .map((op) => {
      if (!forceByKey.get(op.item.jiraKey) || op.force === null || op.project.kind !== 'existing') {
        return {
          op,
          force: false,
          action: op.item.action,
          tasksUpdated: op.taskUpdates.length
        }
      }
      const f = op.force
      const changed =
        op.project.backfillKey ||
        f.name !== null ||
        f.description !== null ||
        f.taskOverwrites.length > 0 ||
        op.newTasks.length > 0 ||
        op.newDocuments.length > 0
      return {
        op,
        force: true,
        action: changed ? 'update' : 'unchanged',
        tasksUpdated: f.taskOverwrites.length
      }
    })
}
