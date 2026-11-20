import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3는 Electron ABI로 빌드돼 vitest(Node)에서 로드할 수 없다. node:sqlite로 갈아끼운다.
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  class BetterSqlite3Shim {
    private readonly db: InstanceType<typeof DatabaseSync>
    constructor(path: string) {
      this.db = new DatabaseSync(path)
    }
    pragma(statement: string): void {
      this.db.exec(`PRAGMA ${statement}`)
    }
    exec(sql: string): void {
      this.db.exec(sql)
    }
    prepare(sql: string): unknown {
      return this.db.prepare(sql)
    }
    close(): void {
      this.db.close()
    }
  }
  return { default: BetterSqlite3Shim }
})

import Database from 'better-sqlite3'
import { request } from 'http'
import { gunzipSync } from 'zlib'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applySchema } from '../../db/schema'
import { createMobileServer, type MobileServer, type MobileActivityLogger } from './server'
import { createSnapshotStore, type SnapshotStore } from './snapshot'
import { deriveCookieValue, MOBILE_COOKIE_NAME } from './auth'
import { allowedHostNames } from './network'

// en0(LAN) + utun4(Tailscale) 가 있는 Mac 을 흉내 낸다. Host 허용 목록은 실제 계산 함수로 만든다
const FAKE_IFACES = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  en0: [{ address: '192.168.0.10', family: 'IPv4', internal: false }],
  utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false }]
} as unknown as Parameters<typeof allowedHostNames>[0]

interface Res {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

let db: Database.Database
let server: MobileServer
let port: number
let token: string
let staticDir: string
let snapshots: SnapshotStore
let changed: string[]
let publishRequests: number
let activity: Parameters<MobileActivityLogger>[]
let clock: number

function cookie(t = token): string {
  return `${MOBILE_COOKIE_NAME}=${deriveCookieValue(t)}`
}

function send(opts: {
  method?: string
  path: string
  headers?: Record<string, string>
  body?: string | Buffer
  host?: string | null
}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) }
    if (opts.host !== null) headers.Host = opts.host ?? `127.0.0.1:${port}`
    const r = request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers, setHost: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    r.on('error', reject)
    if (opts.body !== undefined) r.write(opts.body)
    r.end()
  })
}

function authed(path: string, extra: Record<string, string> = {}): Promise<Res> {
  return send({ path, headers: { Cookie: cookie(), ...extra } })
}

