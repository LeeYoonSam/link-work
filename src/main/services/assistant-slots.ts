// 빈 구간 계산과 블록 타임라인 (docs/ASSISTANT.md 부록 B.3). 순수 모듈이다 (A3·A14).
import { isUrgent } from './assistant-candidates'
import { rankCandidates } from './assistant-score'
import type {
  BusyBlock,
  CalendarRef,
  Candidate,
  DayTimeline,
  NewPlanItem,
  PlanItem,
  PlanItemStatus,
  Slot,
  TimelineEntry
} from './assistant-types'

const DAY_END_MIN = 24 * 60
/** 배정 가능 블록의 최소 남은 분 (B.2). */
export const MIN_ASSIGN_MIN = 30

/** 'HH:mm' → 분. 형식이 아니면 null. */
export function toMinutes(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null
  return h * 60 + min
}

/** 분 → 'HH:mm'. 0~24:00 범위로 자른다. */
export function fromMinutes(total: number): string {
  const v = Math.max(0, Math.min(DAY_END_MIN, Math.round(total)))
  const h = Math.floor(v / 60)
  const m = v % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 15분 단위로 올림한다. 23:50 은 '24:00' 이 된다. 형식이 아니면 입력을 그대로 돌려준다. */
export function roundUpToQuarter(hhmm: string): string {
  const v = toMinutes(hhmm)
  if (v === null) return hhmm
  return fromMinutes(Math.ceil(v / 15) * 15)
}

/** 종일 일정을 빼고 시작 순으로 정렬한 busy 목록. 형식이 틀리거나 길이가 0 인 일정은 뺀다. */
export function calendarToBusy(calendar: CalendarRef[]): BusyBlock[] {
  return calendar
    .filter((e) => !e.allDay)
    .filter((e) => {
      const s = toMinutes(e.start)
      const en = toMinutes(e.end)
      return s !== null && en !== null && en > s
    })
    .map((e) => ({ start: e.start, end: e.end }))
    .sort((a, b) => (toMinutes(a.start) as number) - (toMinutes(b.start) as number) ||
      (toMinutes(a.end) as number) - (toMinutes(b.end) as number))
}

/** from~workEnd 에서 busy 를 뺀 구간. 겹치는 busy 는 합친다. minSlotMin 미만 구간은 버린다. */
export function computeFreeSlots(
  from: string,
  workEnd: string,
  busy: BusyBlock[],
  minSlotMin = 30
): Slot[] {
  const f = toMinutes(from)
  const e = toMinutes(workEnd)
  if (f === null || e === null || f >= e) return []

  const blocks: Array<[number, number]> = []
  for (const b of busy) {
    const s = toMinutes(b.start)
    const en = toMinutes(b.end)
    if (s === null || en === null) continue
    const cs = Math.max(s, f)
    const ce = Math.min(en, e)
    if (ce > cs) blocks.push([cs, ce])
  }
  blocks.sort((a, b) => a[0] - b[0] || a[1] - b[1])

  // 겹치거나 맞닿은 busy 를 합친다
  const merged: Array<[number, number]> = []
  for (const b of blocks) {
    const last = merged[merged.length - 1]
    if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1])
    else merged.push([b[0], b[1]])
  }

  const slots: Slot[] = []
  let cursor = f
  for (const [s, en] of merged) {
    if (s - cursor >= minSlotMin) slots.push({ start: fromMinutes(cursor), end: fromMinutes(s) })
    cursor = Math.max(cursor, en)
  }
  if (e - cursor >= minSlotMin) slots.push({ start: fromMinutes(cursor), end: fromMinutes(e) })
  return slots
}

/** 하루 시작 계획 항목. 점수 순 상위 planSize 개를 시간 없이 만든다 (B.6). */
export function buildStartPlanItems(candidates: Candidate[], today: string, planSize: number): NewPlanItem[] {
  return rankCandidates(candidates, today)
    .slice(0, Math.max(0, Math.floor(planSize)))
    .map(({ candidate: c, score }, idx) => ({
      candidate_id: c.id,
      source: c.source,
      title: c.title,
      link: c.link,
      jira_issue_key: c.jiraKey,
      project_id: c.projectId,
      due_date: c.dueDate,
      score,
      rank: idx + 1,
      slot_start: null,
      slot_end: null,
      pinned: false,
      added_by: 'start',
      urgent: isUrgent(c, today),
      status: 'planned',
      status_note: null
    }))
}

/** rank 오름차순. null 은 뒤로, 같으면 id 오름차순. */
export function compareByRank(a: PlanItem, b: PlanItem): number {
  if (a.rank !== b.rank) {
    if (a.rank === null) return 1
    if (b.rank === null) return -1
    return a.rank - b.rank
  }
  return a.id - b.id
}

