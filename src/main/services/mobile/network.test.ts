import { describe, expect, it, vi } from 'vitest'
import {
  allowedHostNames,
  detectTailscale,
  isTailscaleIPv4,
  listPairAddresses,
  TAILSCALE_INSTALL_PATHS
} from './network'
import { buildMobileStatus, createQrCache, pairUrlFor } from './status'

type Ifaces = Parameters<typeof listPairAddresses>[0]
const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal })

describe('주소 분류', () => {
  it('100.64.0.0/10 만 tailscale (100.63·100.128 은 아님)', () => {
    expect(isTailscaleIPv4('100.63.255.255')).toBe(false)
    expect(isTailscaleIPv4('100.64.0.1')).toBe(true)
    expect(isTailscaleIPv4('100.100.1.1')).toBe(true)
    expect(isTailscaleIPv4('100.127.255.254')).toBe(true)
    expect(isTailscaleIPv4('100.128.0.1')).toBe(false)
    expect(isTailscaleIPv4('10.64.0.1')).toBe(false)
    expect(isTailscaleIPv4('not-an-ip')).toBe(false)

    const ifaces = {
      en7: [v4('100.63.0.5')],
      en8: [v4('100.128.0.5')],
      utun3: [v4('100.64.0.9')]
    } as unknown as Ifaces
    expect(listPairAddresses(ifaces)).toEqual([
      { iface: 'en7', ip: '100.63.0.5', kind: 'lan' },
      { iface: 'en8', ip: '100.128.0.5', kind: 'lan' },
      { iface: 'utun3', ip: '100.64.0.9', kind: 'tailscale' }
    ])
  })

  it('순서 lan(en0 우선) → tailscale, 링크 로컬·가상 브리지·다른 VPN·IPv6·internal 은 QR 목록에서 뺀다', () => {
    const ifaces = {
      lo0: [v4('127.0.0.1', true)],
      utun4: [v4('100.101.102.103'), { address: 'fd7a:115c::1', family: 'IPv6', internal: false }],
      en5: [v4('10.0.0.3')],
      en0: [v4('192.168.0.7'), { address: 'fe80::1', family: 'IPv6', internal: false }],
      en9: [v4('169.254.10.20')],
      bridge100: [v4('192.168.64.1')],
      vmnet8: [v4('172.16.10.1')],
      utun7: [v4('10.8.0.2')]
    } as unknown as Ifaces
    expect(listPairAddresses(ifaces)).toEqual([
      { iface: 'en0', ip: '192.168.0.7', kind: 'lan' },
      { iface: 'en5', ip: '10.0.0.3', kind: 'lan' },
      { iface: 'utun4', ip: '100.101.102.103', kind: 'tailscale' }
    ])
    // Host 허용은 기존대로 internal 아닌 IPv4 전체 + localhost
    expect(allowedHostNames(ifaces)).toEqual([
      '192.168.0.7',
      '100.101.102.103',
      '10.0.0.3',
      '169.254.10.20',
      '192.168.64.1',
      '172.16.10.1',
      '10.8.0.2',
      'localhost',
      '127.0.0.1'
    ])
  })
})

describe('Tailscale 상태', () => {
  const ts = [{ iface: 'utun4', ip: '100.100.1.1', kind: 'tailscale' as const }]
  const lan = [{ iface: 'en0', ip: '192.168.0.7', kind: 'lan' as const }]

  it('주소가 있으면 connected (파일 확인 없이)', () => {
    const exists = vi.fn(() => false)
    expect(detectTailscale([...lan, ...ts], exists)).toBe('connected')
  })

  it('설치 경로 중 하나라도 있으면 installed', () => {
    for (const path of TAILSCALE_INSTALL_PATHS) {
      expect(detectTailscale(lan, (p) => p === path)).toBe('installed')
    }
  })

  it('둘 다 없으면 not_installed, 확인 중 예외도 없음으로 본다', () => {
    expect(detectTailscale(lan, () => false)).toBe('not_installed')
    expect(
      detectTailscale([], () => {
        throw new Error('EACCES')
      })
    ).toBe('not_installed')
  })
})

