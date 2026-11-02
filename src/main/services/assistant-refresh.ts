// 최신화 변경 계산·반영 계획·최신화 알림 (docs/ASSISTANT.md §8.3·§8.4, 부록 B.4·B.7·E.3). 순수 모듈이다 (A3·A14).
import { isUrgent } from './assistant-candidates'
import { compareDue, compareId, rankCandidates, scoreCandidate, SOURCE_ORDER } from './assistant-score'
import { ACTIVE_STATUSES, buildTimeline, compareByRank, toMinutes } from './assistant-slots'
import type {
  CalendarRef,
  DayTimeline,
  Candidate,
  CurrentSources,
  JiraSnapshotRef,
  NewPlanItem,
  NoticeInput,
  NotifyContext,
  PlanItem,
  PlanItemStatus,
  PlanItemUpdate,
  RefreshContext,
  RefreshDiff,
  RefreshPlan,
  RefreshSummary,
  PlanUpdateNotice,
  SourceSnapshot,
  TimelineEntry
} from './assistant-types'

type Patch = PlanItemUpdate['patch']

/** 사라짐 판정 대상 상태. done·dropped·dismissed 는 이미 끝난 결정이다. */
const VANISH_TARGET: ReadonlySet<PlanItemStatus> = new Set<PlanItemStatus>([
  'planned',
  'in_progress',
  'suggested',
  'deferred'
])

/** 출처 갱신 대상에서 빼는 상태. */
const NO_SOURCE_UPDATE: ReadonlySet<PlanItemStatus> = new Set<PlanItemStatus>(['dropped', 'dismissed'])

/**
 * Jira 를 이번에 보지 않았으면 Jira 와 연결된 항목의 출처 갱신을 건너뛴다.
 * 이유: 병합되지 않은 task 값으로 덮으면 다음 full 최신화와 값이 뒤집힌다.
 */
function skipSourceUpdate(it: PlanItem, c: Candidate, current: CurrentSources): boolean {
  if (current.jira !== null) return false
  return it.source === 'jira' || it.jira_issue_key !== null || c.jiraKey !== null
}

function calendarEqual(a: CalendarRef, b: CalendarRef): boolean {
  return a.start === b.start && a.end === b.end && a.title === b.title && !!a.allDay === !!b.allDay
}

function jiraRefChanged(a: JiraSnapshotRef, b: JiraSnapshotRef): boolean {
  return a.status !== b.status || a.priority !== b.priority || a.duedate !== b.duedate
}

/** §8.3 변경 계산. */
export function diffSources(prev: SourceSnapshot, current: CurrentSources, items: PlanItem[]): RefreshDiff {
  const calendarAdded: CalendarRef[] = []
  const calendarChanged: CalendarRef[] = []
  const calendarRemoved: CalendarRef[] = []
  if (current.calendar !== null) {
    const prevById = new Map(prev.calendar.map((e) => [e.id, e]))
    const curIds = new Set(current.calendar.map((e) => e.id))
    for (const e of current.calendar) {
      const p = prevById.get(e.id)
      if (!p) calendarAdded.push(e)
      else if (!calendarEqual(p, e)) calendarChanged.push(e)
    }
    for (const e of prev.calendar) if (!curIds.has(e.id)) calendarRemoved.push(e)
  }

  const seen = new Set(prev.seenCandidateIds)
  const itemIds = new Set(items.map((it) => it.candidate_id))
  const curById = new Map(current.candidates.map((c) => [c.id, c]))

  // 새 후보: 스냅샷에서 본 적이 없고 계획 항목도 아니다. dismissed 항목도 계획 항목이라 다시 제안하지 않는다.
  const newCandidates = current.candidates.filter((c) => !seen.has(c.id) && !itemIds.has(c.id))

  // 사라진 항목: jira 를 이번에 보지 않았으면 jira 항목은 사라진 것으로 보지 않는다.
  const vanishedCandidateIds: string[] = []
  for (const it of items) {
    if (!VANISH_TARGET.has(it.status)) continue
    if (it.source === 'manual') continue   // 임시 항목은 후보 출처가 없다 (A37)
    if (curById.has(it.candidate_id)) continue
    if (it.source === 'jira' && current.jira === null) continue
    if (!vanishedCandidateIds.includes(it.candidate_id)) vanishedCandidateIds.push(it.candidate_id)
  }

  // 출처 갱신: 제목·마감이 바뀌었거나 Jira 상태·우선순위·마감이 바뀐 항목
  const prevJira = new Map(prev.jira.map((j) => [j.key, j]))
  const curJira = new Map((current.jira ?? []).map((j) => [j.key, j]))
  const updatedCandidates: Candidate[] = []
  const updatedIds = new Set<string>()
  for (const it of items) {
    if (NO_SOURCE_UPDATE.has(it.status)) continue
    const c = curById.get(it.candidate_id)
    if (!c || updatedIds.has(c.id)) continue
    if (skipSourceUpdate(it, c, current)) continue
    let changed = c.title !== it.title || c.dueDate !== it.due_date
    const key = c.jiraKey ?? it.jira_issue_key
    if (!changed && key && current.jira !== null) {
      const p = prevJira.get(key)
      const n = curJira.get(key)
      changed = !!p && !!n && jiraRefChanged(p, n)
    }
    if (changed) {
      updatedIds.add(c.id)
      updatedCandidates.push(c)
    }
  }

  return { calendarAdded, calendarChanged, calendarRemoved, newCandidates, vanishedCandidateIds, updatedCandidates }
}

