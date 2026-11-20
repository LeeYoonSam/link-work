import { safeStorage } from 'electron'
import { getDatabase } from '../db/database'

// Jira Cloud REST 연동 (읽기 전용 사용).
//
// [가드레일]
// - API 토큰은 app_settings에 safeStorage로 암호화해 저장한다 (notion.ts와 동일 패턴).
// - renderer에는 연결 여부·계정 표시명·만료일만 내보내고 토큰 값은 절대 노출하지 않는다.
// - 이 모듈은 조회 API(myself, project, version, search/jql, issue/{key}/remotelink)만 호출한다 — 쓰기 API 호출 금지.
//   프로젝트 보드도 Jira를 읽기만 하고 DB에 쓰지 않는다.
// - Jira REST 호출은 전부 이 파일에만 둔다. 엔드포인트가 또 바뀌어도 수정 지점이 하나다
//   (구 /rest/api/3/search 제거 전례 — 아래 searchJql 주석 참고).
// - 한 릴리스에서 가져오는 이슈는 MAX_ISSUES로 상한을 둬 응답이 무한정 커지지 않게 한다.

const REQUEST_TIMEOUT_MS = 15_000

/** 한 릴리스에서 가져올 이슈 상한 */
export const MAX_ISSUES = 500
// 페이지당 100건 × 5페이지 = MAX_ISSUES. 두 값을 따로 바꾸면 상한이 어긋난다.
const ISSUE_PAGE_SIZE = 100
const MAX_ISSUE_PAGES = 5

// PageBean 계열(project/search, project/{key}/version) 공용 페이지네이션 상한.
// 이쪽은 커서가 아니라 startAt/isLast라 무한 루프 방지용 페이지 상한을 따로 둔다.
const PAGE_BEAN_SIZE = 50
const MAX_PAGE_BEAN_PAGES = 20

// 429 재시도 — 2초 시작, 매회 2배, 30초 상한, 지터 계수 0.7~1.3, 재시도 4회(총 5요청).
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 30_000
const MAX_RETRIES = 4

// 만료 임박 경고 기준. API 토큰은 최대 1년 만료라 "등록하고 잊는" 운영이 불가능하다
// (docs/RELEASE_NOTES.md §2.1) — 조용히 만료돼 방치되는 것을 막으려고 미리 알린다.
const EXPIRING_SOON_DAYS = 30

const SITE_URL_KEY = 'jira_site_url'
const EMAIL_KEY = 'jira_email'
const TOKEN_KEY = 'jira_api_token'
const EXPIRES_AT_KEY = 'jira_token_expires_at'
// 계약서에 없는 추가 키. 표시명은 /myself 응답에만 있어 저장해 두지 않으면
// 상태 조회 때마다 네트워크를 타야 한다.
const ACCOUNT_NAME_KEY = 'jira_account_name'
// 전체 동기화가 deploy_version과 버전 이름을 맞춰볼 대상 Jira 프로젝트.
// 워크스페이스에 프로젝트가 수십 개라 어디서 찾을지 지정돼 있어야 한다.
// 비밀값이 아니므로 암호화하지 않는다.
const DEFAULT_PROJECT_KEY_KEY = 'jira_default_project_key'

const NOT_CONNECTED_MESSAGE =
  'Jira에 연결되어 있지 않습니다. 연동 설정에서 API 토큰을 등록해 주세요.'

export interface JiraCredentialsInput {
  siteUrl: string
  email: string
  apiToken: string
  expiresAt: string
}

export interface JiraConnectionStatus {
  connected: boolean
  siteUrl: string | null
  accountName: string | null
  defaultProjectKey: string | null
  expiresAt: string | null
  expiringSoon: boolean
  expired: boolean
  /** 저장된 Atlassian 이메일. Bitbucket 팝업에 미리 채운다. 토큰은 내보내지 않는다 */
  email: string | null
}

export interface JiraProjectSummary {
  key: string
  name: string
}

export interface JiraVersionSummary {
  id: string
  name: string
  description: string | null
  released: boolean
  archived: boolean
  releaseDate: string | null
  startDate: string | null
}

export interface JiraIssueSummary {
  key: string
  issueType: string | null
  status: string | null
  resolution: string | null
  summary: string
  parentKey: string | null
}

interface JiraCredentials {
  siteUrl: string
  email: string
  apiToken: string
}

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

