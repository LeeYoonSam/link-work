import { app, Notification, powerMonitor, type BrowserWindow } from 'electron'
import { getDatabase } from '../db/database'
import { onActivity, type ActivityEvent, type EntityType } from '../utils/activity-logger'
import { logicalDate, shouldSendStartNudge, toLocalDateTime, type NudgeTrigger } from './assistant-day'
import { closeStalePlans, findEventByKey, getPlanByDate, insertEvent, readAssistantSettings, updateEventStatus } from './assistant-store'
import { decideRefresh, TICK_MS } from './assistant-schedule'
import { interpretReplyRule } from './assistant-command'
import {
  getSourceCheckTimes,
  getStartNudgeContent,
  respondCheckin,
  runAutoRefresh,
  runDueCheckin,
  runRefresh,
  setAssistantChangedListener
} from './assistant-service'
import type {
  AssistantChangedEvent,
  AssistantNavigateEvent,
  CheckinAnswer,
  SentCheckinNotice,
  SentPlanUpdateNotice
} from './assistant-types'

// 비서의 부수 효과 모듈이다. 이벤트 처리기와 60초 틱을 둔다 (§7.2, 부록 E.2).
// A13: 모든 처리기는 try/catch 로 감싼다. 백업 복원 중 DB 가 닫혀 있어도 메인 프로세스가 죽지 않는다.
// 위험 8: 확인 시각은 assistant-service 경유로 읽는다. assistant-sources 를 직접 import 하지 않는다.

interface SchedulerDeps {
  getMainWindow: () => BrowserWindow | null
  createWindow: () => void
}

const START_NUDGE_TITLE = '오늘 시작할까요?'
const LOCAL_REFRESH_DEBOUNCE_MS = 2000
// 보관 신호 유효 시간. 창 생성·로딩이 이보다 오래 걸리면 이동을 포기한다
const PENDING_NAVIGATE_TTL_MS = 60_000
// 체크인 알림의 답장 입력 안내 문구 (H.6.1)
const CHECKIN_REPLY_PLACEHOLDER = '완료 / 진행 중 / 미룸'
// 서비스 respondCheckin 은 이보다 긴 note 를 거부한다 (H.9.5)
const CHECKIN_NOTE_MAX = 500
// 비서 후보와 무관한 엔티티는 최신화를 예약하지 않는다
const IGNORED_ENTITIES: EntityType[] = ['todo_tag', 'memo', 'memo_category', 'document', 'variable', 'release_note']

let deps: SchedulerDeps | null = null
let unsubscribeActivity: (() => void) | null = null
let localRefreshTimer: ReturnType<typeof setTimeout> | null = null
// 알림 객체가 GC 되면 클릭 핸들러가 사라진다. 닫히거나 클릭될 때까지 참조를 잡는다
const liveNotifications = new Set<Notification>()
// 렌더러가 아직 받을 수 없을 때 보관하는 navigate 신호
let pendingNavigate: { payload: AssistantNavigateEvent; at: number } | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
// A26: 자동 최신화는 동시에 1개만 실행한다. 서비스의 serialized 는 큐라서 중복 실행을 막지 못한다
let autoRefreshInFlight = false
// A42: 체크인 판정은 동시에 1개만 실행한다. autoRefreshInFlight 와 같은 이유다
let dueInFlight = false

function logError(where: string, err: unknown): void {
  console.error(`[assistant-scheduler] ${where}`, err)
}

function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

function sendToMainWindow(channel: string, payload: unknown): void {
  try {
    const win = deps?.getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  } catch (err) {
    logError(`send ${channel}`, err)
  }
}

/**
 * 알림 클릭 → 오늘 화면 이동 (§12.1).
 * 렌더러가 아직 구독 전일 수 있다. 그래서 로딩 중이거나 창이 없으면 보관 신호에 두고,
 * 렌더러가 마운트 직후 takePendingNavigate 로 가져간다.
 */
export function navigateToToday(focus?: AssistantNavigateEvent['focus']): void {
  if (!deps) return
  const payload: AssistantNavigateEvent = focus ? { view: 'today', focus } : { view: 'today' }
  try {
    const win = deps.getMainWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      if (win.webContents.isLoading()) {
        pendingNavigate = { payload, at: Date.now() }
        return
      }
      pendingNavigate = null
      win.webContents.send('assistant:navigate', payload)
      return
    }
    pendingNavigate = { payload, at: Date.now() }
    deps.createWindow()
  } catch (err) {
    logError('navigate', err)
  }
}

