import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Electron 런타임 없이 돌아야 하므로 safeStorage와 DB를 모듈 경계에서 대체한다.
// safeStorage는 "암호화 불가" 경로로 고정해 저장값을 평문으로 확인할 수 있게 한다.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (b: Buffer) => b.toString()
  }
}))

const settings = new Map<string, string>()

vi.mock('../db/database', () => ({
  getDatabase: () => ({
    prepare: (sql: string) => ({
      get: (key: string) => {
        const value = settings.get(key)
        return value === undefined ? undefined : { value }
      },
      run: (...args: string[]) => {
        if (sql.trimStart().startsWith('DELETE')) settings.delete(args[0])
        else settings.set(args[0], args[1])
        return { changes: 1 }
      }
    })
  })
}))

import {
  computeRetryDelayMs,
  disconnectJira,
  getDefaultJiraProjectKey,
  getJiraIssueUrl,
  getJiraStatus,
  getJiraVersion,
  isJiraConnected,
  listIssuesByFixVersion,
  listJiraProjects,
  listJiraVersions,
  MAX_ISSUES,
  saveJiraCredentials,
  setDefaultJiraProjectKey
} from './jira'

interface ResponseInit {
  status?: number
  headers?: Record<string, string>
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const status = init.status ?? 200
  const headers = init.headers ?? {}
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        headers[name] ??
        headers[Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase()) ?? ''] ??
        null
    },
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()

function calledUrls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]))
}

function connect(): void {
  settings.set('jira_site_url', 'https://acme.atlassian.net')
  settings.set('jira_email', 'me@acme.com')
  settings.set('jira_api_token', 'token-123')
  settings.set('jira_token_expires_at', '2027-01-01')
  settings.set('jira_account_name', '홍길동')
}