// 사이트 URL의 뒤 슬래시를 제거해 저장·조립 양쪽에서 `//rest/...`가 생기지 않게 한다.
function normalizeSiteUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function getCredentials(): JiraCredentials | null {
  const siteUrl = readSetting(SITE_URL_KEY)
  const email = readSetting(EMAIL_KEY)
  const token = readSetting(TOKEN_KEY)
  if (!siteUrl || !email || !token) return null
  return { siteUrl: normalizeSiteUrl(siteUrl), email, apiToken: decrypt(token) }
}

export function isJiraConnected(): boolean {
  return getCredentials() !== null
}

export function getDefaultJiraProjectKey(): string | null {
  return readSetting(DEFAULT_PROJECT_KEY_KEY)
}

// Jira 프로젝트 키는 대문자로 시작하는 영숫자/언더스코어다. 검증해 두면 이 값이
// 그대로 /project/{key}/... 경로에 들어가도 안전하고, 오타가 조용히 저장되지 않는다.
export function setDefaultJiraProjectKey(key: string | null): void {
  if (key === null) {
    getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(DEFAULT_PROJECT_KEY_KEY)
    return
  }
  const trimmed = key.trim()
  if (!/^[A-Z][A-Z0-9_]*$/.test(trimmed)) {
    throw new Error('잘못된 Jira 프로젝트 키입니다. 대문자로 시작하는 프로젝트 키를 입력해 주세요.')
  }
  writeSetting(DEFAULT_PROJECT_KEY_KEY, trimmed)
}

// YYYY-MM-DD를 로컬 자정 기준으로 비교한다. Date 파싱에 문자열을 그대로 넘기면
// UTC로 해석돼 시간대에 따라 하루가 밀리므로 숫자로 쪼개 만든다.
function daysUntil(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim())
  if (!m) return null
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(target.getTime())) return null
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target.getTime() - today.getTime()) / 86_400_000)
}

export function getJiraStatus(): JiraConnectionStatus {
  const creds = getCredentials()
  const expiresAt = readSetting(EXPIRES_AT_KEY)
  const remaining = expiresAt ? daysUntil(expiresAt) : null

  return {
    connected: creds !== null,
    siteUrl: creds?.siteUrl ?? null,
    accountName: creds ? (readSetting(ACCOUNT_NAME_KEY) ?? creds.email) : null,
    defaultProjectKey: getDefaultJiraProjectKey(),
    expiresAt,
    // 미연결 상태에서 "만료 임박"을 띄우면 사용자가 할 일이 없어 혼란만 준다.
    expiringSoon:
      creds !== null && remaining !== null && remaining >= 0 && remaining <= EXPIRING_SOON_DAYS,
    expired: creds !== null && remaining !== null && remaining < 0,
    // 토큰 없이 이메일만 남은 경우(백업 복원 뒤)에도 돌려준다. 다시 연결할 때 미리 채운다
    email: readSetting(EMAIL_KEY)
  }
}

/**
 * 설정 화면 [연결 테스트]. 저장된 자격 증명으로 /myself 를 GET 한 번 부른다.
 * 실패하면 status 가 붙은 에러를 던진다(분류는 integration-verify.ts). 토큰은 돌려주지 않는다.
 */
export async function verifyStoredJira(): Promise<{ account: string | null }> {
  // 연결 테스트는 429 여도 재시도 없이 바로 끝낸다(재시도 누적 시 버튼이 최대 2분 멈춘다)
  const me = (await jiraRequest('/rest/api/3/myself', undefined, { maxRetries: 0 })) as {
    displayName?: string
    emailAddress?: string
  }
  return { account: me.displayName ?? me.emailAddress ?? readSetting(EMAIL_KEY) }
}

export function disconnectJira(): void {
  const stmt = getDatabase().prepare('DELETE FROM app_settings WHERE key = ?')
  // 기본 프로젝트 키도 함께 지운다 — 남겨 두면 다른 사이트/계정으로 다시 연결했을 때
  // 존재하지도 않는 이전 프로젝트를 가리킨 채로 전체 동기화가 돈다.
  for (const key of [
    SITE_URL_KEY,
    EMAIL_KEY,
    TOKEN_KEY,
    EXPIRES_AT_KEY,
    ACCOUNT_NAME_KEY,
    DEFAULT_PROJECT_KEY_KEY
  ]) {
    stmt.run(key)
  }
}

