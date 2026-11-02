// 비서의 수집 지점. DB·Jira·캘린더에서 후보와 오늘 일정을 모은다.
// SSOT: docs/ASSISTANT.md §8.4, §9.1, 부록 A.4, 부록 F.3 (맥락 복구 수집)
//
// [가드레일]
// - A2: 이 파일은 DB 를 읽기만 한다. 원본 테이블에 쓰지 않는다.
// - A1: Jira 는 jira.ts 의 조회 함수만 쓴다.
// - 조회 실패는 throw 하지 않는다. 해당 출처를 null 로 두고 errors 에 문구를 넣는다.
import type Database from 'better-sqlite3'
import { ACTIVE_STATUSES } from '../../renderer/src/utils/projectOrder'
import { applyProjectAutoStatus } from '../utils/project-dates'
import { buildCandidates } from './assistant-candidates'
import { addDays, isoToLocalDateTime, logicalDate, toLocalDateTime } from './assistant-day'
import { MEETING_LINE_MAX, matchProjects, sameTitle } from './assistant-meeting'
import { RECOVERY_LIMITS, RECOVERY_WRAPUP_MAX_DAYS } from './assistant-recovery'
import { calendarToBusy } from './assistant-slots'
import type {
  ActionItemRow,
  AssistantSettings,
  BusyBlock,
  CalendarRef,
  Candidate,
  CurrentSources,
  JiraCandidateInput,
  JiraSnapshotRef,
  MeetingContext,
  MeetingPastRef,
  MeetingProjectRef,
  MeetingRef,
  PlanItem,
  PlanItemStatus,
  RecoveryActivityGroup,
  RecoveryContext,
  RecoveryEntityType,
  RecoveryInput,
  RecoveryJiraIssue,
  RecoveryLocalInput,
  RecoveryMeeting,
  RecoveryTodoDone,
  RefreshMode,
  SourceCheckTimes,
  TaskRow,
  TodoRow,
  VanishedResolution
} from './assistant-types'
import { isConnected as isCalendarConnected } from './google-auth'
import { fetchEventsInRange, type CalendarEvent } from './google-calendar'
import {
  getDefaultJiraProjectKey,
  getJiraMyAccountId,
  getJiraIssueUrl,
  isJiraConnected,
  listIssuesByKeys,
  listMyOpenIssues,
  listMyRecentlyUpdatedIssues,
  type JiraMyIssue
} from './jira'
import { parseJsonArray, type NoteActionItem } from './meeting-notes'

export interface CollectedSources extends CurrentSources {
  busy: BusyBlock[]
  jiraTruncated: boolean
  errors: string[]                 // calendarErrors 다음 jiraErrors 순서로 합친 값
  calendarErrors: string[]         // 출처별 오류. 부분 mode 가 보지 않은 출처의 문구를 유지할 때 쓴다
  jiraErrors: string[]
  jiraConnected: boolean
  calendarConnected: boolean
}

const ACTION_ITEM_DAYS = 14
const JIRA_CACHE_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000

const CALENDAR_NOT_CONNECTED = 'Google 캘린더가 연결되어 있지 않아 오늘 일정을 확인하지 못했습니다.'
const CALENDAR_FAILED = 'Google 캘린더 조회에 실패해 오늘 일정을 확인하지 못했습니다.'
const JIRA_FAILED = 'Jira 조회에 실패했습니다.'

const ACTIVE_PROJECT_STATUSES = new Set<string>(ACTIVE_STATUSES)

// ── DB 읽기 ──

interface ProjectStatusRow {
  id: number
  name: string
  dev_start_date: string
  dev_end_date: string
  qa_start_date: string
  qa_end_date: string
  deploy_date: string
  status: string
  status_manual: number
  priority: string | null
}

function normalizeProjectPriority(value: string | null): TaskRow['project_priority'] {
  return value === 'now' || value === 'next' || value === 'later' ? value : null
}

// 활성 프로젝트 판정은 대시보드·트레이와 같다. 자동 상태를 계산한 뒤 ACTIVE_STATUSES 로 거른다.
function readActiveProjects(db: Database.Database): Map<number, ProjectStatusRow> {
  const projects = db
    .prepare(
      `SELECT id, name, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date,
              status, status_manual, priority
       FROM projects`
    )
    .all() as ProjectStatusRow[]
  const active = new Map<number, ProjectStatusRow>()
  for (const p of projects) {
    const resolved = applyProjectAutoStatus(p)
    if (ACTIVE_PROJECT_STATUSES.has(resolved.status)) active.set(p.id, p)
  }
  return active
}

