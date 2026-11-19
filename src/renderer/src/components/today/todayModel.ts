// 오늘 대시보드 순수 모델. 스토어 값을 받아 화면 한 장(신호·다음 배포·내 Jira 작업·할 일·일정)을 조립한다.
// React·스토어·window 를 쓰지 않는다. 시각(now)은 호출부가 넘긴다.
// 신호와 그 근거(ref)는 여기 규칙이 만든다. LLM 브리핑은 headline 과 신호 순서·문구만 다듬는다(applyBriefing).
// 브리핑 입력에는 상대 시간("40분 뒤")을 넣지 않는다 — 입력 해시가 분마다 바뀌면 안 된다. "n분 뒤"는 화면이 붙인다.
import type {
  CalendarEvent,
  JiraBoardIssue,
  JiraBoardSnapshot,
  ReleaseNoteSummary,
  SignalKind,
  SignalSeverity,
  Todo,
  TodoPriority,
  TodayBriefing,
  TodayBriefingInput
} from '../../types'
import { clockTime, compareIssueKeys, isOverdue, localDate } from '../project/boardModel'
import {
  classifyReleaseEvent,
  issuesInRelease,
  releaseRiskKeys,
  resolveNextRelease,
  shiftDay,
  toJiraRow,
  type JiraRow,
  type NextRelease
} from './releaseModel'

export type { JiraRow, NextRelease } from './releaseModel'

// ─── 계약 타입 ─────────────────────────────────────────────

export interface SignalRef {
  type: 'issue' | 'todo' | 'meeting' | 'release'
  id: string
  label: string
}

export interface TodaySignal {
  id: string
  kind: SignalKind
  severity: SignalSeverity
  text: string
  refs: SignalRef[]
}

export interface TodoRow {
  id: number
  title: string
  priority: TodoPriority
  dueDate: string | null
  bucket: 'overdue' | 'today' | 'later' | 'none'
  signaled: boolean
}

export interface ScheduleRow {
  id: string
  title: string
  /** 'HH:mm' */
  start: string
  end: string
  startISO: string
  endISO: string
  timing: 'past' | 'current' | 'upcoming'
  location: string | null
  htmlLink: string | null
  /** 일정이 온 캘린더 id. 없으면 null(기본 캘린더로 본다) */
  calendarId?: string | null
}

export interface TodayModelInput {
  now: Date
  events: CalendarEvent[]
  calendarConnected: boolean
  snapshot: JiraBoardSnapshot | null
  boardErrorCode: 'not_connected' | 'no_default_project' | null
  notes: ReleaseNoteSummary[]
  activeTodos: Todo[]
  completedTodos: Todo[]
  /** Jira 보드 동기화 중(jiraBoardStore.loading) */
  boardLoading?: boolean
  /** Jira 보드 오류 문구(jiraBoardStore.error). 저장본도 없이 실패하면 'error' 상태가 된다 */
  boardError?: string | null
}

export interface TodayDashboard {
  date: string
  headline: string
  signals: TodaySignal[]
  hiddenSignalCount: number
  /**
   * 상한 밖으로 숨은 신호(규칙 순서). 화면이 "외 n건"을 펼쳐 보인다. 길이 = hiddenSignalCount.
   * 계약 뒤에 추가한 필드라 선택이지만 buildTodayDashboard 는 늘 채운다.
   */
  hiddenSignals?: TodaySignal[]
  summaryLine: string
  release: NextRelease | null
  /**
   * 다음 배포를 모른다: release 가 null 인데 Jira 상태가 'ok' 가 아니다(미연결·불러오는 중·실패).
   * 이때 화면은 "예정된 배포가 없어요"라고 단정하지 않는다. 선택 필드지만 buildTodayDashboard 는 늘 채운다.
   */
  releaseUnknown?: boolean
  jira: { state: 'ok' | 'not_connected' | 'no_project' | 'loading' | 'error'; rows: JiraRow[]; moreCount: number }
  todos: { rows: TodoRow[]; moreCount: number; doneTodayCount: number }
  schedule: {
    connected: boolean
    allDay: { id: string; title: string }[]
    rows: ScheduleRow[]
    nowIndex: number
    tomorrowCount: number
    tomorrowFirst: string | null
  }
  /**
   * 브리핑 입력용 사실. 행 목록은 상한으로 잘려 있어 건수를 다시 셀 수 없다.
   * 계약 밖의 선택 필드다 — 없으면 toBriefingInput 이 행에서 근사한다.
   */
  facts?: TodayBriefingInput['facts']
  /**
   * 상한으로 자르기 전 전체 신호(규칙 순서). 계약 밖의 선택 필드다.
   * 브리핑 입력은 시간에 따라 바뀌는 meeting_soon 을 뺀 상위 신호를 여기서 고른다.
   */
  allSignals?: TodaySignal[]
}

