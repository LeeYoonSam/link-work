import { safeStorage } from 'electron'
import { getDatabase } from '../db/database'

// Jira Cloud REST 연동 (읽기 전용 사용).
//
// [가드레일]
// - API 토큰은 app_settings에 safeStorage로 암호화해 저장한다 (notion.ts와 동일 패턴).
// - renderer에는 연결 여부·계정 표시명·만료일만 내보내고 토큰 값은 절대 노출하지 않는다.
// - 이 모듈은 조회 API(myself, project, version, search/jql)만 호출한다 — 쓰기 API 호출 금지.
// - Jira REST 호출은 전부 이 파일에만 둔다. 엔드포인트가 또 바뀌어도 수정 지점이 하나다
//   (구 /rest/api/3/search 제거 전례 — 아래 listIssuesByFixVersion 주석 참고).
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
    expired: creds !== null && remaining !== null && remaining < 0
  }
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

async function jiraRequest(path: string, credsOverride?: JiraCredentials): Promise<unknown> {
  const creds = credsOverride ?? getCredentials()
  if (!creds) throw new Error(NOT_CONNECTED_MESSAGE)

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
      if (attempt >= MAX_RETRIES) {
        throw new Error('Jira API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.')
      }
      await sleep(computeRetryDelayMs(attempt, res.headers.get('Retry-After')))
      continue
    }

    throw mapErrorStatus(res.status, await res.text().catch(() => ''))
  }
}

function mapErrorStatus(status: number, body: string): Error {
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
  const jql = `fixVersion = ${id} ORDER BY issuetype, key`

  const issues: JiraIssueSummary[] = []
  let truncated = false
  let nextPageToken: string | undefined

  for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
    const params = new URLSearchParams({
      jql,
      // /search/jql은 fields를 명시하지 않으면 id/key 정도만 돌려준다. 구 /search와 다른 점이라
      // 여기를 지우면 릴리스 노트가 제목 없는 껍데기가 된다.
      fields: 'summary,issuetype,status,resolution,parent',
      maxResults: String(ISSUE_PAGE_SIZE)
    })
    if (nextPageToken) params.set('nextPageToken', nextPageToken)

    // 구 GET|POST /rest/api/3/search는 2025년 10월에 제거됐다(410 Gone). 되돌리지 말 것.
    // 이 엔드포인트는 startAt/total이 없는 커서 기반이라 페이지네이션 방식도 다르다.
    const data = (await jiraRequest(`/rest/api/3/search/jql?${params}`)) as {
      issues?: RawIssue[]
      nextPageToken?: string
    }

    for (const raw of data.issues ?? []) {
      if (issues.length >= MAX_ISSUES) {
        truncated = true
        break
      }
      issues.push({
        key: raw.key ?? '',
        issueType: raw.fields?.issuetype?.name ?? null,
        status: raw.fields?.status?.name ?? null,
        resolution: raw.fields?.resolution?.name ?? null,
        summary: raw.fields?.summary ?? '',
        parentKey: raw.fields?.parent?.key ?? null
      })
    }

    nextPageToken = data.nextPageToken ?? undefined
    // 토큰이 없으면 마지막 페이지다 — total이 없으므로 이것이 유일한 종료 신호다.
    if (!nextPageToken) break
    if (issues.length >= MAX_ISSUES) {
      truncated = true
      break
    }
    // 아직 토큰이 남았는데 페이지 상한에 걸렸다면 가져오지 못한 이슈가 있다는 뜻이다.
    if (page === MAX_ISSUE_PAGES - 1) truncated = true
  }

  return { issues, truncated }
}