function readTasks(db: Database.Database): TaskRow[] {
  const active = readActiveProjects(db)
  if (active.size === 0) return []

  const rows = db
    .prepare(
      `SELECT id, project_id, name, status, end_date, jira_issue_key
       FROM tasks
       WHERE status IS NULL OR status != 'done'
       ORDER BY id`
    )
    .all() as {
    id: number
    project_id: number
    name: string
    status: string | null
    end_date: string | null
    jira_issue_key: string | null
  }[]

  const tasks: TaskRow[] = []
  for (const r of rows) {
    const project = active.get(r.project_id)
    if (!project) continue
    tasks.push({
      id: r.id,
      project_id: r.project_id,
      project_name: project.name,
      project_priority: normalizeProjectPriority(project.priority),
      name: r.name,
      status: r.status ?? 'pending',
      end_date: r.end_date,
      jira_issue_key: r.jira_issue_key
    })
  }
  return tasks
}

function readTodos(db: Database.Database): TodoRow[] {
  return db
    .prepare(
      `SELECT id, title, priority, due_date, updated_at
       FROM todos
       WHERE is_completed = 0
       ORDER BY id`
    )
    .all() as TodoRow[]
}

function readActionItems(db: Database.Database, now: Date): ActionItemRow[] {
  const cutoff = toLocalDateTime(new Date(now.getTime() - ACTION_ITEM_DAYS * DAY_MS))
  const rows = db
    .prepare(
      `SELECT ms.meeting_id, ms.action_items, m.title
       FROM meeting_summaries ms
       JOIN meetings m ON m.id = ms.meeting_id
       WHERE ms.generated_at >= ?
       ORDER BY ms.meeting_id`
    )
    .all(cutoff) as { meeting_id: number; action_items: string | null; title: string }[]

  const items: ActionItemRow[] = []
  for (const row of rows) {
    parseJsonArray<NoteActionItem>(row.action_items).forEach((a, index) => {
      // todo 로 옮긴 항목은 그 todo 가 후보를 대표한다 (A4).
      if (!a || a.todo_id != null) return
      if (typeof a.text !== 'string' || a.text.trim() === '') return
      items.push({
        meeting_id: row.meeting_id,
        index,
        text: a.text,
        due: typeof a.due === 'string' && a.due.trim() !== '' ? a.due : null,
        meeting_title: row.title
      })
    })
  }
  return items
}

// activity_log.created_at 은 UTC 기본값이다. A12 형식에 맞춰 로컬 시각으로 바꾼다.
function readTaskTouchedAt(db: Database.Database, taskIds: Set<number>): Record<number, string> {
  if (taskIds.size === 0) return {}
  const rows = db
    .prepare(
      `SELECT entity_id, datetime(MAX(created_at), 'localtime') AS touched
       FROM activity_log
       WHERE entity_type = 'task' AND entity_id IS NOT NULL
       GROUP BY entity_id`
    )
    .all() as { entity_id: number; touched: string | null }[]
  const out: Record<number, string> = {}
  for (const r of rows) {
    if (r.touched && taskIds.has(r.entity_id)) out[r.entity_id] = r.touched
  }
  return out
}

// ── 캘린더 ──

function hhmmOf(localDateTime: string): string {
  return localDateTime.slice(11, 16)
}

// 오늘 로컬 'HH:mm' 으로 바꾼다. 오늘 밖으로 넘친 시각은 하루 경계로 자른다.
export function toCalendarRef(e: CalendarEvent, today: string): CalendarRef | null {
  if (e.allDay) return { id: e.id, title: e.summary, start: '00:00', end: '23:59', allDay: true }
  const start = isoToLocalDateTime(e.start)
  const end = isoToLocalDateTime(e.end)
  if (!start || !end) return null
  const startDate = start.slice(0, 10)
  const endDate = end.slice(0, 10)
  if (endDate < today || startDate > today) return null
  return {
    id: e.id,
    title: e.summary,
    start: startDate < today ? '00:00' : hhmmOf(start),
    end: endDate > today ? '23:59' : hhmmOf(end),
    allDay: false
  }
}

