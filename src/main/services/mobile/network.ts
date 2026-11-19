// 주소 계산 — 페어링 URL(QR) 목록과 Host 허용 목록에 쓴다. electron 을 import 하지 않는다.
import { existsSync } from 'fs'
import { networkInterfaces, type NetworkInterfaceInfo } from 'os'
import type { MobileTailscaleState } from './types'

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>

function isIPv4(info: NetworkInterfaceInfo): boolean {
  // Node 18 이전에는 family 가 숫자 4 였다
  return info.family === 'IPv4' || (info.family as unknown) === 4
}

function sortedNames(ifaces: Interfaces): string[] {
  return Object.keys(ifaces).sort((a, b) => (a === 'en0' ? -1 : b === 'en0' ? 1 : 0))
}

/** internal 이 아닌 IPv4 전체. en0 을 맨 앞에 둔다 — Host 허용 목록의 바탕 */
export function listLanIPv4(ifaces: Interfaces = networkInterfaces()): string[] {
  const out: string[] = []
  for (const name of sortedNames(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (isIPv4(info) && !info.internal && !out.includes(info.address)) out.push(info.address)
    }
  }
  return out
}

/** 대표 주소(en0 우선). 없으면 null */
export function primaryLanIPv4(ifaces: Interfaces = networkInterfaces()): string | null {
  return listLanIPv4(ifaces)[0] ?? null
}

/** Host 헤더에서 허용할 호스트 이름: internal 아닌 IPv4 전체 + localhost + 127.0.0.1 */
export function allowedHostNames(ifaces: Interfaces = networkInterfaces()): string[] {
  return [...listLanIPv4(ifaces), 'localhost', '127.0.0.1']
}

// ── 휴대폰에 보여 줄 주소(QR) 목록 ──

export type PairAddressKind = 'lan' | 'tailscale'

export interface PairAddress {
  iface: string
  ip: string
  kind: PairAddressKind
}

function octets(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  return n.every((x) => x >= 0 && x <= 255) ? n : null
}

/** 100.64.0.0/10 (CGNAT — Tailscale 이 쓰는 대역): 첫 옥텟 100, 둘째 옥텟 64~127 */
export function isTailscaleIPv4(ip: string): boolean {
  const o = octets(ip)
  return o !== null && o[0] === 100 && o[1] >= 64 && o[1] <= 127
}

/** 169.254.0.0/16 링크 로컬(DHCP 실패 등) — 휴대폰이 닿을 수 없다 */
export function isLinkLocalIPv4(ip: string): boolean {
  const o = octets(ip)
  return o !== null && o[0] === 169 && o[1] === 254
}

/**
 * 가상 브리지·호스트 전용 네트워크(가상머신·Docker·인터넷 공유·AirDrop 등). 휴대폰이 닿는 주소가 아니다.
 */
const VIRTUAL_IFACE_RE = /^(?:bridge|vmnet|vnic|vboxnet|docker|veth|awdl|llw|anpi|ap\d|gif|stf)/i
/** 터널 인터페이스. 100.64/10 이 아닌 주소는 다른 VPN(회사 VPN 등)이라 QR 에서 뺀다 */
const TUNNEL_IFACE_RE = /^(?:utun|tun|tap|ipsec|ppp)/i

/**
 * QR 로 보여 줄 주소 목록. 순서: lan(en0 우선) → tailscale.
 * - 링크 로컬(169.254/16)·가상 브리지 인터페이스·터널의 비-Tailscale 주소는 뺀다(Host 허용에는 남는다).
 * - 100.64/10 은 인터페이스 이름과 관계없이 tailscale 이다.
 */
export function listPairAddresses(ifaces: Interfaces = networkInterfaces()): PairAddress[] {
  const lan: PairAddress[] = []
  const ts: PairAddress[] = []
  const seen = new Set<string>()
  for (const name of sortedNames(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (!isIPv4(info) || info.internal || seen.has(info.address)) continue
      const ip = info.address
      if (isTailscaleIPv4(ip)) {
        seen.add(ip)
        ts.push({ iface: name, ip, kind: 'tailscale' })
        continue
      }
      if (isLinkLocalIPv4(ip) || VIRTUAL_IFACE_RE.test(name) || TUNNEL_IFACE_RE.test(name)) continue
      seen.add(ip)
      lan.push({ iface: name, ip, kind: 'lan' })
    }
  }
  return [...lan, ...ts]
}

export const TAILSCALE_INSTALL_PATHS: readonly string[] = [
  '/Applications/Tailscale.app',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale'
]

/**
 * Tailscale 상태. 외부 프로세스(tailscale status)는 실행하지 않는다.
 * tailscale 주소가 있으면 connected, 설치 흔적만 있으면 installed, 둘 다 없으면 not_installed.
 */
export function detectTailscale(
  addresses: readonly PairAddress[],
  exists: (path: string) => boolean = existsSync
): MobileTailscaleState {
  if (addresses.some((a) => a.kind === 'tailscale')) return 'connected'
  return TAILSCALE_INSTALL_PATHS.some((p) => {
    try {
      return exists(p)
    } catch {
      return false
    }
  })
    ? 'installed'
    : 'not_installed'
}
