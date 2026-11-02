import { app } from 'electron'
import { getDatabase } from '../db/database'
import { getTodayEvents } from './google-calendar'
import { isHeadlessAvailable } from './ai-headless'
import { collectSources, resolveVanished, type CollectedSources } from './assistant-sources'
import { renderRuleBriefing, requestLlmBriefing, type BriefingInput } from './assistant-briefing'
import { logicalDate, toLocalDateTime, toHHmm } from './assistant-day'
import { buildStartPlanItems, buildTimeline, roundUpToQuarter } from './assistant-slots'
import { diffSources, focusUpdates, planRefresh, rerank } from './assistant-refresh'
import { isUrgent } from './assistant-candidates'
import { rankCandidates, scoreCandidate } from './assistant-score'
import {
  applyRefreshPlan,
  closePlan,
  closeStalePlans,
  createPlan,
  getLastPlanBefore,
  getPlanByDate,
  getPlanItem,
  insertEvent,
  insertPlanItems,
  listEventsByDate,
  listPlanItems,
  readAssistantSettings,
  reopenPlan,
  saveWrapupNote,
  setBriefing,
  setBriefingError,
  updatePlanItems,
  writeAssistantSettings
} from './assistant-store'
import type {
  AssistantChangedEvent,
  AssistantSettings,
  Candidate,
  DailyPlan,
  DayTimeline,
  NewPlanItem,
  PlanItem,
  PlanItemStatus,
  PlanItemUpdate,
  SourceSnapshot,
  TodayPayload
} from './assistant-types'

// 비서 흐름 조정 모듈이다. IPC 와 스케줄러가 이 파일만 부른다.
// A2: 이 파일은 비서 테이블과 assistant_* 설정만 쓴다. 원본(projects·tasks·todos·meetings)은 쓰지 않는다.

type Db = ReturnType<typeof getDatabase>

const NO_ACTIVE_PLAN = '근무 중인 오늘 계획이 없습니다. 먼저 하루를 시작하세요.'
const DAY_ALREADY_CLOSED = '오늘 계획은 이미 마감했습니다. 다시 열기를 사용하세요.'
const NO_PLAN_TODAY = '오늘 계획이 없습니다.'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const WRAPUP_MAX = 2000
const SETTABLE_STATUSES: PlanItemStatus[] = ['planned', 'in_progress', 'done', 'deferred', 'dropped']
// 집중 작업으로 정할 수 있는 상태다. 활성 항목만 해당한다 (B.2)
const FOCUSABLE_STATUSES: PlanItemStatus[] = ['planned', 'in_progress']
// 원본이 사라지지 않은 채 다시 계획에 넣을 수 있는 상태
const REVIVABLE_STATUSES: PlanItemStatus[] = ['suggested', 'dismissed', 'dropped', 'deferred']

let changedListener: ((e: AssistantChangedEvent) => void) | null = null
// 마지막 수집 결과. 오늘 화면의 연결 상태·오류 문구에 쓴다
let lastCollected: CollectedSources | null = null
let startDayInFlight: Promise<TodayPayload> | null = null
// 최신화와 사용자 쓰기는 한 줄로 처리한다. 최신화가 수집을 기다리는 사이 사용자가 바꾼 상태를
// 예전에 읽은 항목으로 만든 패치가 덮지 않게 한다 (A15)
let writeChain: Promise<unknown> = Promise.resolve()

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn)
  writeChain = run.catch(() => undefined)
  return run
}
const backgroundTasks = new Set<Promise<void>>()

export function setAssistantChangedListener(fn: ((e: AssistantChangedEvent) => void) | null): void {
  changedListener = fn
}

