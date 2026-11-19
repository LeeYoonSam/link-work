import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 호출 순서를 한 배열에 남긴다. A5 는 INSERT 가 show() 보다 먼저인지 본다
const order = vi.hoisted(() => [] as string[])

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  interface NoticeOpts { title: string; body: string; hasReply?: boolean; replyPlaceholder?: string }
  const handlers = new Map<string, () => void>()
  const notifications: { opts: NoticeOpts; listeners: Map<string, Listener>; reply: (text: string) => void }[] = []
  const state = { throwOnShow: false }
  class FakeNotification {
    listeners = new Map<string, Listener>()
    constructor(public opts: NoticeOpts) {
      order.push('new Notification')
      notifications.push(this)
    }
    on(ev: string, fn: Listener): this {
      this.listeners.set(ev, fn)
      return this
    }
    show(): void {
      if (state.throwOnShow) throw new Error('show failed')
      order.push('show')
    }
    // macOS 답장 이벤트를 흉내 낸다. Electron 시그니처는 (event, reply) 다
    reply(text: string): void {
      this.listeners.get('reply')?.({}, text)
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
  toLocalDateTime: () => '2026-11-02 09:40:00'
}))

const store = vi.hoisted(() => ({
  closeStalePlans: vi.fn((): unknown[] => {
    order.push('closeStalePlans')
    return []
  }),
  findEventByKey: vi.fn(() => null),
  getPlanByDate: vi.fn(() => null),
  insertEvent: vi.fn(),
  readAssistantSettings: vi.fn(() => ({ dayRollover: '04:00', openAtLogin: false })),
  updateEventStatus: vi.fn()
}))
vi.mock('./assistant-store', () => store)

const service = vi.hoisted(() => ({
  setAssistantChangedListener: vi.fn(),
  runDueMeetingBriefings: vi.fn(async (): Promise<unknown[]> => [])
}))
vi.mock('./assistant-service', () => service)

const schedule = vi.hoisted(() => ({ TICK_MS: 60_000 }))
vi.mock('./assistant-schedule', () => schedule)

import {
  navigateToToday,
  runTick,
  startAssistantScheduler,
  stopAssistantScheduler,
  takePendingNavigate
} from './assistant-scheduler'

// 부록 O(오늘 대시보드 개편, 2026-11-19): 시작 알림·자동 최신화·활동 기반 최신화는 제거됐다.
// 틱은 지난 계획 닫기 → 회의 브리핑 → onTick 순서만 남는다.

function deferred(): { promise: Promise<unknown>; resolve: (v: unknown) => void } {
  let resolve: (v: unknown) => void = () => undefined
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

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

function meetingNotice(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 41,
    title: '주간 회의 15분 전',
    body: '링크워크 · 미완료 액션 2건',
    focus: { kind: 'meeting', id: '41' },
    ...over
  }
}

// 서비스가 회의 브리핑 행을 INSERT 한 뒤 결과를 돌려준다 (I.9.1)
function dueMeetingsReturn(notices: Record<string, unknown>[]): void {
  service.runDueMeetingBriefings.mockImplementation(async () => {
    order.push('runDueMeetingBriefings')
    for (const _ of notices) order.push('insertEvent')
    return notices
  })
}

beforeEach(() => {
  order.length = 0
  electron.notifications.length = 0
  electron.state.throwOnShow = false
  vi.clearAllMocks()
  db.getDatabase.mockReturnValue({})
  store.getPlanByDate.mockReturnValue(null)
  store.closeStalePlans.mockImplementation(() => {
    order.push('closeStalePlans')
    return []
  })
  store.findEventByKey.mockReturnValue(null)
  service.runDueMeetingBriefings.mockImplementation(async () => [])
  store.insertEvent.mockImplementation((_db: unknown, ev: { event_key: string }) => {
    order.push('insertEvent')
    return { id: 1, ...ev }
  })
})

