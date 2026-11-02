import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 호출 순서를 한 배열에 남긴다. A5 는 INSERT 가 show() 보다 먼저인지 본다
const order = vi.hoisted(() => [] as string[])

const electron = vi.hoisted(() => {
  const handlers = new Map<string, () => void>()
  const notifications: { opts: { title: string; body: string }; listeners: Map<string, () => void> }[] = []
  const state = { throwOnShow: false }
  class FakeNotification {
    listeners = new Map<string, () => void>()
    constructor(public opts: { title: string; body: string }) {
      order.push('new Notification')
      notifications.push(this)
    }
    on(ev: string, fn: () => void): this {
      this.listeners.set(ev, fn)
      return this
    }
    show(): void {
      if (state.throwOnShow) throw new Error('show failed')
      order.push('show')
    }
  }
  return {
    handlers,
    notifications,
    state,
    Notification: FakeNotification,
    powerMonitor: {
      on: vi.fn((ev: string, fn: () => void) => handlers.set(`power:${ev}`, fn)),
      removeListener: vi.fn((ev: string) => handlers.delete(`power:${ev}`))
    },
    app: {
      isPackaged: false,
      on: vi.fn((ev: string, fn: () => void) => handlers.set(`app:${ev}`, fn)),
      removeListener: vi.fn((ev: string) => handlers.delete(`app:${ev}`)),
      setLoginItemSettings: vi.fn()
    }
  }
})
vi.mock('electron', () => ({
  app: electron.app,
  powerMonitor: electron.powerMonitor,
  Notification: electron.Notification
}))

const db = vi.hoisted(() => ({ getDatabase: vi.fn() }))
vi.mock('../db/database', () => db)

const activity = vi.hoisted(() => ({ listener: null as null | ((e: unknown) => void) }))
vi.mock('../utils/activity-logger', () => ({
  onActivity: (fn: (e: unknown) => void) => {
    activity.listener = fn
    return () => {
      activity.listener = null
    }
  }
}))

vi.mock('./assistant-day', () => ({
  logicalDate: () => '2026-11-02',
  toLocalDateTime: () => '2026-11-02 09:40:00',
  shouldSendStartNudge: (input: { hasPlanToday: boolean; nudgeSentToday: boolean }) =>
    !input.hasPlanToday && !input.nudgeSentToday
}))

const store = vi.hoisted(() => ({
  closeStalePlans: vi.fn(() => []),
  findEventByKey: vi.fn(() => null),
  getPlanByDate: vi.fn(() => null),
  insertEvent: vi.fn(),
  readAssistantSettings: vi.fn(() => ({ dayRollover: '04:00', openAtLogin: false })),
  updateEventStatus: vi.fn()
}))
vi.mock('./assistant-store', () => store)

const service = vi.hoisted(() => ({
  getStartNudgeContent: vi.fn(async () => ({ candidateCount: 3, eventCount: 2 })),
  runRefresh: vi.fn(async () => null),
  setAssistantChangedListener: vi.fn()
}))
vi.mock('./assistant-service', () => service)

import {
  runStartNudgeCheck,
  startAssistantScheduler,
  stopAssistantScheduler,
  takePendingNavigate
} from './assistant-scheduler'

function fakeWindow(loading = false): {
  isDestroyed: () => boolean
  isMinimized: () => boolean
  restore: () => void
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  webContents: { send: ReturnType<typeof vi.fn>; isLoading: () => boolean }
} {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => undefined,
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn(), isLoading: () => loading }
  }
}

beforeEach(() => {
  order.length = 0
  electron.notifications.length = 0
  electron.state.throwOnShow = false
  vi.clearAllMocks()
  db.getDatabase.mockReturnValue({})
  store.getPlanByDate.mockReturnValue(null)
  store.findEventByKey.mockReturnValue(null)
  store.insertEvent.mockImplementation((_db: unknown, ev: { event_key: string }) => {
    order.push('insertEvent')
    return { id: 1, ...ev }
  })
})