function emitChanged(e: AssistantChangedEvent): void {
  try {
    changedListener?.(e)
  } catch (err) {
    console.error('[assistant] changed listener', err)
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function emptySnapshot(takenAt: string): SourceSnapshot {
  return { calendar: [], jira: [], seenCandidateIds: [], takenAt }
}

function todayOf(db: Db, now: Date): { settings: AssistantSettings; today: string; at: string } {
  const settings = readAssistantSettings(db)
  const today = logicalDate(now, settings.dayRollover)
  const at = toLocalDateTime(now)
  // A18: 진입점마다 지난 active 계획을 닫는다. 여러 번 실행해도 결과가 같다
  closeStalePlans(db, today, at)
  return { settings, today, at }
}

function missingWrapupDateOf(db: Db, today: string): string | null {
  const last = getLastPlanBefore(db, today)
  if (last && last.closed_by === 'auto' && !last.wrapup_note) return last.plan_date
  return null
}

function safeHeadlessAvailable(): boolean {
  try {
    return isHeadlessAvailable()
  } catch {
    return false
  }
}

async function ensureCollected(db: Db, settings: AssistantSettings, now: Date): Promise<void> {
  if (lastCollected) return
  try {
    // 연결 상태만 알면 된다. local 은 네트워크를 쓰지 않는다
    lastCollected = await collectSources(db, settings, 'local', now)
  } catch (err) {
    console.error('[assistant] collect(local)', err)
  }
}

const EMPTY_TIMELINE: DayTimeline = { entries: [], freeMinutesLeft: 0, focusItemId: null, unplacedDeadlineItemIds: [] }

// 타임라인의 '지금'. 날짜 경계 전 새벽은 논리 날짜가 전날이다. 이때 전날 블록은 모두 지났으므로 '24:00' 을 쓴다
function timelineNow(now: Date, today: string): string {
  return toLocalDateTime(now).slice(0, 10) > today ? '24:00' : toHHmm(now)
}

// 타임라인 시작 시각. 계획의 started_at('YYYY-MM-DD HH:mm:ss') 을 15분 단위로 올린다 (A23-1)
function dayStartOf(plan: DailyPlan): string {
  return roundUpToQuarter(plan.started_at.slice(11, 16))
}

// 타임라인 입력의 calendar 는 계획 스냅샷의 일정이다 (B.7)
function timelineOf(
  plan: DailyPlan | null,
  items: PlanItem[],
  settings: AssistantSettings,
  today: string,
  now: Date
): DayTimeline {
  if (!plan) return EMPTY_TIMELINE
  return buildTimeline({
    calendar: plan.source_snapshot?.calendar ?? [],
    dayStart: dayStartOf(plan),
    nowHHmm: timelineNow(now, today),
    workEnd: settings.workEnd,
    items,
    today,
    closed: plan.status === 'closed'
  })
}

function buildPayload(db: Db, settings: AssistantSettings, today: string, now: Date): TodayPayload {
  const plan = getPlanByDate(db, today)
  const items = plan ? listPlanItems(db, plan.id) : []
  return {
    logicalDate: today,
    plan,
    items,
    timeline: timelineOf(plan, items, settings, today, now),
    events: listEventsByDate(db, today),
    settings,
    missingWrapupDate: missingWrapupDateOf(db, today),
    aiAvailable: safeHeadlessAvailable(),
    jiraConnected: lastCollected?.jiraConnected ?? false,
    calendarConnected: lastCollected?.calendarConnected ?? false,
    jiraTruncated: lastCollected?.jiraTruncated ?? false,
    lastErrors: lastCollected?.errors ?? []
  }
}

function requireActivePlan(db: Db, today: string): DailyPlan {
  const plan = getPlanByDate(db, today)
  if (!plan || plan.status !== 'active') throw new Error(NO_ACTIVE_PLAN)
  return plan
}

function requireItemOfPlan(db: Db, itemId: unknown, plan: DailyPlan): PlanItem {
  if (typeof itemId !== 'number' || !Number.isInteger(itemId)) throw new Error('항목 ID 가 올바르지 않습니다.')
  const item = getPlanItem(db, itemId)
  if (!item || item.plan_id !== plan.id) throw new Error('오늘 계획의 항목이 아닙니다.')
  return item
}

function briefingInputOf(
  db: Db,
  plan: DailyPlan,
  settings: AssistantSettings,
  today: string,
  now: Date,
  errors: string[]
): BriefingInput {
  const items = listPlanItems(db, plan.id)
  return {
    logicalDate: today,
    plan,
    items,
    calendar: plan.source_snapshot?.calendar ?? [],
    timeline: timelineOf(plan, items, settings, today, now),
    errors
  }
}

async function runLlmBriefing(planId: number, input: BriefingInput, settings: AssistantSettings): Promise<void> {
  try {
    const r = await requestLlmBriefing(input, settings.llmModel)
    const db = getDatabase()
    if (r.ok) {
      setBriefing(db, planId, { text: r.markdown, source: 'llm', model: r.model, at: toLocalDateTime(new Date()) })
    } else {
      setBriefingError(db, planId, r.error)
    }
  } catch (err) {
    try {
      setBriefingError(getDatabase(), planId, toMessage(err))
    } catch {
      // DB 가 닫혔으면 기록을 건너뛴다
    }
  }
}

// A8: LLM 브리핑은 계획 생성을 막지 않는다. 결과를 기다리지 않는다
function startBackgroundBriefing(planId: number, input: BriefingInput, settings: AssistantSettings, date: string): void {
  if (!settings.llmEnabled || !safeHeadlessAvailable()) return
  const task = runLlmBriefing(planId, input, settings).finally(() => {
    backgroundTasks.delete(task)
    emitChanged({ date, reason: 'briefing' })
  })
  backgroundTasks.add(task)
}

/** 테스트용: 진행 중인 백그라운드 브리핑이 끝날 때까지 기다린다 */
export async function waitForAssistantBackground(): Promise<void> {
  while (backgroundTasks.size > 0) {
    await Promise.allSettled([...backgroundTasks])
  }
}

export async function getToday(now: Date = new Date()): Promise<TodayPayload> {
  const db = getDatabase()
  const { settings, today } = todayOf(db, now)
  await ensureCollected(db, settings, now)
  return buildPayload(db, settings, today, now)
}

export function startDay(now: Date = new Date()): Promise<TodayPayload> {
  // 버튼 연타·트레이 동시 호출에서 계획을 두 번 만들지 않는다
  if (startDayInFlight) return startDayInFlight
  const p = startDayImpl(now).finally(() => {
    startDayInFlight = null
  })
  startDayInFlight = p
  return p
}

async function startDayImpl(now: Date): Promise<TodayPayload> {
  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)

  const existing = getPlanByDate(db, today)
  if (existing?.status === 'active') return buildPayload(db, settings, today, now)
  if (existing?.status === 'closed') throw new Error(DAY_ALREADY_CLOSED)

  const sources = await collectSources(db, settings, 'full', now)
  lastCollected = sources

  const items = buildStartPlanItems(sources.candidates, today, settings.planSize)
  const snapshot: SourceSnapshot = {
    calendar: sources.calendar ?? [],
    jira: sources.jira ?? [],
    seenCandidateIds: sources.candidates.map((c) => c.id),
    takenAt: at
  }
  const plan = createPlan(db, { plan_date: today, started_at: at, source_snapshot: snapshot, items })

  // A8: 규칙 브리핑을 먼저 저장한다. 스냅샷 calendar 는 sources.calendar 와 같다
  const input = briefingInputOf(db, plan, settings, today, now, sources.errors)
  setBriefing(db, plan.id, { text: renderRuleBriefing(input), source: 'rules', model: null, at })

  const payload = buildPayload(db, settings, today, now)
  emitChanged({ date: today, reason: 'day' })
  startBackgroundBriefing(plan.id, input, settings, today)
  return payload
}

export function closeDay(note?: string | null, now: Date = new Date()): Promise<TodayPayload> {
  return serialized(() => closeDayImpl(note, now))
}

async function closeDayImpl(note: string | null | undefined, now: Date): Promise<TodayPayload> {
  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)
  const plan = requireActivePlan(db, today)
  const cleanNote = normalizeNote(note ?? null)
  closePlan(db, plan.id, 'button', at, cleanNote)
  emitChanged({ date: today, reason: 'day' })
  return buildPayload(db, settings, today, now)
}

