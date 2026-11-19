import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MobileAddress, MobileServerStatus } from '../../../mobile/contract'
import { useMobileStore } from '../../../stores/mobileStore'
import {
  MobileSectionView,
  REGENERATE_CONFIRM,
  addressKey,
  addressLabel,
  confirmAndRegenerate,
  maskPairUrl,
  resolveSelectedAddress,
  statusAddresses
} from './MobileSection'

// 설정 > 모바일 섹션. zustand v5 는 서버 렌더에서 초기 상태만 돌려주므로
// 실제 스토어를 돌린 뒤 그 상태를 표시 컴포넌트(MobileSectionView)에 넘겨 그린다.

const TOKEN = 'Zx9secretTOKENvalue_abcdefghijklmnopqrstu'
const LAN: MobileAddress = {
  kind: 'lan',
  iface: 'en0',
  ip: '192.168.0.12',
  pairUrl: `http://192.168.0.12:8946/pair?t=${TOKEN}`,
  qrDataUrl: 'data:image/svg+xml;base64,TEFO'
}
const WIRED: MobileAddress = {
  kind: 'lan',
  iface: 'en7',
  ip: '10.1.2.3',
  pairUrl: `http://10.1.2.3:8946/pair?t=${TOKEN}`,
  qrDataUrl: 'data:image/svg+xml;base64,V0lSRUQ='
}
const TS: MobileAddress = {
  kind: 'tailscale',
  iface: 'utun4',
  ip: '100.101.102.103',
  pairUrl: `http://100.101.102.103:8946/pair?t=${TOKEN}`,
  qrDataUrl: 'data:image/svg+xml;base64,VFM='
}
const OFF: MobileServerStatus = {
  enabled: false,
  running: false,
  port: null,
  pairUrl: null,
  qrDataUrl: null,
  error: null,
  addresses: [],
  tailscale: 'not_installed'
}
const ON: MobileServerStatus = {
  enabled: true,
  running: true,
  port: 8946,
  pairUrl: LAN.pairUrl,
  qrDataUrl: LAN.qrDataUrl,
  error: null,
  addresses: [LAN],
  tailscale: 'not_installed'
}

let api: {
  getStatus: ReturnType<typeof vi.fn>
  setEnabled: ReturnType<typeof vi.fn>
  regenerateToken: ReturnType<typeof vi.fn>
  publishToday: ReturnType<typeof vi.fn>
  onPublishRequested: ReturnType<typeof vi.fn>
}

const renderStore = (selectedKey: string | null = null): string => {
  const s = useMobileStore.getState()
  return renderToStaticMarkup(
    <MobileSectionView
      status={s.status}
      loaded={s.loaded}
      busy={s.busy}
      error={s.error}
      selectedKey={selectedKey}
      onToggle={() => {}}
      onRegenerate={() => {}}
      onCopy={() => {}}
    />
  )
}

beforeEach(() => {
  api = {
    getStatus: vi.fn(async () => OFF),
    setEnabled: vi.fn(async (enabled: boolean) => (enabled ? ON : OFF)),
    regenerateToken: vi.fn(async () => ({
      ...ON,
      pairUrl: 'http://192.168.0.12:8946/pair?t=NEWTOKEN123',
      addresses: [{ ...LAN, pairUrl: 'http://192.168.0.12:8946/pair?t=NEWTOKEN123' }]
    })),
    publishToday: vi.fn(async () => ({ success: true })),
    onPublishRequested: vi.fn(() => () => {})
  }
  vi.stubGlobal('window', { api: { mobile: api } })
  useMobileStore.setState({ status: null, loaded: false, busy: false, error: null })
})

