import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MobileServerStatus } from '../mobile/contract'
import { useMobileStore } from './mobileStore'

// 휴대폰 열람 상태 스토어 (docs/MOBILE_VIEW.md). window.api.mobile 만 흉내 낸다.

const OFF: MobileServerStatus = { enabled: false, running: false, port: null, pairUrl: null, qrDataUrl: null, error: null, addresses: [], tailscale: 'not_installed' }
const ON: MobileServerStatus = { ...OFF, enabled: true, running: true, port: 8946, pairUrl: 'http://x/pair?t=a', qrDataUrl: 'data:,' }

beforeEach(() => {
  useMobileStore.setState({ status: null, loaded: false, busy: false, error: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mobileStore', () => {
  it('load 는 상태를 읽어 둔다', async () => {
    vi.stubGlobal('window', { api: { mobile: { getStatus: vi.fn(async () => ON) } } })
    await useMobileStore.getState().load()
    expect(useMobileStore.getState()).toMatchObject({ status: ON, loaded: true, error: null })
  })

  it('처리 중에는 busy 이고, 끝나면 결과 상태로 바꾼다. 처리 중 재요청은 무시한다', async () => {
    let resolve!: (s: MobileServerStatus) => void
    const setEnabled = vi.fn(() => new Promise<MobileServerStatus>((r) => (resolve = r)))
    vi.stubGlobal('window', { api: { mobile: { setEnabled } } })
    const p = useMobileStore.getState().setEnabled(true)
    expect(useMobileStore.getState().busy).toBe(true)
    await useMobileStore.getState().setEnabled(false)
    expect(setEnabled).toHaveBeenCalledTimes(1)
    resolve(ON)
    await p
    expect(useMobileStore.getState()).toMatchObject({ status: ON, busy: false })
  })

  it('preload 에 mobile API 가 없으면 안내 문구를 둔다', async () => {
    vi.stubGlobal('window', { api: {} })
    await useMobileStore.getState().load()
    expect(useMobileStore.getState().loaded).toBe(true)
    expect(useMobileStore.getState().error).toContain('쓸 수 없습니다')
  })
})