export function reopenDay(now: Date = new Date()): Promise<TodayPayload> {
  return serialized(() => reopenDayImpl(now))
}

async function reopenDayImpl(now: Date): Promise<TodayPayload> {
  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)
  const plan = getPlanByDate(db, today)
  if (!plan) throw new Error(NO_PLAN_TODAY)
  if (plan.status === 'closed') {
    reopenPlan(db, plan.id, at)
    emitChanged({ date: today, reason: 'day' })
  }
  return buildPayload(db, settings, today, now)
}

function normalizeNote(note: unknown): string | null {
  if (note === null || note === undefined) return null
  if (typeof note !== 'string') throw new Error('메모 형식이 올바르지 않습니다.')
  const trimmed = note.trim()
  if (trimmed.length > WRAPUP_MAX) throw new Error(`메모는 ${WRAPUP_MAX}자 이하로 입력하세요.`)
  return trimmed.length > 0 ? trimmed : null
}

export async function saveWrapup(note: string, planDate: string, now: Date = new Date()): Promise<DailyPlan> {
  if (typeof planDate !== 'string' || !DATE_RE.test(planDate)) throw new Error('날짜 형식이 올바르지 않습니다.')
  const clean = normalizeNote(note)
  if (clean === null) throw new Error('메모를 입력하세요.')
  const db = getDatabase()
  const saved = saveWrapupNote(db, planDate, clean, toLocalDateTime(now))
  if (!saved) throw new Error('해당 날짜의 계획이 없습니다.')
  return saved
}