function sendRaw(path: string, headers: Record<string, string>): Promise<{ status: number; headers: Res['headers']; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const r = request(
      { host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}`, Cookie: cookie(), ...headers }, setHost: false },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      }
    )
    r.on('error', reject)
    r.end()
  })
}

function post(path: string, body: unknown, extra: Record<string, string> = {}): Promise<Res> {
  return send({
    method: 'POST',
    path,
    headers: {
      Cookie: cookie(),
      'Content-Type': 'application/json',
      'X-LinkWork-Mobile': '1',
      ...extra
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

beforeEach(async () => {
  db = new Database(':memory:')
  applySchema(db)
  db.exec(`
    INSERT INTO todos (id, title, priority, created_at) VALUES (1, '낮은 할 일', 'low', '2026-01-01 09:00:00');
    INSERT INTO todos (id, title, priority, created_at) VALUES (2, '높은 할 일', 'high', '2026-01-02 09:00:00');
    INSERT INTO todos (id, title, priority, is_completed, completed_at) VALUES (3, '끝난 할 일', 'medium', 1, '2026-01-03 10:00:00');
    INSERT INTO todo_tags (id, name, color) VALUES (1, '업무', '#ff0000');
    INSERT INTO todo_tag_map (todo_id, tag_id) VALUES (2, 1);
    INSERT INTO memo_categories (id, name, sort_order) VALUES (1, '아이디어', 0);
    INSERT INTO memos (id, content, created_at) VALUES (1, '첫 메모', '2026-01-01 00:00:00');
    INSERT INTO memos (id, content, is_archived) VALUES (2, '보관 메모', 1);
  `)
  staticDir = mkdtempSync(join(tmpdir(), 'lw-mobile-static-'))
  const root = join(staticDir, 'renderer')
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(
    join(root, 'mobile.html'),
    '<!doctype html><title>mobile</title><script type="module" crossorigin src="./assets/app-abc.js"></script>' +
      '<link rel="modulepreload" crossorigin href="./assets/shared-1.js"><link rel="stylesheet" href="./assets/app-abc.css">'
  )
  // 모바일 그래프: app → shared(정적 import) → lazy(동적 import), css → font(url())
  writeFileSync(
    join(root, 'assets', 'app-abc.js'),
    'import{a}from"./shared-1.js";console.log("app");\n' + '// padding '.repeat(300)
  )
  writeFileSync(join(root, 'assets', 'shared-1.js'), 'export const a=1;const l=()=>import("./lazy-2.js");')
  writeFileSync(join(root, 'assets', 'lazy-2.js'), 'export default 2')
  writeFileSync(join(root, 'assets', 'app-abc.css'), 'body{}@font-face{src:url(./font-3.woff2)}')
  writeFileSync(join(root, 'assets', 'font-3.woff2'), 'FONT')
  // 데스크톱 번들 — 모바일 그래프 밖이라 404 여야 한다
  writeFileSync(join(root, 'assets', 'index-desk.js'), 'DESKTOP-BUNDLE')
  writeFileSync(join(root, 'index.html'), 'DESKTOP-INDEX')
  writeFileSync(join(staticDir, 'package.json'), '{"name":"SECRET-PACKAGE"}')

  token = 'tok-' + Math.random().toString(36).slice(2)
  snapshots = createSnapshotStore()
  changed = []
  publishRequests = 0
  activity = []
  clock = 1_000_000
  server = createMobileServer({
    db,
    getToken: () => token,
    staticRoot: root,
    getAllowedHosts: () => allowedHostNames(FAKE_IFACES),
    getTodaySnapshot: snapshots.get,
    onDataChanged: (e) => changed.push(e),
    onPublishRequested: () => {
      publishRequests += 1
    },
    logActivity: (...args) => {
      activity.push(args)
    },
    now: () => clock
  })
  port = await server.listen([0], '127.0.0.1')
})

afterEach(async () => {
  await server.close()
  db.close()
  rmSync(staticDir, { recursive: true, force: true })
})

describe('인증', () => {
  it('쿠키 없는 /, /api/todos, /assets/x.js 는 401', async () => {
    const root = await send({ path: '/' })
    expect(root.status).toBe(401)
    expect(root.body).toContain('QR')
    expect(root.body).not.toContain('mobile')
    const api = await send({ path: '/api/todos' })
    expect(api.status).toBe(401)
    expect(JSON.parse(api.body).error).toBeTruthy()
    expect(api.headers['cache-control']).toBe('no-store')
    expect((await send({ path: '/assets/app-abc.js' })).status).toBe(401)
    // 위조 쿠키도 401
    expect((await send({ path: '/api/todos', headers: { Cookie: `${MOBILE_COOKIE_NAME}=forged` } })).status).toBe(401)
    // 토큰 자체를 쿠키에 넣어도 401
    expect((await send({ path: '/api/todos', headers: { Cookie: `${MOBILE_COOKIE_NAME}=${token}` } })).status).toBe(401)
  })

  it('잘못된 토큰 /pair 는 401, 올바른 토큰은 302 + HttpOnly·SameSite=Strict 쿠키', async () => {
    const bad = await send({ path: '/pair?t=wrong' })
    expect(bad.status).toBe(401)
    expect(bad.headers['set-cookie']).toBeUndefined()
    expect((await send({ path: '/pair' })).status).toBe(401)

    const ok = await send({ path: `/pair?t=${encodeURIComponent(token)}` })
    expect(ok.status).toBe(302)
    expect(ok.headers.location).toBe('/')
    expect(ok.headers['cache-control']).toBe('no-store')
    const setCookie = String(ok.headers['set-cookie'])
    expect(setCookie).toContain(`${MOBILE_COOKIE_NAME}=${deriveCookieValue(token)}`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toContain('Max-Age=2592000')
    expect(setCookie).not.toContain(token + ';')

    // 받은 쿠키로 화면이 열린다
    const cookieValue = setCookie.split(';')[0]
    const home = await send({ path: '/', headers: { Cookie: cookieValue } })
    expect(home.status).toBe(200)
    expect(home.headers['content-type']).toContain('text/html')
    expect(home.body).toContain('mobile')
  })

  it('토큰 재발급 뒤 옛 쿠키는 401', async () => {
    const old = cookie()
    expect((await send({ path: '/api/todos', headers: { Cookie: old } })).status).toBe(200)
    token = 'tok-new'
    expect((await send({ path: '/api/todos', headers: { Cookie: old } })).status).toBe(401)
    expect((await send({ path: '/api/todos', headers: { Cookie: cookie('tok-new') } })).status).toBe(200)
  })

  it('잘못된 Host 헤더는 쿠키가 있어도 403', async () => {
    expect((await authed('/api/todos', {})).status).toBe(200)
    for (const host of ['evil.example.com', `evil.example.com:${port}`, '127.0.0.1', `192.168.0.11:${port}`, `127.0.0.1:${port + 1}`]) {
      const r = await send({ path: '/api/todos', headers: { Cookie: cookie() }, host })
      expect(r.status).toBe(403)
    }
    expect((await send({ path: '/api/todos', headers: { Cookie: cookie() }, host: `192.168.0.10:${port}` })).status).toBe(200)
    expect((await send({ path: '/api/todos', headers: { Cookie: cookie() }, host: `localhost:${port}` })).status).toBe(200)
    // /pair 도 Host 검사를 먼저 한다
    expect((await send({ path: `/pair?t=${token}`, host: 'evil.example.com' })).status).toBe(403)
  })

  it('인증 실패 10회 뒤 11회째는 429 (올바른 쿠키여도)', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await send({ path: '/api/todos' })).status).toBe(401)
    }
    expect((await send({ path: '/pair?t=wrong' })).status).toBe(429)
    expect((await authed('/api/todos')).status).toBe(429)
    // 1분이 지나면 풀린다
    clock += 61_000
    expect((await authed('/api/todos')).status).toBe(200)
  })

  it('공통 보안 헤더', async () => {
    const r = await authed('/api/todos')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['referrer-policy']).toBe('no-referrer')
    expect(r.headers['cache-control']).toBe('no-store')
  })
})

describe('Tailscale 주소', () => {
  it('Host 가 이 Mac 의 100.x 주소면 허용되지만 쿠키·속도 제한은 그대로다. *.ts.net 이름은 403', async () => {
    const host = `100.101.102.103:${port}`
    expect((await send({ path: '/api/todos', headers: { Cookie: cookie() }, host })).status).toBe(200)
    // 쿠키 없으면 401, 페어링은 같은 규칙
    expect((await send({ path: '/api/todos', host })).status).toBe(401)
    expect((await send({ path: `/pair?t=${encodeURIComponent(token)}`, host })).status).toBe(302)
    // 다른 Tailscale 기기 주소·MagicDNS 이름은 403
    for (const bad of [`100.101.102.104:${port}`, `my-mac.tail1234.ts.net:${port}`, `my-mac:${port}`]) {
      expect((await send({ path: '/api/todos', headers: { Cookie: cookie() }, host: bad })).status).toBe(403)
    }
    // 위 올바른 /pair 가 실패 기록을 지웠으므로 새로 10회 실패 → 차단
    for (let i = 0; i < 10; i++) expect((await send({ path: '/api/todos', host })).status).toBe(401)
    expect((await send({ path: '/api/todos', headers: { Cookie: cookie() }, host })).status).toBe(429)
  })
})

describe('정적 파일', () => {
  it('assets 는 올바른 Content-Type·Cache-Control 로 나간다', async () => {
    const js = await authed('/assets/app-abc.js')
    expect(js.status).toBe(200)
    expect(js.headers['content-type']).toContain('text/javascript')
    expect(js.headers['cache-control']).toContain('max-age')
    expect(js.body).toContain('console.log')
    const css = await authed('/assets/app-abc.css')
    expect(css.headers['content-type']).toContain('text/css')
    expect((await authed('/assets/none.js')).status).toBe(404)
  })

  it('경로 탈출은 막히고 파일 내용이 나오지 않는다', async () => {
    const paths = [
      '/assets/../../package.json',
      '/assets/../index.html',
      '/assets/..%2f..%2fpackage.json',
      '/assets/%2e%2e/%2e%2e/package.json',
      '/assets/%2e%2e%2f%2e%2e%2fpackage.json',
      '/assets/..\\..\\package.json',
      '/assets//etc/passwd',
      '/assets/%00.js',
      '/../package.json',
      '/index.html',
      '/mobile.html/../package.json'
    ]
    for (const path of paths) {
      const r = await authed(path)
      expect([400, 403, 404]).toContain(r.status)
      expect(r.body).not.toContain('SECRET-PACKAGE')
      expect(r.body).not.toContain('DESKTOP-INDEX')
    }
  })

  it('빌드된 mobile.html 이 없으면 503 안내', async () => {
    rmSync(join(staticDir, 'renderer', 'mobile.html'))
    const r = await authed('/')
    expect(r.status).toBe(503)
    expect(r.body).toContain('모바일 화면')
  })
})

describe('쿠키 갱신·차단 중 페어링', () => {
  it('인증된 GET / 는 같은 속성의 쿠키를 다시 내려 만료를 연장한다', async () => {
    const r = await authed('/')
    expect(r.status).toBe(200)
    const setCookie = String(r.headers['set-cookie'])
    expect(setCookie).toContain(`${MOBILE_COOKIE_NAME}=${deriveCookieValue(token)}`)
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) expect(setCookie).toContain(attr)
    // 인증 실패·API 응답에는 쿠키를 내리지 않는다
    expect((await send({ path: '/' })).headers['set-cookie']).toBeUndefined()
    expect((await authed('/api/todos')).headers['set-cookie']).toBeUndefined()
  })

  it('차단 중에도 올바른 토큰의 /pair 는 302 이고 실패 기록이 지워진다. 틀린 토큰은 429', async () => {
    for (let i = 0; i < 10; i++) expect((await send({ path: '/api/todos' })).status).toBe(401)
    expect((await authed('/api/todos')).status).toBe(429)
    expect((await send({ path: '/pair?t=wrong' })).status).toBe(429)
    const ok = await send({ path: `/pair?t=${encodeURIComponent(token)}` })
    expect(ok.status).toBe(302)
    expect(String(ok.headers['set-cookie'])).toContain(deriveCookieValue(token))
    // 실패 기록이 지워져 바로 쓸 수 있다
    expect((await authed('/api/todos')).status).toBe(200)
  })

  it('틀린 토큰 /pair 는 차단 중에도 계속 실패로 센다', async () => {
    for (let i = 0; i < 10; i++) await send({ path: '/pair?t=wrong' })
    clock += 30_000
    for (let i = 0; i < 5; i++) expect((await send({ path: '/pair?t=wrong' })).status).toBe(429)
    // 처음 10회가 창을 벗어나도 차단 중 실패 5회 + … 로 아직 막힌다(최근 10회 이상)
    clock += 31_000
    for (let i = 0; i < 5; i++) await send({ path: '/pair?t=wrong' })
    expect((await authed('/api/todos')).status).toBe(429)
  })
})

describe('gzip', () => {
  it('gzip 을 받는 요청에 1KB 이상 js 는 압축하고 풀면 원본과 같다', async () => {
    const original = readFileSync(join(staticDir, 'renderer', 'assets', 'app-abc.js'))
    const r1 = await sendRaw('/assets/app-abc.js', { 'Accept-Encoding': 'gzip, deflate, br' })
    expect(r1.status).toBe(200)
    expect(r1.headers['content-encoding']).toBe('gzip')
    expect(r1.headers.vary).toBe('Accept-Encoding')
    expect(r1.headers['content-type']).toContain('text/javascript')
    expect(gunzipSync(r1.body).equals(original)).toBe(true)
    expect(Number(r1.headers['content-length'])).toBe(r1.body.length)
    // 두 번째(캐시) 응답도 같다
    const r2 = await sendRaw('/assets/app-abc.js', { 'Accept-Encoding': 'gzip' })
    expect(gunzipSync(r2.body).equals(original)).toBe(true)

    // gzip 을 받지 않으면 원본
    const plain = await sendRaw('/assets/app-abc.js', {})
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.headers.vary).toBe('Accept-Encoding')
    expect(plain.body.equals(original)).toBe(true)
    expect((await sendRaw('/assets/app-abc.js', { 'Accept-Encoding': 'gzip;q=0' })).headers['content-encoding']).toBeUndefined()
  })

  it('1KB 미만은 압축하지 않는다', async () => {
    const r = await sendRaw('/assets/app-abc.css', { 'Accept-Encoding': 'gzip' })
    expect(r.status).toBe(200)
    expect(r.headers['content-encoding']).toBeUndefined()
    expect(r.body.toString()).toContain('font-face')
  })

  it('JSON API 와 mobile.html 도 압축한다', async () => {
    db.prepare('INSERT INTO memos (content) VALUES (?)').run('긴 메모 '.repeat(500))
    const r = await sendRaw('/api/memos', { 'Accept-Encoding': 'gzip' })
    expect(r.status).toBe(200)
    expect(r.headers['content-encoding']).toBe('gzip')
    expect(r.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(gunzipSync(r.body).toString('utf8'))
    expect(body.memos).toHaveLength(2)

    writeFileSync(join(staticDir, 'renderer', 'mobile.html'), '<!doctype html><title>mobile</title>' + '<!-- pad -->'.repeat(200))
    const html = await sendRaw('/', { 'Accept-Encoding': 'gzip' })
    expect(html.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(html.body).toString()).toContain('<title>mobile</title>')
  })
})

describe('자산 허용 목록', () => {
  it('mobile.html 그래프(정적·동적 import, css url)만 200, 데스크톱 번들은 404', async () => {
    for (const name of ['app-abc.js', 'shared-1.js', 'lazy-2.js', 'app-abc.css', 'font-3.woff2']) {
      expect((await authed(`/assets/${name}`)).status, name).toBe(200)
    }
    const desk = await authed('/assets/index-desk.js')
    expect(desk.status).toBe(404)
    expect(desk.body).not.toContain('DESKTOP-BUNDLE')
  })

  it('mobile.html 이 바뀌면 허용 목록을 다시 계산한다', async () => {
    expect((await authed('/assets/index-desk.js')).status).toBe(404)
    const htmlPath = join(staticDir, 'renderer', 'mobile.html')
    writeFileSync(htmlPath, '<script type="module" src="./assets/index-desk.js"></script>')
    const later = new Date(Date.now() + 10_000)
    utimesSync(htmlPath, later, later)
    expect((await authed('/assets/index-desk.js')).status).toBe(200)
    expect((await authed('/assets/app-abc.js')).status).toBe(404)
  })
})

describe('API', () => {
  it('/api/today: 없으면 null, publish 뒤에는 그 값. 데스크톱에 재발행 요청(5초 간격)', async () => {
    const r1 = await authed('/api/today')
    expect(r1.status).toBe(200)
    expect(JSON.parse(r1.body)).toEqual({ snapshot: null })
    expect(publishRequests).toBe(1)

    const snap = { v: 1, date: '2026-11-19', heading: '11월 19일 (목)', dashboard: { x: 1 } }
    expect(snapshots.publish(snap)).toEqual({ success: true })
    const r2 = await authed('/api/today')
    expect(JSON.parse(r2.body)).toEqual({ snapshot: snap })
    expect(publishRequests).toBe(1) // 5초 안 중복 요청은 생략
    clock += 5000
    await authed('/api/today')
    expect(publishRequests).toBe(2)
  })

  it('/api/todos: todo:list 와 같은 정렬·tags, completed=1 은 완료 목록', async () => {
    const open = JSON.parse((await authed('/api/todos?completed=0')).body)
    expect(open.todos.map((t: { id: number }) => t.id)).toEqual([2, 1])
    expect(open.todos[0].tags).toEqual([expect.objectContaining({ id: 1, name: '업무' })])
    expect(open.todos[1].tags).toEqual([])
    const def = JSON.parse((await authed('/api/todos')).body)
    expect(def.todos.map((t: { id: number }) => t.id)).toEqual([2, 1])
    const done = JSON.parse((await authed('/api/todos?completed=1')).body)
    expect(done.todos.map((t: { id: number }) => t.id)).toEqual([3])
    expect((await authed('/api/todos?completed=2')).status).toBe(400)
  })

  it('할 일 complete/restore 가 DB·이력을 바꾸고 변경 알림·활동 로그를 남긴다. 없는 id 는 404', async () => {
    const c = await post('/api/todos/1/complete', {})
    expect(c.status).toBe(200)
    expect(JSON.parse(c.body)).toEqual({ success: true })
    const row1 = db.prepare('SELECT is_completed, completed_at FROM todos WHERE id = 1').get() as { is_completed: number; completed_at: string | null }
    expect(row1.is_completed).toBe(1)
    expect(row1.completed_at).toBeTruthy()
    expect(changed).toEqual(['todo'])
    expect(activity).toEqual([['todo', 'complete', 1]])

    const r = await post('/api/todos/1/restore', {})
    expect(r.status).toBe(200)
    const row2 = db.prepare('SELECT is_completed, completed_at FROM todos WHERE id = 1').get() as { is_completed: number; completed_at: string | null }
    expect(row2.is_completed).toBe(0)
    expect(row2.completed_at).toBeNull()
    expect(changed).toEqual(['todo', 'todo'])
    const history = db.prepare('SELECT action FROM todo_history WHERE todo_id = 1 ORDER BY id').all() as { action: string }[]
    expect(history.map((h) => h.action)).toEqual(['complete', 'restore'])

    const missing = await post('/api/todos/999/complete', {})
    expect(missing.status).toBe(404)
    expect(JSON.parse(missing.body).error).toBeTruthy()
    expect((await post('/api/todos/abc/complete', {})).status).toBe(404)
    expect(changed).toHaveLength(2)
  })

  it('/api/memos: 보관하지 않은 메모 + 카테고리', async () => {
    const r = await authed('/api/memos')
    expect(r.status).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.memos.map((m: { id: number }) => m.id)).toEqual([1])
    expect(body.categories.map((c: { name: string }) => c.name)).toEqual(['아이디어'])
  })

  it('메모 작성 성공(trim 저장, 카테고리·중요) / 빈 content·20000자 초과·없는 category·잘못된 JSON 은 400', async () => {
    const ok = await post('/api/memos', { content: '  휴대폰 메모  ', category_id: 1, is_important: 1 })
    expect(ok.status).toBe(200)
    const { id } = JSON.parse(ok.body)
    expect(typeof id).toBe('number')
    const row = db.prepare('SELECT content, category_id, is_important, color FROM memos WHERE id = ?').get(id) as Record<string, unknown>
    expect(row).toMatchObject({ content: '휴대폰 메모', category_id: 1, is_important: 1, color: 'default' })
    expect(changed).toEqual(['memo'])
    expect(activity).toEqual([['memo', 'create', id, '휴대폰 메모']])

    const ok2 = await post('/api/memos', { content: 'x'.repeat(20000), category_id: null })
    expect(ok2.status).toBe(200)

    for (const bad of [
      { content: '' },
      { content: '   ' },
      { content: 'x'.repeat(20001) },
      { content: '메모', category_id: 999 },
      { content: '메모', category_id: 'a' },
      { content: '메모', is_important: 2 },
      {}
    ]) {
      const r = await post('/api/memos', bad)
      expect(r.status).toBe(400)
      expect(JSON.parse(r.body).error).toBeTruthy()
    }
    expect((await post('/api/memos', '{not json')).status).toBe(400)
    expect(changed).toEqual(['memo', 'memo'])
  })

  it('POST 에 X-LinkWork-Mobile 헤더가 없으면 403, 다른 Origin 이면 403, JSON 이 아니면 415', async () => {
    const noHeader = await send({
      method: 'POST',
      path: '/api/memos',
      headers: { Cookie: cookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' })
    })
    expect(noHeader.status).toBe(403)
    expect((await post('/api/todos/1/complete', {}, { Origin: 'http://evil.example.com' })).status).toBe(403)
    expect((await post('/api/todos/1/complete', {}, { Origin: `http://127.0.0.1:${port}` })).status).toBe(200)
    expect((await post('/api/memos', { content: 'x' }, { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await post('/api/memos', { content: 'x' }, { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415)
    expect(db.prepare("SELECT COUNT(*) AS c FROM memos WHERE content = 'x'").get()).toEqual(expect.objectContaining({ c: 0 }))
  })

  it('본문 64KB 초과는 413', async () => {
    const big = JSON.stringify({ content: 'x'.repeat(70 * 1024) })
    const r = await post('/api/memos', big)
    expect(r.status).toBe(413)
    expect(db.prepare('SELECT COUNT(*) AS c FROM memos').get()).toEqual(expect.objectContaining({ c: 2 }))
  })

  it('허용하지 않은 메서드·경로는 404/405', async () => {
    const cases: [string, string][] = [
      ['PUT', '/api/todos'],
      ['DELETE', '/api/memos/1'],
      ['POST', '/api/todos'],
      ['DELETE', '/api/todos/1/complete'],
      ['GET', '/api/todos/1/complete'],
      ['GET', '/api/unknown'],
      ['POST', '/']
    ]
    for (const [method, path] of cases) {
      const r = await send({
        method,
        path,
        headers: { Cookie: cookie(), 'Content-Type': 'application/json', 'X-LinkWork-Mobile': '1' },
        body: '{}'
      })
      expect([404, 405]).toContain(r.status)
    }
    expect(db.prepare('SELECT COUNT(*) AS c FROM todos').get()).toEqual(expect.objectContaining({ c: 3 }))
  })
})

describe('포트', () => {
  it('사용 중인 포트는 건너뛰고 다음 후보를 쓴다', async () => {
    const other = createMobileServer({
      db,
      getToken: () => token,
      staticRoot: staticDir,
      getAllowedHosts: () => ['127.0.0.1'],
      getTodaySnapshot: () => null,
      onDataChanged: () => undefined,
      onPublishRequested: () => undefined,
      logActivity: () => undefined
    })
    const p = await other.listen([port, 0], '127.0.0.1')
    expect(p).not.toBe(port)
    expect(other.running).toBe(true)
    await other.close()
    expect(other.running).toBe(false)

    const third = createMobileServer({
      db,
      getToken: () => token,
      staticRoot: staticDir,
      getAllowedHosts: () => ['127.0.0.1'],
      getTodaySnapshot: () => null,
      onDataChanged: () => undefined,
      onPublishRequested: () => undefined,
      logActivity: () => undefined
    })
    await expect(third.listen([port], '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(third.running).toBe(false)
  })
})
