import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IntegrationVerifyResult } from '../types'
import { useSettingsStore } from './settingsStore'
import { useNavigationStore } from './navigationStore'

const api = {
  calendar: { status: vi.fn(async () => ({ connected: true, hasCredentials: true })) },
  jira: {
    status: vi.fn(async () => ({
      connected: true,
      siteUrl: 'https://x.atlassian.net',
      accountName: '홍길동',
      expiresAt: null,
      expiringSoon: false,
      expired: false,
      defaultProjectKey: null,
      email: 'a@b.com'
    }))
  },
  ai: {
    bitbucketStatus: vi.fn(async () => ({ connected: false, email: null })),
    notionStatus: vi.fn(async () => ({ connected: true })),
    status: vi.fn(async () => ({ available: true }))
  },
  settings: {
    verifyIntegration: vi.fn(
      async (id: string): Promise<IntegrationVerifyResult> =>
        id === 'notion'
          ? { ok: false, code: 'auth_failed', error: '거부됨', checkedAt: '2026-11-18T00:00:00.000Z' }
          : { ok: true, account: `${id}-account`, checkedAt: '2026-11-18T00:00:00.000Z' }
    )
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = { api }
  useSettingsStore.setState({
    section: 'integrations',
    statuses: { google: null, jira: null, bitbucket: null, notion: null },
    claude: null,
    statusErrors: {},
    verifyResults: {},
    verifying: {}
  })
  useNavigationStore.setState({ view: 'today' })
})

describe('settingsStore', () => {
  it('open(section) 은 화면을 settings 로 바꾸고 섹션을 고른다', () => {
    useSettingsStore.getState().open('assistant')
    expect(useNavigationStore.getState().view).toBe('settings')
    expect(useSettingsStore.getState().section).toBe('assistant')

    // 섹션 없이 열면 고른 섹션을 그대로 둔다
    useNavigationStore.setState({ view: 'today' })
    useSettingsStore.getState().open()
    expect(useNavigationStore.getState().view).toBe('settings')
    expect(useSettingsStore.getState().section).toBe('assistant')
  })

  it('refreshStatuses 는 한 연동이 실패해도 나머지 상태를 채운다', async () => {
    api.jira.status.mockRejectedValueOnce(new Error('jira 꺼짐'))
    await useSettingsStore.getState().refreshStatuses()
    const s = useSettingsStore.getState()
    expect(s.statuses.google).toEqual({ connected: true, hasCredentials: true })
    expect(s.statuses.jira).toBeNull()
    expect(s.statuses.bitbucket).toEqual({ connected: false, email: null })
    expect(s.statuses.notion).toEqual({ connected: true })
    expect(s.claude).toEqual({ available: true })
    expect(s.statusErrors.jira).toBe('jira 꺼짐')
    expect(s.statusErrors.google).toBeUndefined()
    expect(s.refreshing).toBe(false)
    // 상태 조회는 외부 검증을 부르지 않는다
    expect(api.settings.verifyIntegration).not.toHaveBeenCalled()
  })

  it('verify 결과를 연동별로 저장한다', async () => {
    await useSettingsStore.getState().verify('jira')
    await useSettingsStore.getState().verify('notion')
    const s = useSettingsStore.getState()
    expect(s.verifyResults.jira).toEqual({
      ok: true,
      account: 'jira-account',
      checkedAt: '2026-11-18T00:00:00.000Z'
    })
    expect(s.verifyResults.notion?.ok).toBe(false)
    expect(s.verifyResults.google).toBeUndefined()
    expect(s.verifying.jira).toBe(false)

    useSettingsStore.getState().clearVerify('jira')
    expect(useSettingsStore.getState().verifyResults.jira).toBeUndefined()
    expect(useSettingsStore.getState().verifyResults.notion).toBeDefined()
  })
})