/** 보관 신호를 1번만 꺼낸다. 유효 시간이 지났으면 버리고 null 을 돌려준다. */
export function takePendingNavigate(now: number = Date.now()): AssistantNavigateEvent | null {
  const p = pendingNavigate
  pendingNavigate = null
  if (!p || now - p.at > PENDING_NAVIGATE_TTL_MS) return null
  return p.payload
}

function startNudgeBody(content: { candidateCount: number; eventCount: number } | null): string {
  if (!content) return '하루 시작을 눌러 오늘 계획을 만드세요.'
  return `후보 ${content.candidateCount}건 · 오늘 일정 ${content.eventCount}건`
}

/**
 * 시작 알림 판정과 발송. 처리기와 테스트가 함께 쓴다. 이 함수는 throw 하지 않는다 (A13).
 * 발송 순서 (A5): INSERT → 충돌이면 중단 → show() → 예외면 'failed'.
 */
export async function runStartNudgeCheck(trigger: NudgeTrigger, now: Date = new Date()): Promise<void> {
  try {
    const db = getDatabase()
    const settings = readAssistantSettings(db)
    const today = logicalDate(now, settings.dayRollover)
    const at = toLocalDateTime(now)
    closeStalePlans(db, today, at)

    const eventKey = `start_nudge:${today}:`
    const send = shouldSendStartNudge({
      settings,
      today,
      weekday: weekdayOf(today),
      hasPlanToday: getPlanByDate(db, today) !== null,
      nudgeSentToday: findEventByKey(db, eventKey) !== null,
      trigger
    })
    if (!send) return

    let content: { candidateCount: number; eventCount: number } | null = null
    try {
      content = await getStartNudgeContent(now)
    } catch (err) {
      logError('nudge content', err)
    }
    const body = startNudgeBody(content)

    // 본문 계산을 기다리는 사이 DB 가 바뀌었을 수 있다. 다시 연결해 기록한다
    const db2 = getDatabase()
    const ev = insertEvent(db2, {
      event_key: eventKey,
      kind: 'start_nudge',
      plan_date: today,
      scheduled_at: at,
      fired_at: at,
      status: 'sent',
      ref_id: null,
      payload: JSON.stringify({ title: START_NUDGE_TITLE, body, trigger })
    })
    // A5: 같은 키가 이미 있으면 다른 처리기가 보냈다. 발송하지 않는다
    if (!ev) return

    try {
      const n = new Notification({ title: START_NUDGE_TITLE, body })
      liveNotifications.add(n)
      n.on('click', () => {
        liveNotifications.delete(n)
        navigateToToday()
      })
      n.on('close', () => {
        liveNotifications.delete(n)
      })
      n.show()
    } catch (err) {
      logError('nudge show', err)
      // 같은 키는 다시 시도하지 않는다
      try {
        updateEventStatus(db2, ev.id, 'failed')
      } catch (e2) {
        logError('nudge mark failed', e2)
      }
    }
  } catch (err) {
    logError(`nudge(${trigger})`, err)
  }
}

/**
 * 최신화 알림 발송. 서비스가 INSERT 에 성공한 알림만 받는다 (A5, E.3.6).
 * show() 가 실패하면 그 알림 행을 'failed' 로 바꾼다.
 */
function showPlanUpdateNotices(notices: SentPlanUpdateNotice[]): void {
  for (const notice of notices) {
    try {
      const n = new Notification({ title: notice.title, body: notice.body })
      liveNotifications.add(n)
      n.on('click', () => {
        liveNotifications.delete(n)
        navigateToToday(notice.focus)
      })
      n.on('close', () => {
        liveNotifications.delete(n)
      })
      n.show()
    } catch (err) {
      logError('plan update show', err)
      try {
        updateEventStatus(getDatabase(), notice.eventId, 'failed')
      } catch (e2) {
        logError('plan update mark failed', e2)
      }
    }
  }
}

function toAnswer(r: { status: CheckinAnswer['status']; note: string | null }, raw: string): CheckinAnswer {
  // 긴 답장이 거부되어 응답이 기록되지 않는 일을 막는다
  const note = r.note === null ? null : r.note.slice(0, CHECKIN_NOTE_MAX)
  return { status: r.status, note, raw }
}