describe('상태 조립', () => {
  const addresses = [
    { iface: 'en0', ip: '192.168.0.7', kind: 'lan' as const },
    { iface: 'utun4', ip: '100.100.1.1', kind: 'tailscale' as const }
  ]

  it('주소마다 pairUrl·QR, pairUrl·qrDataUrl 은 addresses[0] 과 같다', () => {
    const s = buildMobileStatus({
      enabled: true,
      running: true,
      port: 8946,
      getToken: () => 'tok',
      lastError: null,
      addresses,
      tailscale: 'connected',
      qr: (u) => `QR(${u})`
    })
    expect(s.addresses).toEqual([
      { kind: 'lan', iface: 'en0', ip: '192.168.0.7', pairUrl: 'http://192.168.0.7:8946/pair?t=tok', qrDataUrl: 'QR(http://192.168.0.7:8946/pair?t=tok)' },
      { kind: 'tailscale', iface: 'utun4', ip: '100.100.1.1', pairUrl: 'http://100.100.1.1:8946/pair?t=tok', qrDataUrl: 'QR(http://100.100.1.1:8946/pair?t=tok)' }
    ])
    expect(s.pairUrl).toBe(s.addresses[0].pairUrl)
    expect(s.qrDataUrl).toBe(s.addresses[0].qrDataUrl)
    expect(s.tailscale).toBe('connected')
    expect(s.error).toBeNull()
  })

  it('꺼져 있으면 addresses 는 빈 배열, pairUrl·qrDataUrl 은 null, 토큰을 읽지 않는다', () => {
    const getToken = vi.fn(() => 'tok')
    const s = buildMobileStatus({
      enabled: false,
      running: false,
      port: null,
      getToken,
      lastError: null,
      addresses,
      tailscale: 'installed',
      qr: () => 'QR'
    })
    expect(s).toMatchObject({ addresses: [], pairUrl: null, qrDataUrl: null, port: null, tailscale: 'installed' })
    expect(getToken).not.toHaveBeenCalled()
  })

  it('켜졌지만 주소가 없으면 안내 오류', () => {
    const s = buildMobileStatus({
      enabled: true,
      running: true,
      port: 8946,
      getToken: () => 'tok',
      lastError: null,
      addresses: [],
      tailscale: 'not_installed',
      qr: () => 'QR'
    })
    expect(s.addresses).toEqual([])
    expect(s.pairUrl).toBeNull()
    expect(s.error).toBeTruthy()
  })

  it('QR 캐시: 같은 (token, ip, port) 는 다시 만들지 않고, 토큰·포트가 바뀌면 새로 만든다', () => {
    const make = vi.fn((u: string) => `QR(${u})`)
    const cache = createQrCache(make)
    const input = {
      enabled: true,
      running: true,
      port: 8946,
      getToken: () => 'tok',
      lastError: null,
      addresses,
      tailscale: 'connected' as const,
      qr: cache.get
    }
    for (let i = 0; i < 5; i++) buildMobileStatus(input)
    expect(make).toHaveBeenCalledTimes(2)
    buildMobileStatus({ ...input, getToken: () => 'tok2' })
    expect(make).toHaveBeenCalledTimes(4)
    buildMobileStatus({ ...input, port: 8947 })
    expect(make).toHaveBeenCalledTimes(6)
    expect(pairUrlFor('1.2.3.4', 1, 'a b')).toBe('http://1.2.3.4:1/pair?t=a%20b')
  })

  it('실제 QR 생성기로 SVG data URL 을 만든다', () => {
    const cache = createQrCache()
    expect(cache.get('http://100.100.1.1:8946/pair?t=x').startsWith('data:image/svg+xml')).toBe(true)
  })
})