beforeEach(() => {
  settings.clear()
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('연결 상태와 자격 증명 저장', () => {
  it('연결 정보가 없으면 미연결이다', () => {
    expect(isJiraConnected()).toBe(false)
    expect(getJiraIssueUrl('ICA-1')).toBeNull()
    const status = getJiraStatus()
    expect(status.connected).toBe(false)
    expect(status.siteUrl).toBeNull()
    // 미연결일 때는 만료 경고를 띄우지 않는다 (사용자가 할 수 있는 조치가 없다)
    expect(status.expiringSoon).toBe(false)
    expect(status.expired).toBe(false)
  })

  it('myself 검증에 성공하면 저장하고 표시명을 돌려준다', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ displayName: '이윤삼' }))

    const result = await saveJiraCredentials({
      // 뒤 슬래시가 붙어도 정규화돼야 한다
      siteUrl: 'https://acme.atlassian.net/',
      email: 'me@acme.com',
      apiToken: 'token-123',
      expiresAt: '2027-01-01'
    })

    expect(result.accountName).toBe('이윤삼')
    expect(settings.get('jira_site_url')).toBe('https://acme.atlassian.net')
    expect(calledUrls()[0]).toBe('https://acme.atlassian.net/rest/api/3/myself')

    // Basic base64(email:token) 인증 헤더
    const headers = (fetchMock.mock.calls[0][1]?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('me@acme.com:token-123').toString('base64')}`
    )
    expect(isJiraConnected()).toBe(true)
  })

  it('myself 검증에 실패하면 아무것도 저장하지 않는다', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'nope' }, { status: 401 }))

    await expect(
      saveJiraCredentials({
        siteUrl: 'https://acme.atlassian.net',
        email: 'me@acme.com',
        apiToken: 'bad',
        expiresAt: '2027-01-01'
      })
    ).rejects.toThrow('Jira 토큰이 만료됐거나 유효하지 않습니다')

    expect(settings.size).toBe(0)
    expect(isJiraConnected()).toBe(false)
  })

  it('만료일 형식이 잘못되면 네트워크를 타지 않고 거부한다', async () => {
    await expect(
      saveJiraCredentials({
        siteUrl: 'https://acme.atlassian.net',
        email: 'me@acme.com',
        apiToken: 'token',
        expiresAt: '2027/01/01'
      })
    ).rejects.toThrow('YYYY-MM-DD')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('연결 해제는 토큰을 포함한 모든 키를 지운다', () => {
    connect()
    setDefaultJiraProjectKey('ICA')
    disconnectJira()
    expect(settings.size).toBe(0)
    expect(isJiraConnected()).toBe(false)
  })

  it('이슈 키로 브라우저 URL을 만든다', () => {
    connect()
    expect(getJiraIssueUrl('ICA-8678')).toBe('https://acme.atlassian.net/browse/ICA-8678')
  })
})

describe('기본 Jira 프로젝트 키', () => {
  it('설정하기 전에는 null이다', () => {
    expect(getDefaultJiraProjectKey()).toBeNull()
  })

  it('유효한 키를 저장하고 다시 읽는다', () => {
    setDefaultJiraProjectKey('ICA')
    expect(getDefaultJiraProjectKey()).toBe('ICA')
    expect(settings.get('jira_default_project_key')).toBe('ICA')

    // 언더스코어·숫자 포함 키와 앞뒤 공백
    setDefaultJiraProjectKey('  BACK_2  ')
    expect(getDefaultJiraProjectKey()).toBe('BACK_2')
  })

  it('잘못된 형식은 거부한다', () => {
    for (const bad of ['abc', '123', '', '   ', 'IC A', 'ICA-1', '_ICA', 'iCA']) {
      expect(() => setDefaultJiraProjectKey(bad), bad).toThrow('잘못된 Jira 프로젝트 키입니다.')
    }
    expect(getDefaultJiraProjectKey()).toBeNull()
  })

  it('거부된 값이 기존 설정을 덮어쓰지 않는다', () => {
    setDefaultJiraProjectKey('ICA')
    expect(() => setDefaultJiraProjectKey('ica')).toThrow()
    expect(getDefaultJiraProjectKey()).toBe('ICA')
  })

  it('null을 넘기면 설정을 지운다', () => {
    setDefaultJiraProjectKey('ICA')
    setDefaultJiraProjectKey(null)
    expect(getDefaultJiraProjectKey()).toBeNull()
  })

  it('연결을 끊으면 기본 프로젝트 키도 사라진다', () => {
    connect()
    setDefaultJiraProjectKey('ICA')
    disconnectJira()
    // 남아 있으면 다른 계정으로 재연결했을 때 없는 프로젝트를 가리킨다
    expect(getDefaultJiraProjectKey()).toBeNull()
  })

  it('getJiraStatus가 기본 프로젝트 키를 함께 돌려준다', () => {
    connect()
    expect(getJiraStatus().defaultProjectKey).toBeNull()
    setDefaultJiraProjectKey('ICA')
    expect(getJiraStatus().defaultProjectKey).toBe('ICA')
  })
})

describe('getJiraStatus 만료 경계', () => {
  function statusAt(today: string, expiresAt: string) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${today}T09:00:00`))
    connect()
    settings.set('jira_token_expires_at', expiresAt)
    return getJiraStatus()
  }

  it('만료 30일 전은 임박으로 본다', () => {
    const s = statusAt('2026-08-20', '2026-09-19')
    expect(s.expiringSoon).toBe(true)
    expect(s.expired).toBe(false)
  })

  it('만료 31일 전은 임박이 아니다', () => {
    const s = statusAt('2026-08-20', '2026-09-20')
    expect(s.expiringSoon).toBe(false)
    expect(s.expired).toBe(false)
  })

  it('만료일 당일은 아직 만료가 아니다', () => {
    const s = statusAt('2026-08-20', '2026-08-20')
    expect(s.expiringSoon).toBe(true)
    expect(s.expired).toBe(false)
  })

  it('만료일이 지나면 만료로 표시한다', () => {
    const s = statusAt('2026-08-20', '2026-08-19')
    expect(s.expired).toBe(true)
    expect(s.expiringSoon).toBe(false)
  })

  it('계정 표시명과 만료일을 함께 돌려준다', () => {
    const s = statusAt('2026-08-20', '2027-01-01')
    expect(s.accountName).toBe('홍길동')
    expect(s.expiresAt).toBe('2027-01-01')
    expect(s.siteUrl).toBe('https://acme.atlassian.net')
  })
})

