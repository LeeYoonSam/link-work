// 연동 카드의 상태 판정 — 순수 함수다. React·스토어·window 를 쓰지 않는다.
//
// 판정 순서 (docs/SETTINGS.md):
//   확인 중 → 인증 실패 → 만료됨/만료 임박 → 연결됨(확인 실패 경고 포함) → 설정 필요 → 연결 안 됨
// 상태 조회(status IPC)는 외부 호출 없이 저장값만 본다. 인증 실패·확인 실패는
// 사용자가 [연결 테스트]를 눌러 받은 verify 결과에서만 나온다.
import type {
  AiBitbucketStatus,
  AiNotionStatus,
  CalendarStatus,
  IntegrationId,
  IntegrationVerifyResult,
  JiraConnectionStatus
} from '../../types'

export type CardStateKind =
  | 'checking'
  | 'auth_failed'
  | 'expired'
  | 'expiring'
  | 'connected'
  | 'needs_setup'
  | 'disconnected'

export type CardTone = 'gray' | 'green' | 'amber' | 'red'

export type CardActionId =
  | 'connect'
  | 'google_login'
  | 'reconnect'
  | 'replace_token'
  | 'test'
  | 'change'
  | 'disconnect'

export interface CardState {
  kind: CardStateKind
  label: string
  tone: CardTone
  /** 연결된 계정(이메일·계정명·워크스페이스). 없으면 null */
  account: string | null
  /** 보조 정보 한 줄(만료일 등) */
  detail: string | null
  /** 경고·오류 한 줄 */
  warning: string | null
  /** 이번 세션에서 마지막으로 [연결 테스트]한 시각(ISO). 없으면 null */
  checkedAt: string | null
  /** 그릴 버튼 순서. 첫 번째가 주 버튼이다 */
  actions: CardActionId[]
}

export const CARD_STATE_LABELS: Record<CardStateKind, string> = {
  checking: '확인 중',
  auth_failed: '인증 실패',
  expired: '만료됨',
  expiring: '만료 임박',
  connected: '연결됨',
  needs_setup: '설정 필요',
  disconnected: '연결 안 됨'
}

const TONES: Record<CardStateKind, CardTone> = {
  checking: 'gray',
  auth_failed: 'red',
  expired: 'red',
  expiring: 'amber',
  connected: 'green',
  needs_setup: 'gray',
  disconnected: 'gray'
}

export const CARD_ACTION_LABELS: Record<CardActionId, string> = {
  connect: '연결',
  google_login: 'Google 로그인',
  reconnect: '다시 연결',
  replace_token: '토큰 교체',
  test: '연결 테스트',
  change: '변경',
  disconnect: '해제'
}

/** 상태별 버튼 목록. 첫 번째가 주 버튼이다 */
export const CARD_ACTIONS: Record<CardStateKind, CardActionId[]> = {
  checking: [],
  auth_failed: ['reconnect', 'disconnect'],
  expired: ['replace_token', 'disconnect'],
  expiring: ['replace_token', 'test', 'disconnect'],
  connected: ['test', 'change', 'disconnect'],
  needs_setup: ['connect'],
  disconnected: ['connect']
}

// Google 은 자격 증명이 이미 있으면 [Google 로그인] 한 번으로 OAuth 를 띄운다
const GOOGLE_DISCONNECTED_ACTIONS: CardActionId[] = ['google_login', 'change']

export type IntegrationStatusInput =
  | { id: 'google'; status: CalendarStatus | null }
  | { id: 'jira'; status: JiraConnectionStatus | null }
  | { id: 'bitbucket'; status: AiBitbucketStatus | null }
  | { id: 'notion'; status: AiNotionStatus | null }

export const UNREACHABLE_WARNING = '네트워크 확인 실패'

function statusAccount(input: IntegrationStatusInput): string | null {
  switch (input.id) {
    case 'jira':
      return input.status?.accountName ?? null
    case 'bitbucket':
      return input.status?.email ?? null
    default:
      return null
  }
}

function isConnected(input: IntegrationStatusInput): boolean {
  return input.status?.connected === true
}

function build(
  kind: CardStateKind,
  extra: Partial<Omit<CardState, 'kind' | 'label' | 'tone'>> = {},
  actions: CardActionId[] = CARD_ACTIONS[kind]
): CardState {
  return {
    kind,
    label: CARD_STATE_LABELS[kind],
    tone: TONES[kind],
    account: null,
    detail: null,
    warning: null,
    checkedAt: null,
    actions,
    ...extra
  }
}

export function toCardState(
  input: IntegrationStatusInput,
  verify?: IntegrationVerifyResult | null
): CardState {
  if (input.status === null) return build('checking')

  const checkedAt = verify?.checkedAt ?? null
  const failed = verify && !verify.ok ? verify : null
  const connected = isConnected(input)
  const account = (verify?.ok ? verify.account : null) ?? statusAccount(input)

  if (connected && failed?.code === 'auth_failed') {
    return build('auth_failed', { account, checkedAt, warning: failed.error || null })
  }

  if (input.id === 'jira' && connected) {
    const jira = input.status
    const expiry = jira?.expiresAt ? `토큰 만료일 ${jira.expiresAt}` : null
    if (jira?.expired || failed?.code === 'expired') {
      return build('expired', { account, checkedAt, detail: expiry })
    }
    if (jira?.expiringSoon) {
      return build('expiring', { account, checkedAt, detail: expiry })
    }
  }

  if (connected) {
    let warning: string | null = null
    if (failed?.code === 'unreachable') warning = UNREACHABLE_WARNING
    else if (failed && failed.code !== 'not_connected') warning = failed.error || '연결을 확인하지 못했습니다'
    const detail =
      input.id === 'jira' && input.status?.expiresAt ? `토큰 만료일 ${input.status.expiresAt}` : null
    return build('connected', { account, checkedAt, warning, detail })
  }

  if (input.id === 'google') {
    if (!input.status?.hasCredentials) return build('needs_setup')
    return build('disconnected', {}, GOOGLE_DISCONNECTED_ACTIONS)
  }

  return build('disconnected')
}

/** "마지막 확인 hh:mm". 시각을 읽지 못하면 null */
export function formatCheckedAt(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `마지막 확인 ${hh}:${mm}`
}

/** 해제 전 확인 문구. 카드와 팝업이 같은 문구를 쓴다 */
export const DISCONNECT_CONFIRM: Record<IntegrationId, string> = {
  google: 'Google 캘린더 연결을 해제할까요? 회의 일정을 더 이상 가져오지 않습니다.',
  jira: 'Jira 연결을 해제할까요? 릴리스 노트와 프로젝트 보드를 더 이상 쓸 수 없습니다.',
  bitbucket: 'Bitbucket 연결을 해제할까요? AI가 더 이상 Bitbucket 저장소를 읽을 수 없습니다.',
  notion: 'Notion 연결을 해제할까요? AI가 더 이상 Notion 문서를 읽을 수 없습니다.'
}

export const INTEGRATION_LABELS: Record<IntegrationId, { title: string; purpose: string }> = {
  google: { title: 'Google 캘린더', purpose: '캘린더 화면과 오늘 화면에 회의 일정을 가져옵니다' },
  jira: { title: 'Jira', purpose: '릴리스 노트와 프로젝트 보드에 Jira 이슈를 읽어 옵니다' },
  bitbucket: { title: 'Bitbucket', purpose: 'AI 대화가 저장소의 파일과 PR 을 읽습니다' },
  notion: { title: 'Notion', purpose: 'AI 대화가 Notion 문서를 검색하고 읽습니다' }
}