function addPatch(map: Map<number, Patch>, id: number, patch: Patch): void {
  map.set(id, { ...(map.get(id) ?? {}), ...patch })
}

/** 원래 값과 같은 필드를 빼고, 빈 패치는 버린다. id 오름차순. */
function finalizeUpdates(items: PlanItem[], patches: Map<number, Patch>): PlanItemUpdate[] {
  const byId = new Map(items.map((it) => [it.id, it]))
  const out: PlanItemUpdate[] = []
  for (const [id, patch] of patches) {
    const orig = byId.get(id)
    if (!orig) continue
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) {
      if ((orig as unknown as Record<string, unknown>)[k] !== v) clean[k] = v
    }
    if (Object.keys(clean).length > 0) out.push({ id, patch: clean as Patch })
  }
  return out.sort((a, b) => a.id - b.id)
}

function applyPatches(items: PlanItem[], patches: Map<number, Patch>): PlanItem[] {
  return items.map((it) => {
    const p = patches.get(it.id)
    return p ? { ...it, ...p } : { ...it }
  })
}

/** §8.4 반영 계획. DB 를 바꾸지 않고 적용할 변경 목록을 돌려준다. */
export function planRefresh(
  diff: RefreshDiff,
  current: CurrentSources,
  prev: SourceSnapshot,
  items: PlanItem[],
  ctx: RefreshContext
): RefreshPlan {
  const patches = new Map<number, Patch>()
  const curById = new Map(current.candidates.map((c) => [c.id, c]))
  const itemCandidateIds = new Set(items.map((it) => it.candidate_id))

  // 1. 출처 갱신: 제목·마감·점수. rank·상태는 바꾸지 않는다.
  for (const it of items) {
    if (NO_SOURCE_UPDATE.has(it.status)) continue
    const c = curById.get(it.candidate_id)
    if (!c || skipSourceUpdate(it, c, current)) continue
    addPatch(patches, it.id, { title: c.title, due_date: c.dueDate, score: scoreCandidate(c, ctx.today) })
  }

  // 2. 사라진 항목 처리 (A15: 출처 완료 반영 외에는 사용자 결정을 유지한다)
  let completed = 0
  let dropped = 0
  let replaced = 0
  const replaceTargets = new Set<string>()
  const vanished = new Set(diff.vanishedCandidateIds)
  const ordered = [...items].sort((a, b) => a.id - b.id)
  for (const it of ordered) {
    if (!vanished.has(it.candidate_id) || !VANISH_TARGET.has(it.status)) continue
    if (it.source === 'jira' && current.jira === null) continue
    const res = ctx.resolutions[it.candidate_id]

    if (res?.kind === 'replace') {
      const c = res.candidate
      // 대상이 이미 계획 항목이거나 다른 항목이 먼저 가져갔으면 UNIQUE 충돌을 피해 건너뛴다
      if (itemCandidateIds.has(c.id) || replaceTargets.has(c.id)) continue
      replaceTargets.add(c.id)
      addPatch(patches, it.id, {
        candidate_id: c.id,
        source: c.source,
        link: c.link,
        title: c.title,
        due_date: c.dueDate,
        score: scoreCandidate(c, ctx.today)
      })
      replaced++
      continue
    }

    if (it.status === 'suggested') {
      // 사라진 제안 항목은 dropped 가 된다
      addPatch(patches, it.id, {
        status: 'dropped',
        status_note: res?.kind === 'dropped' ? res.note : null
      })
      dropped++
      continue
    }
    if (!res) continue // 해석이 없으면 바꾸지 않는다
    if (res.kind === 'done') {
      addPatch(patches, it.id, { status: 'done' })
      completed++
    } else if (it.status !== 'deferred') {
      // deferred 는 사용자 결정이라 완료 반영만 받는다
      addPatch(patches, it.id, { status: 'dropped', status_note: res.note })
      dropped++
    }
  }

  // 3. 일정 변경 여부: 캘린더를 이번에 봤고 변경이 있을 때만
  const timelineChanged =
    current.calendar !== null &&
    diff.calendarAdded.length + diff.calendarChanged.length + diff.calendarRemoved.length > 0

  // 4. 새 후보는 suggested 로만 넣는다 (A19). replace 대상과 기존 항목은 뺀다.
  const fresh = diff.newCandidates.filter((c) => !replaceTargets.has(c.id) && !itemCandidateIds.has(c.id))
  const inserts: NewPlanItem[] = rankCandidates(fresh, ctx.today).map(({ candidate: c, score }) => ({
    candidate_id: c.id,
    source: c.source,
    title: c.title,
    link: c.link,
    jira_issue_key: c.jiraKey,
    project_id: c.projectId,
    due_date: c.dueDate,
    score,
    rank: null,
    slot_start: null,
    slot_end: null,
    pinned: false,
    added_by: 'refresh',
    urgent: isUrgent(c, ctx.today),
    status: 'suggested',
    status_note: null
  }))

  const updates = finalizeUpdates(items, patches)

  // 5. 타임라인 전후의 current·다음 future 블록 비교 (E.3.1)
  const before = buildTimeline({
    calendar: prev.calendar, dayStart: ctx.dayStart, nowHHmm: ctx.nowHHmm, workEnd: ctx.workEnd,
    items, today: ctx.today, closed: false
  })
  const after = buildTimeline({
    calendar: current.calendar ?? prev.calendar, dayStart: ctx.dayStart, nowHHmm: ctx.nowHHmm, workEnd: ctx.workEnd,
    items: applyPatches(items, patches), today: ctx.today, closed: false
  })
  const currentOrNextChanged = !sameCurrentAndNext(currentAndNextBlocks(before), currentAndNextBlocks(after))

  // 6. 스냅샷: 조회하지 못한 출처는 이전 값을 유지한다
  const seenIds = new Set(prev.seenCandidateIds)
  for (const c of current.candidates) seenIds.add(c.id)
  const snapshot: SourceSnapshot = {
    calendar: current.calendar !== null ? current.calendar.map((e) => ({ ...e })) : prev.calendar.map((e) => ({ ...e })),
    jira: current.jira !== null ? current.jira.map((j) => ({ ...j })) : prev.jira.map((j) => ({ ...j })),
    seenCandidateIds: [...seenIds].sort(compareId),
    takenAt: `${ctx.today} ${ctx.nowHHmm}:00`
  }

  return {
    inserts,
    updates,
    snapshot,
    summary: {
      calendarAdded: diff.calendarAdded.length,
      calendarChanged: diff.calendarChanged.length,
      calendarRemoved: diff.calendarRemoved.length,
      suggested: inserts.length,
      urgentSuggestedIds: inserts.filter((i) => i.urgent).map((i) => i.candidate_id),
      completed,
      dropped,
      replaced,
      timelineChanged,
      currentOrNextChanged
    }
  }
}