// 논리 날짜 1일(로컬 00:00:00~23:59:59)의 일정을 가져온다.
// 조회 실패는 throw 한다. 호출자는 calendar 를 null 로 두어 이전 스냅샷을 유지한다 (§8.2).
async function fetchDayEvents(date: string): Promise<CalendarEvent[]> {
  const [y, m, d] = date.split('-').map(Number)
  return fetchEventsInRange(new Date(y, m - 1, d, 0, 0, 0), new Date(y, m - 1, d, 23, 59, 59))
}

// ── Jira 캐시 ──

interface JiraCache {
  scopeKey: string | null
  issues: JiraMyIssue[]
  truncated: boolean
  fetchedAt: number
}

let jiraCache: JiraCache | null = null

// 내 accountId. 담당 변경 판정에 쓴다. 계정이 바뀔 수 있으므로 clearJiraCache 가 함께 지운다.
let myAccountId: string | null = null

export function clearJiraCache(): void {
  jiraCache = null
  myAccountId = null
}

function jiraScopeKey(settings: AssistantSettings): string | null {
  return settings.jiraScope === 'default_project' ? getDefaultJiraProjectKey() : null
}

function toJiraCandidateInput(issue: JiraMyIssue): JiraCandidateInput {
  return {
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    statusCategory: issue.statusCategory,
    priority: issue.priority,
    duedate: issue.duedate,
    updatedLocal: isoToLocalDateTime(issue.updated),
    url: getJiraIssueUrl(issue.key)
  }
}

// 스냅샷은 DB 에 저장된다. A12 에 맞춰 updated 를 로컬 형식으로 둔다.
function toJiraSnapshotRef(issue: JiraMyIssue): JiraSnapshotRef {
  return {
    key: issue.key,
    status: issue.status,
    priority: issue.priority,
    duedate: issue.duedate,
    updated: isoToLocalDateTime(issue.updated) ?? issue.updated
  }
}

function errorText(prefix: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  return detail ? `${prefix} ${detail}` : prefix
}

// ── 출처별 마지막 확인 시각 (부록 E.2.2) ──
// DB 에 두지 않는다. 재시작 뒤 null 이므로 첫 틱이 바로 확인한다.
let checkTimes: SourceCheckTimes = { calendarAt: null, jiraAt: null }

export function getSourceCheckTimes(): SourceCheckTimes {
  return { ...checkTimes }
}

/** 테스트용. clearJiraCache 와 별개다. */
export function resetSourceCheckTimes(): void {
  checkTimes = { calendarAt: null, jiraAt: null }
}

// ── 수집 ──

// mode 별 출처 선택은 부록 E.2.6 표를 따른다.
export async function collectSources(
  db: Database.Database,
  settings: AssistantSettings,
  mode: RefreshMode,
  now: Date
): Promise<CollectedSources> {
  const calendarErrors: string[] = []
  const jiraErrors: string[] = []
  // 일정은 논리 날짜 기준이다. 날짜 경계 전(예: 00:00~04:00)에는 전날 일정을 본다.
  const today = logicalDate(now, settings.dayRollover)

  // 로컬 출처
  const tasks = readTasks(db)
  const todos = readTodos(db)
  const actionItems = readActionItems(db, now)
  const taskTouchedAt = readTaskTouchedAt(db, new Set(tasks.map((t) => t.id)))

  // 캘린더
  const calendarConnected = isCalendarConnected()
  let calendar: CalendarRef[] | null = null
  if (mode === 'full' || mode === 'calendar') {
    // 미연결·실패에도 기록한다. 실패한 출처를 매 틱마다 다시 두드리지 않는다
    checkTimes = { ...checkTimes, calendarAt: now.getTime() }
    if (!calendarConnected) {
      calendarErrors.push(CALENDAR_NOT_CONNECTED)
    } else {
      try {
        const events = await fetchDayEvents(today)
        calendar = events
          .map((e) => toCalendarRef(e, today))
          .filter((e): e is CalendarRef => e !== null)
      } catch (err) {
        calendarErrors.push(errorText(CALENDAR_FAILED, err))
      }
    }
  }

  // Jira
  const jiraConnected = isJiraConnected()
  let jiraIssues: JiraMyIssue[] | null = null
  let jiraTruncated = false
  const jiraTarget = mode === 'full' || mode === 'jira'
  // 미연결·60초 캐시 사용에도 기록한다
  if (jiraTarget) checkTimes = { ...checkTimes, jiraAt: now.getTime() }
  if (jiraConnected) {
    const scopeKey = jiraScopeKey(settings)
    const cache = jiraCache && jiraCache.scopeKey === scopeKey ? jiraCache : null
    const fresh = cache !== null && now.getTime() - cache.fetchedAt < JIRA_CACHE_MS
    if (!jiraTarget || fresh) {
      // local·calendar 는 Jira 네트워크를 쓰지 않는다. 캐시가 없으면 null 이다.
      if (cache) {
        jiraIssues = cache.issues
        jiraTruncated = cache.truncated
      }
    } else {
      try {
        const found = await listMyOpenIssues(scopeKey)
        jiraCache = { scopeKey, issues: found.issues, truncated: found.truncated, fetchedAt: now.getTime() }
        jiraIssues = found.issues
        jiraTruncated = found.truncated
      } catch (err) {
        jiraErrors.push(errorText(JIRA_FAILED, err))
      }
    }
  }

  const candidates = buildCandidates({
    tasks,
    todos,
    jiraIssues: jiraIssues === null ? null : jiraIssues.map(toJiraCandidateInput),
    actionItems,
    taskTouchedAt
  })

  return {
    candidates,
    calendar,
    jira: jiraIssues === null ? null : jiraIssues.map(toJiraSnapshotRef),
    busy: calendarToBusy(calendar ?? []),
    jiraTruncated,
    errors: [...calendarErrors, ...jiraErrors],
    calendarErrors,
    jiraErrors,
    jiraConnected,
    calendarConnected
  }
}

