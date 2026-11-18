import { describe, it, expect } from 'vitest'
import type { IntegrationVerifyResult, JiraConnectionStatus } from '../../types'
import {
  CARD_ACTIONS,
  UNREACHABLE_WARNING,
  formatCheckedAt,
  toCardState
} from './integrationStatus'

const jira = (over: Partial<JiraConnectionStatus> = {}): JiraConnectionStatus => ({
  connected: true,
  siteUrl: 'https://x.atlassian.net',
  accountName: '홍길동',
  expiresAt: '2027-01-01',
  expiringSoon: false,
  expired: false,
  defaultProjectKey: null,
  email: 'a@b.com',
  ...over
})

const fail = (code: Extract<IntegrationVerifyResult, { ok: false }>['code']): IntegrationVerifyResult => ({
  ok: false,
  code,
  error: `오류 ${code}`,
  checkedAt: '2026-11-18T01:02:00.000Z'
})

describe('integrationStatus', () => {
  it('상태를 받기 전에는 확인 중이다', () => {
    for (const id of ['google', 'jira', 'bitbucket', 'notion'] as const) {
      const s = toCardState({ id, status: null } as Parameters<typeof toCardState>[0])
      expect(s.kind).toBe('checking')
      expect(s.actions).toEqual([])
    }
  })

  it('연결되면 연결됨과 계정을 보여 준다', () => {
    const j = toCardState({ id: 'jira', status: jira() })
    expect(j.kind).toBe('connected')
    expect(j.label).toBe('연결됨')
    expect(j.tone).toBe('green')
    expect(j.account).toBe('홍길동')

    const b = toCardState({ id: 'bitbucket', status: { connected: true, email: 'dev@x.com' } })
    expect(b.account).toBe('dev@x.com')

    const n = toCardState(
      { id: 'notion', status: { connected: true } },
      { ok: true, account: '내 워크스페이스', checkedAt: '2026-11-18T01:02:00.000Z' }
    )
    expect(n.kind).toBe('connected')
    expect(n.account).toBe('내 워크스페이스')
    expect(n.checkedAt).toBe('2026-11-18T01:02:00.000Z')
    expect(formatCheckedAt(n.checkedAt)).toMatch(/^마지막 확인 \d\d:\d\d$/)
  })

  it('auth_failed 검증 결과는 연결됨보다 우선한다', () => {
    const s = toCardState({ id: 'bitbucket', status: { connected: true, email: 'a@b.com' } }, fail('auth_failed'))
    expect(s.kind).toBe('auth_failed')
    expect(s.tone).toBe('red')
    expect(s.actions[0]).toBe('reconnect')
    // Jira 만료 임박보다도 우선한다
    expect(toCardState({ id: 'jira', status: jira({ expiringSoon: true }) }, fail('auth_failed')).kind).toBe(
      'auth_failed'
    )
  })

  it('Jira 만료됨과 만료 임박을 구분한다', () => {
    const expired = toCardState({ id: 'jira', status: jira({ expired: true }) })
    expect(expired.kind).toBe('expired')
    expect(expired.tone).toBe('red')
    expect(expired.detail).toContain('2027-01-01')
    expect(expired.actions[0]).toBe('replace_token')

    const soon = toCardState({ id: 'jira', status: jira({ expiringSoon: true }) })
    expect(soon.kind).toBe('expiring')
    expect(soon.tone).toBe('amber')
    expect(soon.actions[0]).toBe('replace_token')

    // 검증 결과가 expired 여도 만료됨이다
    expect(toCardState({ id: 'jira', status: jira() }, fail('expired')).kind).toBe('expired')
  })

  it('Google 자격 증명이 없으면 설정 필요, 있으면 연결 안 됨이다', () => {
    const setup = toCardState({ id: 'google', status: { connected: false, hasCredentials: false } })
    expect(setup.kind).toBe('needs_setup')
    expect(setup.actions).toEqual(['connect'])

    const off = toCardState({ id: 'google', status: { connected: false, hasCredentials: true } })
    expect(off.kind).toBe('disconnected')
    expect(off.actions[0]).toBe('google_login')

    expect(toCardState({ id: 'google', status: { connected: true, hasCredentials: true } }).kind).toBe(
      'connected'
    )
  })

  it('unreachable 은 연결됨을 유지하고 경고 문구를 단다', () => {
    const s = toCardState({ id: 'notion', status: { connected: true } }, fail('unreachable'))
    expect(s.kind).toBe('connected')
    expect(s.tone).toBe('green')
    expect(s.warning).toBe(UNREACHABLE_WARNING)
    expect(s.actions).toContain('test')
  })

  it('상태별 버튼 목록이 정해져 있다', () => {
    expect(CARD_ACTIONS).toEqual({
      checking: [],
      auth_failed: ['reconnect', 'disconnect'],
      expired: ['replace_token', 'disconnect'],
      expiring: ['replace_token', 'test', 'disconnect'],
      connected: ['test', 'change', 'disconnect'],
      needs_setup: ['connect'],
      disconnected: ['connect']
    })
    expect(toCardState({ id: 'notion', status: { connected: false } }).actions).toEqual(['connect'])
    expect(toCardState({ id: 'jira', status: jira() }).actions).toEqual(CARD_ACTIONS.connected)
  })
})
