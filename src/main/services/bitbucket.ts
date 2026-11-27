import { safeStorage } from 'electron'
import { getDatabase } from '../db/database'
import { parseBitbucketUrl } from './bitbucket-url'
import { getUrlBlockReason } from './web-fetch'

// Bitbucket Cloud 조회 (읽기 전용). AI read_bitbucket·fetch_url 도구의 저장소 읽기와
// 나에게 온 요청의 리뷰 요청 PR 조회(listReviewRequests, docs/ASSISTANT.md §11.6)가 쓴다.
//
// [가드레일] — docs/AI_GUARDRAILS.md 8.7
// - 인증은 Atlassian 이메일 + Bitbucket API token 의 Basic 인증이다.
// - token 은 app_settings 에 safeStorage 로 암호화해 저장한다 (notion.ts 와 같은 패턴).
// - 이 모듈은 GET 만 호출한다. 쓰기 API 를 호출하지 않는다.
// - 인증 헤더는 https://api.bitbucket.org 에만 보낸다. 다른 호스트로 가는 리다이렉트에는 붙이지 않는다.
// - token·이메일·Authorization 값은 에러 메시지와 반환값에 넣지 않는다.
// - 응답 2MB / 요청 15초 / 본문 15,000자 / 목록 5페이지·500항목 상한.

const API_ORIGIN = 'https://api.bitbucket.org'
const API_HOST = 'api.bitbucket.org'
const API_BASE = `${API_ORIGIN}/2.0`
const REQUEST_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 5
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_CONTENT_CHARS = 15_000
const MAX_LIST_PAGES = 5
const MAX_LIST_ENTRIES = 500
const LIST_PAGE_LEN = 100
// 슬래시가 든 브랜치를 찾으려고 ref 를 늘려 다시 시도하는 최대 횟수
const MAX_REF_RETRIES = 3

const EMAIL_KEY = 'bitbucket_email'
const TOKEN_KEY = 'bitbucket_api_token'
// 리뷰 요청을 찾을 워크스페이스 slug. 비밀값이 아니라 암호화하지 않는다
const WORKSPACE_KEY = 'bitbucket_workspace'

export const BITBUCKET_NOT_CONNECTED_MESSAGE =
  'Bitbucket 이 연동되어 있지 않습니다. 설정 > 연동(linkwork://view/settings)의 Bitbucket 카드에서 Atlassian 이메일과 Bitbucket API token 을 등록하도록 사용자에게 안내하세요.'

const AUTH_FAILED_MESSAGE =
  'Bitbucket 인증에 실패했습니다. Atlassian 이메일, API token, token 스코프(read:repository)를 확인한 뒤 다시 등록해 주세요.'
const NOT_FOUND_MESSAGE =
  'Bitbucket 에서 대상을 찾을 수 없습니다. 저장소·경로·브랜치가 맞는지 확인하세요. token 계정에 그 저장소의 읽기 권한이 있는지도 확인하세요.'

// ── 저장 (notion.ts 와 같은 encrypt/decrypt 패턴) ──

function encrypt(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString('base64')
  }
  return value
}

function decrypt(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return value
    }
  }
  return value
}

function readSetting(key: string): string | null {
  const row = getDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row ? row.value : null
}

function writeSetting(key: string, value: string): void {
  getDatabase()
    .prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    )
    .run(key, value)
}

function getBitbucketToken(): string | null {
  const raw = readSetting(TOKEN_KEY)
  return raw ? decrypt(raw) : null
}

export function getBitbucketEmail(): string | null {
  return readSetting(EMAIL_KEY)
}

// 연결 판정은 token 기준이다. 백업 복원 뒤에는 이메일만 남고 token 은 없다. 이때 false 다.
export function isBitbucketConnected(): boolean {
  return getBitbucketToken() !== null && getBitbucketEmail() !== null
}

export function disconnectBitbucket(): void {
  const db = getDatabase()
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(TOKEN_KEY)
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(EMAIL_KEY)
}