afterEach(() => {
  stopAssistantScheduler()
  vi.useRealTimers()
})

describe('시작 알림 발송 순서', () => {
  it('A5: assistant_events INSERT 가 Notification show() 보다 먼저다', async () => {
    await runStartNudgeCheck('unlock-screen')
    expect(order).toEqual(['insertEvent', 'new Notification', 'show'])
    const ev = store.insertEvent.mock.calls[0][1]
    expect(ev).toMatchObject({ event_key: 'start_nudge:2026-11-02:', kind: 'start_nudge', status: 'sent' })
    expect(electron.notifications[0].opts).toEqual({ title: '오늘 시작할까요?', body: '후보 3건 · 오늘 일정 2건' })
  })

  it('A5: insertEvent 가 null(UNIQUE 충돌)이면 Notification 을 만들지 않는다', async () => {
    store.insertEvent.mockImplementation(() => {
      order.push('insertEvent')
      return null
    })
    await runStartNudgeCheck('focus')
    expect(order).toEqual(['insertEvent'])
    expect(electron.notifications).toHaveLength(0)
  })

  it('A5: show() 가 실패하면 status 를 failed 로 바꾸고 다시 시도하지 않는다', async () => {
    electron.state.throwOnShow = true
    await runStartNudgeCheck('resume')
    expect(store.updateEventStatus).toHaveBeenCalledWith({}, 1, 'failed')
  })

  it('오늘 계획이 있으면 INSERT 도 알림도 하지 않는다', async () => {
    store.getPlanByDate.mockReturnValue({ id: 9 } as never)
    await runStartNudgeCheck('unlock-screen')
    expect(store.insertEvent).not.toHaveBeenCalled()
    expect(electron.notifications).toHaveLength(0)
  })

})

describe('알림 클릭 이동과 보관 신호 (§12.1)', () => {
  async function clickNudge(): Promise<void> {
    await runStartNudgeCheck('unlock-screen')
    electron.notifications[0].listeners.get('click')?.()
  }

  it('창이 있고 로딩이 끝났으면 바로 navigate 를 보내고 보관 신호는 없다', async () => {
    const win = fakeWindow()
    startAssistantScheduler({ getMainWindow: () => win as never, createWindow: vi.fn() })
    await clickNudge()
    expect(win.show).toHaveBeenCalled()
    expect(win.webContents.send).toHaveBeenCalledWith('assistant:navigate', { view: 'today' })
    expect(takePendingNavigate()).toBeNull()
  })

  it('창이 없으면 createWindow 를 부르고 보내지 않는다. 보관 신호는 1번만 꺼낸다', async () => {
    let win: ReturnType<typeof fakeWindow> | null = null
    const createWindow = vi.fn(() => {
      win = fakeWindow(true)
    })
    startAssistantScheduler({ getMainWindow: () => win as never, createWindow })
    await clickNudge()
    expect(createWindow).toHaveBeenCalledTimes(1)
    const created = win as unknown as ReturnType<typeof fakeWindow>
    expect(created.webContents.send).not.toHaveBeenCalledWith('assistant:navigate', expect.anything())
    expect(takePendingNavigate()).toEqual({ view: 'today' })
    expect(takePendingNavigate()).toBeNull()
  })

  it('창이 로딩 중이면 띄우기만 하고 보내지 않는다. 보관 신호가 남는다', async () => {
    const win = fakeWindow(true)
    const createWindow = vi.fn()
    startAssistantScheduler({ getMainWindow: () => win as never, createWindow })
    await clickNudge()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(createWindow).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalledWith('assistant:navigate', expect.anything())
    expect(takePendingNavigate()).toEqual({ view: 'today' })
  })

  it('로딩이 끝난 창으로 다시 이동하면 이전 보관 신호를 비운다', async () => {
    const win = fakeWindow(true)
    startAssistantScheduler({ getMainWindow: () => win as never, createWindow: vi.fn() })
    await clickNudge()
    win.webContents.isLoading = () => false
    electron.notifications[0].listeners.get('click')?.()
    expect(win.webContents.send).toHaveBeenCalledWith('assistant:navigate', { view: 'today' })
    expect(takePendingNavigate()).toBeNull()
  })

  it('60초가 지나면 보관 신호를 버리고 null 을 돌려준다', async () => {
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    await clickNudge()
    expect(takePendingNavigate(Date.now() + 60_001)).toBeNull()
    expect(takePendingNavigate()).toBeNull()
  })

  it('60초 안이면 보관 신호를 돌려준다', async () => {
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    await clickNudge()
    expect(takePendingNavigate(Date.now() + 59_000)).toEqual({ view: 'today' })
  })

  it('stopAssistantScheduler 후 보관 신호가 비어 있다', async () => {
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    await clickNudge()
    stopAssistantScheduler()
    expect(takePendingNavigate()).toBeNull()
  })
})

