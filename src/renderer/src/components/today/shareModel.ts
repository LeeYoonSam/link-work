// 오늘 대시보드 '업무 공유' 카드의 순수 모델. 데일리 스탠드업에서 팀에 공유할
// 작업 완료 / 작업 중 / 작업 예정 / 회의·리뷰를 모은다.
// React·스토어·window 를 쓰지 않는다. 시각(now)은 호출부가 넘긴다.
// 출처: Jira 보드 스냅샷(내 담당), 할 일, 지난 근무일·오늘 캘린더 일정과 회의록. 새 IPC 없이 렌더러에 있는 값만 쓴다.
import type { CalendarEvent, JiraBoardIssue, JiraBoardSnapshot, MeetingNoteItem, Todo } from '../../types'
import { clockTime, compareIssueKeys, localDate } from '../project/boardModel'
import { PRIORITY_RANK, todoBucket } from '../todo/todoModel'
import {
  WEEKDAYS,
  formatDayLabel,
  hhmm,
  parseIso,
  parseLocalDateTime,
  previousWorkRange,
  type WorkRange
} from './yesterdayModel'

export interface ShareItem {
  kind: 'issue' | 'todo'
  /** 이슈 키 또는 할 일 id 문자열 */
  id: string
  /** 이슈는 summary */
  title: string
  /** 작업 중: Jira 상태 이름 / 예정 할 일: 기한 지났으면 '기한 지남' / 그 밖 null */
  note: string | null
}

export interface ShareMeeting {
  /** 캘린더 일정 id, 회의록만 있으면 `note-${noteId}` */
  id: string
  title: string
  /** 'HH:mm' */
  start: string
  day: 'past' | 'today'
  /** past: 구간이 하루면 '어제', multiDay 면 '금' 같은 요일 / today: '오늘' */
  dayLabel: string
  /** 제목이 PRD·리뷰·review 를 담으면 true */
  review: boolean
  noteId: number | null
  tldr: string | null
}

export interface WorkShare {
  /** previousWorkRange(now) */
  range: WorkRange
  /** 어제 묶음 제목. range.multiDay 아니면 '어제', multiDay 면 '지난 근무일 이후' */
  pastTitle: string
  /** 오늘 '11월 20일 (금)' */
  dateLabel: string
  /** snapshot 과 myAccountId 가 있어 Jira 를 판단할 수 있었나 */
  jiraKnown: boolean
  /** [range.from, 오늘 0시) 에 완료한 내 Jira·할 일 */
  done: ShareItem[]
  /** [오늘 0시, now] 에 완료한 내 Jira·할 일. 정렬은 done 과 같다 */
  doneToday: ShareItem[]
  doing: ShareItem[]
  planned: ShareItem[]
  meetings: ShareMeeting[]
  /** 네 목록 길이 합 */
  total: number
}

export interface WorkShareInput {
  now: Date
  snapshot: JiraBoardSnapshot | null
  /** listActive 결과라 오늘 완료분이 섞여 있다 — is_completed 인 것은 예정에서 뺀다 */
  activeTodos: Todo[]
  completedTodos: Todo[]
  /** todayStore.events (오늘 0시~+21일) */
  events: CalendarEvent[]
  pastEvents: CalendarEvent[]
  notes: MeetingNoteItem[]
}

// review 는 단어 첫머리에서만 본다(Preview 같은 제목을 리뷰로 잡지 않게)
const REVIEW_RE = /PRD|리뷰|\breview/i

/** 회의록을 일정에 붙일 때 일정 시작 전 몇 분까지 봐 주나 */
const NOTE_LEAD_MS = 10 * 60 * 1000

const issueItem = (i: JiraBoardIssue, note: string | null): ShareItem => ({
  kind: 'issue',
  id: i.key,
  title: i.summary,
  note
})

const todoItem = (t: Todo, note: string | null): ShareItem => ({ kind: 'todo', id: String(t.id), title: t.title, note })

/** 같은 id 의 할 일은 한 번만. 앞쪽(activeTodos)이 남는다 */
function uniqueTodos(...lists: Todo[][]): Todo[] {
  const seen = new Set<number>()
  const out: Todo[] = []
  for (const list of lists) {
    for (const t of list) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      out.push(t)
    }
  }
  return out
}