function basicAuth(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`, 'utf-8').toString('base64')}`
}

function getStoredAuth(): string {
  const email = getBitbucketEmail()
  const token = getBitbucketToken()
  if (!email || !token) throw new Error(BITBUCKET_NOT_CONNECTED_MESSAGE)
  return basicAuth(email, token)
}

// ── HTTP (GET 전용, 수동 리다이렉트) ──

class BitbucketHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

interface BodyResult {
  text: string
  bytes: Uint8Array
  overflow: boolean
}

async function readBodyWithCap(res: Response, maxBytes: number): Promise<BodyResult> {
  const empty = { text: '', bytes: new Uint8Array(0), overflow: false }
  if (!res.body) return empty
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let overflow = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (received + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - received))
      received = maxBytes
      overflow = true
      void reader.cancel().catch(() => {})
      break
    }
    received += value.byteLength
    chunks.push(value)
  }
  const bytes = new Uint8Array(Buffer.concat(chunks))
  return { text: Buffer.from(bytes).toString('utf-8'), bytes, overflow }
}

// 인증 헤더는 https://api.bitbucket.org 에만 붙인다.
function isApiUrl(url: URL): boolean {
  return url.protocol === 'https:' && url.hostname.toLowerCase() === API_HOST && !url.username
}

// 상태 코드를 사용자용 한국어 메시지로 바꾼다. 응답 본문의 오류 문구만 짧게 덧붙인다.
async function toHttpError(res: Response): Promise<BitbucketHttpError> {
  if (res.status === 401 || res.status === 403) {
    return new BitbucketHttpError(res.status, AUTH_FAILED_MESSAGE)
  }
  if (res.status === 404) return new BitbucketHttpError(404, NOT_FOUND_MESSAGE)
  if (res.status === 429) {
    return new BitbucketHttpError(
      429,
      'Bitbucket API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.'
    )
  }
  let detail = ''
  try {
    const body = await readBodyWithCap(res, 8 * 1024)
    const parsed = JSON.parse(body.text) as { error?: { message?: unknown } }
    if (typeof parsed.error?.message === 'string') detail = `: ${parsed.error.message.slice(0, 200)}`
  } catch {
    // 본문이 JSON 이 아니면 상태 코드만 알린다
  }
  return new BitbucketHttpError(res.status, `Bitbucket API 오류 (${res.status})${detail}`)
}

async function bitbucketGet(startUrl: string, auth: string, accept: string): Promise<Response> {
  let current = new URL(startUrl)
  if (!isApiUrl(current)) throw new Error('Bitbucket API 주소가 아닙니다.')

  for (let redirects = 0; ; redirects++) {
    const headers: Record<string, string> = { Accept: accept }
    if (isApiUrl(current)) {
      headers.Authorization = auth
    } else {
      // api.bitbucket.org 밖으로 가는 리다이렉트다. 인증 없이 https 공개 주소만 따라간다.
      if (current.protocol !== 'https:') throw new Error('Bitbucket 리다이렉트 주소가 https 가 아닙니다.')
      const reason = getUrlBlockReason(current.toString())
      if (reason) throw new Error(reason)
    }

    const res = await fetch(current.toString(), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new Error(`Bitbucket 리다이렉트 응답에 Location 이 없습니다 (${res.status}).`)
      if (redirects >= MAX_REDIRECTS) throw new Error('Bitbucket 리다이렉트가 너무 많습니다.')
      current = new URL(location, current)
      continue
    }
    if (!res.ok) throw await toHttpError(res)
    return res
  }
}

async function getJson<T>(url: string, auth: string): Promise<T> {
  const res = await bitbucketGet(url, auth, 'application/json')
  const body = await readBodyWithCap(res, MAX_RESPONSE_BYTES)
  if (body.overflow) throw new Error('Bitbucket 응답이 너무 큽니다 (2MB 초과).')
  try {
    return JSON.parse(body.text) as T
  } catch {
    throw new Error('Bitbucket 응답을 해석할 수 없습니다.')
  }
}

