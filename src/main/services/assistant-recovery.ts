// 맥락 복구의 트리거 판정·수집 기준·규칙 본문 (docs/ASSISTANT.md 부록 F).
// 순수 모듈이다 (A3). 같은 입력에 같은 출력을 내고 입력을 바꾸지 않는다 (A14).
import { addDays, daysBetween } from './assistant-day'
import type {
  PlanItem,
  PlanItemStatus,
  RecoveryActivityGroup,
  RecoveryContext,
  RecoveryInput,
  RecoveryJiraIssue,
  RecoveryLastPlan,
  RecoveryMeeting,
  RecoverySection,
  RecoveryTodoDone,
  RecoveryTriggerReason
} from './assistant-types'

export const RECOVERY_MAX_DAYS = 14
export const RECOVERY_DEFAULT_DAYS = 7 // 마지막 계획이 없을 때
export const RECOVERY_WRAPUP_MAX_DAYS = 7
export const RECOVERY_LIMITS = {
  unfinished: 20,
  activityRows: 500,
  activity: 50,
  meetings: 10,
  todos: 50,
  jira: 50,
  actionItemsPerMeeting: 5
} as const

const LINE_MAX = 200
const TLDR_MAX = 300
const SUNDAY = '1970-01-04' // 기준 일요일

const UNFINISHED_STATUSES: readonly PlanItemStatus[] = ['planned', 'in_progress', 'deferred']
const STATUS_LABEL: Partial<Record<PlanItemStatus, string>> = { in_progress: '진행 중', deferred: '미룸' }
const ENTITY_LABEL: Record<RecoveryActivityGroup['entityType'], string> = {
  project: '프로젝트',
  task: '작업',
  todo: '할 일'
}
const ACTION_LABEL: Record<string, string> = {
  create: '생성',
  update: '수정',
  delete: '삭제',
  archive: '보관',
  restore: '복원',
  complete: '완료'
}

// 'YYYY-MM-DD' → 0(일)~6(토). 날짜 문자열로만 계산한다. 형식이 틀리면 throw 한다.
export function weekdayOf(date: string): number {
  return ((daysBetween(SUNDAY, date) % 7) + 7) % 7
}

// A29: F.2 순서로 판정한다.
export function shouldAutoRecover(
  ctx: Pick<RecoveryContext, 'lastPlan' | 'gapDays' | 'weekday'>
): RecoveryTriggerReason | null {
  if (ctx.lastPlan === null || ctx.gapDays === null) return null
  if (ctx.gapDays >= 2) return 'gap'
  if (ctx.weekday === 1) return 'monday'
  return null
}

function clampDays(n: number): number {
  if (!Number.isFinite(n)) return RECOVERY_DEFAULT_DAYS
  return Math.min(RECOVERY_MAX_DAYS, Math.max(1, Math.floor(n)))
}

function startOf(date: string): string {
  return `${date} 00:00:00`
}

// F.3 since·jiraDays 규칙 (A33).
export function recoveryContextOf(input: {
  today: string
  lastPlan: RecoveryLastPlan | null
  days?: number
}): RecoveryContext {
  const { today, lastPlan } = input
  const weekday = weekdayOf(today)
  const gapDays = lastPlan ? daysBetween(lastPlan.plan_date, today) : null

  let since: string
  let jiraDays: number
  if (input.days !== undefined) {
    const days = clampDays(input.days)
    since = startOf(addDays(today, -days))
    jiraDays = days
  } else if (lastPlan === null || gapDays === null) {
    since = startOf(addDays(today, -RECOVERY_DEFAULT_DAYS))
    jiraDays = RECOVERY_DEFAULT_DAYS
  } else {
    since = gapDays > RECOVERY_MAX_DAYS ? startOf(addDays(today, -RECOVERY_MAX_DAYS)) : lastPlan.started_at
    jiraDays = clampDays(gapDays + 1)
  }

  return {
    today,
    weekday,
    lastPlan: lastPlan ? { ...lastPlan } : null,
    gapDays,
    since,
    sinceDate: since.slice(0, 10),
    jiraDays
  }
}