describe('프로젝트·버전 목록 (PageBean)', () => {
  beforeEach(connect)

  it('isLast가 false면 startAt을 밀어 다음 페이지를 받는다', async () => {
    const first = Array.from({ length: 50 }, (_, i) => ({ key: `P${i}`, name: `프로젝트 ${i}` }))
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ startAt: 0, maxResults: 50, isLast: false, values: first })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          startAt: 50,
          maxResults: 50,
          isLast: true,
          values: [{ key: 'LAST', name: '마지막' }]
        })
      )

    const projects = await listJiraProjects()

    expect(projects).toHaveLength(51)
    expect(projects[50]).toEqual({ key: 'LAST', name: '마지막' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(calledUrls()[0]).toContain('startAt=0')
    expect(calledUrls()[1]).toContain('startAt=50')
  })

  it('버전 목록은 페이지네이션 엔드포인트를 쓰고 옵셔널 필드를 null로 정규화한다', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        startAt: 0,
        maxResults: 50,
        isLast: true,
        values: [
          {
            id: '10042',
            name: 'v1.2.0',
            description: '8월 릴리스',
            released: true,
            archived: false,
            releaseDate: '2026-09-01',
            startDate: '2026-08-01'
          },
          // releaseDate/startDate/description이 아예 없는 응답
          { id: 10043, name: 'v1.3.0' }
        ]
      })
    )

    const versions = await listJiraVersions('ICA')

    expect(versions[0]).toEqual({
      id: '10042',
      name: 'v1.2.0',
      description: '8월 릴리스',
      released: true,
      archived: false,
      releaseDate: '2026-09-01',
      startDate: '2026-08-01'
    })
    expect(versions[1]).toEqual({
      id: '10043',
      name: 'v1.3.0',
      description: null,
      released: false,
      archived: false,
      releaseDate: null,
      startDate: null
    })

    const url = calledUrls()[0]
    expect(url).toContain('/rest/api/3/project/ICA/version?')
    // 복수형 /versions는 비페이지네이션이라 쓰지 않는다
    expect(url).not.toContain('/versions')
    expect(url).toContain('orderBy=-releaseDate')
  })

  it('isLast가 없으면 받은 개수로 마지막 페이지를 판정한다', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ values: [{ key: 'A', name: 'A' }] }))
    const projects = await listJiraProjects()
    expect(projects).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('버전 단건 조회', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: '10042', name: 'v1.2.0', released: false }))
    const version = await getJiraVersion('10042')
    expect(version.name).toBe('v1.2.0')
    expect(version.released).toBe(false)
    expect(calledUrls()[0]).toBe('https://acme.atlassian.net/rest/api/3/version/10042')
  })
})