// ── 연동 등록 ──

export async function saveBitbucketCredentials(
  email: string,
  token: string
): Promise<{ account: string }> {
  const trimmedEmail = email.trim()
  const trimmedToken = token.trim()
  if (!trimmedEmail) throw new Error('Atlassian 이메일이 비어 있습니다.')
  if (!/^[^\s@]+@[^\s@]+$/.test(trimmedEmail)) throw new Error('Atlassian 이메일 형식이 아닙니다.')
  if (!trimmedToken) throw new Error('Bitbucket API token 이 비어 있습니다.')

  const auth = basicAuth(trimmedEmail, trimmedToken)
  let account = trimmedEmail
  try {
    const me = await getJson<{ display_name?: unknown }>(`${API_BASE}/user`, auth)
    if (typeof me.display_name === 'string' && me.display_name.trim()) {
      account = me.display_name.trim()
    }
  } catch (err) {
    // 403 은 인증은 됐지만 read:user 스코프가 없다는 뜻이다. read:user 는 선택 스코프라 등록을 허용한다.
    // 401 은 이메일·token 이 틀렸다는 뜻이다. 이때는 등록하지 않는다.
    if (!(err instanceof BitbucketHttpError && err.status === 403)) {
      if (err instanceof BitbucketHttpError && err.status === 401) throw new Error(AUTH_FAILED_MESSAGE)
      throw err
    }
  }

  writeSetting(EMAIL_KEY, trimmedEmail)
  writeSetting(TOKEN_KEY, encrypt(trimmedToken))
  return { account }
}

/**
 * 설정 화면 [연결 테스트]. 저장된 자격 증명으로 /user 를 GET 한 번 부른다.
 * 403 은 read:user 스코프만 없는 것이라(등록과 같은 판단) 성공으로 보고 이메일을 계정으로 쓴다.
 * 그 밖의 실패는 status 가 붙은 BitbucketHttpError 를 그대로 던진다(분류는 integration-verify.ts).
 */
export async function verifyStoredBitbucket(): Promise<{ account: string | null }> {
  const email = getBitbucketEmail()
  try {
    const me = await getJson<{ display_name?: unknown }>(`${API_BASE}/user`, getStoredAuth())
    if (typeof me.display_name === 'string' && me.display_name.trim()) {
      return { account: me.display_name.trim() }
    }
    return { account: email }
  } catch (err) {
    if (err instanceof BitbucketHttpError && err.status === 403) return { account: email }
    throw err
  }
}

// ── 저장소 조회 ──

interface BitbucketDirectoryEntry {
  path: string
  type: 'file' | 'directory'
  size?: number
}

interface BitbucketSourceBase {
  url: string
  workspace: string
  repo: string
  ref: string
  path: string
  truncated: boolean
}

export type BitbucketSourceResult =
  | (BitbucketSourceBase & { type: 'file'; content: string })
  | (BitbucketSourceBase & { type: 'directory'; entries: BitbucketDirectoryEntry[] })

interface SrcMeta {
  type?: string
  size?: number
  mimetype?: string | null
  attributes?: string[]
}

interface SrcListingPage {
  values?: Array<{ path?: string; type?: string; size?: number }>
  next?: string
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/')
}

// ref 는 한 세그먼트로 보낸다. 슬래시가 든 브랜치는 %2F 로 인코딩된다.
function srcUrl(workspace: string, repo: string, ref: string, path: string): string {
  const base = `${API_BASE}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/src/${encodeURIComponent(ref)}/`
  return base + encodePath(path)
}

async function getMainBranch(workspace: string, repo: string, auth: string): Promise<string> {
  const info = await getJson<{ mainbranch?: { name?: unknown } }>(
    `${API_BASE}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}`,
    auth
  )
  const name = info.mainbranch?.name
  if (typeof name !== 'string' || !name) {
    throw new Error('저장소의 기본 브랜치를 알 수 없습니다. URL 에 브랜치를 포함해 주세요.')
  }
  return name
}