describe('MobileSection', () => {
  it('꺼짐 상태에서는 QR 이 없고 주의 문구는 보인다', async () => {
    await useMobileStore.getState().load()
    const html = renderStore()
    expect(html).toContain('휴대폰에서 보기 켜기')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('QR 다시 만들기')
    expect(html).toContain('공용 Wi-Fi')
    expect(html).toContain('잠자기')
    expect(html).toContain('들어오는 연결 허용')
    expect(html).toContain('기기 간 통신')
  })

  it('켜면 setEnabled(true) 를 부르고 QR·안내·주소 복사가 보인다', async () => {
    await useMobileStore.getState().load()
    await useMobileStore.getState().setEnabled(true)
    expect(api.setEnabled).toHaveBeenCalledWith(true)
    const html = renderStore()
    expect(html).toContain(`src="${ON.qrDataUrl}"`)
    expect(html).toContain('같은 Wi-Fi')
    expect(html).toContain('QR 을 스캔')
    expect(html).toContain('홈 화면에 추가')
    expect(html).toContain('주소 복사')
    expect(html).toContain('QR 다시 만들기')
    expect(html).toContain('http://192.168.0.12:8946/pair?t=')
  })

  it('화면에 토큰 원문이 텍스트로 노출되지 않는다', async () => {
    await useMobileStore.getState().setEnabled(true)
    const html = renderStore()
    expect(html).not.toContain(TOKEN)
    expect(maskPairUrl(ON.pairUrl!)).not.toContain(TOKEN)
    expect(maskPairUrl(ON.pairUrl!)).toMatch(/^http:\/\/192\.168\.0\.12:8946\/pair\?t=•+$/)
  })

  it('서버가 돌려준 error 를 경고 문구로 보인다', async () => {
    api.setEnabled.mockResolvedValueOnce({ ...OFF, enabled: true, error: '포트 8946~8955 가 모두 사용 중입니다' })
    await useMobileStore.getState().setEnabled(true)
    const html = renderStore()
    expect(html).toContain('포트 8946~8955 가 모두 사용 중입니다')
    expect(html).not.toContain('<img')
  })

  it('IPC 가 실패하면 그 문구를 보인다', async () => {
    api.setEnabled.mockRejectedValueOnce(new Error('IPC 실패'))
    await useMobileStore.getState().setEnabled(true)
    expect(useMobileStore.getState().busy).toBe(false)
    expect(renderStore()).toContain('IPC 실패')
  })

  it('켜져 있는데 pairUrl 이 없으면 Wi-Fi 주소를 찾지 못했다고 안내한다', () => {
    useMobileStore.setState({ status: { ...ON, pairUrl: null, qrDataUrl: null, addresses: [] }, loaded: true })
    const html = renderStore()
    expect(html).toContain('Wi-Fi 주소를 찾지 못했어요')
    expect(html).not.toContain('<img')
  })

  it('처리 중에는 토글이 비활성이다', () => {
    useMobileStore.setState({ status: OFF, loaded: true, busy: true })
    expect(renderStore()).toMatch(/<input type="checkbox" disabled=""/)
  })

  it('QR 다시 만들기는 확인을 받은 뒤에만 regenerateToken 을 부른다', async () => {
    useMobileStore.setState({ status: ON, loaded: true })
    const regenerate = (): Promise<void> => useMobileStore.getState().regenerate()

    const deny = vi.fn(() => false)
    expect(await confirmAndRegenerate(deny, regenerate)).toBe(false)
    expect(deny).toHaveBeenCalledWith(REGENERATE_CONFIRM)
    expect(api.regenerateToken).not.toHaveBeenCalled()

    const accept = vi.fn(() => true)
    expect(await confirmAndRegenerate(accept, regenerate)).toBe(true)
    expect(api.regenerateToken).toHaveBeenCalledTimes(1)
    expect(useMobileStore.getState().status?.pairUrl).toContain('NEWTOKEN123')
    expect(REGENERATE_CONFIRM).toContain('다시 스캔')
  })
})

