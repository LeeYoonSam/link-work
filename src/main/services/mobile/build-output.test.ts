import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// 실제 빌드 산출물(out/renderer)로 자산 허용 목록을 확인한다. `npm run build` 뒤에만 돈다.
// mobile.html 이 참조하는 그래프(정적·동적 import, css url)가 전부 200 이고, 데스크톱 번들은 404 인지 본다.
import { request } from 'http'
import { existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { gunzipSync } from 'zlib'
import type Database from 'better-sqlite3'
import { createMobileServer, type MobileServer } from './server'
import { cssAssetRefs, htmlAssetRefs, jsAssetRefs } from './static'
import { deriveCookieValue, MOBILE_COOKIE_NAME } from './auth'

const root = resolve(__dirname, '../../../../out/renderer')
const built = existsSync(resolve(root, 'mobile.html')) && existsSync(resolve(root, 'index.html'))

let server: MobileServer
let port: number

function get(path: string): Promise<{ status: number; body: Buffer; encoding?: string }> {
  return new Promise((ok, fail) => {
    const r = request(
      {
        host: '127.0.0.1',
        port,
        path,
        setHost: false,
        headers: {
          Host: `127.0.0.1:${port}`,
          Cookie: `${MOBILE_COOKIE_NAME}=${deriveCookieValue('t')}`,
          'Accept-Encoding': 'gzip'
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          const encoding = res.headers['content-encoding'] as string | undefined
          ok({ status: res.statusCode ?? 0, body: encoding === 'gzip' ? gunzipSync(raw) : raw, encoding })
        })
      }
    )
    r.on('error', fail)
    r.end()
  })
}

describe.skipIf(!built)('실제 빌드 산출물', () => {
  beforeAll(async () => {
    server = createMobileServer({
      db: {} as Database.Database,
      getToken: () => 't',
      staticRoot: root,
      getAllowedHosts: () => ['127.0.0.1'],
      getTodaySnapshot: () => null,
      onDataChanged: () => undefined,
      onPublishRequested: () => undefined,
      logActivity: () => undefined
    })
    port = await server.listen([0], '127.0.0.1')
  })
  afterAll(() => server?.close())

  it('mobile.html 그래프는 전부 200, 그 밖의 데스크톱 자산은 404', async () => {
    const home = await get('/')
    expect(home.status).toBe(200)
    const queue = htmlAssetRefs(home.body.toString('utf8'))
    expect(queue.length).toBeGreaterThan(0)
    const seen = new Set<string>()
    while (queue.length > 0) {
      const name = queue.shift()!
      if (seen.has(name)) continue
      // 빌드에 없는 이름(문자열 오탐)은 건너뛴다 — 서버도 허용하지 않는다
      if (!existsSync(resolve(root, 'assets', name))) continue
      seen.add(name)
      const r = await get(`/assets/${name}`)
      expect(r.status, name).toBe(200)
      const text = r.body.toString('utf8')
      if (name.endsWith('.js')) queue.push(...jsAssetRefs(text))
      if (name.endsWith('.css')) queue.push(...cssAssetRefs(text))
    }
    const others = readdirSync(resolve(root, 'assets')).filter((n) => !seen.has(n))
    // 데스크톱 진입 번들(index-*.js)은 모바일 그래프 밖이어야 한다
    expect(others.some((n) => /^index-.*\.js$/.test(n))).toBe(true)
    for (const n of others) expect((await get(`/assets/${n}`)).status, n).toBe(404)
  })
})