export function runRefresh(mode: 'full' | 'local', now: Date = new Date()): Promise<TodayPayload | null> {
  return serialized(() => runRefreshImpl(mode, now))
}

async function runRefreshImpl(mode: 'full' | 'local', now: Date): Promise<TodayPayload | null> {
  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)
  if (!settings.enabled) return null
  const plan = getPlanByDate(db, today)
  // 최신화는 근무 중에만 한다. 계획이 없으면 반영할 곳이 없다
  if (!plan || plan.status !== 'active') return null

  const sources = await collectSources(db, settings, mode, now)
  if (mode === 'full' || !lastCollected) lastCollected = sources

  // 수집을 기다리는 사이 계획이 닫혔으면 반영하지 않는다
  const fresh = getPlanByDate(db, today)
  if (!fresh || fresh.status !== 'active' || fresh.id !== plan.id) return null

  const items = listPlanItems(db, plan.id)
  const prev = fresh.source_snapshot ?? emptySnapshot(fresh.started_at)
  const diff = diffSources(prev, sources, items)
  // local 최신화는 네트워크를 쓰지 않는다. 사라진 Jira 항목의 상태 확인도 하지 않는다
  const resolutions = await resolveVanished(db, diff.vanishedCandidateIds, sources.candidates, {
    network: mode === 'full'
  })
  const refreshPlan = planRefresh(diff, sources, prev, items, {
    today,
    nowHHmm: timelineNow(now, today),
    workEnd: settings.workEnd,
    dayStart: dayStartOf(fresh),
    resolutions
  })

  // planRefresh 의 takenAt 은 논리 날짜 기준이다. 날짜 경계 전 새벽에는 실제 날짜와 다르므로 실제 시각으로 덮어쓴다
  refreshPlan.snapshot = { ...refreshPlan.snapshot, takenAt: at }
  applyRefreshPlan(db, plan.id, refreshPlan, at)

  const s = refreshPlan.summary
  const hasChange =
    refreshPlan.inserts.length > 0 ||
    refreshPlan.updates.length > 0 ||
    s.calendarAdded + s.calendarChanged + s.calendarRemoved > 0
  if (hasChange) logPlanUpdate(db, today, at, JSON.stringify(s))

  if (hasChange || mode === 'full') emitChanged({ date: today, reason: 'refresh' })
  return buildPayload(db, settings, today, now)
}

// plan_update 는 알림 없이 기록만 한다(status 'logged'). 같은 초에 두 번 돌면 접미어로 키를 나눈다
function logPlanUpdate(db: Db, today: string, at: string, payload: string): void {
  const base = `plan_update:${today}:${at}`
  for (let i = 0; i < 5; i++) {
    const key = i === 0 ? base : `${base}:${i}`
    const ev = insertEvent(db, {
      event_key: key,
      kind: 'plan_update',
      plan_date: today,
      scheduled_at: at,
      fired_at: null,
      status: 'logged',
      ref_id: null,
      payload
    })
    if (ev) return
  }
}