async function getMeta(
  workspace: string,
  repo: string,
  ref: string,
  path: string,
  auth: string
): Promise<SrcMeta> {
  if (!path) return { type: 'commit_directory' }
  return getJson<SrcMeta>(`${srcUrl(workspace, repo, ref, path)}?format=meta`, auth)
}

// ref 후보 목록. URL 의 첫 세그먼트를 ref 로 본 해석이 틀렸을 수 있다.
// 경로 앞 세그먼트를 ref 에 하나씩 붙여 최대 MAX_REF_RETRIES 회 다시 시도한다.
// 한계: 4단계 이상 슬래시가 든 브랜치는 찾지 못한다. 이때는 ?at= 가 붙은 URL 이 필요하다.
function refCandidates(ref: string, path: string): Array<{ ref: string; path: string }> {
  const candidates = [{ ref, path }]
  const segments = path.split('/').filter((s) => s.length > 0)
  for (let i = 1; i <= Math.min(MAX_REF_RETRIES, segments.length); i++) {
    candidates.push({
      ref: [ref, ...segments.slice(0, i)].join('/'),
      path: segments.slice(i).join('/')
    })
  }
  return candidates
}

function looksBinary(meta: SrcMeta, bytes: Uint8Array): boolean {
  if (meta.attributes?.includes('binary')) return true
  const mime = meta.mimetype ?? ''
  if (/^(image|audio|video|font)\//.test(mime) || mime === 'application/zip') return true
  const sample = bytes.subarray(0, 8000)
  return sample.includes(0)
}

async function readDirectory(
  workspace: string,
  repo: string,
  ref: string,
  path: string,
  auth: string
): Promise<{ entries: BitbucketDirectoryEntry[]; truncated: boolean }> {
  const entries: BitbucketDirectoryEntry[] = []
  let next: string | undefined = `${srcUrl(workspace, repo, ref, path)}${path ? '/' : ''}?pagelen=${LIST_PAGE_LEN}`
  let pages = 0
  while (next) {
    if (pages >= MAX_LIST_PAGES || entries.length >= MAX_LIST_ENTRIES) {
      return { entries, truncated: true }
    }
    // next 는 Bitbucket 이 준 주소다. api.bitbucket.org 가 아니면 bitbucketGet 이 거부한다.
    const page: SrcListingPage = await getJson<SrcListingPage>(next, auth)
    pages += 1
    for (const v of page.values ?? []) {
      if (entries.length >= MAX_LIST_ENTRIES) return { entries, truncated: true }
      if (typeof v.path !== 'string') continue
      const isDir = v.type === 'commit_directory'
      entries.push({
        path: v.path,
        type: isDir ? 'directory' : 'file',
        ...(!isDir && typeof v.size === 'number' ? { size: v.size } : {})
      })
    }
    next = typeof page.next === 'string' ? page.next : undefined
  }
  return { entries, truncated: false }
}

async function readFile(
  workspace: string,
  repo: string,
  ref: string,
  path: string,
  meta: SrcMeta,
  auth: string
): Promise<{ content: string; truncated: boolean }> {
  const res = await bitbucketGet(srcUrl(workspace, repo, ref, path), auth, '*/*')
  const body = await readBodyWithCap(res, MAX_RESPONSE_BYTES)
  if (looksBinary(meta, body.bytes)) {
    const size = typeof meta.size === 'number' ? `${meta.size} 바이트` : '크기 미상'
    return {
      content: `(바이너리 파일이라 본문을 표시하지 않습니다. ${size}${meta.mimetype ? `, ${meta.mimetype}` : ''})`,
      truncated: false
    }
  }
  let content = body.text
  let truncated = body.overflow
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS)
    truncated = true
  }
  return { content, truncated }
}