// 검증에 성공해야만 저장한다 — 잘못된 토큰이 저장되면 이후 모든 동기화가
// 401로 실패하면서 원인이 등록 시점이었다는 사실이 드러나지 않는다.
export async function saveJiraCredentials(
  input: JiraCredentialsInput
): Promise<{ accountName: string }> {
  const siteUrl = normalizeSiteUrl(input.siteUrl ?? '')
  const email = (input.email ?? '').trim()
  const apiToken = (input.apiToken ?? '').trim()
  const expiresAt = (input.expiresAt ?? '').trim()

  if (!siteUrl) throw new Error('Jira 사이트 URL을 입력해 주세요.')
  if (!/^https?:\/\/[^/\s]+$/.test(siteUrl)) {
    throw new Error('Jira 사이트 URL 형식이 올바르지 않습니다. 예: https://your-site.atlassian.net')
  }
  if (!email) throw new Error('Jira 계정 이메일을 입력해 주세요.')
  if (!apiToken) throw new Error('Jira API 토큰을 입력해 주세요.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
    throw new Error('토큰 만료일을 YYYY-MM-DD 형식으로 입력해 주세요.')
  }

  const me = (await jiraRequest('/rest/api/3/myself', { siteUrl, email, apiToken })) as {
    displayName?: string
    emailAddress?: string
  }
  const accountName = me.displayName ?? me.emailAddress ?? email

  writeSetting(SITE_URL_KEY, siteUrl)
  writeSetting(EMAIL_KEY, email)
  writeSetting(TOKEN_KEY, encrypt(apiToken))
  writeSetting(EXPIRES_AT_KEY, expiresAt)
  writeSetting(ACCOUNT_NAME_KEY, accountName)

  return { accountName }
}

export function getJiraIssueUrl(issueKey: string): string | null {
  const creds = getCredentials()
  if (!creds) return null
  return `${creds.siteUrl}/browse/${encodeURIComponent(issueKey)}`
}

/**
 * 429 재시도 간격. Retry-After가 오면 그 값을 그대로 존중하고(서버가 아는 값이 항상 우선),
 * 없을 때만 지수 백오프 + 지터로 계산한다. 지터는 여러 요청이 같은 순간에 몰려
 * 다시 429를 맞는 것을 막는 용도라 Retry-After에는 적용하지 않는다.
 */
export function computeRetryDelayMs(
  attempt: number,
  retryAfter: string | null,
  random: () => number = Math.random
): number {
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, RETRY_MAX_MS)
    }
  }
  const base = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)
  // 지터를 곱한 뒤 한 번 더 자른다 — 곱하기 전에만 자르면 계수 1.3에서 30초를 넘어간다.
  return Math.min(Math.round(base * (0.7 + random() * 0.6)), RETRY_MAX_MS)
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))
}

async function jiraRequest(
  path: string,
  credsOverride?: JiraCredentials,
  options: { maxRetries?: number } = {}
): Promise<unknown> {
  const creds = credsOverride ?? getCredentials()
  if (!creds) throw new Error(NOT_CONNECTED_MESSAGE)
  const maxRetries = options.maxRetries ?? MAX_RETRIES

  const auth = Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64')

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${creds.siteUrl}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    if (res.ok) return res.json()

    if (res.status === 429) {
      if (attempt >= maxRetries) {
        throw Object.assign(
          new Error('Jira API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.'),
          { status: 429 }
        )
      }
      await sleep(computeRetryDelayMs(attempt, res.headers.get('Retry-After')))
      continue
    }

    throw mapErrorStatus(res.status, await res.text().catch(() => ''))
  }
}

// 상태 코드를 에러에 붙여 둔다. 연결 테스트가 메시지 대신 코드로 원인을 분류한다
function mapErrorStatus(status: number, body: string): Error {
  return Object.assign(mapErrorMessage(status, body), { status })
}

function mapErrorMessage(status: number, body: string): Error {
  if (status === 401) {
    return new Error(
      'Jira 토큰이 만료됐거나 유효하지 않습니다. 연동 설정에서 토큰을 다시 등록해 주세요.'
    )
  }
  if (status === 403) return new Error('해당 Jira 프로젝트에 접근할 권한이 없습니다.')
  if (status === 404) {
    return new Error('Jira에서 프로젝트 또는 버전을 찾을 수 없습니다. 삭제되었을 수 있습니다.')
  }
  // 410은 사실상 코드 버그 신호다 — 제거된 엔드포인트를 부르고 있다는 뜻이라 조용히 넘기면 안 된다.
  if (status === 410) return new Error('제거된 Jira API를 호출했습니다. 앱 업데이트가 필요합니다.')
  return new Error(`Jira API 오류 (${status}): ${body.slice(0, 200)}`)
}