// ── 사라진 후보 해석 (§8.4) ──

const DELETED_NOTE = '원본 삭제'
const REASSIGNED_NOTE = '담당 변경'

function parseNumericId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null
}

function resolveTask(db: Database.Database, id: number): VanishedResolution | null {
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as
    | { status: string | null }
    | undefined
  if (!row) return { kind: 'dropped', note: DELETED_NOTE }
  if (row.status === 'done') return { kind: 'done' }
  // 원본이 남아 있고 완료도 아니면 해석하지 않는다. 항목을 그대로 둔다.
  return null
}

function resolveTodo(db: Database.Database, id: number): VanishedResolution | null {
  const row = db.prepare('SELECT is_completed FROM todos WHERE id = ?').get(id) as
    | { is_completed: number }
    | undefined
  if (!row) return { kind: 'dropped', note: DELETED_NOTE }
  if (row.is_completed === 1) return { kind: 'done' }
  return null
}

function resolveActionItem(
  db: Database.Database,
  meetingId: number,
  index: number,
  current: Candidate[]
): VanishedResolution | null {
  const row = db
    .prepare('SELECT action_items FROM meeting_summaries WHERE meeting_id = ?')
    .get(meetingId) as { action_items: string | null } | undefined
  if (!row) return { kind: 'dropped', note: DELETED_NOTE }
  const list = parseJsonArray<NoteActionItem>(row.action_items)
  const action = list[index]
  if (!action) return { kind: 'dropped', note: DELETED_NOTE }
  if (action.todo_id == null) return null // 14일이 지나 빠졌다. 항목을 그대로 둔다.

  // 액션아이템이 todo 로 옮겨졌다. 같은 행을 todo 후보로 바꾼다.
  const todoCandidate = current.find((c) => c.id === `todo:${action.todo_id}`)
  if (todoCandidate) return { kind: 'replace', candidate: todoCandidate }
  return resolveTodo(db, action.todo_id)
}

async function getMyAccountId(): Promise<string | null> {
  if (myAccountId === null) myAccountId = await getJiraMyAccountId()
  return myAccountId
}

async function resolveJira(
  ids: string[],
  current: Candidate[],
  network: boolean
): Promise<Record<string, VanishedResolution>> {
  const out: Record<string, VanishedResolution> = {}
  const pending: string[] = []
  for (const id of ids) {
    const key = id.slice('jira:'.length)
    // 싱크업이 같은 키의 작업을 만들면 후보 ID 가 task 로 바뀐다. 그 작업으로 교체한다.
    const merged = current.find((c) => c.jiraKey === key && c.id !== id)
    if (merged) out[id] = { kind: 'replace', candidate: merged }
    else if (/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) pending.push(key)
  }
  // network 가 false 면 Jira 를 호출하지 않는다. 해석하지 않은 항목은 그대로 남는다.
  if (!network || pending.length === 0 || !isJiraConnected()) return out

  try {
    const { issues } = await listIssuesByKeys(pending)
    const byKey = new Map(issues.map((i) => [i.key, i]))
    let me: string | null | undefined
    for (const key of pending) {
      const issue = byKey.get(key)
      if (!issue) continue // 조회하지 못한 키는 결과에 넣지 않는다.
      if (issue.statusCategory === 'done') {
        out[`jira:${key}`] = { kind: 'done' }
        continue
      }
      // 아직 내 담당이면 해석하지 않는다. 200건 상한으로 잘린 이슈를 잘못 빼지 않는다.
      if (me === undefined) me = await getMyAccountId()
      if (me === null || issue.assigneeAccountId === me) continue
      out[`jira:${key}`] = { kind: 'dropped', note: REASSIGNED_NOTE }
    }
  } catch (err) {
    // 조회 실패는 throw 하지 않는다. 해석하지 않은 항목은 그대로 남는다.
    console.error('[assistant-sources] resolveVanished jira', err)
  }
  return out
}

