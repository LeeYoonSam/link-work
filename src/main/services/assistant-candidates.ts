// 비서 후보 정규화 (docs/ASSISTANT.md §4). 순수 모듈이다 (A3).
import type {
  ActionItemRow,
  Candidate,
  CandidateInput,
  CandidatePriority,
  JiraCandidateInput,
  PlanExclusion,
  TaskRow,
  TodoRow
} from './assistant-types'
import { classifyWork } from './assistant-worktype'

const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/
const DATE_ONLY_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/

/** 'YYYY-MM-DD…' 앞부분만 날짜로 쓴다. 형식이 아니면 null. */
function toDate(value: string | null | undefined): string | null {
  if (!value) return null
  const m = DATE_RE.exec(value.trim())
  return m ? m[1] : null
}

function toPriority(value: string | null | undefined): CandidatePriority | null {
  return value === 'high' || value === 'medium' || value === 'low' ? value : null
}

const PROJECT_PRIORITY: Record<string, CandidatePriority> = {
  now: 'high',
  next: 'medium',
  later: 'low'
}

const JIRA_PRIORITY: Record<string, CandidatePriority> = {
  Highest: 'high',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
  Lowest: 'low'
}

function normalizeKey(key: string | null | undefined): string | null {
  const k = key?.trim()
  return k ? k.toUpperCase() : null
}

function fromTask(t: TaskRow, touched: Record<number, string>): Candidate {
  const jiraKey = normalizeKey(t.jira_issue_key)
  const { workType, workVersion } = classifyWork({
    source: 'task', jiraKey, title: t.name, parentSummary: null, projectName: t.project_name, issueType: null
  })
  return {
    id: `task:${t.id}`,
    source: 'task',
    title: t.name,
    jiraKey,
    projectId: t.project_id,
    projectName: t.project_name,
    dueDate: toDate(t.end_date),
    dueTime: null,
    inProgress: t.status === 'in_progress',
    priority: t.project_priority ? (PROJECT_PRIORITY[t.project_priority] ?? null) : null,
    jiraPriority: null,
    lastTouchedAt: touched[t.id] ?? null,
    link: `linkwork://project/${t.project_id}/task/${t.id}`,
    parentKey: null,
    groupName: t.project_name,
    workType,
    workVersion
  }
}

function fromTodo(t: TodoRow): Candidate {
  const m = t.due_date ? DATE_RE.exec(t.due_date.trim()) : null
  return {
    id: `todo:${t.id}`,
    source: 'todo',
    title: t.title,
    jiraKey: null,
    projectId: null,
    projectName: null,
    dueDate: m ? m[1] : null,
    dueTime: m && m[2] ? m[2] : null,
    inProgress: false,
    priority: toPriority(t.priority),
    jiraPriority: null,
    lastTouchedAt: t.updated_at ?? null,
    link: `linkwork://todo/${t.id}`,
    parentKey: null,
    groupName: null,
    workType: 'etc',
    workVersion: null
  }
}

function fromJira(j: JiraCandidateInput): Candidate {
  const key = normalizeKey(j.key) ?? j.key
  const { workType, workVersion } = classifyWork({
    source: 'jira', jiraKey: key, title: j.summary, parentSummary: j.parentSummary, projectName: null,
    issueType: j.issueType
  })
  return {
    id: `jira:${key}`,
    source: 'jira',
    title: j.summary,
    jiraKey: key,
    projectId: null,
    projectName: null,
    dueDate: toDate(j.duedate),
    dueTime: null,
    inProgress: j.statusCategory === 'indeterminate',
    priority: j.priority ? (JIRA_PRIORITY[j.priority] ?? null) : null,
    jiraPriority: j.priority,
    lastTouchedAt: j.updatedLocal,
    link: j.url,
    parentKey: normalizeKey(j.parentKey),
    groupName: j.parentSummary,
    workType,
    workVersion
  }
}

function fromActionItem(a: ActionItemRow): Candidate {
  const due = a.due?.trim() ?? ''
  const m = DATE_ONLY_RE.exec(due)
  return {
    id: `action_item:${a.meeting_id}:${a.index}`,
    source: 'action_item',
    title: a.text,
    jiraKey: null,
    projectId: null,
    projectName: null,
    dueDate: m ? m[1] : null,
    dueTime: null,
    inProgress: false,
    priority: 'medium',
    jiraPriority: null,
    lastTouchedAt: null,
    link: `linkwork://note/${a.meeting_id}`,
    parentKey: null,
    groupName: null,
    workType: 'etc',
    workVersion: null
  }
}

