import { app } from 'electron'
import { z } from 'zod'
import { getDatabase } from '../db/database'
import { getTodayEvents } from './google-calendar'
import { isHeadlessAvailable } from './ai-headless'
import {
  collectMeetingContext,
  collectRecovery,
  collectSources,
  getSourceCheckTimes as getSourcesCheckTimes,
  resolveVanished,
  toMeetingRef,
  type CollectedSources
} from './assistant-sources'
import {
  renderRuleBriefing,
  requestLlmBriefing,
  requestLlmMeetingBriefing,
  requestLlmRecovery,
  type BriefingInput,
  type MeetingLlmInput
} from './assistant-briefing'
import { buildRecovery, recoveryContextOf, recoveryToMarkdown, shouldAutoRecover } from './assistant-recovery'
import { logicalDate, toLocalDateTime, toHHmm } from './assistant-day'
import { buildStartPlanItems, buildTimeline, roundUpToQuarter, workFieldsOf } from './assistant-slots'
import { isGroupItem } from './assistant-worktype'
import {
  buildPlanUpdateNotices,
  diffSources,
  focusUpdates,
  isInMeeting,
  planRefresh,
  rerank
} from './assistant-refresh'
import {
  buildCommandContext,
  COMMAND_INSTRUCTION_MAX,
  COMMAND_OPS_MAX,
  COMMAND_TITLE_MAX,
  CommandOpSchema,
  describeCommandOp,
  interpretCommandRule,
  nextManualCandidateId,
  normalizeCommandOps,
  normalizeCommandText,
  toManualCandidate
} from './assistant-command'
import { requestLlmCommand } from './assistant-command-llm'
import { computeDueMeetingBriefings } from './assistant-schedule'
import { buildMeetingBriefing, hasMeetingContext, meetingNoticeText } from './assistant-meeting'
import { isExcludedCandidate, isUrgent } from './assistant-candidates'
import { rankCandidates, scoreCandidate } from './assistant-score'
import {
  applyRefreshPlan,
  closePlan,
  closeStalePlans,
  createPlan,
  deleteExclusions,
  getEventById,
  getLastPlanBefore,
  getPlanByDate,
  getPlanItem,
  insertEvent,
  insertPlanItems,
  listEventsByDate,
  listExclusions,
  listPlanItems,
  readAssistantSettings,
  reopenPlan,
  saveWrapupNote,
  setBriefing,
  setBriefingError,
  setBriefingInstruction,
  setRecovery,
  updateEventPayload,
  updatePlanItems,
  upsertExclusion,
  writeAssistantSettings
} from './assistant-store'
import type {
  AssistantChangedEvent,
  AssistantSettings,
  AutoRefreshOutcome,
  Candidate,
  CandidateSource,
  CommandApplyOutcome,
  CommandContext,
  CommandInterpretation,
  CommandOp,
  CommandOpResult,
  DailyPlan,
  DayTimeline,
  MeetingBriefingPayload,
  MeetingRef,
  NewPlanItem,
  PlanItem,
  PlanItemStatus,
  PlanItemUpdate,
  PlanUpdateRecord,
  RecoveryState,
  RefreshDiff,
  RefreshMode,
  RefreshSummary,
  SentMeetingNotice,
  SentPlanUpdateNotice,
  SourceCheckTimes,
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
// 계속 제외할 수 있는 출처다. 액션아이템은 자동으로 들어가지 않고, todo·임시는 사용자가 만든 일이다 (M4)
const EXCLUDABLE_SOURCES: CandidateSource[] = ['jira', 'task']

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

// A32: 헤드리스 LLM 은 한 줄로 실행한다. ai-headless 잠금이 두 번째 실행을 BUSY 로 실패시키지 않게 한다
let llmChain: Promise<unknown> = Promise.resolve()

function llmSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = llmChain.then(fn)
  llmChain = run.catch(() => undefined)
  return run
}

// 맥락 복구 job. 동시에 1개만 돈다. 상태는 메모리에만 둔다 (F.6)
let recoveryJob: Promise<void> | null = null
let recoveryState: { date: string | null; inFlight: boolean; error: string | null } = {
  date: null,
  inFlight: false,
  error: null
}

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
    lastErrors: lastCollected?.errors ?? [],
    recovery:
      recoveryState.date === today
        ? { inFlight: recoveryState.inFlight, error: recoveryState.error }
        : { inFlight: false, error: null },
    exclusions: listExclusions(db)
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
    errors,
    // G.7: 저장된 브리핑 지시. 하루 시작·다시 생성·명령 적용이 모두 이 1곳을 거친다
    instruction: plan.briefing_instruction ?? null
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
  // 줄에 동기로 선다. 하루 시작 때 복구 LLM 보다 먼저 실행된다 (F.5)
  const task = llmSerialized(() => runLlmBriefing(planId, input, settings)).finally(() => {
    backgroundTasks.delete(task)
    emitChanged({ date, reason: 'briefing' })
  })
  backgroundTasks.add(task)
}