/** 계획 항목끼리의 점수 순서. 점수 내림차순 → 마감 → 출처 → candidate_id. */
function compareItemsByScore(a: PlanItem, b: PlanItem): number {
  if (a.score !== b.score) return b.score - a.score
  const due = compareDue(a.due_date, b.due_date)
  if (due !== 0) return due
  const src = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]
  if (src !== 0) return src
  return compareId(a.candidate_id, b.candidate_id)
}

type BlockEntry = Extract<TimelineEntry, { kind: 'block' }>

/** current 블록과 첫 future 블록. 없으면 null. */
function currentAndNextBlocks(t: DayTimeline): { current: BlockEntry | null; next: BlockEntry | null } {
  let current: BlockEntry | null = null
  let next: BlockEntry | null = null
  for (const e of t.entries) {
    if (e.kind !== 'block') continue
    if (e.state === 'current') current = e
    else if (e.state === 'future' && next === null) next = e
  }
  return { current, next }
}

/** E.3.1 비교 키. current 는 end·itemId, next 는 start·end·itemId. */
function sameCurrentAndNext(
  a: ReturnType<typeof currentAndNextBlocks>,
  b: ReturnType<typeof currentAndNextBlocks>
): boolean {
  const cur =
    a.current === null || b.current === null
      ? a.current === b.current
      : a.current.end === b.current.end && a.current.itemId === b.current.itemId
  const next =
    a.next === null || b.next === null
      ? a.next === b.next
      : a.next.start === b.next.start && a.next.end === b.next.end && a.next.itemId === b.next.itemId
  return cur && next
}