// ─── 상수 ─────────────────────────────────────────────────

export const SIGNAL_LIMIT = 3
export const JIRA_ROW_LIMIT = 7
export const TODO_ROW_LIMIT = 6
/** meeting_soon 을 띄우는 범위(분) */
export const MEETING_SOON_MINUTES = 60
/** 신호 행에 그릴 근거 칩 상한(배포 ref 는 상한과 별개로 늘 보인다) */
export const SIGNAL_REF_DISPLAY_LIMIT = 4
/** 메인 브리핑 입력 검증의 refs 상한 */
export const BRIEFING_REF_LIMIT = 20

const SEVERITY_ORDER: Record<SignalSeverity, number> = { critical: 0, warn: 1, info: 2 }
const KIND_ORDER: Record<SignalKind, number> = {
  release_risk: 0,
  release_day: 1,
  overdue: 2,
  meeting_soon: 3,
  due_today: 4,
  qa_start: 5
}
const PRIORITY_ORDER: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 }

// ─── 도우미 ─────────────────────────────────────────────────

/** 시작까지 남은 분(올림). 지난 일정은 0 이하, 잘못된 값은 NaN */
export function minutesUntil(startISO: string, now: Date): number {
  const t = Date.parse(startISO)
  if (Number.isNaN(t)) return Number.NaN
  return Math.ceil((t - now.getTime()) / 60_000)
}

/** 기본 캘린더 일정인가. 추가 캘린더(Tech 등) 회의는 화면에는 보이되 알림성 집계에서 뺀다 */
const isPrimaryCalendar = (e: Pick<CalendarEvent, 'calendarId'>): boolean =>
  !e.calendarId || e.calendarId === 'primary'