export async function resolveVanished(
  db: Database.Database,
  ids: string[],
  current: Candidate[],
  opts?: { network?: boolean }
): Promise<Record<string, VanishedResolution>> {
  const network = opts?.network ?? true
  const out: Record<string, VanishedResolution> = {}
  const jiraIds: string[] = []

  for (const id of new Set(ids)) {
    try {
      const [source, ...rest] = id.split(':')
      let resolution: VanishedResolution | null = null
      if (source === 'task') {
        const n = parseNumericId(rest[0] ?? '')
        if (n !== null) resolution = resolveTask(db, n)
      } else if (source === 'todo') {
        const n = parseNumericId(rest[0] ?? '')
        if (n !== null) resolution = resolveTodo(db, n)
      } else if (source === 'action_item') {
        const meetingId = parseNumericId(rest[0] ?? '')
        const index = parseNumericId(rest[1] ?? '')
        if (meetingId !== null && index !== null) {
          resolution = resolveActionItem(db, meetingId, index, current)
        }
      } else if (source === 'jira') {
        jiraIds.push(id)
      }
      if (resolution) out[id] = resolution
    } catch (err) {
      // 한 항목의 조회 실패가 나머지 해석을 막지 않는다.
      console.error('[assistant-sources] resolveVanished', id, err)
    }
  }

  if (jiraIds.length > 0) Object.assign(out, await resolveJira(jiraIds, current, network))
  return out
}

// ── 맥락 복구 수집 (부록 F.3, F.9.4) ──
// 모두 읽기 전용 SELECT 다. checkTimes·jiraCache 를 건드리지 않는다.

const WRAPUP_MAX_CHARS = 2000
const TLDR_MAX_CHARS = 300
const NO_NAME = '(이름 없음)'
const UNFINISHED_STATUSES = new Set<string>(['planned', 'in_progress', 'deferred'])
const RECOVERY_ENTITY_TYPES: readonly RecoveryEntityType[] = ['project', 'task', 'todo']

const ACTIVITY_FAILED = '활동 기록 조회에 실패했습니다.'
const MEETINGS_FAILED = '회의 요약 조회에 실패했습니다.'
const TODOS_FAILED = '완료한 할 일 조회에 실패했습니다.'