describe('A13: DB 미초기화 예외를 삼킨다', () => {
  beforeEach(() => {
    db.getDatabase.mockImplementation(() => {
      throw new Error('Database not initialized')
    })
  })

  it('A13: runStartNudgeCheck 는 getDatabase 가 throw 해도 throw 하지 않는다', async () => {
    await expect(runStartNudgeCheck('unlock-screen')).resolves.toBeUndefined()
    expect(electron.notifications).toHaveLength(0)
  })

  it('A13: 시작·이벤트 처리기·정지가 getDatabase 예외에도 throw 하지 않는다', async () => {
    expect(() => startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })).not.toThrow()
    expect(() => electron.handlers.get('power:unlock-screen')?.()).not.toThrow()
    expect(() => electron.handlers.get('power:resume')?.()).not.toThrow()
    expect(() => electron.handlers.get('app:browser-window-focus')?.()).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(() => stopAssistantScheduler()).not.toThrow()
  })

  it('A13: 디바운스된 로컬 최신화가 reject 해도 처리기가 throw 하지 않는다', async () => {
    vi.useFakeTimers()
    service.runRefresh.mockRejectedValueOnce(new Error('Database not initialized'))
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    expect(() => activity.listener?.({ entityType: 'todo', action: 'complete', entityId: 1 })).not.toThrow()
    await vi.advanceTimersByTimeAsync(2000)
    expect(service.runRefresh).toHaveBeenCalledWith('local')
  })
})

describe('앱 내부 변경 최신화 예약', () => {
  it('2초 디바운스 후 runRefresh(local) 를 1번 부른다', async () => {
    vi.useFakeTimers()
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    activity.listener?.({ entityType: 'todo', action: 'update', entityId: 1 })
    activity.listener?.({ entityType: 'task', action: 'update', entityId: 2 })
    await vi.advanceTimersByTimeAsync(1999)
    expect(service.runRefresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(service.runRefresh).toHaveBeenCalledTimes(1)
  })

  it('memo·document 같은 무관 엔티티는 무시한다', async () => {
    vi.useFakeTimers()
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    activity.listener?.({ entityType: 'memo', action: 'update', entityId: 1 })
    activity.listener?.({ entityType: 'document', action: 'create', entityId: 2 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(service.runRefresh).not.toHaveBeenCalled()
  })

  it('정지하면 리스너와 타이머를 해제한다', async () => {
    vi.useFakeTimers()
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    activity.listener?.({ entityType: 'todo', action: 'update', entityId: 1 })
    stopAssistantScheduler()
    await vi.advanceTimersByTimeAsync(3000)
    expect(service.runRefresh).not.toHaveBeenCalled()
    expect(activity.listener).toBeNull()
    expect(electron.handlers.size).toBe(0)
    expect(service.setAssistantChangedListener).toHaveBeenLastCalledWith(null)
  })
})