// 한 줄로 만들고 [데이터] 표식을 지운 뒤 max 자로 자른다.
function oneLine(text: string, max = LINE_MAX): string {
  const flat = text
    .replace(/\[\/?데이터\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function byRank(a: PlanItem, b: PlanItem): number {
  const ra = a.rank ?? Number.MAX_SAFE_INTEGER
  const rb = b.rank ?? Number.MAX_SAFE_INTEGER
  if (ra !== rb) return ra - rb
  return a.id - b.id
}

// 문자열 내림차순. 같으면 보조 키 오름차순이다.
function desc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0
}

function lookbackDays(ctx: RecoveryContext): number {
  return daysBetween(ctx.sinceDate, ctx.today)
}

function lastDayLines(input: RecoveryInput): string[] {
  const { ctx } = input
  if (ctx.lastPlan === null) return [`이전 계획이 없다. 최근 ${lookbackDays(ctx)}일을 본다`]
  const note = input.wrapupNote !== null ? oneLine(input.wrapupNote) : ''
  return [`${ctx.lastPlan.plan_date} (${ctx.gapDays ?? 0}일 전)`, note !== '' ? `메모: ${note}` : '메모 없음']
}

function unfinishedLine(item: PlanItem): string {
  const title = item.jira_issue_key ? `${item.jira_issue_key} ${oneLine(item.title)}` : oneLine(item.title)
  const parts = [title]
  const status = STATUS_LABEL[item.status]
  if (status) parts.push(status)
  if (item.due_date) parts.push(`마감 ${item.due_date}`)
  return parts.join(' · ')
}

function todoLine(t: RecoveryTodoDone): string {
  return `${t.completedAt.slice(0, 16)} 완료 · ${oneLine(t.title)}`
}

function activityLine(g: RecoveryActivityGroup): string {
  const actions = g.actions.map((a) => ACTION_LABEL[a] ?? a).join(', ')
  const parts = [`${g.lastAt.slice(0, 10)} ${ENTITY_LABEL[g.entityType]}`, oneLine(g.name), actions]
  if (g.deleted) parts.push('삭제됨')
  return parts.join(' · ')
}

function meetingLines(m: RecoveryMeeting): string[] {
  const head = `${m.startedAt.slice(0, 10)} ${oneLine(m.title)}`
  const out = [m.projectName ? `${head} · ${oneLine(m.projectName)}` : head]
  const tldr = m.tldr !== null ? oneLine(m.tldr, TLDR_MAX) : ''
  if (tldr !== '') out.push(`  요약: ${tldr}`)
  const actions = m.openActionItems
    .slice(0, RECOVERY_LIMITS.actionItemsPerMeeting)
    .map((t) => oneLine(t))
    .filter((t) => t !== '')
  if (m.openActionCount > 0 && actions.length > 0) {
    out.push(`  미완료 액션 ${m.openActionCount}건: ${actions.join('; ')}`)
  }
  return out
}

function jiraLine(j: RecoveryJiraIssue): string {
  const parts = [`${j.key} ${oneLine(j.summary)}`, oneLine(j.status)]
  if (j.duedate) parts.push(`마감 ${j.duedate}`)
  return parts.join(' · ')
}

function jiraLines(input: RecoveryInput): string[] {
  if (input.jira === null) {
    return [input.jiraConnected ? 'Jira 변경을 확인하지 못했다' : 'Jira 가 연결되어 있지 않다']
  }
  if (input.jira.length === 0) return []
  const lines = input.jira.slice(0, RECOVERY_LIMITS.jira).map(jiraLine)
  if (input.jiraTruncated || input.jira.length > RECOVERY_LIMITS.jira) lines.push('이슈가 많아 일부만 가져왔다')
  return lines
}

// F.4: 규칙 본문 섹션. 빈 섹션은 뺀다. last_day 는 항상 있다.
export function buildRecovery(input: RecoveryInput): RecoverySection[] {
  const unfinished = input.unfinishedItems
    .filter((i) => UNFINISHED_STATUSES.includes(i.status))
    .sort(byRank)
    .slice(0, RECOVERY_LIMITS.unfinished)
  const todos = input.completedTodos
    .slice()
    .sort((a, b) => desc(a.completedAt, b.completedAt) || a.id - b.id)
    .slice(0, RECOVERY_LIMITS.todos)
  const activity = input.activity
    .slice()
    .sort((a, b) => desc(a.lastAt, b.lastAt))
    .slice(0, RECOVERY_LIMITS.activity)
  const meetings = input.meetings
    .slice()
    .sort((a, b) => desc(a.startedAt, b.startedAt) || a.meetingId - b.meetingId)
    .slice(0, RECOVERY_LIMITS.meetings)

  const all: RecoverySection[] = [
    { key: 'last_day', title: '마지막 근무', lines: lastDayLines(input) },
    { key: 'unfinished', title: '남은 작업', lines: unfinished.map(unfinishedLine) },
    { key: 'done', title: '그동안 한 일', lines: [...todos.map(todoLine), ...activity.map(activityLine)] },
    { key: 'meetings', title: '회의', lines: meetings.flatMap(meetingLines) },
    { key: 'jira', title: 'Jira 변경', lines: jiraLines(input) },
    {
      key: 'errors',
      title: '확인하지 못한 출처',
      lines: input.errors.map((e) => oneLine(e)).filter((e) => e !== '')
    }
  ]
  return all.filter((s) => s.key === 'last_day' || s.lines.length > 0)
}

// F.4 Markdown 저장 형식. recovery_text 에 저장한다.
export function recoveryToMarkdown(sections: RecoverySection[], ctx: RecoveryContext): string {
  const out: string[] = [`# ${ctx.today} 맥락 복구`, '']
  out.push(
    ctx.lastPlan !== null
      ? `마지막 근무는 ${ctx.lastPlan.plan_date} 입니다. ${ctx.gapDays ?? 0}일 만에 돌아왔습니다.`
      : `최근 ${lookbackDays(ctx)}일을 정리했습니다.`,
    ''
  )
  for (const s of sections) {
    out.push(`## ${s.title}`, '')
    // 회의의 들여쓴 줄은 하위 목록이다
    for (const line of s.lines) out.push(line.startsWith('  ') ? `  - ${line.trim()}` : `- ${line}`)
    out.push('')
  }
  return out.join('\n').trimEnd() + '\n'
}