/** task 와 jira 를 합친다. 식별·이동 경로는 task, 상태는 jira 가 우선이다.
 *  분류는 task 제목·jira 부모 요약·jira 이슈 유형·task 프로젝트 이름으로 다시 계산한다 (J.9.4). */
function mergeTaskJira(task: Candidate, jira: Candidate, raw: JiraCandidateInput): Candidate {
  const { workType, workVersion } = classifyWork({
    source: 'task', jiraKey: jira.jiraKey, title: task.title, parentSummary: raw.parentSummary,
    projectName: task.projectName, issueType: raw.issueType
  })
  return {
    ...task,
    jiraKey: jira.jiraKey,
    inProgress: jira.inProgress,
    priority: jira.priority ?? task.priority,
    jiraPriority: jira.jiraPriority,
    dueDate: jira.dueDate ?? task.dueDate,
    lastTouchedAt: jira.lastTouchedAt ?? task.lastTouchedAt,
    parentKey: jira.parentKey,
    groupName: jira.groupName ?? task.groupName,
    workType,
    workVersion
  }
}

function byId(a: Candidate, b: Candidate): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** §4 정규화·중복 제거 (A4). 결과는 id 오름차순이다. */
export function buildCandidates(input: CandidateInput): Candidate[] {
  const touched = input.taskTouchedAt ?? {}

  // jira: 완료 이슈는 후보가 아니다. 같은 키는 첫 1건만 쓴다.
  const jiraByKey = new Map<string, Candidate>()
  const jiraInputByKey = new Map<string, JiraCandidateInput>()
  for (const j of input.jiraIssues ?? []) {
    if (j.statusCategory === 'done') continue
    const c = fromJira(j)
    if (c.jiraKey && !jiraByKey.has(c.jiraKey)) {
      jiraByKey.set(c.jiraKey, c)
      jiraInputByKey.set(c.jiraKey, j)
    }
  }

  // task: id 오름차순으로 보고, 같은 jiraKey 는 가장 작은 id 1건만 남긴다.
  const tasks = [...input.tasks].sort((a, b) => a.id - b.id)
  const usedKeys = new Set<string>()
  const result: Candidate[] = []
  for (const t of tasks) {
    let c = fromTask(t, touched)
    if (c.jiraKey) {
      if (usedKeys.has(c.jiraKey)) continue
      usedKeys.add(c.jiraKey)
      const jira = jiraByKey.get(c.jiraKey)
      const raw = jiraInputByKey.get(c.jiraKey)
      if (jira && raw) c = mergeTaskJira(c, jira, raw)
    }
    result.push(c)
  }
  for (const [key, c] of jiraByKey) {
    if (!usedKeys.has(key)) result.push(c)
  }

  const seenIds = new Set(result.map((c) => c.id))
  for (const t of input.todos) {
    const c = fromTodo(t)
    if (!seenIds.has(c.id)) {
      seenIds.add(c.id)
      result.push(c)
    }
  }
  for (const a of input.actionItems) {
    const c = fromActionItem(a)
    if (!seenIds.has(c.id)) {
      seenIds.add(c.id)
      result.push(c)
    }
  }

  return result.sort(byId)
}

/** 마감이 오늘이거나 지났거나, Jira 우선순위가 Highest 면 긴급이다. */
export function isUrgent(c: Candidate, today: string): boolean {
  if (c.dueDate !== null && c.dueDate <= today) return true
  return c.jiraPriority === 'Highest'
}

/** 계속 제외 후보인가 (A58). id 가 같거나, 둘 다 Jira 키가 있고 대소문자 무시로 같으면 true 다. */
export function isExcludedCandidate(
  c: Pick<Candidate, 'id' | 'jiraKey'>,
  exclusions: Pick<PlanExclusion, 'candidate_id' | 'jira_key'>[]
): boolean {
  const key = c.jiraKey ? c.jiraKey.toUpperCase() : null
  return exclusions.some(
    (e) => e.candidate_id === c.id || (key !== null && e.jira_key !== null && e.jira_key.toUpperCase() === key)
  )
}