interface PageBean<T> {
  startAt?: number
  maxResults?: number
  isLast?: boolean
  values?: T[]
}

// project/search와 project/{key}/version이 같은 PageBean 형태라 한 곳에서 처리한다.
// isLast가 빠진 응답에 대비해 "받은 개수 < 요청 개수"도 종료 신호로 함께 본다.
async function fetchAllPageBean<T>(buildPath: (startAt: number) => string): Promise<T[]> {
  const collected: T[] = []
  let startAt = 0

  for (let page = 0; page < MAX_PAGE_BEAN_PAGES; page++) {
    const data = (await jiraRequest(buildPath(startAt))) as PageBean<T>
    const values = data.values ?? []
    collected.push(...values)

    if (data.isLast === true || values.length === 0 || values.length < PAGE_BEAN_SIZE) break
    startAt += values.length
  }

  return collected
}

/**
 * /rest/api/3/search/jql 커서 페이지네이션 공용 루프. 릴리스·보드·비서 검색이 모두 이것을 쓴다.
 * - 구 GET|POST /rest/api/3/search는 2025년 10월에 제거됐다(410 Gone). 되돌리지 말 것.
 *   이 엔드포인트는 startAt/total이 없는 커서 기반이다. nextPageToken이 없으면 마지막 페이지다.
 * - /search/jql은 fields를 명시하지 않으면 id/key 정도만 돌려준다(구 /search와 다른 점).
 * - limit에 닿거나, 토큰이 남았는데 페이지 상한(MAX_ISSUE_PAGES)에 걸리면 truncated다.
 * - map이 null을 돌려주면 그 행은 건너뛴다(센 것으로 치지 않는다).
 */
async function searchJql<R, T>(
  jql: string,
  fields: string,
  limit: number,
  map: (raw: R) => T | null
): Promise<{ issues: T[]; truncated: boolean }> {
  const issues: T[] = []
  let truncated = false
  let nextPageToken: string | undefined

  for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
    const params = new URLSearchParams({ jql, fields, maxResults: String(ISSUE_PAGE_SIZE) })
    if (nextPageToken) params.set('nextPageToken', nextPageToken)

    const data = (await jiraRequest(`/rest/api/3/search/jql?${params}`)) as {
      issues?: R[]
      nextPageToken?: string
    }

    for (const raw of data.issues ?? []) {
      if (issues.length >= limit) {
        truncated = true
        break
      }
      const mapped = map(raw)
      if (mapped !== null) issues.push(mapped)
    }

    nextPageToken = data.nextPageToken ?? undefined
    if (!nextPageToken) break
    if (issues.length >= limit) {
      truncated = true
      break
    }
    // 아직 토큰이 남았는데 페이지 상한에 걸렸다면 가져오지 못한 이슈가 있다는 뜻이다.
    if (page === MAX_ISSUE_PAGES - 1) truncated = true
  }

  return { issues, truncated }
}

export async function listJiraProjects(): Promise<JiraProjectSummary[]> {
  const values = await fetchAllPageBean<{ key?: string; name?: string }>(
    (startAt) =>
      `/rest/api/3/project/search?${new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(PAGE_BEAN_SIZE),
        orderBy: 'key'
      })}`
  )

  return values
    .filter((p): p is { key: string; name?: string } => typeof p.key === 'string')
    .map((p) => ({ key: p.key, name: p.name ?? p.key }))
}

interface RawVersion {
  id?: string | number
  name?: string
  description?: string
  released?: boolean
  archived?: boolean
  releaseDate?: string
  startDate?: string
}

// 버전 ID는 Jira 응답 → release_notes.jira_version_id → 재호출로 흘러온다.
// 그 경로 어디서든 오염되면 JQL이 조작되므로(`10042 OR project = SECRET`) 호출 직전에 막는다.
// Jira Cloud의 버전 ID는 항상 숫자다.
function assertVersionId(versionId: string): string {
  if (!/^\d+$/.test(versionId)) throw new Error('잘못된 Jira 버전 ID입니다.')
  return versionId
}

// releaseDate/startDate/description은 응답에 아예 없을 수 있는 옵셔널 필드다.
// 여기서 null로 정규화해 두지 않으면 undefined가 그대로 DB 바인딩까지 흘러간다.
function toVersionSummary(raw: RawVersion): JiraVersionSummary {
  return {
    id: String(raw.id ?? ''),
    name: raw.name ?? '',
    description: raw.description ?? null,
    released: raw.released === true,
    archived: raw.archived === true,
    releaseDate: raw.releaseDate ?? null,
    startDate: raw.startDate ?? null
  }
}

