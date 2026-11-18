import { describe, expect, it, vi } from 'vitest'
import {
  classifyVerifyError,
  verifyIntegration,
  type IntegrationId,
  type IntegrationProbe,
  type IntegrationVerifyDeps
} from './integration-verify'

const NOW = new Date('2026-11-18T09:30:00.000Z')

function probe(overrides: Partial<IntegrationProbe> = {}): IntegrationProbe {
  return {
    isConnected: () => true,
    verify: vi.fn(async () => ({ account: 'tester' })),
    ...overrides
  }
}

function deps(overrides: Partial<Record<IntegrationId, IntegrationProbe>> = {}): IntegrationVerifyDeps {
  return {
    probes: {
      google: probe(),
      jira: probe(),
      bitbucket: probe(),
      notion: probe(),
      ...overrides
    },
    now: () => NOW
  }
}

function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status })
}

describe('integration-verify', () => {
  it('연결 안 된 연동은 not_connected 를 돌려주고 외부 호출을 하지 않는다', async () => {
    for (const id of ['google', 'jira', 'bitbucket', 'notion'] as const) {
      const verify = vi.fn(async () => ({ account: 'x' }))
      const result = await verifyIntegration(
        id,
        deps({ [id]: probe({ isConnected: () => false, verify }) })
      )
      expect(result).toMatchObject({ ok: false, code: 'not_connected' })
      expect(verify).not.toHaveBeenCalled()
    }
  })

  it('401·403 은 auth_failed 로 분류한다', async () => {
    expect(classifyVerifyError(httpError(401)).code).toBe('auth_failed')
    expect(classifyVerifyError(httpError(403)).code).toBe('auth_failed')
    // googleapis(gaxios) 는 response.status 에 담는다
    expect(classifyVerifyError({ message: 'x', response: { status: 401 } }).code).toBe('auth_failed')
    // Google refresh token 취소
    expect(
      classifyVerifyError({ message: 'invalid_grant', response: { status: 400, data: { error: 'invalid_grant' } } })
        .code
    ).toBe('auth_failed')

    const result = await verifyIntegration(
      'jira',
      deps({ jira: probe({ verify: async () => Promise.reject(httpError(401)) }) })
    )
    expect(result).toMatchObject({ ok: false, code: 'auth_failed' })
    // 404·500 은 인증 문제가 아니다
    expect(classifyVerifyError(httpError(500)).code).toBe('unknown')
  })

  it('네트워크 오류는 unreachable 로 분류한다', async () => {
    expect(classifyVerifyError(new TypeError('fetch failed')).code).toBe('unreachable')
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    expect(classifyVerifyError(timeout).code).toBe('unreachable')
    expect(
      classifyVerifyError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })).code
    ).toBe('unreachable')
    expect(classifyVerifyError(Object.assign(new Error('getaddrinfo'), { code: 'ECONNREFUSED' })).code).toBe(
      'unreachable'
    )

    const result = await verifyIntegration(
      'notion',
      deps({ notion: probe({ verify: async () => Promise.reject(new TypeError('fetch failed')) }) })
    )
    expect(result).toMatchObject({ ok: false, code: 'unreachable' })
  })

  it('Jira 만료일이 지났으면 호출 없이 expired 를 돌려준다', async () => {
    const verify = vi.fn(async () => ({ account: 'x' }))
    const result = await verifyIntegration(
      'jira',
      deps({ jira: probe({ isExpired: () => true, verify }) })
    )
    expect(result).toMatchObject({ ok: false, code: 'expired' })
    expect(verify).not.toHaveBeenCalled()
  })

  it('성공하면 account 와 checkedAt 을 돌려준다', async () => {
    const result = await verifyIntegration(
      'bitbucket',
      deps({ bitbucket: probe({ verify: async () => ({ account: '홍길동' }) }) })
    )
    expect(result).toEqual({ ok: true, account: '홍길동', checkedAt: NOW.toISOString() })

    const noAccount = await verifyIntegration(
      'google',
      deps({ google: probe({ verify: async () => ({ account: null }) }) })
    )
    expect(noAccount).toEqual({ ok: true, account: null, checkedAt: NOW.toISOString() })
  })

  it('결과 직렬화에 저장된 token 문자열이 들어가지 않는다', async () => {
    const TOKEN = 'ATATT3xFfGF0-secret-token-value'
    const leaky = [
      httpError(401, `Unauthorized for token ${TOKEN}`),
      httpError(500, `server echoed ${TOKEN}`),
      Object.assign(new TypeError(`fetch failed ${TOKEN}`), { cause: { code: 'ENOTFOUND' } }),
      new Error(`boom ${TOKEN}`),
      `raw string ${TOKEN}`
    ]
    for (const err of leaky) {
      const result = await verifyIntegration(
        'notion',
        deps({ notion: probe({ verify: async () => Promise.reject(err) }) })
      )
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain(TOKEN)
    }
    // isConnected 가 던져도 원래 메시지를 싣지 않는다
    const thrown = await verifyIntegration(
      'jira',
      deps({
        jira: probe({
          isConnected: () => {
            throw new Error(`decrypt failed ${TOKEN}`)
          }
        })
      })
    )
    expect(JSON.stringify(thrown)).not.toContain(TOKEN)
  })

  it('알 수 없는 id 는 throw 하지 않고 unknown 을 돌려준다', async () => {
    for (const id of ['slack', '', null, undefined, 42, { id: 'jira' }]) {
      const result = await verifyIntegration(id, deps())
      expect(result).toMatchObject({ ok: false, code: 'unknown', checkedAt: NOW.toISOString() })
    }
  })
})
