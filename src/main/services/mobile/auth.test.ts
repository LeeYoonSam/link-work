import { describe, expect, it } from 'vitest'
import { join, resolve } from 'path'
import {
  AuthFailureLimiter,
  deriveCookieValue,
  generateToken,
  isCookieValid,
  isHostAllowed,
  parseCookies,
  safeEqual
} from './auth'
import { computeAssetAllowlist, contentTypeFor, cssAssetRefs, htmlAssetRefs, jsAssetRefs, resolveAssetPath } from './static'
import { MAX_SNAPSHOT_BYTES, validateSnapshot } from './snapshot'
import { allowedHostNames, listLanIPv4, primaryLanIPv4 } from './network'
import { qrSvgDataUrl } from './qr'

describe('토큰·쿠키', () => {
  it('토큰은 32바이트 base64url, 매번 다르다', () => {
    const a = generateToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateToken()).not.toBe(a)
  })

  it('쿠키 값은 토큰에서 결정적으로 유도되고 토큰과 다르다', () => {
    expect(deriveCookieValue('t1')).toBe(deriveCookieValue('t1'))
    expect(deriveCookieValue('t1')).not.toBe(deriveCookieValue('t2'))
    expect(deriveCookieValue('t1')).not.toContain('t1')
  })

  it('isCookieValid: 현재 토큰의 쿠키만 통과', () => {
    const c = `a=1; lw_mobile=${deriveCookieValue('tok')}; b=2`
    expect(isCookieValid(c, 'tok')).toBe(true)
    expect(isCookieValid(c, 'other')).toBe(false)
    expect(isCookieValid(c, null)).toBe(false)
    expect(isCookieValid(undefined, 'tok')).toBe(false)
    expect(isCookieValid('lw_mobile=tok', 'tok')).toBe(false)
    expect(parseCookies('x=1; y = 2;bad')).toEqual({ x: '1', y: '2' })
  })

  it('safeEqual: 길이가 달라도 예외 없이 false', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', 'a')).toBe(false)
  })

  it('isHostAllowed: 허용 호스트 + 정확한 포트만', () => {
    const hosts = ['192.168.0.5', 'localhost', '127.0.0.1']
    expect(isHostAllowed('192.168.0.5:8946', 8946, hosts)).toBe(true)
    expect(isHostAllowed('LOCALHOST:8946', 8946, hosts)).toBe(true)
    expect(isHostAllowed('192.168.0.5', 8946, hosts)).toBe(false)
    expect(isHostAllowed('192.168.0.5:8947', 8946, hosts)).toBe(false)
    expect(isHostAllowed('evil.com:8946', 8946, hosts)).toBe(false)
    expect(isHostAllowed(undefined, 8946, hosts)).toBe(false)
  })

  it('AuthFailureLimiter: 창 안 10회 실패 뒤 차단, 창이 지나면 풀림', () => {
    let t = 0
    const l = new AuthFailureLimiter(10, 60_000, () => t)
    for (let i = 0; i < 9; i++) l.recordFailure('a')
    expect(l.isBlocked('a')).toBe(false)
    l.recordFailure('a')
    expect(l.isBlocked('a')).toBe(true)
    expect(l.isBlocked('b')).toBe(false)
    t = 60_001
    expect(l.isBlocked('a')).toBe(false)
  })
})

describe('정적 경로', () => {
  const root = resolve('/srv/renderer')
  it('assets 아래 안전한 경로만 해석한다', () => {
    expect(resolveAssetPath(root, '/assets/app-1.js')).toBe(join(root, 'assets', 'app-1.js'))
    expect(resolveAssetPath(root, '/assets/fonts/a.woff2')).toBe(join(root, 'assets', 'fonts', 'a.woff2'))
    for (const bad of [
      '/assets/',
      '/assets/../x',
      '/assets/a/../../x',
      '/assets/%2e%2e/x',
      '/assets/..%2fx',
      '/assets/a%5cb',
      '/assets/a\\b',
      '/assets//x',
      '/assets/%00',
      '/assets/%E0%A4%A',
      '/index.html',
      '/assets/a b.js'
    ]) {
      expect(resolveAssetPath(root, bad)).toBeNull()
    }
  })

  it('Content-Type', () => {
    expect(contentTypeFor('a.js')).toContain('text/javascript')
    expect(contentTypeFor('a.CSS')).toContain('text/css')
    expect(contentTypeFor('a.woff2')).toBe('font/woff2')
    expect(contentTypeFor('a.unknown')).toBe('application/octet-stream')
  })
})