interface MeetingWindow {
  from: Date
  to: Date
  day: 'past' | 'today'
  dayLabel: (d: Date) => string
}

/**
 * 구간 안 종일 아닌 일정 + 구간 안 회의록. 회의록 시작이 [일정 시작 − 10분, 일정 끝) 에 들면
 * 아직 회의록이 없는 가장 이른 일정에 붙이고(일정 하나에 회의록 하나), 못 붙이면 독립 행으로 시간순에 끼운다
 */
function meetingsIn(events: CalendarEvent[], notes: MeetingNoteItem[], w: MeetingWindow): ShareMeeting[] {
  const inside = (t: Date): boolean => t >= w.from && t < w.to
  type Slot = { at: Date; end: Date; row: ShareMeeting }
  const slots: Slot[] = []
  for (const e of events) {
    if (e.allDay) continue
    const start = parseIso(e.start)
    if (!start || !inside(start)) continue
    slots.push({
      at: start,
      end: parseIso(e.end) ?? start,
      row: {
        id: e.id,
        title: e.summary,
        start: clockTime(e.start),
        day: w.day,
        dayLabel: w.dayLabel(start),
        review: REVIEW_RE.test(e.summary),
        noteId: null,
        tldr: null
      }
    })
  }
  slots.sort((a, b) => a.at.getTime() - b.at.getTime())

  const loose: Slot[] = []
  const dated = notes
    .map((n) => ({ n, at: parseLocalDateTime(n.started_at) }))
    .filter((x): x is { n: MeetingNoteItem; at: Date } => x.at !== null && inside(x.at))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.n.id - b.n.id)
  for (const { n, at } of dated) {
    const t = at.getTime()
    const hit = slots.find((s) => s.row.noteId === null && t >= s.at.getTime() - NOTE_LEAD_MS && t < s.end.getTime())
    if (hit) {
      hit.row.noteId = n.id
      hit.row.tldr = n.tldr
    } else {
      loose.push({
        at,
        end: at,
        row: {
          id: `note-${n.id}`,
          title: n.title,
          start: hhmm(at),
          day: w.day,
          dayLabel: w.dayLabel(at),
          review: REVIEW_RE.test(n.title),
          noteId: n.id,
          tldr: n.tldr
        }
      })
    }
  }
  return [...slots, ...loose].sort((a, b) => a.at.getTime() - b.at.getTime()).map((s) => s.row)
}