afterEach(() => {
  stopAssistantScheduler()
  vi.useRealTimers()
})

describe('시작 알림·자동 최신화 제거 (부록 O)', () => {
  it('깨어나도 시작 알림을 보내지 않는다. 계획이 없어도 start_nudge 행을 만들지 않는다', async () => {
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    electron.handlers.get('power:resume')?.()
    await vi.waitFor(() => expect(service.runDueMeetingBriefings).toHaveBeenCalledTimes(1))
    electron.handlers.get('power:unlock-screen')?.()
    await vi.waitFor(() => expect(service.runDueMeetingBriefings).toHaveBeenCalledTimes(2))
    expect(store.insertEvent).not.toHaveBeenCalled()
    expect(electron.notifications).toHaveLength(0)
  })

  it('창 포커스 처리기와 활동 구독을 등록하지 않는다', () => {
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    expect(electron.app.on).not.toHaveBeenCalledWith('browser-window-focus', expect.anything())
    expect(electron.handlers.has('app:browser-window-focus')).toBe(false)
    expect(activity.listener).toBeNull()
  })

  it('틱은 계획이 없어도 회의 브리핑을 보낸다', async () => {
    store.getPlanByDate.mockReturnValue(null)
    dueMeetingsReturn([meetingNotice()])
    await runTick()
    expect(electron.notifications).toHaveLength(1)
    expect(electron.notifications[0].opts.title).toBe('주간 회의 15분 전')
  })

  it('틱 순서는 closeStalePlans → 회의 브리핑 → onTick 이다', async () => {
    const onTick = vi.fn(() => {
      order.push('onTick')
    })
    dueMeetingsReturn([])
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn(), onTick })
    order.length = 0
    await runTick()
    expect(order).toEqual(['closeStalePlans', 'runDueMeetingBriefings', 'onTick'])
  })
})

describe('알림 클릭 이동과 보관 신호 (§12.1)', () => {
  it('창이 있고 로딩이 끝났으면 바로 navigate 를 보내고 보관 신호는 없다', () => {
    const win = fakeWindow()
    startAssistantScheduler({ getMainWindow: () => win as never, createWindow: vi.fn() })
    navigateToToday()
    expect(win.show).toHaveBeenCalled()
    expect(win.webContents.send).toHaveBeenCalledWith('assistant:navigate', { view: 'today' })
    expect(takePendingNavigate()).toBeNull()
  })

  it('창이 없으면 createWindow 를 부르고 보내지 않는다. 보관 신호는 1번만 꺼낸다', () => {
    let win: ReturnType<typeof fakeWindow> | null = null
    const createWindow = vi.fn(() => {
      win = fakeWindow(true)
    })
    startAssistantScheduler({ getMainWindow: () => win as never, createWindow })
    navigateToToday()
    expect(createWindow).toHaveBeenCalledTimes(1)
    const created = win as unknown as ReturnType<typeof fakeWindow>
    expect(created.webContents.send).not.toHaveBeenCalledWith('assistant:navigate', expect.anything())
    expect(takePendingNavigate()).toEqual({ view: 'today' })
    expect(takePendingNavigate()).toBeNull()
  })

  it('창이 로딩 중이면 띄우기만 하고 보내지 않는다. 보관 신호가 남는다', () => {
    const win = fakeWindow(true)
    const createWindow = vi.fn()
    startAssistantScheduler({ getMainWindow: () => win as never, createWindow })
    navigateToToday()
    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
    expect(createWindow).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalledWith('assistant:navigate', expect.anything())
    expect(takePendingNavigate()).toEqual({ view: 'today' })
  })

  it('로딩이 끝난 창으로 다시 이동하면 이전 보관 신호를 비운다', () => {
    const win = fakeWindow(true)
    startAssistantScheduler({ getMainWindow: () => win as never, createWindow: vi.fn() })
    navigateToToday()
    win.webContents.isLoading = () => false
    navigateToToday()
    expect(win.webContents.send).toHaveBeenCalledWith('assistant:navigate', { view: 'today' })
    expect(takePendingNavigate()).toBeNull()
  })

  it('60초가 지나면 보관 신호를 버리고 null 을 돌려준다', () => {
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    navigateToToday()
    expect(takePendingNavigate(Date.now() + 60_001)).toBeNull()
    expect(takePendingNavigate()).toBeNull()
  })

  it('60초 안이면 보관 신호를 돌려준다', () => {
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    navigateToToday()
    expect(takePendingNavigate(Date.now() + 59_000)).toEqual({ view: 'today' })
  })

  it('stopAssistantScheduler 후 보관 신호가 비어 있다', () => {
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    navigateToToday()
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

  it('A13: 시작·이벤트 처리기·정지가 getDatabase 예외에도 throw 하지 않는다', async () => {
    expect(() => startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })).not.toThrow()
    expect(() => electron.handlers.get('power:unlock-screen')?.()).not.toThrow()
    expect(() => electron.handlers.get('power:resume')?.()).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(() => stopAssistantScheduler()).not.toThrow()
  })

  it('A13: runTick 은 getDatabase 가 throw 해도 throw 하지 않는다', async () => {
    await expect(runTick()).resolves.toBeUndefined()
  })
})