/**
 * 체크인 답장 처리 (H.6.2). 테스트용으로 export 한다.
 * A43: 해석은 interpretReplyRule 만 쓴다. LLM 을 쓰지 않는다. 버튼과 같은 respondCheckin 을 거친다.
 * A13: 이 함수는 throw 하지 않는다.
 */
export async function onCheckinReply(eventId: number, reply: string): Promise<void> {
  try {
    const text = typeof reply === 'string' ? reply : ''
    // 빈 답장은 넘기기와 같다. 원문이 없으므로 서비스가 response 를 'skip' 으로 기록한다
    const answer: CheckinAnswer =
      text.trim() === ''
        ? { status: null, note: null, raw: null }
        : toAnswer(interpretReplyRule(text), text)
    await respondCheckin(eventId, answer)
  } catch (err) {
    logError('checkin reply', err)
  }
}

/**
 * 체크인 알림 발송 (H.6.1). 서비스가 INSERT 에 성공한 알림만 받는다 (A5).
 * 답장 입력은 hasReply 로 연다. actions 를 함께 쓰면 macOS 가 첫 action 외에는 무시한다.
 * show() 가 실패하면 그 알림 행을 'failed' 로 바꾼다.
 */
function showCheckinNotice(notice: SentCheckinNotice): void {
  try {
    const n = new Notification({
      title: notice.title,
      body: notice.body,
      hasReply: true,
      replyPlaceholder: CHECKIN_REPLY_PLACEHOLDER
    })
    liveNotifications.add(n)
    n.on('click', () => {
      liveNotifications.delete(n)
      navigateToToday(notice.focus)
    })
    n.on('reply', (_e, reply) => {
      liveNotifications.delete(n)
      void onCheckinReply(notice.eventId, reply)
    })
    n.on('close', () => {
      liveNotifications.delete(n)
    })
    n.show()
  } catch (err) {
    logError('checkin show', err)
    try {
      updateEventStatus(getDatabase(), notice.eventId, 'failed')
    } catch (e2) {
      logError('checkin mark failed', e2)
    }
  }
}

/**
 * 틱 6단계 (H.5). 체크인 판정과 발송. A42: dueInFlight 로 동시에 1개만 실행한다.
 * now 가 undefined 면 서비스가 serialized 줄 안에서 현재 시각을 잡는다. 최신화 대기로 시각이 낡지 않는다.
 * A13: 이 함수는 throw 하지 않는다.
 */
async function runCheckinStep(now: Date | undefined): Promise<void> {
  if (dueInFlight) return
  dueInFlight = true
  try {
    const notice = await runDueCheckin(now)
    if (notice) showCheckinNotice(notice)
  } catch (err) {
    logError('checkin', err)
  } finally {
    dueInFlight = false
  }
}

/**
 * 틱 1회 (부록 E.2.1, H.5). 판정은 decideRefresh 가 한다 (A25). 이 함수는 throw 하지 않는다 (A13).
 * wake 는 resume·unlock-screen 에서 불렀는지다. 테스트용으로 export 한다.
 * injectedNow 는 테스트가 주입하는 시각이다. 실제 틱은 넘기지 않는다.
 */
export async function runTick(wake: boolean = false, injectedNow?: Date): Promise<void> {
  const now = injectedNow ?? new Date()
  try {
    const db = getDatabase()
    const settings = readAssistantSettings(db)
    const today = logicalDate(now, settings.dayRollover)
    // A18: 날짜 경계가 지나면 닫는다. 열린 오늘 화면을 닫힘 상태로 바꾼다
    const closed = closeStalePlans(db, today, toLocalDateTime(now))
    if (closed.length > 0) sendToMainWindow('assistant:changed', { date: today, reason: 'day' } satisfies AssistantChangedEvent)

    const plan = getPlanByDate(db, today)
    const mode = decideRefresh({
      nowMs: now.getTime(),
      settings,
      hasActivePlan: plan?.status === 'active',
      inFlight: autoRefreshInFlight,
      times: getSourceCheckTimes(),
      wake
    })
    // A26: 진행 중이면 건너뛴다. 판정 결과와 별개로 한 번 더 막는다
    if (mode !== null && !autoRefreshInFlight) {
      autoRefreshInFlight = true
      try {
        const outcome = await runAutoRefresh(mode, now)
        if (outcome) showPlanUpdateNotices(outcome.notices)
      } catch (err) {
        // 최신화가 실패해도 6단계 체크인은 실행한다
        logError(`auto refresh${wake ? '(wake)' : ''}`, err)
      } finally {
        autoRefreshInFlight = false
      }
    }
  } catch (err) {
    logError(`tick${wake ? '(wake)' : ''}`, err)
    return
  }
  // A42: 6단계는 4단계 뒤다. 4단계를 건너뛰어도 실행한다. 서비스의 serialized 줄이 진행 중 최신화 뒤에 세운다
  // 실제 틱은 undefined 를 넘긴다. 4단계 await 로 틱 시작 시각이 낡았을 수 있다
  await runCheckinStep(injectedNow)
}