export async function listJiraVersions(projectKey: string): Promise<JiraVersionSummary[]> {
  // 복수형 /versions는 비페이지네이션이라 버전이 많은 프로젝트에서 응답이 무한정 커진다.
  // 페이지네이션 되는 /version만 쓴다 (docs/RELEASE_NOTES.md §2.3).
  const values = await fetchAllPageBean<RawVersion>(
    (startAt) =>
      `/rest/api/3/project/${encodeURIComponent(projectKey)}/version?${new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(PAGE_BEAN_SIZE),
        orderBy: '-releaseDate'
      })}`
  )

  return values.map(toVersionSummary)
}

export async function getJiraVersion(versionId: string): Promise<JiraVersionSummary> {
  const id = assertVersionId(versionId)
  const raw = (await jiraRequest(`/rest/api/3/version/${id}`)) as RawVersion
  return toVersionSummary(raw)
}

interface RawIssue {
  key?: string
  fields?: {
    summary?: string
    issuetype?: { name?: string } | null
    status?: { name?: string } | null
    resolution?: { name?: string } | null
    parent?: { key?: string } | null
  }
}

export async function listIssuesByFixVersion(
  versionId: string
): Promise<{ issues: JiraIssueSummary[]; truncated: boolean }> {
  // JQL은 버전 이름이 아니라 불변 ID로 조립한다. 이름은 언제든 바뀌어(v1.2.0 → 1.2.0 (hotfix))
  // 이름으로 매칭하면 그 순간 동기화가 조용히 끊긴다.
  // 따옴표 없이 그대로 끼워 넣을 수 있는 것은 바로 위에서 숫자임을 검증했기 때문이다 —
  // assertVersionId를 빼면 JQL 인젝션이 열린다.
  const id = assertVersionId(versionId)
  // fields를 지우면 릴리스 노트가 제목 없는 껍데기가 된다(searchJql 주석 참고).
  return searchJql<RawIssue, JiraIssueSummary>(
    `fixVersion = ${id} ORDER BY issuetype, key`,
    'summary,issuetype,status,resolution,parent',
    MAX_ISSUES,
    toIssueSummary
  )
}

function toIssueSummary(raw: RawIssue): JiraIssueSummary {
  return {
    key: raw.key ?? '',
    issueType: raw.fields?.issuetype?.name ?? null,
    status: raw.fields?.status?.name ?? null,
    resolution: raw.fields?.resolution?.name ?? null,
    summary: raw.fields?.summary ?? '',
    parentKey: raw.fields?.parent?.key ?? null
  }
}

// ── 이슈 검색 (services/jira-board.ts 프로젝트 보드, assistant-sources.ts 비서) ──

/** 검색 한 번으로 가져올 이슈 상한 (검색 호출마다 따로 적용) */
export const MAX_SEARCH_ISSUES = 500
// 키 목록을 JQL `in (...)`에 넣을 때 한 번에 넣는 개수. URL 길이가 무한정 늘지 않게 나눈다.
const SEARCH_KEY_CHUNK = 50

const SEARCH_FIELDS =
  'summary,status,issuetype,priority,parent,assignee,duedate,updated,resolutiondate,labels,description,' +
  'fixVersions,attachment,issuelinks'

export type JiraIssueLevel = 'epic' | 'standard' | 'subtask'
export type JiraStatusCategory = 'new' | 'indeterminate' | 'done'

/** 보드·비서가 쓰는 만큼 정규화한 이슈 */
export interface JiraSearchIssue {
  key: string
  summary: string
  issueType: string
  level: JiraIssueLevel
  status: string
  statusCategory: JiraStatusCategory
  priority: string | null
  parentKey: string | null
  /** raw.fields.parent.fields.summary. 없으면 null */
  parentSummary: string | null
  assigneeAccountId: string | null
  assigneeName: string | null
  duedate: string | null
  /** Jira 원본 ISO 문자열 */
  updated: string
  /** resolutiondate. 없으면 null */
  resolvedAt: string | null
  labels: string[]
  /** ADF 원본. 해석은 jira-adf.ts가 한다 */
  description: unknown
  /** 이 이슈의 fixVersions */
  fixVersions: { id: string; name: string }[]
  /** 첨부 목록. url 은 첨부 content URL(브라우저에서 Jira 로그인으로 열린다) */
  attachments: JiraAttachmentRef[]
  /** 연결 이슈(issuelinks) */
  issueLinks: JiraIssueLinkRef[]
}