export async function readBitbucketSource(url: string): Promise<BitbucketSourceResult> {
  const location = parseBitbucketUrl(url)
  if (!location) {
    throw new Error(
      'Bitbucket 저장소 파일·폴더 URL 이 아닙니다. https://bitbucket.org/{workspace}/{repo}/src/{브랜치}/{경로} 형식만 읽을 수 있습니다.'
    )
  }
  const auth = getStoredAuth()
  const { workspace, repo } = location

  const firstRef = location.ref ?? (await getMainBranch(workspace, repo, auth))
  // ref 를 URL 에서 읽었을 때만 슬래시 브랜치 재시도를 한다. 기본 브랜치는 정확한 이름이다.
  const candidates =
    location.ref === null
      ? [{ ref: firstRef, path: location.path }]
      : refCandidates(firstRef, location.path)

  let lastError: unknown = null
  for (const candidate of candidates) {
    let meta: SrcMeta
    try {
      meta = await getMeta(workspace, repo, candidate.ref, candidate.path, auth)
    } catch (err) {
      lastError = err
      if (err instanceof BitbucketHttpError && err.status === 404) continue
      throw err
    }

    const base = { url, workspace, repo, ref: candidate.ref, path: candidate.path }
    if (meta.type === 'commit_directory') {
      const listing = await readDirectory(workspace, repo, candidate.ref, candidate.path, auth)
      return { ...base, type: 'directory', ...listing }
    }
    const file = await readFile(workspace, repo, candidate.ref, candidate.path, meta, auth)
    return { ...base, type: 'file', ...file }
  }
  throw lastError instanceof Error ? lastError : new Error(NOT_FOUND_MESSAGE)
}

// ── 리뷰 요청 (나에게 온 요청, docs/ASSISTANT.md §11.6) ──
//
// Bitbucket Cloud 에는 "내가 리뷰어인 PR 전체" API 가 없다(작성자 기준 API 만 있다).
// 그래서 워크스페이스에서 최근 갱신된 저장소 REVIEW_REPO_LIMIT 개를 골라, 저장소마다 열린 PR 중
// 나를 리뷰어로 둔 것을 BBQL(q=)로 찾는다. 이미 승인했거나 변경 요청한 PR 은 처리한 것으로 보고 뺀다.
// 필요한 token 스코프: read:repository(저장소 목록), read:pullrequest(PR). 내 uuid 는 read:user 로 읽고,
// 그 스코프가 없으면 호출자가 넘긴 Atlassian accountId(Jira 와 같은 값)로 찾는다.

/** 리뷰 요청을 찾을 저장소 수(최근 갱신순) */
export const REVIEW_REPO_LIMIT = 30
/** 승인 여부를 확인할 PR 수 상한(이미 처리한 PR 은 세지 않는다) */
const REVIEW_DETAIL_LIMIT = 40
/** 동시에 보내는 요청 수 */
const REVIEW_CONCURRENCY = 5

const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,61}$/
const UUID_RE = /^\{[0-9a-fA-F-]{36}\}$/
const ACCOUNT_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/

export const BITBUCKET_NO_WORKSPACE_MESSAGE =
  '리뷰 요청을 찾을 Bitbucket 워크스페이스가 정해지지 않았습니다. 설정 > 연동의 Bitbucket 카드에서 워크스페이스를 입력해 주세요.'
const PR_SCOPE_MESSAGE =
  'Bitbucket token 에 PR 읽기 권한(read:pullrequest)이 없습니다. 이 범위를 넣은 token 으로 다시 등록해 주세요.'
const WORKSPACE_NOT_FOUND_MESSAGE =
  'Bitbucket 워크스페이스를 찾을 수 없습니다. 설정 > 연동의 Bitbucket 카드에서 워크스페이스 이름을 확인해 주세요.'

export function getBitbucketWorkspace(): string | null {
  const v = readSetting(WORKSPACE_KEY)
  return v && WORKSPACE_RE.test(v) ? v : null
}

/**
 * 워크스페이스를 저장한다. slug 또는 https://bitbucket.org/{slug}/... 주소를 받는다. 빈 값이면 지운다.
 * 반환: 저장한 slug(지웠으면 null). 형식이 틀리면 throw
 */