export async function refreshBriefing(now: Date = new Date()): Promise<TodayPayload> {
  const db = getDatabase()
  const { settings, today } = todayOf(db, now)
  const plan = getPlanByDate(db, today)
  if (!plan) throw new Error(NO_PLAN_TODAY)
  if (!settings.llmEnabled) throw new Error('AI 브리핑이 꺼져 있습니다. 비서 설정에서 켜세요.')
  if (!safeHeadlessAvailable()) {
    const msg = 'Claude Code 를 찾을 수 없습니다. 설치와 로그인을 확인하세요.'
    setBriefingError(db, plan.id, msg)
    return buildPayload(db, settings, today, now)
  }
  // 버튼은 결과를 기다린다. 실패해도 규칙 브리핑은 그대로 남는다
  await runLlmBriefing(plan.id, briefingInputOf(db, plan, settings, today, now, lastCollected?.errors ?? []), settings)
  emitChanged({ date: today, reason: 'briefing' })
  return buildPayload(getDatabase(), settings, today, now)
}

export async function listCandidates(now: Date = new Date()): Promise<Candidate[]> {
  const db = getDatabase()
  const { settings, today } = todayOf(db, now)
  const sources = await collectSources(db, settings, 'full', now)
  lastCollected = sources
  const plan = getPlanByDate(db, today)
  const taken = new Set(
    (plan ? listPlanItems(db, plan.id) : [])
      .filter((i) => !REVIVABLE_STATUSES.includes(i.status))
      .map((i) => i.candidate_id)
  )
  return rankCandidates(sources.candidates, today)
    .map((s) => s.candidate)
    .filter((c) => !taken.has(c.id))
}

// 점수 순서로 rank 를 다시 매긴다. in_progress 항목은 rank 를 유지한다 (B.4)
function applyRerank(db: Db, plan: DailyPlan, at: string): void {
  const updates = rerank(listPlanItems(db, plan.id))
  if (updates.length > 0) updatePlanItems(db, updates, at)
}

export function addItem(candidateId: string, now: Date = new Date()): Promise<TodayPayload> {
  return serialized(() => addItemImpl(candidateId, now))
}

async function addItemImpl(candidateId: string, now: Date): Promise<TodayPayload> {
  if (typeof candidateId !== 'string' || candidateId.length === 0 || candidateId.length > 200) {
    throw new Error('후보 ID 가 올바르지 않습니다.')
  }
  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)
  const plan = requireActivePlan(db, today)

  const existing = listPlanItems(db, plan.id).find((i) => i.candidate_id === candidateId)
  if (existing) {
    if (!REVIVABLE_STATUSES.includes(existing.status)) throw new Error('이미 계획에 있는 항목입니다.')
    updatePlanItems(db, [{ id: existing.id, patch: { status: 'planned', status_note: null } }], at)
  } else {
    // local 은 네트워크를 쓰지 않는다. Jira 후보는 '후보 더 보기' 조회의 캐시에서 찾는다
    const sources = await collectSources(db, settings, 'local', now)
    const c = sources.candidates.find((x) => x.id === candidateId)
    if (!c) throw new Error('후보를 찾을 수 없습니다. 후보 목록을 다시 여세요.')
    const item: NewPlanItem = {
      candidate_id: c.id,
      source: c.source,
      title: c.title,
      link: c.link,
      jira_issue_key: c.jiraKey,
      project_id: c.projectId,
      due_date: c.dueDate,
      score: scoreCandidate(c, today),
      rank: null,
      slot_start: null,
      slot_end: null,
      pinned: false,
      added_by: 'user',
      urgent: isUrgent(c, today),
      status: 'planned',
      status_note: null
    }
    insertPlanItems(db, plan.id, [item])
  }

  applyRerank(db, plan, at)
  return buildPayload(db, settings, today, now)
}

export function acceptSuggestion(itemId: number, now: Date = new Date()): Promise<TodayPayload> {
  return serialized(() => acceptSuggestionImpl(itemId, now))
}

async function acceptSuggestionImpl(itemId: number, now: Date): Promise<TodayPayload> {
  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)
  const plan = requireActivePlan(db, today)
  const item = requireItemOfPlan(db, itemId, plan)
  if (item.status !== 'suggested') throw new Error('제안 항목이 아닙니다.')
  updatePlanItems(db, [{ id: item.id, patch: { status: 'planned' } }], at)
  applyRerank(db, plan, at)
  return buildPayload(db, settings, today, now)
}

export function dismissSuggestion(itemId: number, now: Date = new Date()): Promise<TodayPayload> {
  return serialized(() => dismissSuggestionImpl(itemId, now))
}

