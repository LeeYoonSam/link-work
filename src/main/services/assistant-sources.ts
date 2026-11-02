// 비서의 수집 지점. DB·Jira·캘린더에서 후보와 오늘 일정을 모은다.
// SSOT: docs/ASSISTANT.md §8.4, §9.1, 부록 A.4
//
// [가드레일]
// - A2: 이 파일은 DB 를 읽기만 한다. 원본 테이블에 쓰지 않는다.
// - A1: Jira 는 jira.ts 의 조회 함수만 쓴다.
// - 조회 실패는 throw 하지 않는다. 해당 출처를 null 로 두고 errors 에 문구를 넣는다.
import type Database from 'better-sqlite3'
import { ACTIVE_STATUSES } from '../../renderer/src/utils/projectOrder'
import { applyProjectAutoStatus } from '../utils/project-dates'
import { buildCandidates } from './assistant-candidates'
import { isoToLocalDateTime, logicalDate, toLocalDateTime } from './assistant-day'
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
  TaskRow,
  TodoRow,
  VanishedResolution
} from './assistant-types'
import { isConnected as isCalendarConnected } from './google-auth'
import { getEventsInRange, getTodayEvents, type CalendarEvent } from './google-calendar'
import {
  getDefaultJiraProjectKey,
  getJiraMyAccountId,
  getJiraIssueUrl,
  isJiraConnected,
  listIssuesByKeys,
  listMyOpenIssues,
  type JiraMyIssue
} from './jira'
import { parseJsonArray, type NoteActionItem } from './meeting-notes'

export interface CollectedSources extends CurrentSources {
  busy: BusyBlock[]
  jiraTruncated: boolean
  errors: string[]
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
function readTasks(db: Database.Database): TaskRow[] {
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

// 달력 날짜 1일의 일정을 가져온다. 논리 날짜가 오늘 달력 날짜와 다를 때만 쓴다.
async function fetchDayEvents(date: string): Promise<CalendarEvent[]> {
  const [y, m, d] = date.split('-').map(Number)
  const events = await getEventsInRange(new Date(y, m - 1, d, 0, 0, 0), new Date(y, m - 1, d, 23, 59, 59))
  if (events === null) throw new Error('')
  return events
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

// ── 수집 ──

export async function collectSources(
  db: Database.Database,
  settings: AssistantSettings,
  mode: 'full' | 'local',
  now: Date
): Promise<CollectedSources> {
  const errors: string[] = []
  // 일정은 논리 날짜 기준이다. 날짜 경계 전(예: 00:00~04:00)에는 전날 일정을 본다.
  const today = logicalDate(now, settings.dayRollover)
  const calendarDay = toLocalDateTime(now).slice(0, 10)

  // 로컬 출처
  const tasks = readTasks(db)
  const todos = readTodos(db)
  const actionItems = readActionItems(db, now)
  const taskTouchedAt = readTaskTouchedAt(db, new Set(tasks.map((t) => t.id)))

  // 캘린더
  const calendarConnected = isCalendarConnected()
  let calendar: CalendarRef[] | null = null
  if (mode === 'full') {
    if (!calendarConnected) {
      errors.push(CALENDAR_NOT_CONNECTED)
    } else {
      try {
        const events =
          today === calendarDay ? await getTodayEvents(true) : await fetchDayEvents(today)
        calendar = events
          .map((e) => toCalendarRef(e, today))
          .filter((e): e is CalendarRef => e !== null)
      } catch (err) {
        errors.push(errorText(CALENDAR_FAILED, err))
      }
    }
  }

  // Jira
  const jiraConnected = isJiraConnected()
  let jiraIssues: JiraMyIssue[] | null = null
  let jiraTruncated = false
  if (jiraConnected) {
    const scopeKey = jiraScopeKey(settings)
    const cache = jiraCache && jiraCache.scopeKey === scopeKey ? jiraCache : null
    const fresh = cache !== null && now.getTime() - cache.fetchedAt < JIRA_CACHE_MS
    if (mode === 'local' || fresh) {
      // local 은 네트워크를 쓰지 않는다. 캐시가 없으면 null 이다.
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
        errors.push(errorText(JIRA_FAILED, err))
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
    errors,
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