// 맥락 복구 job 본문 (F.9.7). 규칙 본문을 먼저 저장하고 LLM 은 그 뒤다.
// A30: 모든 예외를 여기서 잡는다. throw 하지 않는다
async function runRecoveryJob(
  db: Db,
  settings: AssistantSettings,
  today: string,
  now: Date,
  plan: DailyPlan
): Promise<void> {
  recoveryState = { date: today, inFlight: true, error: null }
  const at = toLocalDateTime(now)
  try {
    const lastPlan = getLastPlanBefore(db, today)
    const lastItems = lastPlan ? listPlanItems(db, lastPlan.id) : []
    const ctx = recoveryContextOf({ today, lastPlan })
    const input = await collectRecovery(db, settings, ctx, lastItems)
    const sections = buildRecovery(input)
    // 수집 중 하루가 닫혀도 같은 plan_id 행에 쓴다
    setRecovery(getDatabase(), plan.id, { text: recoveryToMarkdown(sections, ctx), source: 'rules', at })
    emitChanged({ date: today, reason: 'recovery' })

    if (settings.llmEnabled && safeHeadlessAvailable()) {
      const r = await llmSerialized(() => requestLlmRecovery({ ctx, sections }, settings.llmModel))
      if (r.ok) setRecovery(getDatabase(), plan.id, { text: r.markdown, source: 'llm', at })
      else recoveryState.error = r.error
    }
  } catch (err) {
    console.error('[assistant] recovery', err)
    recoveryState.error = toMessage(err)
  } finally {
    recoveryState.inFlight = false
    emitChanged({ date: today, reason: 'recovery' })
  }
}

function startRecoveryJob(db: Db, settings: AssistantSettings, today: string, now: Date, plan: DailyPlan): Promise<void> {
  const job: Promise<void> = runRecoveryJob(db, settings, today, now, plan)
    .catch(() => undefined)
    .finally(() => {
      if (recoveryJob === job) recoveryJob = null
    })
  recoveryJob = job
  return job
}

// A29: 자동 맥락 복구. 결과를 기다리지 않는다. 진행 중인 job 이 있으면 건너뛴다 (F.2).
// A30: 판정 실패도 하루 시작을 막지 않는다
function maybeStartAutoRecovery(db: Db, settings: AssistantSettings, today: string, now: Date, plan: DailyPlan): void {
  try {
    if (recoveryJob) return
    // 오늘 계획은 plan_date < today 가 아니므로 createPlan 뒤에 읽어도 결과가 같다
    const lastPlan = getLastPlanBefore(db, today)
    if (shouldAutoRecover(recoveryContextOf({ today, lastPlan })) === null) return
    void startRecoveryJob(db, settings, today, now, plan)
  } catch (err) {
    console.error('[assistant] auto recovery', err)
  }
}

/** 테스트용: 현재 맥락 복구 상태 */
export function getRecoveryState(): RecoveryState {
  return { inFlight: recoveryState.inFlight, error: recoveryState.error }
}

/**
 * 수동 맥락 복구 (F.2). 조건과 무관하게 만든다. 오늘 계획이 없으면 throw 한다.
 * 진행 중인 job 이 있으면 새로 만들지 않고 그것을 기다린다. 규칙 저장과 LLM 완료까지 기다린다.
 */
export async function generateRecovery(now: Date = new Date()): Promise<TodayPayload> {
  const db = getDatabase()
  const { settings, today } = todayOf(db, now)
  const plan = getPlanByDate(db, today)
  if (!plan) throw new Error(NO_PLAN_TODAY)
  // 다른 날짜의 job 이 남아 있으면 끝난 뒤 오늘 job 을 새로 만든다
  if (recoveryJob && recoveryState.date !== today) await recoveryJob
  if (recoveryJob) await recoveryJob
  else await startRecoveryJob(db, settings, today, now, plan)
  return buildPayload(getDatabase(), settings, today, now)
}