interface JiraAttachmentRef {
  filename: string
  url: string
  mimeType: string | null
  size: number | null
  createdAt: string | null
}

interface JiraIssueLinkRef {
  /** 이 이슈에서 본 관계 이름(Jira 표시 이름. 예: 관심, 선행 작업, blocks) */
  relation: string
  key: string
  summary: string
  /** 연결된 이슈의 상태 이름. 없으면 null */
  status: string | null
}

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]*$/
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/

// 아래 키들은 JQL에 따옴표 없이 그대로 들어간다. 키는 Jira 응답 → 캐시 → 다시 JQL로 흘러오므로
// 어디서든 오염되면 JQL이 조작된다(`PROJ-1) OR project = SECRET`). 호출 직전에 막는다.
function assertProjectKey(key: string): string {
  if (!PROJECT_KEY_RE.test(key)) throw new Error('잘못된 Jira 프로젝트 키입니다.')
  return key
}

function assertIssueKey(key: string): string {
  if (!ISSUE_KEY_RE.test(key)) throw new Error('잘못된 Jira 이슈 키입니다.')
  return key
}

/** 이슈 키 형식인가. IPC 입력 검증용 */
export function isJiraIssueKey(value: unknown): value is string {
  return typeof value === 'string' && ISSUE_KEY_RE.test(value)
}

interface RawSearchIssue {
  key?: string
  fields?: {
    summary?: string
    issuetype?: { name?: string; subtask?: boolean; hierarchyLevel?: number } | null
    status?: { name?: string; statusCategory?: { key?: string } | null } | null
    priority?: { name?: string } | null
    parent?: { key?: string; fields?: { summary?: string } } | null
    assignee?: { accountId?: string; displayName?: string } | null
    duedate?: string | null
    updated?: string | null
    resolutiondate?: string | null
    labels?: string[] | null
    description?: unknown
    fixVersions?: Array<{ id?: string | number; name?: string } | null> | null
    attachment?: Array<{
      filename?: string
      content?: string
      mimeType?: string
      size?: number
      created?: string
    } | null> | null
    issuelinks?: Array<{
      type?: { name?: string; inward?: string; outward?: string } | null
      inwardIssue?: RawLinkedIssue | null
      outwardIssue?: RawLinkedIssue | null
    } | null> | null
  }
}

interface RawLinkedIssue {
  key?: string
  fields?: { summary?: string; status?: { name?: string } | null }
}

function toFixVersions(raw: NonNullable<RawSearchIssue['fields']>['fixVersions']): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = []
  for (const v of raw ?? []) {
    if (v?.id === undefined || v.id === null) continue
    out.push({ id: String(v.id), name: v.name ?? String(v.id) })
  }
  return out
}

