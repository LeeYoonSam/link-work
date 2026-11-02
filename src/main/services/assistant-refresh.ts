// 최신화 변경 계산·반영 계획 (docs/ASSISTANT.md §8.3·§8.4, 부록 B.4·B.7). 순수 모듈이다 (A3·A14).
import { isUrgent } from './assistant-candidates'
import { compareDue, compareId, rankCandidates, scoreCandidate, SOURCE_ORDER } from './assistant-score'
import { ACTIVE_STATUSES, buildTimeline, compareByRank } from './assistant-slots'
import type {
  CalendarRef,
  DayTimeline,
  Candidate,
  CurrentSources,
  JiraSnapshotRef,
  NewPlanItem,
  PlanItem,
  PlanItemStatus,
  PlanItemUpdate,
  RefreshContext,
  RefreshDiff,
  RefreshPlan,
  SourceSnapshot
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

  // 5. 타임라인 전후의 current·다음 future 블록 itemId 비교
  const before = buildTimeline({
    calendar: prev.calendar, dayStart: ctx.dayStart, nowHHmm: ctx.nowHHmm, workEnd: ctx.workEnd,
    items, today: ctx.today, closed: false
  })
  const after = buildTimeline({
    calendar: current.calendar ?? prev.calendar, dayStart: ctx.dayStart, nowHHmm: ctx.nowHHmm, workEnd: ctx.workEnd,
    items: applyPatches(items, patches), today: ctx.today, closed: false
  })
  const a = currentAndNextItemIds(before)
  const b = currentAndNextItemIds(after)
  const currentOrNextChanged = a[0] !== b[0] || a[1] !== b[1]

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

/** current 블록과 첫 future 블록의 itemId. 블록이 없으면 null. */
function currentAndNextItemIds(t: DayTimeline): [number | null, number | null] {
  let cur: number | null = null
  let next: number | null = null
  let nextSeen = false
  for (const e of t.entries) {
    if (e.kind !== 'block') continue
    if (e.state === 'current') cur = e.itemId
    else if (e.state === 'future' && !nextSeen) {
      next = e.itemId
      nextSeen = true
    }
  }
  return [cur, next]
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
