// MobileServerStatus 조립 — electron 없이 테스트할 수 있게 controller 에서 떼어 냈다.
import { qrSvgDataUrl } from './qr'
import type { PairAddress } from './network'
import type { MobileAddress, MobileServerStatus, MobileTailscaleState } from './types'

export function pairUrlFor(ip: string, port: number, token: string): string {
  return `http://${ip}:${port}/pair?t=${encodeURIComponent(token)}`
}

/**
 * pairUrl → QR 캐시. 설정 화면이 상태를 10초마다 읽어도 QR 을 다시 만들지 않는다.
 * 키는 (token, ip, port) 를 담은 pairUrl 자체다. 토큰을 재발급하면 옛 항목은 버린다.
 */
export function createQrCache(make: (text: string) => string = qrSvgDataUrl): {
  get: (pairUrl: string) => string
  readonly size: number
} {
  const cache = new Map<string, string>()
  return {
    get(pairUrl) {
      let v = cache.get(pairUrl)
      if (v === undefined) {
        v = make(pairUrl)
        if (cache.size >= 32) cache.clear()
        cache.set(pairUrl, v)
      }
      return v
    },
    get size() {
      return cache.size
    }
  }
}

export interface StatusInput {
  enabled: boolean
  running: boolean
  port: number | null
  /** running 일 때만 부른다 */
  getToken: () => string
  lastError: string | null
  addresses: readonly PairAddress[]
  tailscale: MobileTailscaleState
  qr: (pairUrl: string) => string
}

export function buildMobileStatus(input: StatusInput): MobileServerStatus {
  const { enabled, running, tailscale } = input
  const port = running ? input.port : null
  const addresses: MobileAddress[] = []
  if (running && port) {
    const token = input.getToken()
    for (const a of input.addresses) {
      const pairUrl = pairUrlFor(a.ip, port, token)
      addresses.push({ kind: a.kind, iface: a.iface, ip: a.ip, pairUrl, qrDataUrl: input.qr(pairUrl) })
    }
  }
  let error = input.lastError
  if (running && addresses.length === 0 && !error) error = 'Wi-Fi·Tailscale 등 휴대폰이 닿을 주소를 찾지 못했습니다.'
  return {
    enabled,
    running,
    port,
    pairUrl: addresses[0]?.pairUrl ?? null,
    qrDataUrl: addresses[0]?.qrDataUrl ?? null,
    error,
    addresses,
    tailscale
  }
}