export function buildWorkShare(input: WorkShareInput): WorkShare {
  const { now } = input
  const range = previousWorkRange(now)
  const today = localDate(now)
  const todayStart = range.to
  const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const sinceFrom = (t: Date | null): t is Date => t !== null && t >= range.from && t <= now

  // ── Jira (내 담당만) ──
  const me = input.snapshot?.myAccountId
  const jiraKnown = !!input.snapshot && !!me
  const mine = jiraKnown ? input.snapshot!.issues.filter((i) => i.assigneeAccountId === me) : []
  const byKey = (a: JiraBoardIssue, b: JiraBoardIssue): number => compareIssueKeys(a.key, b.key)

  const doneIssues = mine.filter((i) => sinceFrom(parseIso(i.resolvedAt))).sort(byKey)
  const doneKeys = new Set(doneIssues.map((i) => i.key))
  const doingIssues = mine.filter((i) => i.statusCategory === 'indeterminate' && !doneKeys.has(i.key)).sort(byKey)
  const plannedIssues = mine
    .filter((i) => i.statusCategory === 'new' && i.inScope && !doneKeys.has(i.key))
    .sort((a, b) => {
      // 기한 있는 것 먼저 기한순, 그다음 키 순
      if (a.duedate !== b.duedate) {
        if (!a.duedate) return 1
        if (!b.duedate) return -1
        return a.duedate < b.duedate ? -1 : 1
      }
      return byKey(a, b)
    })

  // ── 할 일 ──
  const todos = uniqueTodos(input.activeTodos, input.completedTodos)
  const doneTodos = todos
    .map((t) => ({ t, at: parseLocalDateTime(t.completed_at) }))
    .filter((x): x is { t: Todo; at: Date } => sinceFrom(x.at))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.t.id - b.t.id)
    .map(({ t }) => t)
  const doneTodoIds = new Set(doneTodos.map((t) => t.id))
  // 완료는 어제 묶음(오늘 0시 전)과 오늘 완료로 나눈다. doing·planned 에서는 양쪽 모두 뺀다
  const isPast = (t: Date | null): boolean => t !== null && t < todayStart
  const plannedTodos = todos
    .filter((t) => !t.is_completed && !doneTodoIds.has(t.id))
    .map((t) => ({ t, bucket: todoBucket(t.due_date, today) }))
    .filter((x) => x.bucket === 'overdue' || x.bucket === 'today')
    .sort(
      (a, b) =>
        (a.bucket === b.bucket ? 0 : a.bucket === 'overdue' ? -1 : 1) ||
        (PRIORITY_RANK[a.t.priority] ?? 1) - (PRIORITY_RANK[b.t.priority] ?? 1) ||
        (a.t.due_date ?? '').localeCompare(b.t.due_date ?? '') ||
        a.t.id - b.t.id
    )

  // ── 회의·리뷰 ──
  const meetings = [
    ...meetingsIn(input.pastEvents, input.notes, {
      from: range.from,
      to: todayStart,
      day: 'past',
      dayLabel: (d) => (range.multiDay ? WEEKDAYS[d.getDay()] : '어제')
    }),
    ...meetingsIn(input.events, input.notes, { from: todayStart, to: tomorrowStart, day: 'today', dayLabel: () => '오늘' })
  ]

  const doneItems = (past: boolean): ShareItem[] => [
    ...doneIssues.filter((i) => isPast(parseIso(i.resolvedAt)) === past).map((i) => issueItem(i, null)),
    ...doneTodos.filter((t) => isPast(parseLocalDateTime(t.completed_at)) === past).map((t) => todoItem(t, null))
  ]
  const done = doneItems(true)
  const doneToday = doneItems(false)
  const doing = doingIssues.map((i) => issueItem(i, i.status))
  const planned = [
    ...plannedIssues.map((i) => issueItem(i, null)),
    ...plannedTodos.map(({ t, bucket }) => todoItem(t, bucket === 'overdue' ? '기한 지남' : null))
  ]
  return {
    range,
    pastTitle: range.multiDay ? '지난 근무일 이후' : '어제',
    dateLabel: formatDayLabel(now),
    jiraKnown,
    done,
    doneToday,
    doing,
    planned,
    meetings,
    total: done.length + doneToday.length + doing.length + planned.length + meetings.length
  }
}

/**
 * 팀 공유용 평문. 어제 묶음(완료·지난 회의)은 짧게, 오늘 묶음(작업 중·예정·오늘 회의·오늘 완료)은 섹션별로.
 * 빈 묶음·빈 섹션은 생략, total 0 이면 ''
 */
export function workShareText(share: WorkShare): string {
  if (share.total === 0) return ''
  const item = (i: ShareItem): string => {
    const head = i.kind === 'issue' ? `${i.id} ${i.title}` : i.title
    return i.note ? `- ${head} (${i.note})` : `- ${head}`
  }

  const past = share.done.map(item)
  const pastMeetings = share.meetings.filter((m) => m.day === 'past')
  if (pastMeetings.length > 0) past.push(`- 회의: ${pastMeetings.map((m) => m.title).join(', ')}`)

  const today: string[] = []
  const section = (name: string, rows: string[]): void => {
    if (rows.length > 0) today.push(`[${name}]`, ...rows)
  }
  section('작업 중', share.doing.map(item))
  section('작업 예정', share.planned.map(item))
  section(
    '회의·리뷰',
    share.meetings.filter((m) => m.day === 'today').map((m) => `- ${m.start} ${m.title}`)
  )
  section('오늘 완료', share.doneToday.map(item))

  const blocks: string[] = [`업무 공유 · ${share.dateLabel}`]
  if (past.length > 0) blocks.push([`■ ${share.pastTitle} · ${share.range.label}`, ...past].join('\n'))
  if (today.length > 0) blocks.push(['■ 오늘', ...today].join('\n'))
  return blocks.join('\n\n')
}