/** 활성 항목 상태 (B.2). */
export const ACTIVE_STATUSES: ReadonlySet<PlanItemStatus> = new Set<PlanItemStatus>(['planned', 'in_progress'])

export interface TimelineInput {
  calendar: CalendarRef[]
  dayStart: string
  nowHHmm: string
  workEnd: string
  items: PlanItem[]
  today: string
  closed: boolean
}

type BlockEntry = Extract<TimelineEntry, { kind: 'block' }>

/** 부록 B.3 블록 타임라인 (A23). Date.now 를 쓰지 않는다. 입력을 바꾸지 않는다 (A14). */
export function buildTimeline(input: TimelineInput): DayTimeline {
  const { calendar, nowHHmm, workEnd, items, today, closed } = input
  const now = toMinutes(nowHHmm) ?? 0

  // 회의: 종일이 아니고 형식이 맞는 일정
  const meetings = calendar
    .filter((e) => !e.allDay)
    .filter((e) => {
      const s = toMinutes(e.start)
      const en = toMinutes(e.end)
      return s !== null && en !== null && en > s
    })
    .map((e): TimelineEntry => ({ kind: 'meeting', start: fromMinutes(toMinutes(e.start) as number), end: fromMinutes(toMinutes(e.end) as number), title: e.title }))

  // 규칙 1·2: dayStart~workEnd 에서 회의를 뺀 구간. 30분 미만도 보인다.
  const dayStart = roundUpToQuarter(input.dayStart)
  const free = computeFreeSlots(dayStart, workEnd, calendarToBusy(calendar), 1)

  // 규칙 3·4·11: state 와 배정 판단 길이
  const blocks: BlockEntry[] = []
  const remain: number[] = []
  for (const f of free) {
    const s = toMinutes(f.start) as number
    const e = toMinutes(f.end) as number
    let state: BlockEntry['state']
    if (closed || e <= now) state = 'past'
    else if (s <= now) state = 'current'
    else state = 'future'
    blocks.push({ kind: 'block', start: f.start, end: f.end, minutes: e - s, state, itemId: null, reason: null, continued: false })
    remain.push(state === 'past' ? 0 : state === 'current' ? e - now : e - s)
  }
  const assignable = blocks.map((_, i) => i).filter((i) => remain[i] >= MIN_ASSIGN_MIN)

  // 규칙 5: 활성 항목을 rank 순으로. 첫 항목이 집중 작업이다.
  const active = items.filter((it) => ACTIVE_STATUSES.has(it.status)).sort(compareByRank)
  const focus = active[0] ?? null

  // 규칙 6·7: 마감 항목은 첫 배정 가능 블록을 빼고 가장 늦은 빈 블록을 받는다.
  const unplacedDeadlineItemIds: number[] = []
  if (focus) {
    const pool = assignable.slice(1)
    for (const it of active.slice(1)) {
      if (it.due_date === null || it.due_date > today) continue
      const idx = pool.pop()
      if (idx === undefined) {
        // 닫힌 계획은 경고하지 않는다
        if (!closed) unplacedDeadlineItemIds.push(it.id)
        continue
      }
      blocks[idx].itemId = it.id
      blocks[idx].reason = 'deadline'
    }
    // 규칙 8: 남은 배정 가능 블록은 집중 작업이 받는다
    for (const i of assignable) {
      if (blocks[i].itemId !== null) continue
      blocks[i].itemId = focus.id
      blocks[i].reason = 'focus'
    }
  }

  // 규칙 9: 바로 앞 배정 블록과 item 이 같으면 이어서
  let prevItem: number | null = null
  for (const b of blocks) {
    if (b.itemId === null) continue
    b.continued = b.itemId === prevItem
    prevItem = b.itemId
  }

  // 규칙 10: 배정 가능 블록의 남은 길이 합
  const freeMinutesLeft = assignable.reduce((sum, i) => sum + remain[i], 0)

  const entries: TimelineEntry[] = [...meetings, ...blocks].sort(compareEntries)
  return { entries, freeMinutesLeft, focusItemId: focus?.id ?? null, unplacedDeadlineItemIds }
}

/** 시작 → 끝 → 회의 먼저 → 제목 순. */
function compareEntries(a: TimelineEntry, b: TimelineEntry): number {
  const s = (toMinutes(a.start) as number) - (toMinutes(b.start) as number)
  if (s !== 0) return s
  const e = (toMinutes(a.end) as number) - (toMinutes(b.end) as number)
  if (e !== 0) return e
  if (a.kind !== b.kind) return a.kind === 'meeting' ? -1 : 1
  const ta = a.kind === 'meeting' ? a.title : ''
  const tb = b.kind === 'meeting' ? b.title : ''
  return ta < tb ? -1 : ta > tb ? 1 : 0
}