describe('틱 (부록 E.2)', () => {
  it('setInterval 로 60초마다 틱을 돌린다. 정지하면 더 돌지 않는다', async () => {
    vi.useFakeTimers()
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(service.runDueMeetingBriefings).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(service.runDueMeetingBriefings).toHaveBeenCalledTimes(1)
    stopAssistantScheduler()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(service.runDueMeetingBriefings).toHaveBeenCalledTimes(1)
  })

  it('A18: closeStalePlans 가 닫으면 메인 창에 assistant:changed day 를 보낸다', async () => {
    const win = fakeWindow()
    startAssistantScheduler({ getMainWindow: () => win as never, createWindow: vi.fn() })
    store.closeStalePlans.mockReturnValue([3] as never)
    await runTick()
    expect(win.webContents.send).toHaveBeenCalledWith('assistant:changed', { date: '2026-11-02', reason: 'day' })

    win.webContents.send.mockClear()
    store.closeStalePlans.mockReturnValue([])
    await runTick()
    expect(win.webContents.send).not.toHaveBeenCalledWith('assistant:changed', expect.anything())
  })

  it('정지하면 처리기를 해제하고 변경 리스너를 비운다', () => {
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    stopAssistantScheduler()
    expect(electron.handlers.size).toBe(0)
    expect(service.setAssistantChangedListener).toHaveBeenLastCalledWith(null)
  })

  it('navigateToToday 는 인자가 없으면 focus 없이 보낸다 (트레이 오늘 보기)', () => {
    const win = fakeWindow()
    startAssistantScheduler({ getMainWindow: () => win as never, createWindow: vi.fn() })
    navigateToToday()
    expect(win.webContents.send).toHaveBeenCalledWith('assistant:navigate', { view: 'today' })
  })
})