/** 'YYYY-MM-DD' → 'M/D' */
const md = (day: string): string => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`

const releaseLabel = (r: NextRelease): string => r.version ?? `${md(r.date)} 배포`
const dDayText = (dDay: number): string => (dDay === 0 ? 'D-day' : `D-${dDay}`)

const todoDue = (t: Todo): string | null => (t.due_date ? t.due_date.slice(0, 10) : null)

function todoBucket(due: string | null, today: string): TodoRow['bucket'] {
  if (!due) return 'none'
  if (due < today) return 'overdue'
  if (due === today) return 'today'
  return 'later'
}

/** 시간 있는 일정이 [from, to) 와 겹치는가 */
function overlaps(e: CalendarEvent, from: number, to: number): boolean {
  const s = Date.parse(e.start)
  const en = Date.parse(e.end)
  if (Number.isNaN(s)) return false
  const end = Number.isNaN(en) || en < s ? s : en
  // 길이 0 인 일정은 시작 시각이 범위 안이면 겹친 것으로 본다
  return end === s ? s >= from && s < to : s < to && end > from
}

/** 종일 일정이 그 날을 덮는가(end 는 배타적) */
function allDayCovers(e: CalendarEvent, day: string): boolean {
  const s = e.start.slice(0, 10)
  const endRaw = (e.end ?? '').slice(0, 10)
  const end = endRaw && endRaw > s ? endRaw : shiftDay(s, 1)
  return s <= day && day < end
}

// ─── 일정 ─────────────────────────────────────────────────

function buildSchedule(
  events: CalendarEvent[],
  now: Date,
  today: string,
  connected: boolean
): TodayDashboard['schedule'] & {
  nextMeeting: { title: string; start: string } | null
  /** 기본 캘린더 일정 행 id */
  primaryIds: Set<string>
} {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()
  const tomorrowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).getTime()
  const nowMs = now.getTime()

  const allDay: { id: string; title: string }[] = []
  const timed: CalendarEvent[] = []
  const tomorrow: CalendarEvent[] = []
  for (const e of events) {
    if (e.allDay) {
      // 릴리스·QA 종일 일정은 배포 카드가 보인다
      if (classifyReleaseEvent(e)) continue
      if (allDayCovers(e, today)) allDay.push({ id: e.id, title: e.summary.trim() })
      continue
    }
    if (overlaps(e, dayStart, dayEnd)) timed.push(e)
    const s = Date.parse(e.start)
    if (!Number.isNaN(s) && s >= dayEnd && s < tomorrowEnd) tomorrow.push(e)
  }
  const byStart = (a: CalendarEvent, b: CalendarEvent): number =>
    Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end)
  timed.sort(byStart)
  tomorrow.sort(byStart)

  const rows: ScheduleRow[] = timed.map((e) => {
    const s = Date.parse(e.start)
    const en = Date.parse(e.end)
    const end = Number.isNaN(en) ? s : en
    const timing: ScheduleRow['timing'] = nowMs < s ? 'upcoming' : nowMs < end ? 'current' : 'past'
    return {
      id: e.id,
      title: e.summary.trim(),
      start: clockTime(e.start),
      end: clockTime(e.end),
      startISO: e.start,
      endISO: e.end,
      timing,
      location: e.location ?? null,
      htmlLink: e.htmlLink ?? null,
      calendarId: e.calendarId ?? null
    }
  })
  const nowIndex = rows.filter((r) => r.timing !== 'upcoming').length
  const primaryIds = new Set(timed.filter(isPrimaryCalendar).map((e) => e.id))
  const next = rows.find((r) => r.timing === 'upcoming' && primaryIds.has(r.id)) ?? null
  const first = tomorrow[0]
  return {
    connected,
    allDay,
    rows,
    nowIndex,
    tomorrowCount: tomorrow.length,
    tomorrowFirst: first ? `${clockTime(first.start)} ${first.summary.trim()}` : null,
    nextMeeting: next ? { title: next.title, start: next.start } : null,
    primaryIds
  }
}

// ─── 내 Jira 작업 ───────────────────────────────────────────

/** 지남 → 오늘 마감 → 진행 중 → 리뷰·QA → 나머지 */
function jiraGroup(row: JiraRow): number {
  if (row.overdue) return 0
  if (row.dueToday) return 1
  if (row.statusCategory === 'indeterminate') return row.review ? 3 : 2
  return 4
}

function myOpenIssues(snapshot: JiraBoardSnapshot | null): JiraBoardIssue[] {
  const my = snapshot?.myAccountId ?? null
  if (!snapshot || !my) return []
  return snapshot.issues.filter(
    (i) => i.assigneeAccountId === my && i.level !== 'epic' && i.inScope && i.statusCategory !== 'done'
  )
}

// ─── 신호 ─────────────────────────────────────────────────

function sortSignals(list: TodaySignal[]): TodaySignal[] {
  return list
    .map((s, idx) => ({ s, idx }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.s.severity] - SEVERITY_ORDER[b.s.severity] ||
        KIND_ORDER[a.s.kind] - KIND_ORDER[b.s.kind] ||
        a.idx - b.idx
    )
    .map((x) => x.s)
}

const issueRef = (key: string): SignalRef => ({ type: 'issue', id: key, label: key })
const todoRef = (t: Todo): SignalRef => ({ type: 'todo', id: String(t.id), label: t.title })
const releaseRef = (r: NextRelease): SignalRef => ({
  type: 'release',
  id: r.version ?? r.date,
  label: releaseLabel(r)
})

// ─── 조립 ─────────────────────────────────────────────────

export function buildTodayDashboard(input: TodayModelInput): TodayDashboard {
  const { now, snapshot } = input
  const today = localDate(now)
  const issues = snapshot?.issues ?? []
  const my = snapshot?.myAccountId ?? null

  // 다음 배포
  const release = resolveNextRelease({ today, events: input.events, notes: input.notes, snapshot })
  const riskKeys = new Set(releaseRiskKeys(release, today))
  const releaseKeys = new Set(
    release?.linked ? issuesInRelease(issues, release.version, release.jiraVersionId).map((i) => i.key) : []
  )

  // 일정
  const schedule = buildSchedule(input.events, now, today, input.calendarConnected)

  // 내 Jira 작업. 스냅샷과 내 계정을 알아야 "내 Jira 건수"를 말할 수 있다
  const jiraKnown = !!snapshot && !!my
  const openIssues = myOpenIssues(snapshot)
  // 다음 배포 카드에 보이는 행은 이 카드에서 뺀다(같은 이슈 중복). 배포 카드 "외 n건"으로 잘린 이슈는 남긴다
  const releaseShownKeys = new Set((release?.rows ?? []).map((r) => r.key))
  const jiraAll = openIssues
    .filter((i) => !releaseShownKeys.has(i.key))
    .filter((i) => i.statusCategory !== 'new' || !!i.duedate || releaseKeys.has(i.key))
    .map((i) => toJiraRow(i, issues, today))
    .sort((a, b) => jiraGroup(a) - jiraGroup(b) || compareIssueKeys(a.key, b.key))
  const jiraPinned = jiraAll.filter((r) => r.overdue || riskKeys.has(r.key))
  const jiraRest = jiraAll.filter((r) => !(r.overdue || riskKeys.has(r.key)))
  const jiraShown = new Set([...jiraPinned, ...jiraRest.slice(0, JIRA_ROW_LIMIT)].map((r) => r.key))
  const jiraRows = jiraAll.filter((r) => jiraShown.has(r.key))
  const jiraState: TodayDashboard['jira']['state'] =
    input.boardErrorCode === 'not_connected'
      ? 'not_connected'
      : input.boardErrorCode === 'no_default_project'
        ? 'no_project'
        : snapshot
          ? 'ok'
          : !input.boardLoading && input.boardError
            ? 'error'
            : 'loading'

  // 할 일 — listActive 에는 오늘 완료한 항목도 섞여 온다
  const openTodos = input.activeTodos.filter((t) => !t.is_completed)
  const todoSorted = openTodos
    .map((t) => ({ t, due: todoDue(t) }))
    .map((x) => ({ ...x, bucket: todoBucket(x.due, today) }))
    .sort((a, b) => {
      // 지남(날짜순) → 오늘 → 마감 있음(날짜순) → 마감 없음, 같은 날짜·묶음 안에서는 우선순위 → 생성순
      const g: Record<TodoRow['bucket'], number> = { overdue: 0, today: 1, later: 2, none: 3 }
      return (
        g[a.bucket] - g[b.bucket] ||
        (a.due && b.due ? a.due.localeCompare(b.due) : 0) ||
        (PRIORITY_ORDER[a.t.priority] ?? 1) - (PRIORITY_ORDER[b.t.priority] ?? 1) ||
        a.t.created_at.localeCompare(b.t.created_at) ||
        a.t.id - b.t.id
      )
    })
  const todoOverdue = todoSorted.filter((x) => x.bucket === 'overdue')
  const todoRest = todoSorted.filter((x) => x.bucket !== 'overdue')
  const todoShown = [...todoOverdue, ...todoRest.slice(0, TODO_ROW_LIMIT)]
  const doneIds = new Set<number>()
  for (const t of [...input.activeTodos, ...input.completedTodos]) {
    if (t.is_completed && t.completed_at && t.completed_at.slice(0, 10) === today) doneIds.add(t.id)
  }

  // 신호
  const signals: TodaySignal[] = []
  if (release && release.linked && my && riskKeys.size > 0) {
    const n = riskKeys.size
    const reason = release.dDay === 0 ? '오늘 배포' : release.dDay === 1 ? '내일 배포' : 'QA 진행 중'
    signals.push({
      id: 'release_risk',
      kind: 'release_risk',
      severity: release.dDay <= 1 ? 'critical' : 'warn',
      text: `${reason}, ${n}건 미완 — ${releaseLabel(release)} 포함분`,
      refs: [...riskKeys].map(issueRef).concat(releaseRef(release))
    })
  }
  if (release && release.dDay === 0) {
    signals.push({
      id: 'release_day',
      kind: 'release_day',
      severity: 'warn',
      text: `오늘 ${releaseLabel(release)} 배포`,
      refs: [releaseRef(release)]
    })
  }
  const overdueJira = openIssues.filter((i) => isOverdue(i, today)).sort((a, b) => compareIssueKeys(a.key, b.key))
  if (overdueJira.length > 0) {
    signals.push({
      id: 'overdue:jira',
      kind: 'overdue',
      severity: 'warn',
      text: `마감 지난 Jira ${overdueJira.length}건`,
      refs: overdueJira.map((i) => issueRef(i.key))
    })
  }
  if (todoOverdue.length > 0) {
    signals.push({
      id: 'overdue:todo',
      kind: 'overdue',
      severity: 'warn',
      text: `마감 지난 할 일 ${todoOverdue.length}건`,
      refs: todoOverdue.map((x) => todoRef(x.t))
    })
  }
  const soon = schedule.rows
    .filter((r) => {
      if (!schedule.primaryIds.has(r.id)) return false
      const m = minutesUntil(r.startISO, now)
      return m > 0 && m <= MEETING_SOON_MINUTES
    })
    .sort((a, b) => Date.parse(a.startISO) - Date.parse(b.startISO))[0]
  if (soon) {
    signals.push({
      id: `meeting_soon:${soon.id}`,
      kind: 'meeting_soon',
      severity: 'info',
      text: `${soon.start} ${soon.title}`,
      refs: [{ type: 'meeting', id: soon.id, label: soon.title }]
    })
  }
  const dueTodayJira = openIssues.filter((i) => i.duedate === today).sort((a, b) => compareIssueKeys(a.key, b.key))
  const dueTodayTodos = todoSorted.filter((x) => x.bucket === 'today')
  const dueTodayCount = dueTodayJira.length + dueTodayTodos.length
  if (dueTodayCount > 0) {
    const parts: string[] = []
    if (dueTodayJira.length > 0) parts.push(`Jira ${dueTodayJira.length}`)
    if (dueTodayTodos.length > 0) parts.push(`할 일 ${dueTodayTodos.length}`)
    signals.push({
      id: 'due_today',
      kind: 'due_today',
      severity: 'info',
      // Jira 를 못 셌으면 할 일만 센 값임을 문구에 드러낸다
      text: jiraKnown ? `오늘 마감 ${dueTodayCount}건 (${parts.join(' · ')})` : `오늘 마감 할 일 ${dueTodayCount}건`,
      refs: [...dueTodayJira.map((i) => issueRef(i.key)), ...dueTodayTodos.map((x) => todoRef(x.t))]
    })
  }
  if (release && release.qaStart === today && release.dDay !== 0) {
    signals.push({
      id: 'qa_start',
      kind: 'qa_start',
      severity: 'info',
      text: `오늘 QA 시작 — ${releaseLabel(release)} 배포 ${md(release.date)}`,
      refs: [releaseRef(release)]
    })
  }
  const sorted = sortSignals(signals)
  const visible = pickVisibleSignals(sorted)
  const visibleIds = new Set(visible.map((s) => s.id))
  const hidden = sorted.filter((s) => !visibleIds.has(s.id))

  // 보이는 신호에 올라간 항목만 아래 카드에서 강조한다
  const signaledIssues = new Set<string>()
  const signaledTodos = new Set<string>()
  for (const s of visible) {
    for (const r of s.refs) {
      if (r.type === 'issue') signaledIssues.add(r.id)
      if (r.type === 'todo') signaledTodos.add(r.id)
    }
  }
  const mark = (r: JiraRow): JiraRow => ({ ...r, signaled: signaledIssues.has(r.key) })
  const releaseOut: NextRelease | null = release ? { ...release, rows: release.rows.map(mark) } : null

  const overdueCount = overdueJira.length + todoOverdue.length
  const facts: TodayBriefingInput['facts'] = {
    calendarConnected: input.calendarConnected,
    jiraConnected: isJiraConnected(jiraState),
    meetingCount: schedule.rows.filter((r) => schedule.primaryIds.has(r.id)).length,
    overdueCount,
    dueTodayCount,
    nextMeeting: schedule.nextMeeting,
    release: release
      ? {
          version: release.version,
          date: release.date,
          dDay: release.dDay,
          qaStart: release.qaStart,
          linked: release.linked,
          mine: { ...release.mine }
        }
      : null
  }

  const scheduleOut: TodayDashboard['schedule'] = {
    connected: schedule.connected,
    allDay: schedule.allDay,
    rows: schedule.rows,
    nowIndex: schedule.nowIndex,
    tomorrowCount: schedule.tomorrowCount,
    tomorrowFirst: schedule.tomorrowFirst
  }
  return {
    date: today,
    headline: ruleHeadline(release, riskKeys.size, facts, today, jiraKnown),
    signals: visible,
    hiddenSignalCount: hidden.length,
    hiddenSignals: hidden,
    allSignals: sorted,
    summaryLine: summaryLine(facts, jiraKnown),
    release: releaseOut,
    releaseUnknown: releaseOut === null && jiraState !== 'ok',
    jira: { state: jiraState, rows: jiraRows.map(mark), moreCount: jiraRest.length - Math.min(jiraRest.length, JIRA_ROW_LIMIT) },
    todos: {
      rows: todoShown.map((x) => ({
        id: x.t.id,
        title: x.t.title,
        priority: x.t.priority,
        dueDate: x.t.due_date,
        bucket: x.bucket,
        signaled: signaledTodos.has(String(x.t.id))
      })),
      moreCount: todoRest.length - Math.min(todoRest.length, TODO_ROW_LIMIT),
      doneTodayCount: doneIds.size
    },
    schedule: scheduleOut,
    facts
  }
}

/**
 * 상한 SIGNAL_LIMIT 안에서 보일 신호. meeting_soon 이 있으면 한 자리를 보장한다(곧 시작할 회의가 warn 에 밀려 숨지 않게).
 * 나머지 자리는 규칙 정렬 상위이고, 표시 순서는 규칙 정렬 그대로다.
 */
function pickVisibleSignals(sorted: TodaySignal[]): TodaySignal[] {
  const top = sorted.slice(0, SIGNAL_LIMIT)
  const meeting = sorted.find((s) => s.kind === 'meeting_soon')
  if (!meeting || top.includes(meeting)) return top
  const keep = new Set([...sorted.filter((s) => s !== meeting).slice(0, SIGNAL_LIMIT - 1), meeting])
  return sorted.filter((s) => keep.has(s))
}

/** Jira 데이터를 말해도 되는가. 미연결·기본 프로젝트 없음이면 "없음"으로 말하지 않는다(불러오는 중·조회 실패는 연결된 것으로 본다) */
const isJiraConnected = (state: TodayDashboard['jira']['state']): boolean =>
  state !== 'not_connected' && state !== 'no_project'

/** 할 말이 없을 때의 문구. 미연결 영역을 "없음"으로 단정하지 않는다 */
function quietText(facts: TodayBriefingInput['facts'], period: boolean): string {
  const end = period ? '.' : ''
  if (!facts.calendarConnected && !facts.jiraConnected) return `캘린더와 Jira를 연결하면 오늘 챙길 것이 여기에 보여요${end}`
  if (!facts.calendarConnected) return `급한 Jira 작업·할 일은 없어요. 캘린더를 연결하면 회의도 함께 보여요${end}`
  if (!facts.jiraConnected) return `급한 일정·할 일은 없어요. Jira를 연결하면 내 작업도 함께 보여요${end}`
  return period ? '오늘은 급한 일이 없어요.' : '오늘 챙길 일이 없어요'
}

/** 규칙 헤드라인 1줄. 절대 날짜·건수만 쓴다 */
function ruleHeadline(
  release: NextRelease | null,
  riskCount: number,
  facts: TodayBriefingInput['facts'],
  today: string,
  jiraKnown: boolean
): string {
  // Jira 를 못 셌으면 마감 건수는 할 일만 센 값이다
  const what = jiraKnown ? '일' : '할 일'
  const parts: string[] = []
  if (release) {
    const label = release.version ? `${release.version} ` : ''
    if (release.dDay === 0) parts.push(`오늘 ${label}배포.`)
    else if (release.qaStart === today) parts.push(`오늘 QA 시작, 배포 ${dDayText(release.dDay)}.`)
    else if (release.phase === 'qa') parts.push(`QA 중, 배포 ${dDayText(release.dDay)}.`)
    else parts.push(`${label}배포 ${dDayText(release.dDay)}.`)
  }
  if (riskCount > 0) parts.push(`배포 포함 미완 ${riskCount}건이 남았어요.`)
  else if (facts.overdueCount > 0) parts.push(`마감 지난 ${what} ${facts.overdueCount}건이 있어요.`)
  else if (facts.dueTodayCount > 0) parts.push(`오늘 마감 ${jiraKnown ? '' : '할 일 '}${facts.dueTodayCount}건이 있어요.`)
  else if (facts.calendarConnected && facts.meetingCount > 0) parts.push(`오늘 회의 ${facts.meetingCount}건이 있어요.`)
  if (parts.length === 0) return quietText(facts, true)
  const text = parts.join(' ')
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

/** 신호가 없을 때의 한 줄 요약. 해당 없는 조각은 뺀다 */
function summaryLine(facts: TodayBriefingInput['facts'], jiraKnown: boolean): string {
  const parts: string[] = []
  if (facts.calendarConnected && facts.meetingCount > 0) parts.push(`회의 ${facts.meetingCount}`)
  if (facts.dueTodayCount > 0) parts.push(`오늘 마감${jiraKnown ? '' : ' 할 일'} ${facts.dueTodayCount}`)
  if (facts.release) parts.push(`배포 ${dDayText(facts.release.dDay)}`)
  return parts.length > 0 ? parts.join(' · ') : quietText(facts, false)
}

// ─── 근거 칩 ─────────────────────────────────────────────────

/**
 * 신호 행에 그릴 근거 칩. 배포 ref 는 늘 남기고 나머지는 SIGNAL_REF_DISPLAY_LIMIT 개까지, 넘친 수는 moreCount.
 * TodaySignal.refs 는 자르지 않는다(이동·강조 판정이 전체를 쓴다).
 */
export function visibleRefs(s: Pick<TodaySignal, 'refs'>): { refs: SignalRef[]; moreCount: number } {
  const release = s.refs.filter((r) => r.type === 'release')
  const rest = s.refs.filter((r) => r.type !== 'release')
  const shown = rest.slice(0, SIGNAL_REF_DISPLAY_LIMIT)
  return { refs: [...shown, ...release], moreCount: rest.length - shown.length }
}

// ─── 브리핑 ─────────────────────────────────────────────────

const refText = (r: SignalRef): string => `${r.type}:${r.id}`

/**
 * 브리핑 입력에 넣는 신호인가. meeting_soon 은 시각이 흐르면 생기고 사라져 입력 해시를 흔든다 —
 * 데이터가 그대로인데 회의마다 LLM 을 다시 부르게 된다. 화면에서 규칙 문구 그대로 보인다.
 */
const isBriefingSignal = (s: TodaySignal): boolean => s.kind !== 'meeting_soon'

/**
 * 대시보드 → 메인 브리핑 입력. 시간에 따라 바뀌는 값을 넣지 않는다:
 * meeting_soon 신호를 빼고, nextMeeting 은 늘 null 이다. 신호는 그것을 뺀 규칙 순서 상위 SIGNAL_LIMIT 건이다.
 * refs 는 메인 입력 검증 상한(BRIEFING_REF_LIMIT)으로 자른다.
 */
export function toBriefingInput(d: TodayDashboard): TodayBriefingInput {
  const base: TodayBriefingInput['facts'] = d.facts ?? {
    calendarConnected: d.schedule.connected,
    jiraConnected: isJiraConnected(d.jira.state),
    meetingCount: d.schedule.rows.length,
    overdueCount: d.jira.rows.filter((r) => r.overdue).length + d.todos.rows.filter((r) => r.bucket === 'overdue').length,
    dueTodayCount:
      d.jira.rows.filter((r) => r.dueToday).length + d.todos.rows.filter((r) => r.bucket === 'today').length,
    nextMeeting: null,
    release: d.release
      ? {
          version: d.release.version,
          date: d.release.date,
          dDay: d.release.dDay,
          qaStart: d.release.qaStart,
          linked: d.release.linked,
          mine: { ...d.release.mine }
        }
      : null
  }
  const facts: TodayBriefingInput['facts'] = { ...base, nextMeeting: null }
  const signals = (d.allSignals ?? d.signals).filter(isBriefingSignal).slice(0, SIGNAL_LIMIT)
  return {
    date: d.date,
    ruleHeadline: d.headline,
    signals: signals.map((s) => ({
      id: s.id,
      kind: s.kind,
      severity: s.severity,
      text: s.text,
      refs: s.refs.slice(0, BRIEFING_REF_LIMIT).map(refText)
    })),
    facts
  }
}

/**
 * 브리핑을 대시보드에 얹는다. 브리핑이 없거나 날짜가 다르면 규칙 그대로.
 * 있으면 브리핑이 다룬 신호끼리만 순서·문구를 바꾼다 — 그 신호들이 규칙 순서에서 차지한 자리에
 * 브리핑 순서대로 채운다. 브리핑에 없는 신호(meeting_soon 등)는 규칙 자리·규칙 문구 그대로 남는다.
 * 모르는 id 는 버린다. 신호의 kind·severity·refs 는 늘 규칙 값이다.
 */
export function applyBriefing(
  d: TodayDashboard,
  b: TodayBriefing | null
): { headline: string; signals: TodaySignal[]; hiddenSignals: TodaySignal[]; source: 'llm' | 'rules' } {
  // 숨은 신호는 브리핑 대상이 아니라 규칙 문구 그대로 전달한다
  const hiddenSignals = d.hiddenSignals ?? []
  if (!b || b.date !== d.date) return { headline: d.headline, signals: d.signals, hiddenSignals, source: 'rules' }
  const byId = new Map(d.signals.map((s) => [s.id, s]))
  const used = new Set<string>()
  const llmOrdered: TodaySignal[] = []
  for (const bs of b.signals ?? []) {
    const s = byId.get(bs.id)
    if (!s || used.has(bs.id)) continue
    used.add(bs.id)
    const text = typeof bs.text === 'string' && bs.text.trim() ? bs.text.trim() : s.text
    llmOrdered.push({ ...s, text })
  }
  let k = 0
  const signals = d.signals.map((s) => (used.has(s.id) ? llmOrdered[k++] : s))
  const headline = typeof b.headline === 'string' && b.headline.trim() ? b.headline.trim() : d.headline
  return { headline, signals, hiddenSignals, source: b.source }
}
