// 모바일 열람 HTTP 서버 — 같은 Wi-Fi 의 휴대폰 브라우저가 오늘·할 일·메모를 본다.
// electron 을 import 하지 않는다. DB·토큰·정적 루트·알림 콜백을 주입받아 Node 테스트에서 그대로 띄운다.
//
// 보안 요약
// - 모든 요청: Host 헤더가 허용 호스트(LAN IPv4·localhost·127.0.0.1):<port> 가 아니면 403 (DNS rebinding)
// - /pair?t=<token> 만 쿠키 없이 받는다. 그 밖의 모든 경로는 토큰에서 유도한 쿠키가 필요하다(401)
// - 같은 원격 주소에서 1분에 10회 인증 실패하면 429
// - POST: X-LinkWork-Mobile: 1 + Content-Type: application/json + (Origin 이 있으면 같은 출처) + 본문 64KB 상한
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { readFile, stat } from 'fs/promises'
import { gzipSync } from 'zlib'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import {
  AuthFailureLimiter,
  buildSessionCookie,
  isCookieValid,
  isHostAllowed,
  safeEqual
} from './auth'
import {
  computeAssetAllowlist,
  contentTypeFor,
  htmlAssetRefs,
  mobileHtmlPath,
  resolveAssetPath
} from './static'
import type { MobileChangedEntity, MobileTodaySnapshot } from './types'
import {
  listTodosByCompletion,
  saveTodoHistory,
  setTodoCompletion
} from '../../utils/todo-helpers'
import {
  insertMemo,
  listMemoCategories,
  listMemosByArchived,
  memoCategoryExists
} from '../../utils/memo-helpers'

const MAX_BODY_BYTES = 64 * 1024
const MAX_MEMO_LENGTH = 20000
/** /api/today 가 데스크톱에 재발행을 요청하는 최소 간격 */
const PUBLISH_REQUEST_INTERVAL_MS = 5000
/** 이보다 작은 응답은 압축하지 않는다 */
const GZIP_MIN_BYTES = 1024
const GZIP_CACHE_MAX = 64

export type MobileActivityLogger = (
  entityType: 'todo' | 'memo',
  action: 'complete' | 'restore' | 'create',
  entityId: number,
  entityName?: string
) => void

interface MobileServerDeps {
  db: Database.Database
  /** 현재 페어링 토큰. 없으면 모든 인증이 실패한다 */
  getToken: () => string | null
  /** out/renderer — mobile.html 과 assets/ 가 있는 폴더 */
  staticRoot: string
  /** Host 헤더에서 허용할 호스트 이름(포트 제외). 매 요청마다 부른다 */
  getAllowedHosts: () => readonly string[]
  getTodaySnapshot: () => MobileTodaySnapshot | null
  /** 휴대폰에서 쓰기가 일어났다 → 데스크톱 화면 갱신 */
  onDataChanged: (entity: MobileChangedEntity) => void
  /** /api/today 호출 → 데스크톱에 스냅샷 재발행 요청 (서버가 5초 간격으로 줄인다) */
  onPublishRequested: () => void
  logActivity: MobileActivityLogger
  now?: () => number
  rateLimit?: { max: number; windowMs: number }
}

export interface MobileServer {
  /** 후보 포트를 순서대로 시도한다. 모두 실패하면 마지막 오류를 던진다. 실제 포트를 돌려준다 */
  listen: (ports: readonly number[], host?: string) => Promise<number>
  close: () => Promise<void>
  readonly port: number | null
  readonly running: boolean
}

const memoCreateSchema = z.object({
  content: z.string(),
  category_id: z.number().int().positive().nullable().optional(),
  is_important: z.union([z.literal(0), z.literal(1)]).optional()
})

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const UNAUTHORIZED_HTML = page(
  '다시 연결해 주세요',
  '연결 정보가 없거나 만료되었습니다. 설정 화면의 QR 을 다시 스캔하세요.'
)
const PAIR_FAILED_HTML = page(
  '연결할 수 없습니다',
  'QR 이 만료되었거나 올바르지 않습니다. 설정 화면의 QR 을 다시 스캔하세요.'
)
const NOT_BUILT_HTML = page(
  '모바일 화면이 준비되지 않았습니다',
  '빌드된 모바일 화면 파일을 찾지 못했습니다. 개발 모드라면 npm run build 뒤에 다시 시도하세요.'
)

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LinkWork</title><style>body{font-family:-apple-system,system-ui,sans-serif;padding:32px 20px;color:#1f2937;line-height:1.6}h1{font-size:20px}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`
}

function baseHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
}

/** 요청이 gzip 을 받는가 — handle 이 응답마다 기록한다 */
const acceptsGzip = new WeakMap<ServerResponse, boolean>()

function wantsGzip(header: string | string[] | undefined): boolean {
  const v = Array.isArray(header) ? header.join(',') : (header ?? '')
  return v
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .some((p) => {
      const [name, ...params] = p.split(';').map((x) => x.trim())
      if (name !== 'gzip' && name !== '*') return false
      const q = params.find((x) => x.startsWith('q='))
      return !q || Number(q.slice(2)) > 0
    })
}

/**
 * 압축할 수 있는 본문을 보낸다. 요청이 gzip 을 받고 GZIP_MIN_BYTES 이상이면 gzip 으로 보낸다.
 * gzipped 를 넘기면(정적 자산 캐시) 그것을 쓴다. Vary 는 압축 여부와 무관하게 붙인다.
 */
function sendCompressible(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | number>,
  body: Buffer,
  gzipped?: () => Buffer
): void {
  const h: Record<string, string | number> = { ...headers, Vary: 'Accept-Encoding' }
  if (acceptsGzip.get(res) && body.length >= GZIP_MIN_BYTES) {
    const gz = gzipped ? gzipped() : gzipSync(body)
    res.writeHead(status, { ...h, 'Content-Encoding': 'gzip', 'Content-Length': gz.length })
    res.end(gz)
    return
  }
  res.writeHead(status, { ...h, 'Content-Length': body.length })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendCompressible(
    res,
    status,
    { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
    Buffer.from(JSON.stringify(body), 'utf8')
  )
}

function sendHtml(res: ServerResponse, status: number, html: string, cache = 'no-store'): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': cache,
    'Content-Length': Buffer.byteLength(html)
  })
  res.end(html)
}

/** /api/ 경로는 JSON, 그 밖은 HTML·텍스트로 오류를 돌려준다 */
function sendError(res: ServerResponse, isApi: boolean, status: number, message: string, html?: string): void {
  if (isApi) {
    sendJson(res, status, { error: message })
  } else if (html) {
    sendHtml(res, status, html)
  } else {
    const text = message
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(text)
    })
    res.end(text)
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, '본문이 너무 큽니다.'))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > limit) {
        failed = true
        reject(new HttpError(413, '본문이 너무 큽니다.'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (!failed) {
        failed = true
        reject(err)
      }
    })
  })
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const buf = await readBody(req, MAX_BODY_BYTES)
  if (buf.length === 0) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new HttpError(400, '본문이 올바른 JSON 이 아닙니다.')
  }
}

interface FileData {
  data: Buffer
  mtimeMs: number
  size: number
}