function toAttachments(raw: NonNullable<RawSearchIssue['fields']>['attachment']): JiraAttachmentRef[] {
  const out: JiraAttachmentRef[] = []
  for (const a of raw ?? []) {
    if (!a || typeof a.content !== 'string' || !/^https?:\/\//i.test(a.content)) continue
    out.push({
      filename: a.filename?.trim() || a.content,
      url: a.content,
      mimeType: a.mimeType ?? null,
      size: typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : null,
      createdAt: a.created ?? null
    })
  }
  return out
}

// 바깥 방향이면 outward("선행 작업"), 안쪽 방향이면 inward("후행 작업") 표시 이름을 쓴다
function toIssueLinks(raw: NonNullable<RawSearchIssue['fields']>['issuelinks']): JiraIssueLinkRef[] {
  const out: JiraIssueLinkRef[] = []
  for (const link of raw ?? []) {
    if (!link) continue
    const outward = link.outwardIssue ?? null
    const other = outward ?? link.inwardIssue ?? null
    if (!other?.key || !ISSUE_KEY_RE.test(other.key)) continue
    const relation =
      (outward ? link.type?.outward : link.type?.inward) || link.type?.name || '연결'
    out.push({
      relation,
      key: other.key,
      summary: other.fields?.summary ?? '',
      status: other.fields?.status?.name ?? null
    })
  }
  return out
}

// 계층은 hierarchyLevel(1=에픽, 0=표준, -1=하위 작업)이 기준이다. 오래된 응답에 값이 없으면
// subtask 플래그와 타입 이름으로 보완한다 — 타입 이름은 사이트 언어에 따라 "에픽"/"Epic"이다.
function toIssueLevel(
  issuetype: NonNullable<RawSearchIssue['fields']>['issuetype']
): JiraIssueLevel {
  if (issuetype?.subtask === true || issuetype?.hierarchyLevel === -1) return 'subtask'
  if (issuetype?.hierarchyLevel === 1) return 'epic'
  const name = (issuetype?.name ?? '').trim().toLowerCase()
  return name === '에픽' || name === 'epic' ? 'epic' : 'standard'
}

function toStatusCategory(key: string | undefined): JiraStatusCategory {
  return key === 'done' || key === 'indeterminate' ? key : 'new'
}

function toSearchIssue(raw: RawSearchIssue): JiraSearchIssue {
  const f = raw.fields ?? {}
  return {
    key: raw.key ?? '',
    summary: f.summary ?? '',
    issueType: f.issuetype?.name ?? '',
    level: toIssueLevel(f.issuetype),
    status: f.status?.name ?? '',
    statusCategory: toStatusCategory(f.status?.statusCategory?.key),
    priority: f.priority?.name || null,
    parentKey: f.parent?.key || null,
    parentSummary: f.parent?.fields?.summary || null,
    assigneeAccountId: f.assignee?.accountId || null,
    assigneeName: f.assignee?.displayName || null,
    duedate: f.duedate || null,
    updated: f.updated ?? '',
    resolvedAt: f.resolutiondate || null,
    labels: Array.isArray(f.labels) ? f.labels : [],
    description: f.description ?? null,
    fixVersions: toFixVersions(f.fixVersions),
    attachments: toAttachments(f.attachment),
    issueLinks: toIssueLinks(f.issuelinks)
  }
}

function searchIssues(jql: string): Promise<{ issues: JiraSearchIssue[]; truncated: boolean }> {
  return searchJql<RawSearchIssue, JiraSearchIssue>(jql, SEARCH_FIELDS, MAX_SEARCH_ISSUES, (raw) =>
    raw.key ? toSearchIssue(raw) : null
  )
}

// 키 목록을 SEARCH_KEY_CHUNK개씩 나눠 `<field> in (...)` 검색을 돌리고 합친다.
async function searchByKeyChunks(
  field: 'key' | 'parent',
  keys: string[]
): Promise<{ issues: JiraSearchIssue[]; truncated: boolean }> {
  const unique = [...new Set(keys.map(assertIssueKey))]
  const issues: JiraSearchIssue[] = []
  let truncated = false
  for (let i = 0; i < unique.length; i += SEARCH_KEY_CHUNK) {
    const chunk = unique.slice(i, i + SEARCH_KEY_CHUNK)
    const found = await searchIssues(`${field} in (${chunk.join(', ')}) ORDER BY key`)
    issues.push(...found.issues)
    truncated = truncated || found.truncated
  }
  return { issues, truncated }
}

export interface JiraRemoteLink {
  title: string
  url: string
}

/**
 * 이슈에 붙은 웹링크(Confluence·Figma 등, remotelink). 이슈당 GET 1회다.
 * http(s)가 아닌 것은 버리고, 제목이 없으면 URL을 이름으로 쓴다.
 */
export async function listRemoteLinks(issueKey: string): Promise<JiraRemoteLink[]> {
  const key = assertIssueKey(issueKey)
  const data = (await jiraRequest(`/rest/api/3/issue/${key}/remotelink`)) as Array<{
    object?: { url?: string; title?: string }
  }>
  const links: JiraRemoteLink[] = []
  for (const item of Array.isArray(data) ? data : []) {
    const url = item?.object?.url
    if (!url || !/^https?:\/\//i.test(url)) continue
    links.push({ url, title: item.object?.title?.trim() || url })
  }
  return links
}

/** 연결된 계정의 accountId — "내 담당" 판정에 쓴다 */
export async function getJiraMyAccountId(): Promise<string | null> {
  const me = (await jiraRequest('/rest/api/3/myself')) as { accountId?: string }
  return me.accountId ?? null
}

/**
 * 프로젝트의 미완료 이슈 전부(백로그 포함). 키 내림차순(최신부터)이라 상한에 걸려도 최신이 남는다.
 * 상태 이름은 번역 이름이라 JQL에 넣지 않는다 — `status = "할 일"`은 오류 없이 0건이 된다.
 */
export async function listOpenProjectIssues(
  projectKey: string
): Promise<{ issues: JiraSearchIssue[]; truncated: boolean }> {
  const key = assertProjectKey(projectKey)
  return searchIssues(`project = ${key} AND statusCategory != Done ORDER BY key DESC`)
}

/** 최근 완료 이슈 조회 기간 상한(일) */
const MAX_RECENT_DONE_DAYS = 90

/** 프로젝트에서 최근 days일 안에 완료된 이슈 */
export async function listRecentlyDoneProjectIssues(
  projectKey: string,
  days: number
): Promise<{ issues: JiraSearchIssue[]; truncated: boolean }> {
  const key = assertProjectKey(projectKey)
  // JQL 에 들어가는 값이다. 네트워크 전에 검증한다
  if (!Number.isInteger(days) || days < 1 || days > MAX_RECENT_DONE_DAYS) {
    throw new Error('잘못된 조회 기간')
  }
  return searchIssues(
    `project = ${key} AND statusCategory = Done AND resolved >= -${days}d ORDER BY resolved DESC`
  )
}

/** 증분 조회 기간 상한(분). 7일 + 여유 10분. 그보다 오래됐으면 호출자가 전체 동기화를 한다 */
export const MAX_UPDATED_MINUTES = 7 * 24 * 60 + 10

/**
 * 프로젝트에서 최근 minutes 분 안에 바뀐 이슈를 고르는 JQL.
 * 절대 날짜가 아니라 상대 시간을 쓴다 — JQL 날짜 리터럴은 Jira 사용자 프로필 시간대로
 * 해석돼 로컬 시각과 어긋난다. 상대 시간은 서버 현재 시각 기준이라 시간대와 무관하다.
 * 두 값 모두 JQL 에 들어간다. 네트워크 전에 검증한다.
 */
function updatedSinceJql(projectKey: string, minutes: number): string {
  const key = assertProjectKey(projectKey)
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_UPDATED_MINUTES) {
    throw new Error('잘못된 조회 기간')
  }
  return `project = ${key} AND updated >= "-${minutes}m" ORDER BY updated DESC`
}

/** 프로젝트에서 최근 minutes 분 안에 바뀐 이슈(프로젝트 보드 증분 동기화) */
export async function listUpdatedProjectIssues(
  projectKey: string,
  minutes: number
): Promise<{ issues: JiraSearchIssue[]; truncated: boolean }> {
  return searchIssues(updatedSinceJql(projectKey, minutes))
}

/** 릴리스 변경분 동기화가 쓰는 이슈. 릴리스 항목 필드 + 지금 걸린 fixVersion ID */
export interface JiraReleaseChangeIssue extends JiraIssueSummary {
  /** 지금 이 이슈의 fixVersions 버전 ID. 비었으면 [] */
  fixVersionIds: string[]
}

interface RawReleaseChangeIssue extends RawIssue {
  fields?: RawIssue['fields'] & { fixVersions?: Array<{ id?: string | number }> | null }
}

/** 프로젝트에서 최근 minutes 분 안에 바뀐 이슈(릴리스 변경분 동기화). 상한은 MAX_ISSUES */
export async function listUpdatedReleaseIssues(
  projectKey: string,
  minutes: number
): Promise<{ issues: JiraReleaseChangeIssue[]; truncated: boolean }> {
  return searchJql<RawReleaseChangeIssue, JiraReleaseChangeIssue>(
    updatedSinceJql(projectKey, minutes),
    'summary,issuetype,status,resolution,parent,fixVersions',
    MAX_ISSUES,
    (raw) => {
      if (!raw.key) return null
      const ids: string[] = []
      for (const v of raw.fields?.fixVersions ?? []) {
        if (v?.id !== undefined && v.id !== null) ids.push(String(v.id))
      }
      return { ...toIssueSummary(raw), fixVersionIds: ids }
    }
  )
}

/** 키로 이슈를 가져온다 (조상 보강, 비서의 사라진 후보 해석) */
export async function listIssuesByKeys(
  keys: string[]
): Promise<{ issues: JiraSearchIssue[]; truncated: boolean }> {
  return searchByKeyChunks('key', keys)
}

/** 주어진 이슈들의 직계 자식 (에픽→작업, 작업→하위 작업) */
export async function listChildIssues(
  parentKeys: string[]
): Promise<{ issues: JiraSearchIssue[]; truncated: boolean }> {
  return searchByKeyChunks('parent', parentKeys)
}