/**
 * B.4 제안 수락·후보 추가 뒤 순위 재계산. planned 항목은 점수 순서로 rank 를 다시 매긴다.
 * in_progress 항목은 rank 를 유지하고, 그 번호는 건너뛴다.
 */
export function rerank(items: PlanItem[]): PlanItemUpdate[] {
  const patches = new Map<number, Patch>()
  const taken = new Set(
    items.filter((it) => it.status === 'in_progress' && it.rank !== null).map((it) => it.rank as number)
  )
  const planned = items.filter((it) => it.status === 'planned').sort(compareItemsByScore)
  let next = 1
  for (const it of planned) {
    while (taken.has(next)) next++
    addPatch(patches, it.id, { rank: next })
    next++
  }
  return finalizeUpdates(items, patches)
}

/**
 * B.4 지금 집중. 대상을 rank 1 로 둔다. planned 면 in_progress 로 바꾼다.
 * 다른 활성 항목은 기존 순서를 유지하고 rank 를 2부터 다시 매긴다.
 * 대상이 없거나 활성 항목이 아니면 빈 목록이다.
 */
export function focusUpdates(items: PlanItem[], itemId: number): PlanItemUpdate[] {
  const target = items.find((it) => it.id === itemId)
  if (!target || !ACTIVE_STATUSES.has(target.status)) return []
  const patches = new Map<number, Patch>()
  addPatch(patches, target.id, target.status === 'planned' ? { rank: 1, status: 'in_progress' } : { rank: 1 })
  const others = items.filter((it) => it.id !== itemId && ACTIVE_STATUSES.has(it.status)).sort(compareByRank)
  others.forEach((it, idx) => addPatch(patches, it.id, { rank: idx + 2 }))
  return finalizeUpdates(items, patches)
}

// ── 최신화 알림 (A21, 부록 E.3) ──

/** 긴급 제안 알림의 최신화 1회당 최대 건수 (E.9). */
const URGENT_NOTICE_LIMIT = 3
const TITLE_LIMIT = 20

/** 종일이 아닌 일정 중 start ≤ now < end 인 것이 있으면 참. */
export function isInMeeting(calendar: CalendarRef[], nowHHmm: string): boolean {
  const now = toMinutes(nowHHmm)
  if (now === null) return false
  return calendar.some((e) => {
    if (e.allDay) return false
    const s = toMinutes(e.start)
    const en = toMinutes(e.end)
    return s !== null && en !== null && s <= now && now < en
  })
}

/** 'HH:mm' → 30분 내림 'HHmm'. 14:42 → '1430'. */
export function bucketOf(nowHHmm: string): string {
  const v = toMinutes(nowHHmm) ?? 0
  const b = Math.floor(v / 30) * 30
  return `${String(Math.floor(b / 60)).padStart(2, '0')}${String(b % 60).padStart(2, '0')}`
}