async function dismissSuggestionImpl(itemId: number, now: Date): Promise<TodayPayload> {
  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)
  const plan = requireActivePlan(db, today)
  const item = requireItemOfPlan(db, itemId, plan)
  if (item.status !== 'suggested') throw new Error('제안 항목이 아닙니다.')
  updatePlanItems(db, [{ id: item.id, patch: { status: 'dismissed' } }], at)
  return buildPayload(db, settings, today, now)
}

export function setItemStatus(
  itemId: number,
  status: PlanItemStatus,
  note?: string | null,
  now: Date = new Date()
): Promise<TodayPayload> {
  return serialized(() => setItemStatusImpl(itemId, status, note, now))
}

async function setItemStatusImpl(
  itemId: number,
  status: PlanItemStatus,
  note: string | null | undefined,
  now: Date
): Promise<TodayPayload> {
  if (!SETTABLE_STATUSES.includes(status)) throw new Error('바꿀 수 없는 상태입니다.')
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 500)) {
    throw new Error('상태 메모가 올바르지 않습니다.')
  }
  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)
  const plan = requireActivePlan(db, today)
  const item = requireItemOfPlan(db, itemId, plan)
  if (item.status === 'suggested' || item.status === 'dismissed') {
    throw new Error('제안 항목은 계획에 추가한 뒤 상태를 바꾸세요.')
  }

  const patch: PlanItemUpdate['patch'] = { status, status_note: note ?? null }
  updatePlanItems(db, [{ id: item.id, patch }], at)

  // 계획으로 되돌아오면 점수 순서에 다시 끼운다. 집중 작업 교체는 타임라인 계산이 반영한다 (B.4)
  const revived = status === 'planned' && (item.status === 'deferred' || item.status === 'dropped')
  if (revived) applyRerank(db, plan, at)
  return buildPayload(db, settings, today, now)
}

export function focusItem(itemId: number, now: Date = new Date()): Promise<TodayPayload> {
  return serialized(() => focusItemImpl(itemId, now))
}

// 대상을 rank 1 로 두고, planned 면 in_progress 로 바꾼다. 다른 활성 항목은 순서를 유지한다 (B.4)
async function focusItemImpl(itemId: number, now: Date): Promise<TodayPayload> {
  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)
  const plan = requireActivePlan(db, today)
  const item = requireItemOfPlan(db, itemId, plan)
  if (!FOCUSABLE_STATUSES.includes(item.status)) {
    throw new Error('계획 중이거나 진행 중인 항목만 지금 집중할 수 있습니다.')
  }
  const updates = focusUpdates(listPlanItems(db, plan.id), item.id)
  if (updates.length > 0) updatePlanItems(db, updates, at)
  return buildPayload(db, settings, today, now)
}

export function getSettings(): AssistantSettings {
  return readAssistantSettings(getDatabase())
}

export function saveSettings(patch: unknown): AssistantSettings {
  const db = getDatabase()
  const before = readAssistantSettings(db)
  const after = writeAssistantSettings(db, patch)
  if (before.openAtLogin !== after.openAtLogin) {
    try {
      app.setLoginItemSettings({ openAtLogin: after.openAtLogin })
    } catch (err) {
      console.error('[assistant] setLoginItemSettings', err)
    }
  }
  return after
}

// 시작 알림 본문 숫자. 로컬 DB(local 수집)와 캘린더 캐시만 쓴다. Jira 를 호출하지 않는다 (§6.5).
// 계약과 달리 async 다. 이유: 수집 모듈과 캘린더 캐시 조회가 async 다.
export async function getStartNudgeContent(
  now: Date = new Date()
): Promise<{ candidateCount: number; eventCount: number }> {
  const db = getDatabase()
  const settings = readAssistantSettings(db)
  let candidateCount = 0
  try {
    const sources = await collectSources(db, settings, 'local', now)
    candidateCount = sources.candidates.length
    if (!lastCollected) lastCollected = sources
  } catch (err) {
    console.error('[assistant] nudge candidates', err)
  }
  let eventCount = 0
  try {
    // notification.ts 가 1분마다 같은 캐시를 데운다. 캐시가 5분 안이면 네트워크를 쓰지 않는다
    const events = await getTodayEvents()
    eventCount = events.filter((e) => !e.allDay).length
  } catch (err) {
    console.error('[assistant] nudge calendar', err)
  }
  return { candidateCount, eventCount }
}