describe('자산 그래프', () => {
  it('html·js·css 참조를 뽑는다', () => {
    expect(
      htmlAssetRefs('<script type="module" crossorigin src="./assets/m-1.js"></script><link rel="modulepreload" href="./assets/g-2.js"><link rel="stylesheet" href="/assets/s-3.css?v=1">')
    ).toEqual(['m-1.js', 'g-2.js', 's-3.css'])
    expect(jsAssetRefs('import{a}from"./g-2.js";import("./lazy-4.js");const d=["assets/x-5.css","assets/lazy-4.js"];`./t-6.js`')).toEqual(
      ['g-2.js', 'lazy-4.js', 'x-5.css', 't-6.js']
    )
    expect(cssAssetRefs('a{background:url(./i-1.png)}b{src:url("/assets/f-2.woff2") format("woff2")}c{d:url(data:image/png;base64,AAA)}')).toEqual(
      ['i-1.png', 'f-2.woff2']
    )
  })

  it('재귀로 따라가고, 없는 파일은 빼고, 읽기 실패면 html 직접 참조만', async () => {
    const files: Record<string, string> = { 'm.js': 'import"./g.js";import("./l.js")', 'g.js': 'x', 'l.js': 'import("./m.js")' }
    const r = await computeAssetAllowlist('<script src="./assets/m.js"></script><link href="./assets/none.css">', async (n) => files[n] ?? null)
    expect(r.complete).toBe(true)
    expect([...r.allowed].sort()).toEqual(['g.js', 'l.js', 'm.js'])
    const failed = await computeAssetAllowlist('<script src="./assets/m.js"></script>', async (n) => {
      if (n === 'g.js') throw new Error('EIO')
      return files[n] ?? null
    })
    expect(failed.complete).toBe(false)
    expect([...failed.allowed]).toEqual(['m.js'])
  })
})

describe('스냅샷 검사', () => {
  it('객체 + YYYY-MM-DD + 1MB 이하만 받는다', () => {
    expect(validateSnapshot({ date: '2026-11-19', v: 1 }).ok).toBe(true)
    expect(validateSnapshot(null).ok).toBe(false)
    expect(validateSnapshot([]).ok).toBe(false)
    expect(validateSnapshot('x').ok).toBe(false)
    expect(validateSnapshot({ date: '2026-1-9' }).ok).toBe(false)
    expect(validateSnapshot({ date: 20261119 }).ok).toBe(false)
    expect(validateSnapshot({ date: '2026-11-19', big: 'x'.repeat(MAX_SNAPSHOT_BYTES) }).ok).toBe(false)
  })
})

describe('네트워크·QR', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en5: [{ address: '10.0.0.3', family: 'IPv4', internal: false }],
    en0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.0.7', family: 'IPv4', internal: false }
    ]
  } as unknown as Parameters<typeof listLanIPv4>[0]

  it('internal 아닌 IPv4, en0 우선', () => {
    expect(listLanIPv4(ifaces)).toEqual(['192.168.0.7', '10.0.0.3'])
    expect(primaryLanIPv4(ifaces)).toBe('192.168.0.7')
    expect(primaryLanIPv4({})).toBeNull()
    expect(allowedHostNames(ifaces)).toEqual(['192.168.0.7', '10.0.0.3', 'localhost', '127.0.0.1'])
  })

  it('QR 은 SVG data URL', () => {
    const url = qrSvgDataUrl('http://192.168.0.7:8946/pair?t=abc')
    expect(url.startsWith('data:image/svg+xml')).toBe(true)
    expect(decodeURIComponent(url)).toContain('<svg')
  })
})