/** A21. E.3.2 판정. */
export function shouldNotifyPlanUpdate(summary: RefreshSummary, ctx: NotifyContext): boolean {
  if (!ctx.refreshNotify || ctx.inMeeting) return false
  return summary.currentOrNextChanged || summary.urgentSuggestedIds.length > 0
}

/** 20자를 넘으면 자르고 '…' 를 붙인다. */
function clip(text: string): string {
  const chars = Array.from(text)
  return chars.length > TITLE_LIMIT ? `${chars.slice(0, TITLE_LIMIT).join('')}…` : text
}

/** 'YYYY-MM-DD' 두 날짜의 일수 차이 (b − a). */
function daysBetween(a: string, b: string): number {
  const toUtc = (d: string): number => {
    const [y, m, day] = d.split('-').map(Number)
    return Date.UTC(y, m - 1, day)
  }
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000)
}

/** slot 알림의 일정 조각. 일정 변경이 없으면 null. */
function calendarPiece(input: NoticeInput): string | null {
  const { calendarAdded, calendarChanged, calendarRemoved } = input.diff
  const total = calendarAdded.length + calendarChanged.length + calendarRemoved.length
  let piece: string | null = null
  if (calendarAdded[0]) piece = `${calendarAdded[0].start} ${clip(calendarAdded[0].title)} 추가`
  else if (calendarChanged[0]) piece = `${calendarChanged[0].start} ${clip(calendarChanged[0].title)} 변경`
  else if (calendarRemoved[0]) piece = `${calendarRemoved[0].start} ${clip(calendarRemoved[0].title)} 취소`
  if (piece === null) return null
  return total >= 2 ? `${piece} 외 ${total - 1}건` : piece
}

/** slot 알림의 블록 조각. */
function blockPiece(input: NoticeInput): string {
  const { current, next } = currentAndNextBlocks(input.after)
  const titleOf = (id: number | null): string | null => {
    if (id === null) return null
    const it = input.items.find((i) => i.id === id)
    return it ? clip(it.title) : null
  }
  if (next) return `다음 ${next.start}–${next.end} ${titleOf(next.itemId) ?? '빈 블록'}`
  if (current) return `지금 ${titleOf(current.itemId) ?? '빈 블록'} ~${current.end}`
  return '남은 블록 없음'
}

/** urgent 알림 본문. 대상을 찾지 못하면 null. */
function urgentBody(input: NoticeInput, candidateId: string): string | null {
  const it = input.items.find((i) => i.candidate_id === candidateId)
  const c = it ? null : input.diff.newCandidates.find((x) => x.id === candidateId)
  if (!it && !c) return null
  const key = it ? it.jira_issue_key : (c as Candidate).jiraKey
  const title = it ? it.title : (c as Candidate).title
  const due = it ? it.due_date : (c as Candidate).dueDate
  const label = key ?? clip(title)
  let reason = '우선순위 최상'
  if (due !== null && due === input.today) reason = '오늘 마감'
  else if (due !== null && due < input.today) reason = `${daysBetween(due, input.today)}일 지남`
  return `${label} ${reason}`
}

/** A21. E.3.2~E.3.5 알림 후보. slot 최대 1건 + urgent 최대 3건. */
export function buildPlanUpdateNotices(input: NoticeInput): PlanUpdateNotice[] {
  if (!shouldNotifyPlanUpdate(input.summary, input.ctx)) return []
  const out: PlanUpdateNotice[] = []
  if (input.summary.currentOrNextChanged) {
    const bucket = bucketOf(input.nowHHmm)
    const pieces = [calendarPiece(input), blockPiece(input)].filter((p): p is string => p !== null)
    out.push({
      kind: 'slot',
      eventKey: `plan_update:${input.today}:${bucket}`,
      refId: bucket,
      title: '계획 변경',
      body: pieces.join(' · '),
      focus: { kind: 'timeline' }
    })
  }
  let urgent = 0
  for (const id of input.summary.urgentSuggestedIds) {
    if (urgent >= URGENT_NOTICE_LIMIT) break
    const body = urgentBody(input, id)
    if (body === null) continue
    out.push({
      kind: 'urgent',
      eventKey: `plan_update:${input.today}:urgent:${id}`,
      refId: `urgent:${id}`,
      title: '새로 들어온 일',
      body,
      focus: { kind: 'inbox' }
    })
    urgent++
  }
  return out
}
