// 모바일 서버 인증 유틸 — 토큰·쿠키·Host 검사·실패 속도 제한.
// electron 을 import 하지 않는다(Node 테스트에서 그대로 로드).
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

export const MOBILE_COOKIE_NAME = 'lw_mobile'
/** 30일 */
export const MOBILE_COOKIE_MAX_AGE = 2592000

/** 페어링 토큰: 32바이트 난수 base64url */
export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * 쿠키 값은 토큰에서 유도한다(토큰 자체는 쿠키에 넣지 않는다).
 * 같은 토큰이면 앱을 다시 켜도 같은 값이고, 토큰을 재발급하면 옛 쿠키는 맞지 않게 된다.
 */
export function deriveCookieValue(token: string): string {
  return createHmac('sha256', token).update('linkwork-mobile-cookie-v1').digest('base64url')
}

/** 길이가 달라도 예외 없이 상수 시간 비교한다(길이 차이는 해시로 감춘다) */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'linkwork-mobile-cmp').update(a).digest()
  const hb = createHmac('sha256', 'linkwork-mobile-cmp').update(b).digest()
  return timingSafeEqual(ha, hb) && a.length === b.length
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k && !(k in out)) out[k] = v
  }
  return out
}

/** 쿠키 헤더가 현재 토큰으로 만든 쿠키 값을 갖고 있는가. 토큰이 없으면 늘 false */
export function isCookieValid(cookieHeader: string | undefined, token: string | null): boolean {
  if (!token) return false
  const value = parseCookies(cookieHeader)[MOBILE_COOKIE_NAME]
  if (!value) return false
  return safeEqual(value, deriveCookieValue(token))
}

export function buildSessionCookie(token: string): string {
  return `${MOBILE_COOKIE_NAME}=${deriveCookieValue(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MOBILE_COOKIE_MAX_AGE}`
}

/**
 * Host 헤더가 `<허용 호스트>:<port>` 꼴인가 (DNS rebinding 방어).
 * 허용 호스트는 이 Mac 의 LAN IPv4·localhost·127.0.0.1 이다. 대소문자는 무시한다.
 */
export function isHostAllowed(
  hostHeader: string | undefined,
  port: number,
  allowedHosts: readonly string[]
): boolean {
  if (!hostHeader) return false
  const host = hostHeader.trim().toLowerCase()
  return allowedHosts.some((h) => host === `${h.toLowerCase()}:${port}`)
}

/**
 * 원격 주소별 인증 실패 속도 제한. windowMs 안에 max 회 실패하면 그 뒤 요청은 막는다.
 */
export class AuthFailureLimiter {
  private readonly failures = new Map<string, number[]>()

  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now
  ) {}

  private recent(addr: string): number[] {
    const cutoff = this.now() - this.windowMs
    const list = (this.failures.get(addr) ?? []).filter((t) => t > cutoff)
    if (list.length === 0) this.failures.delete(addr)
    else this.failures.set(addr, list)
    return list
  }

  isBlocked(addr: string): boolean {
    return this.recent(addr).length >= this.max
  }

  /** 올바른 토큰으로 페어링하면 그 주소의 실패 기록을 지운다 */
  clear(addr: string): void {
    this.failures.delete(addr)
  }

  recordFailure(addr: string): void {
    const list = this.recent(addr)
    list.push(this.now())
    this.failures.set(addr, list)
    // 주소가 끝없이 쌓이지 않게 가끔 비운다
    if (this.failures.size > 1000) {
      for (const key of [...this.failures.keys()]) this.recent(key)
    }
  }
}
