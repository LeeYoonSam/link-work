// 설정 화면 [연결 테스트] — 저장된 자격 증명으로 연동이 실제로 되는지 확인한다.
//
// [계약] (렌더러 types/index.ts 의 IntegrationVerifyResult 와 같은 모양)
// - throw 하지 않는다. 어떤 실패든 { ok: false, code, error } 로 돌려준다.
// - 결과에 비밀값을 넣지 않는다. 에러 문구는 코드별 고정 문구만 쓴다. 원래 에러 메시지는 버린다.
// - 연결되지 않은 연동은 외부 호출 없이 not_connected, Jira 만료일이 지났으면 호출 없이 expired.
// - 외부 호출은 probe.verify() 가 하고, 이 모듈은 electron·DB 를 모른다(의존성 주입). 그래서 단위 테스트가 쉽다.

export type IntegrationId = 'google' | 'jira' | 'bitbucket' | 'notion'
type IntegrationVerifyCode =
  | 'not_connected'
  | 'auth_failed'
  | 'expired'
  | 'unreachable'
  | 'unknown'
type IntegrationVerifyResult =
  | { ok: true; account: string | null; checkedAt: string }
  | { ok: false; code: IntegrationVerifyCode; error: string; checkedAt: string }

const INTEGRATION_IDS: readonly IntegrationId[] = ['google', 'jira', 'bitbucket', 'notion']

export interface IntegrationProbe {
  /** 저장된 자격 증명이 있는지. 외부 호출을 하지 않는다 */
  isConnected: () => boolean
  /** 저장된 만료일이 지났는지(Jira 만). 외부 호출을 하지 않는다 */
  isExpired?: () => boolean
  /** 가장 가벼운 GET 한 번. 실패하면 status 등이 붙은 에러를 던진다 */
  verify: () => Promise<{ account: string | null }>
}

export interface IntegrationVerifyDeps {
  probes: Record<IntegrationId, IntegrationProbe>
  now?: () => Date
}

const LABELS: Record<IntegrationId, string> = {
  google: 'Google 캘린더',
  jira: 'Jira',
  bitbucket: 'Bitbucket',
  notion: 'Notion'
}

function isIntegrationId(value: unknown): value is IntegrationId {
  return typeof value === 'string' && (INTEGRATION_IDS as readonly string[]).includes(value)
}

const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET'
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function httpStatusOf(err: Record<string, unknown>): number | null {
  const response = asRecord(err.response)
  const candidates = [err.status, response?.status, err.code]
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isInteger(c)) return c
    if (typeof c === 'string' && /^\d{3}$/.test(c)) return Number(c)
  }
  return null
}

function isNetworkError(err: Record<string, unknown>): boolean {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true
  const codes = [err.code, asRecord(err.cause)?.code, asRecord(err.cause)?.name]
  if (codes.some((c) => typeof c === 'string' && NETWORK_ERROR_CODES.has(c))) return true
  if (asRecord(err.cause)?.name === 'TimeoutError') return true
  // undici fetch 는 연결 실패를 TypeError('fetch failed') 로 던진다
  return err.name === 'TypeError' && typeof err.message === 'string' && /fetch failed/i.test(err.message)
}

function isOAuthGrantError(err: Record<string, unknown>): boolean {
  // Google refresh token 이 취소·만료되면 400 invalid_grant 가 온다. 다시 로그인해야 한다
  const data = asRecord(asRecord(err.response)?.data)
  return data?.error === 'invalid_grant' || err.message === 'invalid_grant'
}

/** 에러를 코드로 분류한다. 문구는 고정 문구만 쓴다 — 원래 메시지에 비밀값이 섞여 있을 수 있다. */
export function classifyVerifyError(
  err: unknown
): { code: Exclude<IntegrationVerifyCode, 'not_connected' | 'expired'>; error: string } {
  const e = asRecord(err)
  if (e) {
    const status = httpStatusOf(e)
    if (status === 401 || status === 403 || isOAuthGrantError(e)) {
      return {
        code: 'auth_failed',
        error: '인증에 실패했습니다. 토큰이 만료됐거나 권한이 바뀌었을 수 있습니다. 다시 연결해 주세요.'
      }
    }
    if (isNetworkError(e)) {
      return {
        code: 'unreachable',
        error: '서버에 연결하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.'
      }
    }
    if (status !== null) {
      return { code: 'unknown', error: `연결 확인 중 오류가 발생했습니다 (HTTP ${status}).` }
    }
  }
  return { code: 'unknown', error: '연결 확인 중 알 수 없는 오류가 발생했습니다.' }
}

export async function verifyIntegration(
  id: unknown,
  deps: IntegrationVerifyDeps
): Promise<IntegrationVerifyResult> {
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString()

  if (!isIntegrationId(id)) {
    return { ok: false, code: 'unknown', error: '알 수 없는 연동입니다.', checkedAt }
  }
  const probe = deps.probes[id]
  const label = LABELS[id]

  try {
    if (!probe.isConnected()) {
      return {
        ok: false,
        code: 'not_connected',
        error: `${label}이(가) 연결되어 있지 않습니다.`,
        checkedAt
      }
    }
    if (probe.isExpired?.()) {
      return {
        ok: false,
        code: 'expired',
        error: `${label} 토큰 만료일이 지났습니다. 새 토큰으로 교체해 주세요.`,
        checkedAt
      }
    }
    const { account } = await probe.verify()
    return { ok: true, account: typeof account === 'string' ? account : null, checkedAt }
  } catch (err) {
    return { ok: false, ...classifyVerifyError(err), checkedAt }
  }
}