function nonBlank(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readUnfinishedItems(lastItems: PlanItem[]): PlanItem[] {
  return lastItems
    .filter((i) => UNFINISHED_STATUSES.has(i.status))
    .sort((a, b) => {
      if (a.rank === b.rank) return a.id - b.id
      if (a.rank === null) return 1
      if (b.rank === null) return -1
      return a.rank - b.rank
    })
    .slice(0, RECOVERY_LIMITS.unfinished)
}

interface ActivityRow {
  entity_type: RecoveryEntityType
  entity_id: number | null
  entity_name: string | null
  action: string
  at: string
}

const NAME_SQL: Record<RecoveryEntityType, string> = {
  project: 'SELECT name AS name FROM projects WHERE id = ?',
  task: 'SELECT name AS name FROM tasks WHERE id = ?',
  todo: 'SELECT title AS name FROM todos WHERE id = ?'
}

// activity_log 에 이름이 없을 때 원본 테이블에서 읽는다. 삭제됐으면 null 이다.
function readEntityName(db: Database.Database, type: RecoveryEntityType, id: number | null): string | null {
  if (id === null) return null
  const row = db.prepare(NAME_SQL[type]).get(id) as { name: string | null } | undefined
  return nonBlank(row?.name)
}

// created_at 은 UTC 기본값이다. 로컬로 바꿔 since 와 비교한다 (F.13 위험 2).
function readActivityGroups(db: Database.Database, since: string): RecoveryActivityGroup[] {
  const placeholders = RECOVERY_ENTITY_TYPES.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT entity_type, entity_id, entity_name, action, at FROM (
         SELECT id, entity_type, entity_id, entity_name, action,
                datetime(created_at, 'localtime') AS at
         FROM activity_log
         WHERE entity_type IN (${placeholders}) AND datetime(created_at, 'localtime') >= ?
         ORDER BY at DESC, id DESC
         LIMIT ?
       ) ORDER BY at ASC, id ASC`
    )
    .all(...RECOVERY_ENTITY_TYPES, since, RECOVERY_LIMITS.activityRows) as unknown as ActivityRow[]

  // 행은 시각 오름차순이다. 묶음 안의 마지막 값이 가장 늦은 값이다.
  const groups = new Map<string, RecoveryActivityGroup & { latestName: string | null }>()
  for (const r of rows) {
    const key =
      r.entity_id !== null
        ? `${r.entity_type}:id:${r.entity_id}`
        : `${r.entity_type}:name:${r.entity_name ?? ''}`
    let g = groups.get(key)
    if (!g) {
      g = {
        entityType: r.entity_type,
        entityId: r.entity_id,
        name: NO_NAME,
        actions: [],
        count: 0,
        firstAt: r.at,
        lastAt: r.at,
        deleted: false,
        latestName: null
      }
      groups.set(key, g)
    }
    g.count++
    g.lastAt = r.at
    if (!g.actions.includes(r.action)) g.actions.push(r.action)
    const name = nonBlank(r.entity_name)
    if (name !== null) g.latestName = name
  }

  const out: RecoveryActivityGroup[] = []
  for (const { latestName, ...g } of groups.values()) {
    out.push({
      ...g,
      name: latestName ?? readEntityName(db, g.entityType, g.entityId) ?? NO_NAME,
      deleted: g.actions.includes('delete')
    })
  }
  out.sort((a, b) => {
    if (a.lastAt !== b.lastAt) return a.lastAt < b.lastAt ? 1 : -1
    if (a.entityType !== b.entityType) return a.entityType < b.entityType ? -1 : 1
    return (a.entityId ?? 0) - (b.entityId ?? 0)
  })
  return out.slice(0, RECOVERY_LIMITS.activity)
}

function readRecoveryMeetings(db: Database.Database, since: string): RecoveryMeeting[] {
  const rows = db
    .prepare(
      `SELECT m.id AS meeting_id, m.title, m.started_at, p.name AS project_name,
              ms.tldr, ms.action_items
       FROM meeting_summaries ms
       JOIN meetings m ON m.id = ms.meeting_id
       LEFT JOIN projects p ON p.id = m.project_id
       WHERE ms.generated_at >= ?
       ORDER BY m.started_at DESC, m.id DESC
       LIMIT ?`
    )
    .all(since, RECOVERY_LIMITS.meetings) as {
    meeting_id: number
    title: string | null
    started_at: string | null
    project_name: string | null
    tldr: string | null
    action_items: string | null
  }[]

  return rows.map((r) => {
    const open = parseJsonArray<NoteActionItem>(r.action_items)
      .filter((a) => a && a.todo_id == null && nonBlank(a.text) !== null)
      .map((a) => a.text)
    const tldr = nonBlank(r.tldr)
    return {
      meetingId: r.meeting_id,
      title: r.title ?? '',
      startedAt: r.started_at ?? '',
      projectName: nonBlank(r.project_name),
      tldr: tldr === null ? null : tldr.slice(0, TLDR_MAX_CHARS),
      openActionItems: open.slice(0, RECOVERY_LIMITS.actionItemsPerMeeting),
      openActionCount: open.length
    }
  })
}

// completed_at 은 로컬 시각이다. since 와 그대로 비교한다.
function readCompletedTodos(db: Database.Database, since: string): RecoveryTodoDone[] {
  const rows = db
    .prepare(
      `SELECT id, title, completed_at
       FROM todos
       WHERE is_completed = 1 AND completed_at >= ?
       ORDER BY completed_at DESC, id DESC
       LIMIT ?`
    )
    .all(since, RECOVERY_LIMITS.todos) as { id: number; title: string | null; completed_at: string }[]
  return rows.map((r) => ({ id: r.id, title: r.title ?? '', completedAt: r.completed_at }))
}

// onError 가 있으면 출처별 실패를 넘기고 그 출처를 비운다. 없으면 throw 한다.
function readLocal(
  db: Database.Database,
  ctx: RecoveryContext,
  lastItems: PlanItem[],
  onError?: (message: string, err: unknown) => void
): RecoveryLocalInput {
  function guard<T>(message: string, empty: T, read: () => T): T {
    if (!onError) return read()
    try {
      return read()
    } catch (err) {
      onError(message, err)
      return empty
    }
  }

  const note = ctx.lastPlan ? nonBlank(ctx.lastPlan.wrapup_note) : null
  const useNote = note !== null && ctx.gapDays !== null && ctx.gapDays <= RECOVERY_WRAPUP_MAX_DAYS
  return {
    wrapupNote: useNote ? note.slice(0, WRAPUP_MAX_CHARS) : null,
    unfinishedItems: ctx.lastPlan ? readUnfinishedItems(lastItems) : [],
    activity: guard(ACTIVITY_FAILED, [], () => readActivityGroups(db, ctx.since)),
    meetings: guard(MEETINGS_FAILED, [], () => readRecoveryMeetings(db, ctx.since)),
    completedTodos: guard(TODOS_FAILED, [], () => readCompletedTodos(db, ctx.since))
  }
}

/** 동기. SELECT 만 한다. 읽기 전용 커넥션도 받는다. AI 채팅 도구가 쓴다 */
export function readRecoveryLocal(
  db: Database.Database,
  ctx: RecoveryContext,
  lastItems: PlanItem[]
): RecoveryLocalInput {
  return readLocal(db, ctx, lastItems)
}

function toRecoveryJiraIssue(issue: JiraMyIssue): RecoveryJiraIssue {
  return {
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    statusCategory: issue.statusCategory,
    priority: issue.priority,
    duedate: issue.duedate,
    updatedLocal: isoToLocalDateTime(issue.updated),
    url: getJiraIssueUrl(issue.key)
  }
}

/** 로컬 + Jira. throw 하지 않는다. 실패한 출처는 비우고 errors 에 문구를 넣는다 */
export async function collectRecovery(
  db: Database.Database,
  settings: AssistantSettings,
  ctx: RecoveryContext,
  lastItems: PlanItem[]
): Promise<RecoveryInput> {
  const errors: string[] = []
  const local = readLocal(db, ctx, lastItems, (message, err) => {
    console.error('[assistant-sources] collectRecovery', message, err)
    errors.push(message)
  })

  let jira: RecoveryJiraIssue[] | null = null
  let jiraConnected = false
  let jiraTruncated = false
  try {
    jiraConnected = isJiraConnected()
    if (jiraConnected) {
      // 캐시를 쓰지 않는다. 복구는 하루에 1~2회다.
      const found = await listMyRecentlyUpdatedIssues(ctx.jiraDays, jiraScopeKey(settings))
      jira = found.issues.slice(0, RECOVERY_LIMITS.jira).map(toRecoveryJiraIssue)
      jiraTruncated = found.truncated || found.issues.length > RECOVERY_LIMITS.jira
    }
  } catch (err) {
    jira = null
    errors.push(errorText(JIRA_FAILED, err))
  }

  return { ...local, ctx, jira, jiraConnected, jiraTruncated, errors }
}

// ── 회의 전 브리핑 수집 (부록 I.3.1, I.5) ──
// A46: DB 읽기만 한다. Jira·캘린더를 부르지 않는다. 일정은 호출자가 캐시에서 읽어 넘긴다.
// A2: meetings·meeting_summaries·projects 는 SELECT 만 한다.

export const MEETING_LIMITS = {
  pastDays: 90,
  pastCandidates: 200,
  pastMeetings: 3,
  actionItems: 10,
  relatedItems: 5
} as const

const MEETING_RELATED_STATUSES = new Set<PlanItemStatus>(['planned', 'in_progress'])

const MEETING_PROJECTS_FAILED = '프로젝트 조회에 실패했습니다.'
const MEETING_PAST_FAILED = '지난 회의 조회에 실패했습니다.'
const MEETING_ITEMS_FAILED = '오늘 계획 항목 확인에 실패했습니다.'

/** 캘린더 일정을 회의 참조로 바꾼다. 종일 일정과 시각 변환 실패는 null 이다 */
export function toMeetingRef(e: CalendarEvent): MeetingRef | null {
  if (e.allDay) return null
  const startAt = isoToLocalDateTime(e.start)
  const endAt = isoToLocalDateTime(e.end)
  if (!startAt || !endAt) return null
  return { id: e.id, title: typeof e.summary === 'string' ? e.summary : '', startAt, endAt }
}

interface PastMeetingRow {
  meeting_id: number
  title: string | null
  calendar_event_title: string | null
  started_at: string | null
  tldr: string | null
  action_items: string | null
}

function openActionTexts(raw: string | null): string[] {
  return parseJsonArray<NoteActionItem>(raw)
    .filter((a) => a && a.todo_id == null && nonBlank(a.text) !== null)
    .map((a) => a.text.trim())
}

// started_at 은 로컬 기본값이다. 회의 시작 시각 기준 90일 안, 시작 전 회의만 본다.
function readPastMeetings(db: Database.Database, meeting: MeetingRef): MeetingPastRef[] {
  const cutoff = `${addDays(meeting.startAt.slice(0, 10), -MEETING_LIMITS.pastDays)}${meeting.startAt.slice(10)}`
  const rows = db
    .prepare(
      `SELECT m.id AS meeting_id, m.title, m.calendar_event_title, m.started_at, ms.tldr, ms.action_items
       FROM meetings m
       JOIN meeting_summaries ms ON ms.meeting_id = m.id
       WHERE m.kind = 'meeting' AND m.started_at >= ? AND m.started_at < ?
       ORDER BY m.started_at DESC, m.id DESC
       LIMIT ?`
    )
    .all(cutoff, meeting.startAt, MEETING_LIMITS.pastCandidates) as unknown as PastMeetingRow[]

  const out: MeetingPastRef[] = []
  for (const r of rows) {
    if (out.length >= MEETING_LIMITS.pastMeetings) break
    const matched =
      (r.title !== null && sameTitle(meeting.title, r.title)) ||
      (r.calendar_event_title !== null && sameTitle(meeting.title, r.calendar_event_title))
    if (!matched) continue
    const tldr = nonBlank(r.tldr)
    out.push({
      meetingId: r.meeting_id,
      title: r.title ?? '',
      startedAt: r.started_at ?? '',
      tldr: tldr === null ? null : tldr.trim().slice(0, MEETING_LINE_MAX),
      openActionItems: openActionTexts(r.action_items).slice(0, MEETING_LIMITS.actionItems)
    })
  }
  return out
}

function relatedItemsOf(items: PlanItem[], projects: MeetingProjectRef[]): MeetingContext['relatedItems'] {
  if (projects.length === 0) return []
  const projectIds = new Set(projects.map((p) => p.id))
  return items
    .filter((i) => i.project_id !== null && projectIds.has(i.project_id) && MEETING_RELATED_STATUSES.has(i.status))
    .sort((a, b) => {
      if (a.rank === b.rank) return a.id - b.id
      if (a.rank === null) return 1
      if (b.rank === null) return -1
      return a.rank - b.rank
    })
    .slice(0, MEETING_LIMITS.relatedItems)
    .map((i) => ({ id: i.id, title: i.title, status: i.status }))
}

/** 회의 브리핑 맥락. throw 하지 않는다. 실패한 출처는 비우고 errors 에 문구를 넣는다 (A46) */
export function collectMeetingContext(
  db: Database.Database,
  meeting: MeetingRef,
  items: PlanItem[]
): MeetingContext {
  const errors: string[] = []
  function guard<T>(message: string, empty: T, read: () => T): T {
    try {
      return read()
    } catch (err) {
      console.error('[assistant-sources] collectMeetingContext', message, err)
      errors.push(message)
      return empty
    }
  }

  const projects = guard<MeetingProjectRef[]>(MEETING_PROJECTS_FAILED, [], () => {
    const active = [...readActiveProjects(db).values()].map((p) => ({ id: p.id, name: p.name ?? '' }))
    return matchProjects(meeting.title, active)
  })
  const pastMeetings = guard<MeetingPastRef[]>(MEETING_PAST_FAILED, [], () => readPastMeetings(db, meeting))
  const openActionItems = pastMeetings.flatMap((m) => m.openActionItems).slice(0, MEETING_LIMITS.actionItems)
  const relatedItems = guard<MeetingContext['relatedItems']>(MEETING_ITEMS_FAILED, [], () =>
    relatedItemsOf(items, projects)
  )

  return { meeting, projects, pastMeetings, openActionItems, relatedItems, errors }
}
