import { app, Notification, powerMonitor, type BrowserWindow } from 'electron'
import { getDatabase } from '../db/database'
import { onActivity, type ActivityEvent, type EntityType } from '../utils/activity-logger'
import { logicalDate, shouldSendStartNudge, toLocalDateTime, type NudgeTrigger } from './assistant-day'
import { closeStalePlans, findEventByKey, getPlanByDate, insertEvent, readAssistantSettings, updateEventStatus } from './assistant-store'
import { getStartNudgeContent, runRefresh, setAssistantChangedListener } from './assistant-service'
import type { AssistantChangedEvent, AssistantNavigateEvent } from './assistant-types'

// 비서의 부수 효과 모듈이다. MVP1 은 이벤트 기반만 쓴다 (§7.2). 주기 틱을 두지 않는다.
// A13: 모든 처리기는 try/catch 로 감싼다. 백업 복원 중 DB 가 닫혀 있어도 메인 프로세스가 죽지 않는다.

interface SchedulerDeps {
  getMainWindow: () => BrowserWindow | null
  createWindow: () => void
}

const START_NUDGE_TITLE = '오늘 시작할까요?'
const LOCAL_REFRESH_DEBOUNCE_MS = 2000
// 비서 후보와 무관한 엔티티는 최신화를 예약하지 않는다
const IGNORED_ENTITIES: EntityType[] = ['todo_tag', 'memo', 'memo_category', 'document', 'variable', 'release_note']

let deps: SchedulerDeps | null = null
let unsubscribeActivity: (() => void) | null = null
let localRefreshTimer: ReturnType<typeof setTimeout> | null = null
// 알림 객체가 GC 되면 클릭 핸들러가 사라진다. 닫히거나 클릭될 때까지 참조를 잡는다
const liveNotifications = new Set<Notification>()

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

function navigateToToday(): void {
  if (!deps) return
  const payload: AssistantNavigateEvent = { view: 'today' }
  try {
    const win = deps.getMainWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('assistant:navigate', payload)
      return
    }
    // 창이 없으면 만든 뒤 렌더러 로드가 끝나면 보낸다
    deps.createWindow()
    const created = deps.getMainWindow()
    if (created && !created.isDestroyed()) {
      created.webContents.once('did-finish-load', () => {
        try {
          if (!created.isDestroyed()) created.webContents.send('assistant:navigate', payload)
        } catch (err) {
          logError('navigate after load', err)
        }
      })
    }
  } catch (err) {
    logError('navigate', err)
  }
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

function onUnlockScreen(): void {
  void runStartNudgeCheck('unlock-screen')
}

function onResume(): void {
  void runStartNudgeCheck('resume')
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
  setAssistantChangedListener(null)
  liveNotifications.clear()
  deps = null
}