// A26: 시작 알림 판정 뒤에 최신화를 한다. 순서를 고정해 결과를 결정론적으로 만든다
async function onWake(trigger: 'resume' | 'unlock-screen'): Promise<void> {
  try {
    await runStartNudgeCheck(trigger)
    await runTick(true)
  } catch (err) {
    logError(`wake(${trigger})`, err)
  }
}

function onUnlockScreen(): void {
  void onWake('unlock-screen')
}

function onResume(): void {
  void onWake('resume')
}

function onIntervalTick(): void {
  void runTick(false)
}

function onWindowFocus(): void {
  void runStartNudgeCheck('focus')
}

async function runLocalRefresh(): Promise<void> {
  try {
    await runRefresh('local')
  } catch (err) {
    logError('local refresh', err)
  }
}

// 기록 경로를 느리게 하지 않도록 예약만 한다. 실제 최신화는 2초 뒤에 1번 한다 (§18 위험 7)
function onActivityEvent(e: ActivityEvent): void {
  try {
    if (IGNORED_ENTITIES.includes(e.entityType)) return
    if (localRefreshTimer) clearTimeout(localRefreshTimer)
    localRefreshTimer = setTimeout(() => {
      localRefreshTimer = null
      void runLocalRefresh()
    }, LOCAL_REFRESH_DEBOUNCE_MS)
  } catch (err) {
    logError('activity', err)
  }
}

function onAssistantChanged(e: AssistantChangedEvent): void {
  sendToMainWindow('assistant:changed', e)
}

function syncLoginItemOnStart(): void {
  try {
    const settings = readAssistantSettings(getDatabase())
    // 개발 실행에서 electron 바이너리를 로그인 항목에 넣지 않는다
    if (settings.openAtLogin && app.isPackaged) app.setLoginItemSettings({ openAtLogin: true })
  } catch (err) {
    logError('login item', err)
  }
}

function closeStaleOnStart(): void {
  try {
    const db = getDatabase()
    const settings = readAssistantSettings(db)
    const now = new Date()
    closeStalePlans(db, logicalDate(now, settings.dayRollover), toLocalDateTime(now))
  } catch (err) {
    logError('auto close', err)
  }
}

export function startAssistantScheduler(d: SchedulerDeps): void {
  if (deps) stopAssistantScheduler()
  deps = d
  closeStaleOnStart()
  syncLoginItemOnStart()
  setAssistantChangedListener(onAssistantChanged)
  try {
    powerMonitor.on('unlock-screen', onUnlockScreen)
    powerMonitor.on('resume', onResume)
  } catch (err) {
    logError('powerMonitor', err)
  }
  app.on('browser-window-focus', onWindowFocus)
  unsubscribeActivity = onActivity(onActivityEvent)
  tickTimer = setInterval(onIntervalTick, TICK_MS)
}

export function stopAssistantScheduler(): void {
  try {
    powerMonitor.removeListener('unlock-screen', onUnlockScreen)
    powerMonitor.removeListener('resume', onResume)
  } catch (err) {
    logError('powerMonitor off', err)
  }
  app.removeListener('browser-window-focus', onWindowFocus)
  unsubscribeActivity?.()
  unsubscribeActivity = null
  if (localRefreshTimer) clearTimeout(localRefreshTimer)
  localRefreshTimer = null
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  autoRefreshInFlight = false
  dueInFlight = false
  setAssistantChangedListener(null)
  liveNotifications.clear()
  pendingNavigate = null
  deps = null
}