describe('listIssuesByFixVersion', () => {
  beforeEach(connect)

  function issuePage(count: number, offset: number, nextPageToken?: string) {
    return jsonResponse({
      issues: Array.from({ length: count }, (_, i) => ({
        key: `ICA-${offset + i}`,
        fields: {
          summary: `이슈 ${offset + i}`,
          issuetype: { name: 'Story' },
          status: { name: '완료' },
          resolution: { name: '해결됨' },
          parent: { key: 'ICA-1' }
        }
      })),
      ...(nextPageToken ? { nextPageToken } : {})
    })
  }

  it('nextPageToken이 사라지면 루프를 종료한다', async () => {
    fetchMock
      .mockResolvedValueOnce(issuePage(100, 1000, 'token-page-2'))
      .mockResolvedValueOnce(issuePage(30, 1100))

    const { issues, truncated } = await listIssuesByFixVersion('10042')

    expect(issues).toHaveLength(130)
    expect(truncated).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 2번째 요청에만 커서가 실린다
    expect(calledUrls()[0]).not.toContain('nextPageToken')
    expect(calledUrls()[1]).toContain('nextPageToken=token-page-2')
  })

  it('MAX_ISSUES 상한에서 멈추고 truncated를 알린다', async () => {
    // 토큰이 계속 오지만 5페이지(=500건)에서 끊겨야 한다
    for (let page = 0; page < 6; page++) {
      fetchMock.mockResolvedValueOnce(issuePage(100, page * 100, `token-${page + 1}`))
    }

    const { issues, truncated } = await listIssuesByFixVersion('10042')

    expect(issues).toHaveLength(MAX_ISSUES)
    expect(truncated).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('이슈 0건도 정상으로 처리한다 (실패와 구분)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ issues: [] }))
    const { issues, truncated } = await listIssuesByFixVersion('10042')
    expect(issues).toEqual([])
    expect(truncated).toBe(false)
  })

  it('필드를 명시해 호출하고 제거된 구 /search는 부르지 않는다', async () => {
    fetchMock.mockResolvedValueOnce(issuePage(1, 1))

    await listIssuesByFixVersion('10042')

    const url = calledUrls()[0]
    expect(url).toContain('/rest/api/3/search/jql?')
    // 구 GET|POST /rest/api/3/search는 2025년 10월에 제거됐다(410 Gone)
    expect(/\/rest\/api\/3\/search(\?|$)/.test(url)).toBe(false)

    const params = new URL(url).searchParams
    expect(params.get('fields')).toBe('summary,issuetype,status,resolution,parent')
    // JQL은 버전 이름이 아니라 불변 ID로 조립한다
    expect(params.get('jql')).toBe('fixVersion = 10042 ORDER BY issuetype, key')
    expect(params.get('maxResults')).toBe('100')
  })

  it('숫자가 아닌 versionId는 네트워크를 타기 전에 거부한다 (JQL 인젝션 방어)', async () => {
    for (const bad of ['10042 OR project = X', 'abc', '', '10042; DROP', '10 042', '-1']) {
      await expect(listIssuesByFixVersion(bad), bad).rejects.toThrow('잘못된 Jira 버전 ID입니다.')
      await expect(getJiraVersion(bad), bad).rejects.toThrow('잘못된 Jira 버전 ID입니다.')
    }
    // 조작된 JQL이 한 번도 나가지 않아야 방어가 의미를 갖는다
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('숫자 문자열 versionId는 그대로 통과한다', async () => {
    fetchMock
      .mockResolvedValueOnce(issuePage(1, 1))
      .mockResolvedValueOnce(jsonResponse({ id: '10042', name: 'v1.2.0' }))

    const { issues } = await listIssuesByFixVersion('10042')
    expect(issues).toHaveLength(1)

    const version = await getJiraVersion('10042')
    expect(version.id).toBe('10042')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('이슈 필드를 요약 형태로 정규화한다', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        issues: [
          {
            key: 'ICA-8678',
            fields: {
              summary: '검색홈 개편',
              issuetype: { name: 'Story' },
              status: { name: '진행 중' },
              // 미해결 이슈는 resolution이 null로 온다
              resolution: null,
              parent: null
            }
          }
        ]
      })
    )

    const { issues } = await listIssuesByFixVersion('10042')

    expect(issues[0]).toEqual({
      key: 'ICA-8678',
      issueType: 'Story',
      status: '진행 중',
      resolution: null,
      summary: '검색홈 개편',
      parentKey: null
    })
  })
})

describe('오류 매핑', () => {
  beforeEach(connect)

  const cases: Array<[number, string]> = [
    [401, 'Jira 토큰이 만료됐거나 유효하지 않습니다. 연동 설정에서 토큰을 다시 등록해 주세요.'],
    [403, '해당 Jira 프로젝트에 접근할 권한이 없습니다.'],
    [404, 'Jira에서 프로젝트 또는 버전을 찾을 수 없습니다. 삭제되었을 수 있습니다.'],
    [410, '제거된 Jira API를 호출했습니다. 앱 업데이트가 필요합니다.']
  ]

  for (const [status, message] of cases) {
    it(`${status} → 한국어 안내로 매핑한다`, async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ errorMessages: [] }, { status }))
      await expect(listIssuesByFixVersion('10042')).rejects.toThrow(message)
    })
  }

  it('그 외 상태는 상태 코드와 본문 앞부분을 함께 알린다', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, { status: 500 }))
    await expect(listJiraProjects()).rejects.toThrow('Jira API 오류 (500)')
  })

  it('미연결 상태에서 호출하면 네트워크를 타지 않고 안내한다', async () => {
    settings.clear()
    await expect(listJiraProjects()).rejects.toThrow('Jira에 연결되어 있지 않습니다')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('429 재시도', () => {
  beforeEach(connect)

  it('Retry-After를 존중해 재시도하고 성공하면 결과를 돌려준다', async () => {
    fetchMock
      // Retry-After: 0 — 테스트가 실제로 기다리지 않게 한다
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(jsonResponse({ issues: [] }))

    const { issues } = await listIssuesByFixVersion('10042')

    expect(issues).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('재시도 4회가 모두 429면 한도 메시지를 던진다', async () => {
    // 초기 1회 + 재시도 4회 = 5요청
    for (let i = 0; i < 5; i++) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({}, { status: 429, headers: { 'Retry-After': '0' } })
      )
    }

    await expect(listIssuesByFixVersion('10042')).rejects.toThrow(
      'Jira API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.'
    )
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })
})

describe('computeRetryDelayMs', () => {
  it('Retry-After가 있으면 그 값을 그대로 쓴다', () => {
    expect(computeRetryDelayMs(0, '7')).toBe(7_000)
    expect(computeRetryDelayMs(3, '1')).toBe(1_000)
    expect(computeRetryDelayMs(0, '0')).toBe(0)
  })

  it('Retry-After가 너무 크면 30초로 자른다', () => {
    expect(computeRetryDelayMs(0, '600')).toBe(30_000)
  })

  it('Retry-After가 없으면 2초에서 시작해 2배씩 늘린다 (지터 계수 0.7~1.3)', () => {
    // random을 0.5로 고정하면 계수가 1.0이 되어 기준값이 그대로 나온다
    const mid = () => 0.5
    expect(computeRetryDelayMs(0, null, mid)).toBe(2_000)
    expect(computeRetryDelayMs(1, null, mid)).toBe(4_000)
    expect(computeRetryDelayMs(2, null, mid)).toBe(8_000)
    expect(computeRetryDelayMs(3, null, mid)).toBe(16_000)

    expect(computeRetryDelayMs(0, null, () => 0)).toBe(1_400)
    expect(computeRetryDelayMs(0, null, () => 1)).toBe(2_600)
  })

  it('지수 백오프도 30초를 넘지 않는다', () => {
    expect(computeRetryDelayMs(10, null, () => 1)).toBe(30_000)
  })

  it('Retry-After가 날짜 형식 등 숫자가 아니면 백오프로 되돌아간다', () => {
    expect(computeRetryDelayMs(0, 'Wed, 21 Oct 2026 07:28:00 GMT', () => 0.5)).toBe(2_000)
  })
})