export function setBitbucketWorkspace(input: unknown): string | null {
  if (input === null || input === undefined) {
    getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(WORKSPACE_KEY)
    return null
  }
  if (typeof input !== 'string') throw new Error('워크스페이스 형식이 올바르지 않습니다.')
  let value = input.trim()
  if (value === '') return setBitbucketWorkspace(null)
  const m = /^https:\/\/bitbucket\.org\/([^/?#]+)/i.exec(value)
  if (m) value = m[1]
  if (!WORKSPACE_RE.test(value)) throw new Error('워크스페이스 이름은 영문·숫자·-·_·. 만 쓸 수 있습니다.')
  writeSetting(WORKSPACE_KEY, value)
  return value
}

export interface BitbucketReviewRequest {
  workspace: string
  repo: string
  id: number
  title: string
  authorName: string | null
  /** PR 웹 주소(https://bitbucket.org/...) */
  url: string
  /** PR 생성 시각 원본 ISO */
  createdOn: string
}

interface RawUser {
  uuid?: unknown
  account_id?: unknown
  display_name?: unknown
}

interface RawPullRequest {
  id?: unknown
  title?: unknown
  created_on?: unknown
  author?: RawUser | null
  links?: { html?: { href?: unknown } | null } | null
  participants?: Array<{ user?: RawUser | null; approved?: unknown; state?: unknown } | null> | null
}

/** 나를 찾는 BBQL 조건. uuid 를 먼저 쓰고, 없으면 accountId 를 쓴다 */
export function reviewerQuery(me: { uuid: string | null; accountId: string | null }): string | null {
  if (me.uuid && UUID_RE.test(me.uuid)) return `state="OPEN" AND reviewers.uuid="${me.uuid}"`
  if (me.accountId && ACCOUNT_ID_RE.test(me.accountId)) {
    return `state="OPEN" AND reviewers.account_id="${me.accountId}"`
  }
  return null
}

/** PR 상세의 참여자 중 내가 이미 승인했거나 변경 요청했는가 */
export function reviewHandledByMe(
  pr: unknown,
  me: { uuid: string | null; accountId: string | null }
): boolean {
  const parts = (pr as RawPullRequest)?.participants ?? []
  return parts.some((p) => {
    if (!p?.user) return false
    const mine =
      (me.uuid !== null && p.user.uuid === me.uuid) || (me.accountId !== null && p.user.account_id === me.accountId)
    return mine && (p.approved === true || p.state === 'approved' || p.state === 'changes_requested')
  })
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

async function whoAmI(auth: string, fallbackAccountId: string | null): Promise<{ uuid: string | null; accountId: string | null }> {
  try {
    const me = await getJson<RawUser>(`${API_BASE}/user`, auth)
    return {
      uuid: typeof me.uuid === 'string' ? me.uuid : null,
      accountId: typeof me.account_id === 'string' ? me.account_id : fallbackAccountId
    }
  } catch (err) {
    // 403 은 read:user 스코프만 없는 것이다. Atlassian accountId 로 찾는다
    if (err instanceof BitbucketHttpError && err.status === 403) return { uuid: null, accountId: fallbackAccountId }
    throw err
  }
}

/**
 * 워크스페이스의 최근 저장소에서 나에게 리뷰를 요청한 열린 PR.
 * complete 는 모든 저장소 조회가 온전했는지다(하나라도 실패하거나 잘리면 false — 호출자가 사라진 요청을 지우지 않는다).
 * isHandled 가 true 인 PR(이미 할 일로 바꾸거나 처리함)은 승인 여부 상세 GET 을 건너뛰고 그대로 돌려준다.
 */
export async function listReviewRequests(
  fallbackAccountId: string | null,
  isHandled: (workspace: string, repo: string, id: number) => boolean = () => false
): Promise<{ requests: BitbucketReviewRequest[]; complete: boolean }> {
  const auth = getStoredAuth()
  const workspace = getBitbucketWorkspace()
  if (!workspace) throw new Error(BITBUCKET_NO_WORKSPACE_MESSAGE)
  const me = await whoAmI(auth, fallbackAccountId)
  const q = reviewerQuery(me)
  if (!q) {
    throw new Error(
      'Bitbucket 계정을 확인하지 못했습니다. token 에 read:user 범위를 넣거나 Jira 를 연결해 주세요.'
    )
  }

  const ws = encodeURIComponent(workspace)
  let repos: string[]
  try {
    const page = await getJson<{ values?: Array<{ slug?: unknown } | null> }>(
      `${API_BASE}/repositories/${ws}?${new URLSearchParams({
        role: 'member',
        sort: '-updated_on',
        pagelen: String(REVIEW_REPO_LIMIT),
        fields: 'values.slug'
      })}`,
      auth
    )
    repos = (page.values ?? [])
      .map((v) => v?.slug)
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
  } catch (err) {
    if (err instanceof BitbucketHttpError && err.status === 404) throw new Error(WORKSPACE_NOT_FOUND_MESSAGE)
    throw err
  }

  let failures = 0
  let forbidden = 0
  let morePages = false
  let firstError: unknown = null
  const listed = await mapLimit(repos, REVIEW_CONCURRENCY, async (repo) => {
    try {
      const page = await getJson<{ values?: Array<RawPullRequest | null>; next?: unknown }>(
        `${API_BASE}/repositories/${ws}/${encodeURIComponent(repo)}/pullrequests?${new URLSearchParams({
          q,
          pagelen: '50'
        })}`,
        auth
      )
      // 다음 페이지는 읽지 않는다. 남은 PR 이 있으면 미완료로 둔다
      if (typeof page.next === 'string') morePages = true
      return (page.values ?? []).flatMap((pr) => (pr ? [{ repo, pr }] : []))
    } catch (err) {
      // 403 은 저장소 하나의 권한 제한일 수 있다. 전부 403 일 때만 스코프 부족으로 본다
      if (err instanceof BitbucketHttpError && err.status === 403) forbidden += 1
      failures += 1
      firstError ??= err
      return []
    }
  })
  if (repos.length > 0 && failures === repos.length) {
    if (forbidden === repos.length) throw new Error(PR_SCOPE_MESSAGE)
    throw firstError instanceof Error ? firstError : new Error('Bitbucket PR 을 읽지 못했습니다.')
  }

  const candidates = listed.flat()
  let complete = failures === 0 && !morePages
  let detailCalls = 0
  const checked = await mapLimit(candidates, REVIEW_CONCURRENCY, async ({ repo, pr }) => {
    const id = typeof pr.id === 'number' ? pr.id : null
    const href = pr.links?.html?.href
    if (id === null || typeof href !== 'string' || !href.startsWith('https://bitbucket.org/')) return null
    const handled = isHandled(workspace, repo, id)
    if (!handled && detailCalls >= REVIEW_DETAIL_LIMIT) {
      complete = false
      return null
    }
    if (!handled) {
      detailCalls += 1
      try {
        const detail = await getJson<RawPullRequest>(
          `${API_BASE}/repositories/${ws}/${encodeURIComponent(repo)}/pullrequests/${id}`,
          auth
        )
        if (reviewHandledByMe(detail, me)) return null
      } catch {
        // 상세를 못 읽으면 이번에는 넣지 않는다. 이미 있던 행이 지워지지 않게 미완료로 둔다
        complete = false
        return null
      }
    }
    const request: BitbucketReviewRequest = {
      workspace,
      repo,
      id,
      title: typeof pr.title === 'string' ? pr.title : '',
      authorName: typeof pr.author?.display_name === 'string' ? pr.author.display_name : null,
      url: href,
      createdOn: typeof pr.created_on === 'string' ? pr.created_on : ''
    }
    return request
  })
  return { requests: checked.filter((r): r is BitbucketReviewRequest => r !== null), complete }
}