/** 테스트용: 진행 중인 백그라운드 브리핑·회의 브리핑 LLM·맥락 복구가 끝날 때까지 기다린다 */
export async function waitForAssistantBackground(): Promise<void> {
  while (backgroundTasks.size > 0 || recoveryJob) {
    await Promise.allSettled([...backgroundTasks, ...(recoveryJob ? [recoveryJob] : [])])
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

  // A57·A58: 액션아이템과 계속 제외 후보는 넣지 않는다
  const items = buildStartPlanItems(sources.candidates, today, settings.planSize, listExclusions(db))
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

  emitChanged({ date: today, reason: 'day' })

  maybeStartAutoRecovery(db, settings, today, now, plan)

  // payload 는 job 시작 뒤에 만든다. recovery.inFlight 가 true 다
  const payload = buildPayload(db, settings, today, now)
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

export function runRefresh(mode: RefreshMode, now: Date = new Date()): Promise<TodayPayload | null> {
  // 알림 후보를 만들지 않는다. IPC·앱 내부 변경이 쓴다 (E.2.7)
  return serialized(async () => (await runRefreshImpl(mode, now, false))?.today ?? null)
}

export function runAutoRefresh(mode: RefreshMode, now: Date = new Date()): Promise<AutoRefreshOutcome | null> {
  // 알림 후보를 INSERT 한 뒤 돌려준다. 틱·깨어남이 쓴다 (E.3.6)
  return serialized(() => runRefreshImpl(mode, now, true))
}

export function getSourceCheckTimes(): SourceCheckTimes {
  return getSourcesCheckTimes()
}

/**
 * 오늘 화면의 연결 상태·오류 문구 기준을 갱신한다 (E.2.6 갱신분).
 * full 은 통째로 바꾼다. local 은 바꾸지 않는다. calendar·jira 는 보지 않은 출처의 오류를 이전 값으로 유지한다.
 */
function mergeCollected(prev: CollectedSources | null, next: CollectedSources, mode: RefreshMode): CollectedSources {
  if (!prev || mode === 'full') return next
  if (mode === 'local') return prev
  if (mode === 'calendar') {
    const jiraErrors = prev.jiraErrors ?? []
    return { ...next, jiraErrors, jiraTruncated: prev.jiraTruncated, errors: [...next.calendarErrors, ...jiraErrors] }
  }
  const calendarErrors = prev.calendarErrors ?? []
  return { ...next, calendarErrors, errors: [...calendarErrors, ...next.jiraErrors] }
}

async function runRefreshImpl(mode: RefreshMode, now: Date, notify: boolean): Promise<AutoRefreshOutcome | null> {
  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)
  if (!settings.enabled) return null
  const plan = getPlanByDate(db, today)
  // 최신화는 근무 중에만 한다. 계획이 없으면 반영할 곳이 없다
  if (!plan || plan.status !== 'active') return null

  const sources = await collectSources(db, settings, mode, now)
  lastCollected = mergeCollected(lastCollected, sources, mode)

  // 수집을 기다리는 사이 계획이 닫혔으면 반영하지 않는다
  const fresh = getPlanByDate(db, today)
  if (!fresh || fresh.status !== 'active' || fresh.id !== plan.id) return null

  const items = listPlanItems(db, plan.id)
  const prev = fresh.source_snapshot ?? emptySnapshot(fresh.started_at)
  const diff = diffSources(prev, sources, items)
  // Jira 를 보지 않는 mode 는 사라진 Jira 항목의 상태 확인에 네트워크를 쓰지 않는다
  const resolutions = await resolveVanished(db, diff.vanishedCandidateIds, sources.candidates, {
    network: mode === 'full' || mode === 'jira'
  })
  const nowHHmm = timelineNow(now, today)
  const refreshPlan = planRefresh(diff, sources, prev, items, {
    today,
    nowHHmm,
    workEnd: settings.workEnd,
    dayStart: dayStartOf(fresh),
    resolutions,
    // A58: 계속 제외 후보는 새 제안에 넣지 않는다
    exclusions: listExclusions(db)
  })

  // planRefresh 의 takenAt 은 논리 날짜 기준이다. 날짜 경계 전 새벽에는 실제 날짜와 다르므로 실제 시각으로 덮어쓴다
  refreshPlan.snapshot = { ...refreshPlan.snapshot, takenAt: at }
  applyRefreshPlan(db, plan.id, refreshPlan, at)

  const s = refreshPlan.summary
  const hasChange =
    refreshPlan.inserts.length > 0 ||
    refreshPlan.updates.length > 0 ||
    s.calendarAdded + s.calendarChanged + s.calendarRemoved > 0

  const notices: SentPlanUpdateNotice[] = []
  if (notify && hasChange) notices.push(...insertPlanUpdateNotices(db, diff, s, settings, today, at, nowHHmm, now))

  if (hasChange) {
    const notified = [...new Set(notices.map((n) => n.kind))]
    const record: PlanUpdateRecord = { ...s, notified }
    logPlanUpdate(db, today, at, JSON.stringify(record))
  }

  // 자동 최신화는 변경이 없으면 알리지 않는다. 수동 full 은 항상 알린다 (E.2.6).
  // 장소·메모만 바뀐 일정은 알림·기록을 만들지 않지만 화면은 다시 그린다 (M.9)
  const detailChanged = (s.calendarDetailChanged ?? 0) > 0
  if (hasChange || detailChanged || (!notify && mode === 'full')) emitChanged({ date: today, reason: 'refresh' })
  return { today: buildPayload(db, settings, today, now), notices }
}

// 알림 후보를 만들고 INSERT 한다. INSERT 에 성공한 후보만 돌려준다 (A5, E.3.6). show() 는 스케줄러가 한다
function insertPlanUpdateNotices(
  db: Db,
  diff: RefreshDiff,
  summary: RefreshSummary,
  settings: AssistantSettings,
  today: string,
  at: string,
  nowHHmm: string,
  now: Date
): SentPlanUpdateNotice[] {
  // 갱신 후 계획·항목으로 후 타임라인을 만든다
  const afterPlan = getPlanByDate(db, today)
  const afterItems = afterPlan ? listPlanItems(db, afterPlan.id) : []
  const after = timelineOf(afterPlan, afterItems, settings, today, now)
  const inMeeting = isInMeeting(afterPlan?.source_snapshot?.calendar ?? [], nowHHmm)
  const candidates = buildPlanUpdateNotices({
    diff,
    summary,
    after,
    items: afterItems,
    today,
    nowHHmm,
    ctx: { refreshNotify: settings.refreshNotify, inMeeting }
  })

  const sent: SentPlanUpdateNotice[] = []
  for (const n of candidates) {
    const ev = insertEvent(db, {
      event_key: n.eventKey,
      kind: 'plan_update',
      plan_date: today,
      scheduled_at: at,
      fired_at: at,
      status: 'sent',
      ref_id: n.refId,
      payload: JSON.stringify({ title: n.title, body: n.body, focus: n.focus })
    })
    // UNIQUE 충돌이면 이미 보낸 버킷·후보다. 보내지 않는다 (A5)
    if (ev) sent.push({ ...n, eventId: ev.id })
  }
  return sent
}

// 변경 기록 행이다. 알림 행과 다른 행이다(status 'logged', ref_id null). 같은 초에 두 번 돌면 접미어로 키를 나눈다
function logPlanUpdate(db: Db, today: string, at: string, payload: string): void {
  insertLoggedEvent(db, 'plan_update', today, at, payload)
}

// 기록 전용 행을 INSERT 한다. 키는 '<kind>:<date>:<at>' 이다. UNIQUE 충돌이면 접미어 :1~:4 로 피한다
function insertLoggedEvent(
  db: Db,
  kind: 'plan_update' | 'command',
  today: string,
  at: string,
  payload: string
): void {
  const base = `${kind}:${today}:${at}`
  for (let i = 0; i < 5; i++) {
    const key = i === 0 ? base : `${base}:${i}`
    const ev = insertEvent(db, {
      event_key: key,
      kind,
      plan_date: today,
      scheduled_at: at,
      // command 행은 적용 시각을 fired_at 에 둔다. 변경 내역이 이 시각을 보인다 (G.10.4)
      fired_at: kind === 'command' ? at : null,
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
  const input = briefingInputOf(db, plan, settings, today, now, lastCollected?.errors ?? [])
  await llmSerialized(() => runLlmBriefing(plan.id, input, settings))
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
  // A58: 계속 제외 후보는 빼지 않고 excluded 로 표시한다. 후보 카드에서 다시 추가할 수 있다
  const exclusions = listExclusions(db)
  return rankCandidates(sources.candidates, today)
    .map((s) => s.candidate)
    .filter((c) => !taken.has(c.id))
    .map((c) => (isExcludedCandidate(c, exclusions) ? { ...c, excluded: true } : c))
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
  let jiraKey: string | null
  if (existing) {
    if (!REVIVABLE_STATUSES.includes(existing.status)) throw new Error('이미 계획에 있는 항목입니다.')
    updatePlanItems(db, [{ id: existing.id, patch: { status: 'planned', status_note: null } }], at)
    jiraKey = existing.jira_issue_key
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
      status_note: null,
      ...workFieldsOf(c)
    }
    insertPlanItems(db, plan.id, [item])
    jiraKey = c.jiraKey
  }

  // A58: 다시 추가하면 계속 제외 기록을 지운다. 같은 Jira 키의 다른 후보 id 기록도 지운다 (M2·M6)
  deleteExclusions(db, { candidateId, jiraKey: upperKey(jiraKey) })
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

// ── 계속 제외 (부록 M.5.5) ──

function upperKey(key: string | null | undefined): string | null {
  return key ? key.toUpperCase() : null
}

export function excludeItem(itemId: number, now: Date = new Date()): Promise<TodayPayload> {
  return serialized(() => excludeItemImpl(itemId, now))
}

// 기록을 남기고 그날 항목을 dropped 로 둔다. 다음 하루 시작·최신화 제안이 이 후보를 넣지 않는다 (A58)
async function excludeItemImpl(itemId: number, now: Date): Promise<TodayPayload> {
  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)
  const plan = requireActivePlan(db, today)
  const item = requireItemOfPlan(db, itemId, plan)
  if (!EXCLUDABLE_SOURCES.includes(item.source)) throw new Error('계속 제외는 Jira·작업 항목만 할 수 있어요.')
  if (item.status === 'suggested' || item.status === 'dismissed') {
    throw new Error('제안 항목은 계속 제외할 수 없어요.')
  }
  // 기록과 상태를 한 번에 바꾼다. 둘 중 하나만 남지 않게 한다
  db.transaction(() => {
    upsertExclusion(db, {
      candidate_id: item.candidate_id,
      jira_key: upperKey(item.jira_issue_key),
      title: item.title,
      source: item.source,
      excluded_at: at
    })
    // setItemStatus 의 dropped 경로와 같은 패치다
    if (item.status !== 'dropped') {
      updatePlanItems(db, [{ id: item.id, patch: { status: 'dropped', status_note: null } }], at)
    }
  })()
  return buildPayload(db, settings, today, now)
}

export function removeExclusion(candidateId: string, now: Date = new Date()): Promise<TodayPayload> {
  return serialized(() => removeExclusionImpl(candidateId, now))
}

// 계속 제외 기록만 지운다. 계획 항목은 바꾸지 않는다. 근무 중이 아니어도 된다 (M6)
async function removeExclusionImpl(candidateId: unknown, now: Date): Promise<TodayPayload> {
  if (typeof candidateId !== 'string' || candidateId.length === 0 || candidateId.length > 200) {
    throw new Error('후보 ID 가 올바르지 않습니다.')
  }
  const db = getDatabase()
  const { settings, today } = todayOf(db, now)
  // 같은 Jira 키로 남은 다른 후보 id 기록도 지운다 (M2)
  deleteExclusions(db, { candidateId, jiraKey: exclusionJiraKeyOf(db, candidateId, today) })
  return buildPayload(db, settings, today, now)
}

// 제외 해제에 쓸 Jira 키다. 최신화가 항목의 후보 id 를 jira:KEY 에서 task:N 으로 바꿔도 기록을 찾는다.
// 순서: 같은 id 의 제외 행 → 오늘 계획의 같은 id 항목 → 'jira:' 접두사 뒤 키
function exclusionJiraKeyOf(db: Db, candidateId: string, today: string): string | null {
  const row = listExclusions(db).find((e) => e.candidate_id === candidateId)
  if (row?.jira_key) return row.jira_key
  const plan = getPlanByDate(db, today)
  const item = plan ? listPlanItems(db, plan.id).find((i) => i.candidate_id === candidateId) : undefined
  if (item?.jira_issue_key) return upperKey(item.jira_issue_key)
  return candidateId.startsWith('jira:') ? upperKey(candidateId.slice(5)) : null
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
  const items = listPlanItems(db, plan.id)
  // 묶음 항목은 집중 작업이 될 수 없다 (A49)
  if (isGroupItem(item, items)) throw new Error('묶음 항목은 집중 작업이 될 수 없어요.')
  const updates = focusUpdates(items, item.id)
  if (updates.length > 0) updatePlanItems(db, updates, at)
  return buildPayload(db, settings, today, now)
}

// ── 명령 입력 (부록 G) ──

const UNSUPPORTED_OP_ERROR = '지원하지 않는 조작입니다.'
const CommandOpsSchema = z.array(CommandOpSchema).max(COMMAND_OPS_MAX)

function normalizeScopeItemId(scopeItemId: unknown): number | null {
  if (scopeItemId === undefined || scopeItemId === null) return null
  if (typeof scopeItemId !== 'number' || !Number.isInteger(scopeItemId) || scopeItemId <= 0) {
    throw new Error('범위 항목 ID 가 올바르지 않습니다.')
  }
  return scopeItemId
}

// 해석용 후보. local 은 네트워크를 쓰지 않는다. 수집이 실패해도 항목 조작은 해석한다
async function localCandidates(db: Db, settings: AssistantSettings, now: Date): Promise<Candidate[]> {
  try {
    return (await collectSources(db, settings, 'local', now)).candidates
  } catch (err) {
    console.error('[assistant] command collect(local)', err)
    return []
  }
}

/**
 * 명령 해석 (G.8.1). 조작 목록만 돌려준다.
 * A34: DB 를 쓰지 않는다. 그래서 todayOf 의 closeStalePlans 도 거치지 않는다. serialized 를 거치지 않는다.
 * A36: LLM 은 llmSerialized 로 1건씩 실행한다. 꺼져 있거나 실패하면 규칙 해석으로 폴백한다.
 */
export async function interpretCommand(
  text: unknown,
  scopeItemId?: unknown,
  now: Date = new Date()
): Promise<CommandInterpretation> {
  const clean = normalizeCommandText(text)
  const scope = normalizeScopeItemId(scopeItemId)

  const db = getDatabase()
  const settings = readAssistantSettings(db)
  const today = logicalDate(now, settings.dayRollover)
  const plan = requireActivePlan(db, today)
  if (scope !== null) {
    const item = requireItemOfPlan(db, scope, plan)
    if (item.status === 'dismissed') throw new Error('무시한 제안 항목은 명령으로 바꿀 수 없습니다.')
  }

  // scope 모드의 ctx 는 후보를 비운다. 수집하지 않는다
  const candidates = scope === null ? await localCandidates(db, settings, now) : []
  const ctx: CommandContext = buildCommandContext({
    today,
    items: listPlanItems(db, plan.id),
    candidates,
    scopeItemId: scope,
    briefingInstruction: plan.briefing_instruction ?? null
  })

  let raw: unknown[] | null = null
  let source: CommandInterpretation['source'] = 'rules'
  let error: string | null = null
  if (settings.llmEnabled && safeHeadlessAvailable()) {
    try {
      const r = await llmSerialized(() => requestLlmCommand({ ctx, text: clean }, settings.llmModel))
      if (r.ok) {
        raw = r.raw
        source = 'llm'
      } else {
        error = r.error
      }
    } catch (err) {
      // requestLlmCommand 는 throw 하지 않는다. 그래도 reject 하면 실패로 본다
      error = toMessage(err)
    }
  }
  if (raw === null) raw = interpretCommandRule(clean, ctx)

  const { ops, dropped } = normalizeCommandOps(raw, ctx)
  return { text: clean, scopeItemId: scope, ops, source, error, dropped }
}

export function applyCommand(ops: unknown, text: unknown, now: Date = new Date()): Promise<CommandApplyOutcome> {
  return serialized(() => applyCommandImpl(ops, text, now))
}

// 조작 1개의 실행 결과. rerank·briefing 은 조작 뒤 1회 처리할 일이다
interface OpEffect { rerank: boolean; briefing: boolean }

/**
 * 명령 적용 (G.8.1 순서 1~10). 공개 함수는 serialized 라 줄 안에서 부르면 교착한다.
 * 그래서 같은 파일의 *Impl 을 직접 부르고, 그 payload 는 버린다.
 */
async function applyCommandImpl(rawOps: unknown, text: unknown, now: Date): Promise<CommandApplyOutcome> {
  const clean = normalizeCommandText(text)
  const parsed = CommandOpsSchema.safeParse(rawOps)
  if (!parsed.success) throw new Error('조작 형식이 올바르지 않습니다.')
  const ops: CommandOp[] = parsed.data.map(squashOpText)

  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)
  const plan = requireActivePlan(db, today)

  // label 은 적용 전 상태로 만든다. 후보 제목은 add_candidate 가 있을 때만 읽는다
  const labelCtx = buildCommandContext({
    today,
    items: listPlanItems(db, plan.id),
    candidates: ops.some((op) => op.kind === 'add_candidate') ? await localCandidates(db, settings, now) : [],
    scopeItemId: null,
    briefingInstruction: plan.briefing_instruction ?? null
  })

  const results: CommandOpResult[] = []
  let needsRerank = false
  let briefingIndex: number | null = null
  for (const op of ops) {
    const label = describeCommandOp(op, labelCtx)
    // A40: unsupported 는 실행하지 않는다
    if (op.kind === 'unsupported') {
      results.push({ op, label, ok: false, error: UNSUPPORTED_OP_ERROR })
      continue
    }
    // A39: 조작 1개의 실패가 다음 조작을 막지 않는다
    try {
      const effect = await executeCommandOp(db, op, plan, today, at, now)
      if (effect.rerank) needsRerank = true
      if (effect.briefing) briefingIndex = results.length
      results.push({ op, label, ok: true, error: null })
    } catch (err) {
      results.push({ op, label, ok: false, error: toMessage(err) })
    }
  }

  if (needsRerank) applyRerank(db, plan, at)

  // G.7.4 2~3: 모든 조작을 반영한 상태로 규칙 브리핑을 저장하고 LLM 브리핑을 백그라운드로 만든다
  if (briefingIndex !== null) {
    try {
      const fresh = requireActivePlan(db, today)
      const input = briefingInputOf(db, fresh, settings, today, now, lastCollected?.errors ?? [])
      setBriefing(db, fresh.id, { text: renderRuleBriefing(input), source: 'rules', model: null, at })
      startBackgroundBriefing(fresh.id, input, settings, today)
    } catch (err) {
      const r = results[briefingIndex]
      results[briefingIndex] = { ...r, ok: false, error: toMessage(err) }
    }
  }

  const applied = results.filter((r) => r.ok).length
  const failed = results.length - applied
  const payload = JSON.stringify({
    text: clean,
    applied,
    failed,
    results: results.map((r) => ({ kind: r.op.kind, label: r.label, ok: r.ok, error: r.error }))
  })
  insertLoggedEvent(db, 'command', today, at, payload)
  emitChanged({ date: today, reason: 'command' })

  return { today: buildPayload(db, settings, today, now), results, applied, failed }
}

function squashText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// 미리보기를 거치지 않은 렌더러 값도 label·저장 값이 같게 공백을 정리한다
// set_status.note·unsupported.reason 의 상한이다. normalizeCommandOps 와 같은 200자다 (G.3.3)
const COMMAND_NOTE_MAX = 200

// CommandOpSchema 는 원문 길이만 넓게 막는다. 실제 상한은 공백 정리 뒤 여기서 다시 적용한다.
// add_manual.title 은 자르지 않는다. 120자를 넘으면 insertManualItem 이 그 조작을 실패시킨다
function squashOpText(op: CommandOp): CommandOp {
  if (op.kind === 'add_manual') return { ...op, title: squashText(op.title) }
  if (op.kind === 'set_status' && op.note !== null) {
    const note = squashText(op.note).slice(0, COMMAND_NOTE_MAX)
    return { ...op, note: note.length > 0 ? note : null }
  }
  if (op.kind === 'unsupported') return { ...op, reason: squashText(op.reason).slice(0, COMMAND_NOTE_MAX) }
  if (op.kind === 'regenerate_briefing' && op.instruction !== null) {
    const instruction = squashText(op.instruction).slice(0, COMMAND_INSTRUCTION_MAX)
    return { ...op, instruction: instruction.length > 0 ? instruction : null }
  }
  return op
}

// G.8.2. A35: 각 *Impl 이 requireItemOfPlan 과 상태 검사로 id 를 다시 검증한다
async function executeCommandOp(
  db: Db,
  op: CommandOp,
  plan: DailyPlan,
  today: string,
  at: string,
  now: Date
): Promise<OpEffect> {
  const none: OpEffect = { rerank: false, briefing: false }
  switch (op.kind) {
    case 'set_status':
      await setItemStatusImpl(op.itemId, op.status, op.note, now)
      return none
    case 'focus':
      await focusItemImpl(op.itemId, now)
      return none
    case 'accept_suggestion':
      await acceptSuggestionImpl(op.itemId, now)
      return none
    case 'dismiss_suggestion':
      await dismissSuggestionImpl(op.itemId, now)
      return none
    case 'add_candidate':
      await addItemImpl(op.candidateId, now)
      return none
    case 'add_manual':
      insertManualItem(db, op.title, op.dueDate, plan, today)
      return { rerank: true, briefing: false }
    case 'regenerate_briefing':
      // G.7.4 1: null 이면 기존 지시를 유지한다
      if (op.instruction !== null) setBriefingInstruction(db, plan.id, op.instruction, at)
      return { rerank: false, briefing: true }
    case 'unsupported':
      throw new Error(UNSUPPORTED_OP_ERROR)
  }
}

// G.6.1 임시 항목. A37: plan_items 에만 쓴다. A2: todos·tasks 를 쓰지 않는다
function insertManualItem(db: Db, title: string, dueDate: string | null, plan: DailyPlan, today: string): void {
  if (title.length === 0) throw new Error('임시 항목 제목이 비어 있습니다.')
  if (title.length > COMMAND_TITLE_MAX) throw new Error(`임시 항목 제목은 ${COMMAND_TITLE_MAX}자 이하로 입력하세요.`)
  const candidateId = nextManualCandidateId(plan.id, listPlanItems(db, plan.id))
  const c = toManualCandidate(title, dueDate, candidateId)
  const item: NewPlanItem = {
    candidate_id: candidateId,
    source: 'manual',
    title,
    link: null,
    jira_issue_key: null,
    project_id: null,
    due_date: dueDate,
    score: scoreCandidate(c, today),
    rank: null,
    slot_start: null,
    slot_end: null,
    pinned: false,
    added_by: 'user',
    urgent: isUrgent(c, today),
    status: 'planned',
    status_note: null,
    work_type: 'etc',
    work_version: null,
    parent_key: null,
    group_name: null
  }
  insertPlanItems(db, plan.id, [item])
}

// ── 회의 전 브리핑 (부록 I) ──

const LLM_OFF_MESSAGE = 'AI 브리핑이 꺼져 있습니다. 비서 설정에서 켜세요.'
const HEADLESS_MISSING_MESSAGE = 'Claude Code 를 찾을 수 없습니다. 설치와 로그인을 확인하세요.'

function parseMeetingPayload(payload: string | null): MeetingBriefingPayload | null {
  if (payload === null) return null
  try {
    const p = JSON.parse(payload) as Partial<MeetingBriefingPayload> | null
    if (p === null || typeof p !== 'object') return null
    if (typeof p.ruleMarkdown !== 'string' || p.meeting === null || typeof p.meeting !== 'object') return null
    return p as MeetingBriefingPayload
  } catch {
    return null
  }
}

// 같은 행의 payload 에 LLM 결과만 덮어쓴다. 규칙 본문과 알림 문구는 그대로다 (A45)
function patchMeetingPayload(eventId: number, patch: Partial<MeetingBriefingPayload>): void {
  const db = getDatabase()
  const ev = getEventById(db, eventId)
  const prev = ev ? parseMeetingPayload(ev.payload) : null
  if (!prev) return
  updateEventPayload(db, eventId, JSON.stringify({ ...prev, ...patch }))
}

// 실패하면 이전 LLM 본문을 비운다. 카드의 배지·본문이 llmStatus 와 어긋나지 않게 한다
function meetingLlmFailed(error: string): Partial<MeetingBriefingPayload> {
  return { llmStatus: 'failed', llmError: error, llmMarkdown: null, llmModel: null, llmAt: null }
}

/**
 * 회의 브리핑 LLM 1회 (I.7). llmSerialized 줄 안에서 부른다 (A32).
 * A45: 이 함수는 throw 하지 않는다. 실패는 payload 의 llmStatus·llmError 로만 남는다.
 */
async function runMeetingLlm(eventId: number, input: MeetingLlmInput, settings: AssistantSettings): Promise<void> {
  try {
    const r = await requestLlmMeetingBriefing(input, settings.llmModel)
    if (r.ok) {
      patchMeetingPayload(eventId, {
        llmStatus: 'done',
        llmMarkdown: r.markdown,
        llmModel: r.model,
        llmAt: toLocalDateTime(new Date()),
        llmError: null
      })
    } else {
      patchMeetingPayload(eventId, meetingLlmFailed(r.error))
    }
  } catch (err) {
    try {
      patchMeetingPayload(eventId, meetingLlmFailed(toMessage(err)))
    } catch {
      // DB 가 닫혔으면 기록을 건너뛴다
    }
  }
}

// A8·A45: 알림을 막지 않는다. 결과를 기다리지 않는다. 끝나면 카드를 다시 그리게 한다
function startBackgroundMeetingLlm(
  eventId: number,
  input: MeetingLlmInput,
  settings: AssistantSettings,
  date: string
): void {
  const task = llmSerialized(() => runMeetingLlm(eventId, input, settings)).finally(() => {
    backgroundTasks.delete(task)
    emitChanged({ date, reason: 'meeting' })
  })
  backgroundTasks.add(task)
}

const LOCAL_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

// 'YYYY-MM-DD HH:mm:ss' 의 논리 날짜다. 형식이 틀리면 null 이다
function logicalDateOfDateTime(dateTime: string, rollover: string): string | null {
  const m = LOCAL_DATE_TIME_RE.exec(dateTime)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
  return Number.isNaN(d.getTime()) ? null : logicalDate(d, rollover)
}

// I.3.1: notification.ts 가 데우는 5분 캐시다. 조회 실패는 이전 캐시로 나타난다. 예외도 '일정 없음' 으로 본다
async function readTodayMeetings(): Promise<MeetingRef[]> {
  try {
    const events = await getTodayEvents()
    return events.map(toMeetingRef).filter((m): m is MeetingRef => m !== null)
  } catch (err) {
    console.error('[assistant] meeting calendar', err)
    return []
  }
}

/**
 * 회의 브리핑 판정·INSERT (I.9.1). show() 는 스케줄러가 한다 (A5).
 * 규칙 본문을 INSERT 한 뒤 알림 목록을 돌려주고, LLM 은 그 뒤 백그라운드로 돈다 (A45).
 */
export async function runDueMeetingBriefings(now?: Date): Promise<SentMeetingNotice[]> {
  // 꺼져 있으면 캘린더 캐시도 읽지 않는다
  const settings = readAssistantSettings(getDatabase())
  if (!settings.enabled || !settings.meetingBriefingEnabled) return []
  // 캘린더 조회는 줄 밖에서 한다. 일정이 0건인 날은 캐시가 적중하지 않아 매 틱 네트워크를 쓴다.
  // 줄 안에서 기다리면 사용자 쓰기가 그동안 막힌다
  const meetings = await readTodayMeetings()
  // 시각은 줄 안에서 잡는다. 앞선 최신화가 줄을 오래 잡아도 창 판정이 낡지 않는다 (H.16)
  return serialized(() => runDueMeetingBriefingsImpl(meetings, now ?? new Date()))
}

interface MeetingLlmJob { eventId: number; input: MeetingLlmInput }

async function runDueMeetingBriefingsImpl(meetings: MeetingRef[], now: Date): Promise<SentMeetingNotice[]> {
  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)
  // getTodayEvents 는 실제 날짜 기준이다. 논리 날짜가 오늘인 회의만 판정한다.
  // 이유: 날짜 경계 직전·직후 틱이 같은 회의를 서로 다른 날짜 키로 두 번 보내지 않게 한다
  const todays = meetings.filter((m) => logicalDateOfDateTime(m.startAt, settings.dayRollover) === today)
  // 줄 밖에서 읽은 뒤 설정이 꺼졌으면 판정이 빈 배열을 돌려준다
  const due = computeDueMeetingBriefings({
    today,
    at,
    settings: {
      enabled: settings.enabled,
      meetingBriefingEnabled: settings.meetingBriefingEnabled,
      meetingLeadMin: settings.meetingLeadMin
    },
    meetings: todays,
    events: listEventsByDate(db, today)
  })
  if (due.length === 0) return []

  const plan = getPlanByDate(db, today)
  const items = plan ? listPlanItems(db, plan.id) : []
  const llmReady = settings.llmEnabled && safeHeadlessAvailable()

  const sent: SentMeetingNotice[] = []
  const jobs: MeetingLlmJob[] = []
  for (const d of due) {
    try {
      if (d.action === 'skip') {
        // A47: 창 밖·상한 초과는 skipped 행이다. 다음 틱이 같은 회의를 다시 보지 않는다
        insertEvent(db, {
          event_key: d.eventKey,
          kind: 'meeting_briefing',
          plan_date: today,
          scheduled_at: d.scheduledAt,
          fired_at: null,
          status: 'skipped',
          ref_id: d.meeting.id,
          payload: JSON.stringify({ reason: d.reason })
        })
        continue
      }

      // A46: DB 읽기만 한다. throw 하지 않는다
      const ctx = collectMeetingContext(db, d.meeting, items)
      const ruleMarkdown = buildMeetingBriefing(ctx)
      const notice = meetingNoticeText(ctx, settings.meetingLeadMin)
      const hasContext = hasMeetingContext(ctx)
      // I-7: 자료가 없으면 LLM 을 부르지 않는다
      const willLlm = hasContext && llmReady
      const payload: MeetingBriefingPayload = {
        meeting: d.meeting,
        title: notice.title,
        body: notice.body,
        projects: ctx.projects,
        hasContext,
        ruleMarkdown,
        llmStatus: willLlm ? 'pending' : 'off',
        llmMarkdown: null,
        llmModel: null,
        llmAt: null,
        llmError: null
      }
      // A45: 규칙 본문을 먼저 저장한다
      const ev = insertEvent(db, {
        event_key: d.eventKey,
        kind: 'meeting_briefing',
        plan_date: today,
        scheduled_at: d.scheduledAt,
        fired_at: at,
        status: d.late ? 'late' : 'sent',
        ref_id: d.meeting.id,
        payload: JSON.stringify(payload)
      })
      // A5: UNIQUE 충돌이면 이미 처리한 회의다. 보내지 않는다
      if (!ev) continue
      sent.push({ eventId: ev.id, title: notice.title, body: notice.body, focus: { kind: 'meeting', id: String(ev.id) } })
      if (willLlm) jobs.push({ eventId: ev.id, input: { ctx, ruleMarkdown } })
    } catch (err) {
      // 회의 1건의 실패가 다음 회의를 막지 않는다
      console.error('[assistant] meeting briefing', err)
    }
  }

  if (sent.length > 0) emitChanged({ date: today, reason: 'meeting' })
  for (const job of jobs) startBackgroundMeetingLlm(job.eventId, job.input, settings, today)
  return sent
}

/**
 * 회의 브리핑 AI 본문 다시 만들기 (I.7, I.11.8). 버튼은 결과를 기다린다.
 * 규칙 본문은 그대로 남는다. 맥락은 지금 DB 로 다시 수집한다.
 */
export async function regenerateMeetingBriefing(eventId: number, now?: Date): Promise<TodayPayload> {
  if (typeof eventId !== 'number' || !Number.isInteger(eventId)) throw new Error('회의 브리핑 ID 가 올바르지 않습니다.')
  const t = now ?? new Date()
  const db = getDatabase()
  const { settings, today } = todayOf(db, t)
  const ev = getEventById(db, eventId)
  if (!ev || ev.kind !== 'meeting_briefing' || ev.status === 'skipped') throw new Error('회의 브리핑을 찾을 수 없습니다.')
  const payload = parseMeetingPayload(ev.payload)
  if (!payload) throw new Error('회의 브리핑 내용을 읽을 수 없습니다.')
  if (!settings.llmEnabled) throw new Error(LLM_OFF_MESSAGE)
  if (!safeHeadlessAvailable()) {
    patchMeetingPayload(eventId, meetingLlmFailed(HEADLESS_MISSING_MESSAGE))
    emitChanged({ date: today, reason: 'meeting' })
    return buildPayload(db, settings, today, t)
  }

  const plan = getPlanByDate(db, ev.plan_date)
  const items = plan ? listPlanItems(db, plan.id) : []
  const ctx = collectMeetingContext(db, payload.meeting, items)
  // 카드가 진행 상태를 보이게 한다. 이전 본문은 결과가 올 때까지 둔다
  patchMeetingPayload(eventId, { llmStatus: 'pending', llmError: null })
  emitChanged({ date: today, reason: 'meeting' })
  await llmSerialized(() => runMeetingLlm(eventId, { ctx, ruleMarkdown: payload.ruleMarkdown }, settings))
  emitChanged({ date: today, reason: 'meeting' })
  return buildPayload(getDatabase(), settings, today, t)
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
