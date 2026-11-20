import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MobileServerStatus } from '../../mobile/contract'
import { useMobileStore } from '../../stores/mobileStore'
import { useTodayStore } from '../../stores/todayStore'
import { installMobileTodayPublisher } from './MobileTodayPublisher'

// 발행기가 휴대폰 열람 켜짐 상태를 따라 시작·정지하는지 고정한다.
// 실제 스토어를 쓰고 window.api.mobile 만 흉내 낸다. 오늘 스토어는 불러온 상태로 둬 첫 로드를 막는다.

const OFF: MobileServerStatus = { enabled: false, running: false, port: null, pairUrl: null, qrDataUrl: null, error: null, addresses: [], tailscale: 'not_installed' }
const ON: MobileServerStatus = {
  enabled: true,
  running: true,
  port: 8946,
  pairUrl: 'http://192.168.0.12:8946/pair?t=abc',
  qrDataUrl: 'data:image/svg+xml;base64,AA==',
  error: null,
  addresses: [],
  tailscale: 'not_installed'
}

let api: {
  getStatus: ReturnType<typeof vi.fn>
  setEnabled: ReturnType<typeof vi.fn>
  regenerateToken: ReturnType<typeof vi.fn>
  publishToday: ReturnType<typeof vi.fn>
  onPublishRequested: ReturnType<typeof vi.fn>
}
let unsubRequested: ReturnType<typeof vi.fn>

function setup(initial: MobileServerStatus): void {
  unsubRequested = vi.fn()
  api = {
    getStatus: vi.fn(async () => initial),
    setEnabled: vi.fn(async (enabled: boolean) => (enabled ? ON : OFF)),
    regenerateToken: vi.fn(async () => ON),
    publishToday: vi.fn(async () => ({ success: true })),
    onPublishRequested: vi.fn(() => unsubRequested)
  }
  vi.stubGlobal('window', { api: { mobile: api } })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 19, 9, 30))
  useMobileStore.setState({ status: null, loaded: false, busy: false, error: null })
  useTodayStore.setState({ lastSyncedAt: '2026-11-19T00:00:00.000Z', loading: false })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('installMobileTodayPublisher', () => {
  it('꺼져 있으면 publishToday 를 부르지 않는다', async () => {
    setup(OFF)
    const stop = installMobileTodayPublisher()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(api.getStatus).toHaveBeenCalledTimes(1)
    expect(api.publishToday).not.toHaveBeenCalled()
    expect(api.onPublishRequested).not.toHaveBeenCalled()
    stop()
  })

  it('켜져 있으면 1회 발행하고 재발행 요청을 구독한다', async () => {
    setup(ON)
    const stop = installMobileTodayPublisher()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.publishToday).toHaveBeenCalledTimes(1)
    const snap = api.publishToday.mock.calls[0][0]
    expect(snap).toMatchObject({ v: 1, date: '2026-11-19', heading: '11월 19일 (목)' })
    expect(api.onPublishRequested).toHaveBeenCalledTimes(1)

    // 메인이 재발행을 요청하면 발행한다(30초 안이 아니면 불러오기도 한다 — 여기서는 load 를 막아 둔다)
    const load = vi.spyOn(useTodayStore.getState(), 'load').mockResolvedValue()
    const cb = api.onPublishRequested.mock.calls[0][0] as () => void
    cb()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.publishToday).toHaveBeenCalledTimes(2)
    load.mockRestore()
    stop()
    expect(unsubRequested).toHaveBeenCalledTimes(1)
  })

  it('설정에서 켜고 끄면 즉시 시작·정지한다', async () => {
    setup(OFF)
    const stop = installMobileTodayPublisher()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.publishToday).not.toHaveBeenCalled()

    await useMobileStore.getState().setEnabled(true)
    expect(api.publishToday).toHaveBeenCalledTimes(1)

    await useMobileStore.getState().setEnabled(false)
    expect(unsubRequested).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(api.publishToday).toHaveBeenCalledTimes(1)
    stop()
  })
})