describe('회의 브리핑 발송 (부록 I.9.2)', () => {
  it('A5: 회의 브리핑은 서비스 INSERT 뒤에 Notification show() 를 한다. 답장 입력이 없다', async () => {
    dueMeetingsReturn([meetingNotice()])
    await runTick()
    expect(order).toEqual(['closeStalePlans', 'runDueMeetingBriefings', 'insertEvent', 'new Notification', 'show'])
    expect(electron.notifications[0].opts).toEqual({ title: '주간 회의 15분 전', body: '링크워크 · 미완료 액션 2건' })
  })

  it('A5: 서비스가 돌려준 회의 알림이 없으면 Notification 을 만들지 않는다', async () => {
    dueMeetingsReturn([])
    await runTick()
    expect(service.runDueMeetingBriefings).toHaveBeenCalledTimes(1)
    expect(electron.notifications).toHaveLength(0)
  })

  it('A5: 회의 브리핑 show() 가 실패하면 그 행마다 failed 로 바꾼다', async () => {
    electron.state.throwOnShow = true
    dueMeetingsReturn([meetingNotice({ eventId: 41 }), meetingNotice({ eventId: 42 })])
    await runTick()
    expect(store.updateEventStatus).toHaveBeenCalledWith({}, 41, 'failed')
    expect(store.updateEventStatus).toHaveBeenCalledWith({}, 42, 'failed')
  })

  it('여러 건이면 모두 알린다', async () => {
    dueMeetingsReturn([meetingNotice({ eventId: 41 }), meetingNotice({ eventId: 42, title: '설계 리뷰 15분 전' })])
    await runTick()
    expect(electron.notifications.map((n) => n.opts.title)).toEqual(['주간 회의 15분 전', '설계 리뷰 15분 전'])
  })

  it('회의 브리핑 알림 클릭은 meeting focus 로 이동한다 (I.2)', async () => {
    const win = fakeWindow()
    startAssistantScheduler({ getMainWindow: () => win as never, createWindow: vi.fn() })
    dueMeetingsReturn([meetingNotice()])
    await runTick()
    electron.notifications[0].listeners.get('click')?.()
    expect(win.webContents.send).toHaveBeenLastCalledWith('assistant:navigate', {
      view: 'today',
      focus: { kind: 'meeting', id: '41' }
    })
  })

  it('창이 없을 때 회의 브리핑 알림을 클릭하면 meeting focus 를 보관 신호에 둔다 (부록 D.4)', async () => {
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    dueMeetingsReturn([meetingNotice()])
    await runTick()
    electron.notifications[0].listeners.get('click')?.()
    expect(takePendingNavigate()).toEqual({ view: 'today', focus: { kind: 'meeting', id: '41' } })
  })

  it('runDueMeetingBriefings 에 테스트가 주입한 now 를 넘기고, 실제 틱은 시각을 넘기지 않는다', async () => {
    const now = new Date(2026, 10, 2, 10, 1, 0)
    await runTick(false, now)
    expect(service.runDueMeetingBriefings).toHaveBeenLastCalledWith(now)
    await runTick()
    expect(service.runDueMeetingBriefings.mock.calls[1]).toEqual([undefined])
  })
})

describe('A42: 회의 브리핑은 1개만 실행한다', () => {
  it('A42: dueInFlight 가 켜져 있으면 두 번째 틱은 runDueMeetingBriefings 를 부르지 않는다', async () => {
    const gate = deferred()
    service.runDueMeetingBriefings.mockImplementationOnce(async () => {
      await gate.promise
      return []
    })
    const first = runTick()
    await vi.waitFor(() => expect(service.runDueMeetingBriefings).toHaveBeenCalledTimes(1))
    await runTick()
    expect(service.runDueMeetingBriefings).toHaveBeenCalledTimes(1)
    gate.resolve([])
    await first
    // 끝나면 가드를 푼다
    await runTick()
    expect(service.runDueMeetingBriefings).toHaveBeenCalledTimes(2)
  })

  it('A42: stopAssistantScheduler 가 dueInFlight 를 비운다', async () => {
    const gate = deferred()
    service.runDueMeetingBriefings.mockImplementationOnce(async () => {
      await gate.promise
      return []
    })
    const first = runTick()
    await vi.waitFor(() => expect(service.runDueMeetingBriefings).toHaveBeenCalledTimes(1))
    stopAssistantScheduler()
    await runTick()
    expect(service.runDueMeetingBriefings).toHaveBeenCalledTimes(2)
    gate.resolve([])
    await first
  })
})