describe('MobileSection 상태 재조회', () => {
  it('10초마다와 창 focus 때 다시 읽고, 처리 중이면 생략하며, 해제하면 멈춘다', async () => {
    vi.useFakeTimers()
    try {
      const { startStatusPolling, STATUS_REFRESH_MS } = await import('./MobileSection')
      let busy = false
      let focusCb: (() => void) | null = null
      const unsubFocus = vi.fn()
      const refresh = vi.fn()
      const stop = startStatusPolling({
        isBusy: () => busy,
        refresh,
        onFocus: (cb) => {
          focusCb = cb
          return unsubFocus
        }
      })
      expect(STATUS_REFRESH_MS).toBe(10_000)
      vi.advanceTimersByTime(STATUS_REFRESH_MS)
      expect(refresh).toHaveBeenCalledTimes(1)
      focusCb!()
      expect(refresh).toHaveBeenCalledTimes(2)
      busy = true
      vi.advanceTimersByTime(STATUS_REFRESH_MS)
      focusCb!()
      expect(refresh).toHaveBeenCalledTimes(2)
      busy = false
      stop()
      expect(unsubFocus).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(STATUS_REFRESH_MS * 3)
      expect(refresh).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('스토어 refresh 는 새 상태(바뀐 IP)를 반영하고, 처리 중이면 getStatus 를 부르지 않는다', async () => {
    useMobileStore.setState({ status: ON, loaded: true })
    const movedAddr = { ...LAN, ip: '10.0.0.5', pairUrl: 'http://10.0.0.5:8946/pair?t=x', qrDataUrl: 'data:image/svg+xml;base64,QQ==' }
    const moved = { ...ON, pairUrl: movedAddr.pairUrl, qrDataUrl: movedAddr.qrDataUrl, addresses: [movedAddr] }
    api.getStatus.mockResolvedValueOnce(moved)
    await useMobileStore.getState().refresh()
    expect(useMobileStore.getState().status).toEqual(moved)

    useMobileStore.setState({ busy: true })
    api.getStatus.mockClear()
    await useMobileStore.getState().refresh()
    expect(api.getStatus).not.toHaveBeenCalled()
  })

  it('getStatus 가 실패해도 직전 상태를 유지한다', async () => {
    useMobileStore.setState({ status: ON, loaded: true })
    api.getStatus.mockRejectedValueOnce(new Error('x'))
    await useMobileStore.getState().refresh()
    expect(useMobileStore.getState().status).toEqual(ON)
    expect(useMobileStore.getState().error).toBeNull()
  })

  it('홈 화면 추가 안내는 단정하지 않고 Safari 책갈피를 안내한다', () => {
    useMobileStore.setState({ status: ON, loaded: true })
    const html = renderStore()
    expect(html).toContain('홈 화면에 추가')
    expect(html).toContain('Safari 책갈피')
  })
})

describe('MobileSection 주소 선택 (Tailscale)', () => {
  const tabs = (html: string): string[] => [...html.matchAll(/data-address="([^"]+)"/g)].map((m) => m[1])

  it('주소가 1개면 선택 UI 없이 그 QR 만 보인다', () => {
    useMobileStore.setState({ status: ON, loaded: true })
    const html = renderStore()
    expect(html).not.toContain('role="tablist"')
    expect(html).toContain(`src="${LAN.qrDataUrl}"`)
  })

  it('lan+tailscale 이면 선택 UI 가 보이고, 고른 주소에 따라 QR·주소가 바뀐다', () => {
    useMobileStore.setState({ status: { ...ON, addresses: [LAN, TS], tailscale: 'connected' }, loaded: true })
    const first = renderStore()
    expect(first).toContain('role="tablist"')
    expect(tabs(first)).toEqual([addressKey(LAN), addressKey(TS)])
    expect(first).toContain('같은 네트워크')
    expect(first).toContain('어디서나 (Tailscale)')
    expect(first).toContain(`src="${LAN.qrDataUrl}"`)
    expect(first).not.toContain(`src="${TS.qrDataUrl}"`)
    expect(first).toContain('같은 Wi-Fi 에 연결')

    const ts = renderStore(addressKey(TS))
    expect(ts).toContain(`src="${TS.qrDataUrl}"`)
    expect(ts).not.toContain(`src="${LAN.qrDataUrl}"`)
    expect(ts).toContain('http://100.101.102.103:8946/pair?t=')
    expect(ts).toContain('휴대폰에서 Tailscale 을 켭니다')
    expect(ts).toMatch(new RegExp(`aria-selected="true" data-address="${addressKey(TS).replace(/[|.]/g, '\\$&')}"`))
  })

  it('lan 주소가 2개면 인터페이스·IP 로 구분한다', () => {
    const list = [LAN, WIRED, TS]
    expect(addressLabel(LAN, list)).toBe('Wi-Fi·유선 (en0 · 192.168.0.12)')
    expect(addressLabel(WIRED, list)).toBe('Wi-Fi·유선 (en7 · 10.1.2.3)')
    expect(addressLabel(TS, list)).toBe('어디서나 (Tailscale)')
    useMobileStore.setState({ status: { ...ON, addresses: list, tailscale: 'connected' }, loaded: true })
    const html = renderStore(addressKey(WIRED))
    expect(html).toContain('Wi-Fi·유선 (en0 · 192.168.0.12)')
    expect(html).toContain(`src="${WIRED.qrDataUrl}"`)
  })

  it('고른 주소가 사라지면 첫 주소로 돌아간다', () => {
    expect(resolveSelectedAddress([LAN, TS], addressKey(TS))).toBe(TS)
    expect(resolveSelectedAddress([LAN], addressKey(TS))).toBe(LAN)
    expect(resolveSelectedAddress([], addressKey(TS))).toBeNull()
    useMobileStore.setState({ status: ON, loaded: true })
    expect(renderStore(addressKey(TS))).toContain(`src="${LAN.qrDataUrl}"`)
  })

  it('tailscale 상태 3종에 맞는 안내를 보인다', () => {
    useMobileStore.setState({ status: { ...ON, tailscale: 'not_installed' }, loaded: true })
    const none = renderStore()
    expect(none).toContain('Tailscale 이 필요해요')
    expect(none).toContain('href="https://tailscale.com/download"')
    expect(none).toContain('같은 계정으로 로그인')

    useMobileStore.setState({ status: { ...ON, tailscale: 'installed' }, loaded: true })
    const off = renderStore()
    expect(off).toContain('Tailscale 이 꺼져 있어요')
    expect(off).toContain('메뉴 막대')
    expect(off).not.toContain('Tailscale 이 필요해요')

    useMobileStore.setState({ status: { ...ON, addresses: [LAN, TS], tailscale: 'connected' }, loaded: true })
    const on = renderStore()
    expect(on).toContain('휴대폰에서도 Tailscale 이 켜져 있어야 열려요')
    expect(on).toContain('한 번 더 스캔')
    expect(on).not.toContain('Tailscale 이 꺼져 있어요')
  })

  it('주의 문구는 같은 네트워크(HTTP 평문)와 Tailscale(암호화)을 구분한다', () => {
    const html = renderStore()
    expect(html).toContain('같은 네트워크 주소는 암호화되지 않은 HTTP')
    expect(html).toContain('Tailscale 로 암호화')
  })

  it('addresses 가 없는 옛 응답도 pairUrl 로 QR 을 보인다', () => {
    const legacy = { ...ON } as Partial<MobileServerStatus>
    delete legacy.addresses
    delete legacy.tailscale
    const status = legacy as MobileServerStatus
    expect(statusAddresses(status)).toEqual([
      { kind: 'lan', iface: '', ip: '192.168.0.12', pairUrl: LAN.pairUrl, qrDataUrl: LAN.qrDataUrl }
    ])
    useMobileStore.setState({ status, loaded: true })
    const html = renderStore()
    expect(html).toContain(`src="${LAN.qrDataUrl}"`)
    expect(html).not.toContain('role="tablist"')
    expect(html).not.toContain('data-tailscale')
    // 꺼진 옛 응답
    expect(statusAddresses({ ...status, pairUrl: null, qrDataUrl: null })).toEqual([])
  })

  it('여러 주소를 보여도 토큰 원문은 텍스트로 노출되지 않는다', () => {
    useMobileStore.setState({ status: { ...ON, addresses: [LAN, WIRED, TS], tailscale: 'connected' }, loaded: true })
    for (const key of [null, addressKey(WIRED), addressKey(TS)]) {
      expect(renderStore(key)).not.toContain(TOKEN)
    }
  })
})