async function readFileIfExists(path: string): Promise<FileData | null> {
  try {
    const s = await stat(path)
    if (!s.isFile()) return null
    return { data: await readFile(path), mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return null
  }
}

const COMPRESSIBLE_EXT = /\.(?:js|mjs|css|html|json|map|svg|txt)$/i

const TODO_ACTION_RE = /^\/api\/todos\/([1-9]\d{0,14})\/(complete|restore)$/

/** 경로별 허용 메서드. 여기 없는 경로는 404, 메서드가 다르면 405 */
function allowedMethods(pathname: string): string[] | null {
  if (pathname === '/') return ['GET']
  if (pathname.startsWith('/assets/')) return ['GET']
  if (pathname === '/api/today') return ['GET']
  if (pathname === '/api/todos') return ['GET']
  if (TODO_ACTION_RE.test(pathname)) return ['POST']
  if (pathname === '/api/memos') return ['GET', 'POST']
  return null
}

export function createMobileServer(deps: MobileServerDeps): MobileServer {
  const now = deps.now ?? Date.now
  const limiter = new AuthFailureLimiter(deps.rateLimit?.max ?? 10, deps.rateLimit?.windowMs ?? 60_000, now)
  let lastPublishRequest = -Infinity
  let server: Server | null = null
  let port: number | null = null
  /** 정적 파일 gzip 캐시: 경로+mtime+size → 압축본 */
  const gzipCache = new Map<string, Buffer>()
  /** mobile.html 이 참조하는 자산 그래프. mobile.html 의 mtime·size 가 바뀌면 다시 계산한다 */
  let allowlist: { key: string; allowed: Set<string> } | null = null

  function cachedGzip(path: string, file: FileData): () => Buffer {
    return () => {
      const key = `${path}:${file.mtimeMs}:${file.size}`
      let gz = gzipCache.get(key)
      if (!gz) {
        gz = gzipSync(file.data)
        if (gzipCache.size >= GZIP_CACHE_MAX) gzipCache.clear()
        gzipCache.set(key, gz)
      }
      return gz
    }
  }

  async function readAssetText(name: string): Promise<string | null> {
    const full = resolveAssetPath(deps.staticRoot, `/assets/${name}`)
    if (!full) return null
    try {
      const s = await stat(full)
      if (!s.isFile()) return null
      return /\.(?:m?js|css)$/i.test(name) ? await readFile(full, 'utf8') : ''
    } catch {
      return null
    }
  }

  /** 허용 자산 이름 집합. mobile.html 이 없으면 빈 집합 */
  async function getAllowlist(): Promise<Set<string>> {
    const html = await readFileIfExists(mobileHtmlPath(deps.staticRoot))
    if (!html) return new Set()
    const key = `${html.mtimeMs}:${html.size}`
    if (allowlist?.key === key) return allowlist.allowed
    const text = html.data.toString('utf8')
    let allowed: Set<string>
    try {
      const r = await computeAssetAllowlist(text, readAssetText)
      if (!r.complete) console.warn('[mobile-server] 자산 그래프 계산 실패 — mobile.html 직접 참조만 허용')
      allowed = r.allowed
    } catch {
      allowed = new Set(htmlAssetRefs(text))
    }
    allowlist = { key, allowed }
    return allowed
  }

  function requestPublish(): void {
    const t = now()
    if (t - lastPublishRequest < PUBLISH_REQUEST_INTERVAL_MS) return
    lastPublishRequest = t
    try {
      deps.onPublishRequested()
    } catch (err) {
      console.error('[mobile-server] publishRequested', err)
    }
  }

  function notifyChanged(entity: MobileChangedEntity): void {
    try {
      deps.onDataChanged(entity)
    } catch (err) {
      console.error('[mobile-server] dataChanged', err)
    }
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams): Promise<void> {
    const db = deps.db
    const method = req.method ?? 'GET'

    if (method === 'POST') {
      // 브라우저 폼·다른 출처 스크립트가 흉내 내기 어려운 조건을 모두 요구한다
      if (req.headers['x-linkwork-mobile'] !== '1') throw new HttpError(403, '허용되지 않은 요청입니다.')
      const origin = req.headers.origin
      if (origin !== undefined && origin.toLowerCase() !== `http://${(req.headers.host ?? '').toLowerCase()}`) {
        throw new HttpError(403, '허용되지 않은 출처입니다.')
      }
      const ct = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (ct !== 'application/json') throw new HttpError(415, 'Content-Type 은 application/json 이어야 합니다.')
    }

    if (pathname === '/api/today') {
      requestPublish()
      sendJson(res, 200, { snapshot: deps.getTodaySnapshot() })
      return
    }

    if (pathname === '/api/todos') {
      const c = search.get('completed')
      if (c !== null && c !== '0' && c !== '1') throw new HttpError(400, 'completed 는 0 또는 1 이어야 합니다.')
      sendJson(res, 200, { todos: listTodosByCompletion(db, c === '1') })
      return
    }

    const todoMatch = TODO_ACTION_RE.exec(pathname)
    if (todoMatch) {
      await readJsonBody(req) // 본문은 쓰지 않지만 상한 검사·소비를 한다
      const id = Number(todoMatch[1])
      const action = todoMatch[2] as 'complete' | 'restore'
      const exists = db.prepare('SELECT 1 FROM todos WHERE id = ?').get(id)
      if (!exists) throw new HttpError(404, '할 일을 찾을 수 없습니다.')
      // todo:complete / todo:restore IPC 와 같은 부수효과(이력·활동 로그)
      setTodoCompletion(db, id, action === 'complete')
      saveTodoHistory(db, id, action)
      deps.logActivity('todo', action, id)
      notifyChanged('todo')
      sendJson(res, 200, { success: true })
      return
    }

    if (pathname === '/api/memos') {
      if (method === 'GET') {
        sendJson(res, 200, { memos: listMemosByArchived(db, false), categories: listMemoCategories(db) })
        return
      }
      const parsed = memoCreateSchema.safeParse(await readJsonBody(req))
      if (!parsed.success) throw new HttpError(400, '메모 입력이 올바르지 않습니다.')
      const content = parsed.data.content.trim()
      if (content.length < 1) throw new HttpError(400, '메모 내용을 입력하세요.')
      if (content.length > MAX_MEMO_LENGTH) throw new HttpError(400, `메모는 ${MAX_MEMO_LENGTH}자 이하로 써 주세요.`)
      const categoryId = parsed.data.category_id ?? null
      if (categoryId !== null && !memoCategoryExists(db, categoryId)) {
        throw new HttpError(400, '카테고리를 찾을 수 없습니다.')
      }
      // memo:create IPC 와 같은 부수효과(활동 로그)
      const id = insertMemo(db, { content, is_important: parsed.data.is_important ?? 0, category_id: categoryId })
      deps.logActivity('memo', 'create', id, content.slice(0, 50))
      notifyChanged('memo')
      sendJson(res, 200, { id })
      return
    }

    throw new HttpError(404, '찾을 수 없습니다.')
  }

  async function handleStatic(res: ServerResponse, pathname: string, token: string): Promise<void> {
    if (pathname === '/') {
      // 인증된 화면 열기마다 쿠키 만료를 30일로 다시 늘린다(슬라이딩). 토큰이 바뀌면 이전 쿠키는 이미 401 이다
      res.setHeader('Set-Cookie', buildSessionCookie(token))
      const htmlPath = mobileHtmlPath(deps.staticRoot)
      const html = await readFileIfExists(htmlPath)
      if (!html) {
        sendHtml(res, 503, NOT_BUILT_HTML)
        return
      }
      sendCompressible(
        res,
        200,
        { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
        html.data,
        cachedGzip(htmlPath, html)
      )
      return
    }
    const file = resolveAssetPath(deps.staticRoot, pathname)
    // 모바일 화면 그래프 밖의 자산(데스크톱 번들 등)은 없는 것으로 다룬다
    const name = pathname.slice('/assets/'.length)
    if (!file || !(await getAllowlist()).has(name)) {
      sendError(res, false, 404, '찾을 수 없습니다.')
      return
    }
    const data = await readFileIfExists(file)
    if (!data) {
      sendError(res, false, 404, '찾을 수 없습니다.')
      return
    }
    const headers = {
      'Content-Type': contentTypeFor(file),
      // 빌드 산출물 이름에 해시가 붙는다. 쿠키 인증 뒤라 공유 캐시에는 두지 않는다
      'Cache-Control': 'private, max-age=31536000, immutable'
    }
    if (COMPRESSIBLE_EXT.test(file)) {
      sendCompressible(res, 200, headers, data.data, cachedGzip(file, data))
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': data.data.length })
      res.end(data.data)
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    baseHeaders(res)
    const rawUrl = req.url ?? '/'
    const qIndex = rawUrl.indexOf('?')
    const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl
    const search = new URLSearchParams(qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '')
    const isApi = pathname.startsWith('/api/')

    if (!port || !isHostAllowed(req.headers.host, port, deps.getAllowedHosts())) {
      sendError(res, isApi, 403, '허용되지 않은 호스트입니다.')
      return
    }

    acceptsGzip.set(res, wantsGzip(req.headers['accept-encoding']))
    const addr = req.socket.remoteAddress ?? 'unknown'
    const tooMany = (): void =>
      sendError(res, isApi, 429, '인증 실패가 너무 많습니다. 잠시 뒤 다시 시도하세요.')

    if (pathname === '/pair') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET')
        sendError(res, false, 405, '허용되지 않은 메서드입니다.')
        return
      }
      const given = search.get('t')
      const token = deps.getToken()
      if (!token || !given || !safeEqual(given, token)) {
        // 틀린 토큰은 차단 중이어도 실패로 센다(토큰 대입 방어)
        const blocked = limiter.isBlocked(addr)
        limiter.recordFailure(addr)
        if (blocked) tooMany()
        else sendHtml(res, 401, PAIR_FAILED_HTML)
        return
      }
      // 올바른 토큰은 차단 중에도 통과한다 — 옛 쿠키로 401 이 쌓인 휴대폰이 새 QR 을 스캔하는 경우
      limiter.clear(addr)
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': buildSessionCookie(token),
        'Cache-Control': 'no-store',
        'Content-Length': 0
      })
      res.end()
      return
    }

    if (limiter.isBlocked(addr)) {
      tooMany()
      return
    }

    if (!pathname.startsWith('/')) {
      sendError(res, isApi, 400, '잘못된 요청입니다.')
      return
    }

    // 그 밖의 모든 경로는 인증이 먼저다(경로 존재 여부도 드러내지 않는다)
    const token = deps.getToken()
    if (!token || !isCookieValid(req.headers.cookie, token)) {
      limiter.recordFailure(addr)
      sendError(res, isApi, 401, '설정 화면의 QR 을 다시 스캔하세요.', UNAUTHORIZED_HTML)
      return
    }

    const allowed = allowedMethods(pathname)
    if (!allowed) {
      sendError(res, isApi, 404, '찾을 수 없습니다.')
      return
    }
    if (!allowed.includes(req.method ?? '')) {
      res.setHeader('Allow', allowed.join(', '))
      sendError(res, isApi, 405, '허용되지 않은 메서드입니다.')
      return
    }

    if (isApi) {
      await handleApi(req, res, pathname, search)
    } else {
      await handleStatic(res, pathname, token)
    }
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    handle(req, res).catch((err: unknown) => {
      const isApi = (req.url ?? '').startsWith('/api/')
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (err instanceof HttpError) {
        if (err.status === 413) {
          // 남은 본문을 기다리지 않고 응답 뒤 연결을 닫는다
          res.setHeader('Connection', 'close')
          res.on('finish', () => req.destroy())
        }
        sendError(res, isApi, err.status, err.message)
        return
      }
      console.error('[mobile-server]', err)
      sendError(res, isApi, 500, '서버 오류가 발생했습니다.')
    })
  }

  function tryListen(srv: Server, p: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        srv.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        srv.removeListener('error', onError)
        const a = srv.address()
        resolve(typeof a === 'object' && a ? a.port : p)
      }
      srv.once('error', onError)
      srv.once('listening', onListening)
      srv.listen(p, host)
    })
  }

  return {
    get port() {
      return port
    },
    get running() {
      return server !== null && server.listening
    },
    async listen(ports, host = '0.0.0.0') {
      if (server) throw new Error('이미 실행 중입니다.')
      let lastError: unknown = new Error('시도할 포트가 없습니다.')
      for (const p of ports) {
        const srv = createServer(onRequest)
        srv.headersTimeout = 10_000
        srv.requestTimeout = 15_000
        srv.keepAliveTimeout = 5_000
        srv.maxHeadersCount = 50
        try {
          port = await tryListen(srv, p, host)
          server = srv
          srv.on('error', (err) => console.error('[mobile-server]', err))
          return port
        } catch (err) {
          lastError = err
          srv.close()
        }
      }
      port = null
      throw lastError
    },
    async close() {
      const srv = server
      server = null
      port = null
      if (!srv) return
      await new Promise<void>((resolve) => {
        srv.close(() => resolve())
        srv.closeAllConnections()
      })
    }
  }
}
