import { app, Notification, powerMonitor, type BrowserWindow } from 'electron'
import { getDatabase } from '../db/database'
import { readAssistantSettings, updateEventStatus } from './assistant-store'
import { TICK_MS } from './assistant-schedule'
import { runDueMeetingBriefings, setAssistantChangedListener } from './assistant-service'
import type { AssistantChangedEvent, AssistantNavigateEvent, SentMeetingNotice } from './assistant-types'

// 비서의 부수 효과 모듈이다. 이벤트 처리기와 60초 틱을 둔다 (docs/ASSISTANT.md §6).
// 틱은 회의 브리핑 → onTick 만 한다.
// 모든 처리기는 try/catch 로 감싼다. 백업 복원 중 DB 가 닫혀 있어도 메인 프로세스가 죽지 않는다.
// 비서 흐름은 assistant-service 경유로만 부른다. assistant-sources 를 직접 import 하지 않는다.
// 아침 자동 동기화는 onTick 주입으로만 돈다. 이 모듈은 릴리스·아침 동기화 모듈을 import 하지 않는다.

export interface SchedulerDeps {
  getMainWindow: () => BrowserWindow | null
  createWindow: () => void
  /** 틱과 wake 의 끝에서 await 없이 부른다. reject 는 삼킨다. */
  onTick?: (wake: boolean, now?: Date) => unknown
}

// 보관 신호 유효 시간. 창 생성·로딩이 이보다 오래 걸리면 이동을 포기한다
const PENDING_NAVIGATE_TTL_MS = 60_000

let deps: SchedulerDeps | null = null
// 알림 객체가 GC 되면 클릭 핸들러가 사라진다. 닫히거나 클릭될 때까지 참조를 잡는다
const liveNotifications = new Set<Notification>()
// 렌더러가 아직 받을 수 없을 때 보관하는 navigate 신호
let pendingNavigate: { payload: AssistantNavigateEvent; at: number } | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
// 회의 브리핑 판정은 동시에 1개만 실행한다. 서비스의 serialized 는 큐라서 중복 실행을 막지 못한다
let dueInFlight = false

function logError(where: string, err: unknown): void {
  console.error(`[assistant-scheduler] ${where}`, err)
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
 * 알림 클릭 → 오늘 화면 이동 (docs/ASSISTANT.md §6.3).
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

/**
 * 회의 브리핑 알림 발송 (docs/ASSISTANT.md §7.6). 서비스가 INSERT 에 성공한 알림만 받는다.
 * 답장 입력이 없다. 클릭은 오늘 화면의 회의 브리핑 카드로 이동한다.
 * show() 가 실패하면 그 알림 행을 'failed' 로 바꾼다.
 */
function showMeetingNotices(notices: SentMeetingNotice[]): void {
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
      logError('meeting briefing show', err)
      try {
        updateEventStatus(getDatabase(), notice.eventId, 'failed')
      } catch (e2) {
        logError('meeting briefing mark failed', e2)
      }
    }
  }
}

/**
 * 틱의 회의 브리핑 단계다. 판정과 발송을 한다.
 * dueInFlight 로 동시에 1개만 실행한다.
 * now 가 undefined 면 서비스가 serialized 줄 안에서 현재 시각을 잡는다. 줄 대기로 시각이 낡지 않는다.
 * 이 함수는 throw 하지 않는다.
 */
async function runDueSteps(now: Date | undefined): Promise<void> {
  if (dueInFlight) return
  dueInFlight = true
  try {
    try {
      const notices = await runDueMeetingBriefings(now)
      showMeetingNotices(notices)
    } catch (err) {
      logError('meeting briefing', err)
    }
  } finally {
    dueInFlight = false
  }
}

/**
 * 주입한 onTick 을 await 없이 부른다. 동기 throw 와 reject 를 모두 삼킨다.
 * 틱을 늦추지 않도록 결과를 기다리지 않는다.
 */
function fireOnTick(wake: boolean, injectedNow: Date | undefined): void {
  const onTick = deps?.onTick
  if (!onTick) return
  try {
    const ret = onTick(wake, injectedNow)
    void Promise.resolve(ret).catch((err: unknown) => logError('onTick', err))
  } catch (err) {
    logError('onTick', err)
  }
}

/**
 * 틱 1회 (docs/ASSISTANT.md §6.1). 이 함수는 throw 하지 않는다.
 * wake 는 resume·unlock-screen 에서 불렀는지다. 테스트용으로 export 한다.
 * injectedNow 는 테스트가 주입하는 시각이다. 실제 틱은 넘기지 않는다.
 * 단계가 끝나면 onTick 을 await 없이 부른다. 앞 단계가 실패해도 부른다.
 */
export async function runTick(wake: boolean = false, injectedNow?: Date): Promise<void> {
  try {
    await runTickSteps(injectedNow)
  } finally {
    fireOnTick(wake, injectedNow)
  }
}

async function runTickSteps(injectedNow: Date | undefined): Promise<void> {
  // 실제 틱은 undefined 를 넘긴다. 서비스가 serialized 줄 안에서 현재 시각을 잡는다
  await runDueSteps(injectedNow)
}

// 깨어나면 틱만 1번 돈다 (시작 알림은 제거됐다)
async function onWake(trigger: 'resume' | 'unlock-screen'): Promise<void> {
  try {
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

export function startAssistantScheduler(d: SchedulerDeps): void {
  if (deps) stopAssistantScheduler()
  deps = d
  syncLoginItemOnStart()
  setAssistantChangedListener(onAssistantChanged)
  try {
    powerMonitor.on('unlock-screen', onUnlockScreen)
    powerMonitor.on('resume', onResume)
  } catch (err) {
    logError('powerMonitor', err)
  }
  tickTimer = setInterval(onIntervalTick, TICK_MS)
}

export function stopAssistantScheduler(): void {
  try {
    powerMonitor.removeListener('unlock-screen', onUnlockScreen)
    powerMonitor.removeListener('resume', onResume)
  } catch (err) {
    logError('powerMonitor off', err)
  }
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  dueInFlight = false
  setAssistantChangedListener(null)
  liveNotifications.clear()
  pendingNavigate = null
  deps = null
}