describe('A13: 회의 브리핑 예외를 삼킨다', () => {
  it('A13: runDueMeetingBriefings 가 reject 해도 runTick 은 throw 하지 않고 가드를 푼다', async () => {
    service.runDueMeetingBriefings.mockRejectedValueOnce(new Error('Database not initialized'))
    await expect(runTick()).resolves.toBeUndefined()
    await runTick()
    expect(service.runDueMeetingBriefings).toHaveBeenCalledTimes(2)
  })
})

describe('A54: 틱 끝의 onTick 주입', () => {
  it('A54: 틱은 7단계 뒤에 onTick(wake=false, now) 를 부른다', async () => {
    const onTick = vi.fn(() => {
      order.push('onTick')
    })
    service.runDueMeetingBriefings.mockImplementation(async () => {
      order.push('runDueMeetingBriefings')
      return []
    })
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn(), onTick })
    const now = new Date(2026, 10, 2, 9, 40)
    await runTick(false, now)
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(onTick).toHaveBeenCalledWith(false, now)
    expect(order.indexOf('onTick')).toBeGreaterThan(order.indexOf('runDueMeetingBriefings'))
  })

  it('A54: wake 처리기도 onTick(wake=true) 를 부른다', async () => {
    const onTick = vi.fn()
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn(), onTick })
    electron.handlers.get('power:unlock-screen')?.()
    await vi.waitFor(() => expect(onTick).toHaveBeenCalled())
    expect(onTick.mock.calls[0][0]).toBe(true)
  })

  it('A54: 60초 틱이 onTick 을 부른다', async () => {
    vi.useFakeTimers()
    const onTick = vi.fn()
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn(), onTick })
    await vi.advanceTimersByTimeAsync(60_000)
    // 틱 본문의 await 를 모두 흘려 보낸다
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(onTick).toHaveBeenCalledTimes(1)
    expect(onTick.mock.calls[0][0]).toBe(false)
  })

  it('A54: onTick 을 기다리지 않는다. 끝나지 않는 onTick 도 틱을 막지 않는다', async () => {
    const gate = deferred()
    const onTick = vi.fn(() => gate.promise)
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn(), onTick })
    await expect(runTick()).resolves.toBeUndefined()
    await expect(runTick()).resolves.toBeUndefined()
    expect(onTick).toHaveBeenCalledTimes(2)
    gate.resolve(null)
  })

  it('A54: onTick 의 reject 를 삼킨다', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onTick = vi.fn(async () => {
      throw new Error('morning sync failed')
    })
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn(), onTick })
    await expect(runTick()).resolves.toBeUndefined()
    await new Promise((r) => setTimeout(r, 0))
    expect(errSpy).toHaveBeenCalledWith('[assistant-scheduler] onTick', expect.any(Error))
    errSpy.mockRestore()
  })

  it('A54: onTick 의 동기 throw 를 삼킨다', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onTick = vi.fn(() => {
      throw new Error('sync throw')
    })
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn(), onTick })
    await expect(runTick()).resolves.toBeUndefined()
    errSpy.mockRestore()
  })

  it('A54: 틱 단계가 getDatabase 예외로 끝나도 onTick 을 부른다', async () => {
    db.getDatabase.mockImplementation(() => {
      throw new Error('Database not initialized')
    })
    const onTick = vi.fn()
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn(), onTick })
    await expect(runTick()).resolves.toBeUndefined()
    expect(onTick).toHaveBeenCalledTimes(1)
  })

  it('A54: onTick 이 없어도 틱이 동작한다', async () => {
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn() })
    await expect(runTick()).resolves.toBeUndefined()
    expect(service.runDueMeetingBriefings).toHaveBeenCalledTimes(1)
  })

  it('A54: 정지하면 onTick 을 더 부르지 않는다', async () => {
    const onTick = vi.fn()
    startAssistantScheduler({ getMainWindow: () => null, createWindow: vi.fn(), onTick })
    stopAssistantScheduler()
    await runTick()
    expect(onTick).not.toHaveBeenCalled()
  })
})
