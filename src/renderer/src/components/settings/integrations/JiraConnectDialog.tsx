import { useState } from 'react'
import { addDays, addYears, format } from 'date-fns'
import type { JiraConnectionStatus } from '../../../types'
import ConnectDialog, {
  ATLASSIAN_TOKEN_URL,
  DialogField,
  inputClass,
  type ConnectScope
} from '../ConnectDialog'
import { DISCONNECT_CONFIRM } from '../integrationStatus'
import JiraDefaultProjectSelect from './JiraDefaultProjectSelect'

// Jira Cloud API 토큰 등록 팝업.
// main 이 GET /rest/api/3/myself 로 확인한 뒤에만 safeStorage 로 암호화 저장한다.
// 연결돼 있으면 같은 팝업 안에서 기본 프로젝트도 고른다(작업 흐름 중에 그 자리에서 띄우기 위해).

export const JIRA_SCOPES: ConnectScope[] = [
  { scope: 'API token', reason: '범위를 고르지 않습니다. 내 계정 권한 그대로 쓰고 읽기만 합니다' },
  { scope: '만료일', reason: '발급할 때 정한 날짜를 입력하면 만료 30일 전부터 알려 줍니다' }
]

export interface JiraConnectDialogProps {
  status: JiraConnectionStatus | null
  onClose: () => void
  onChanged: () => void
  /** 다른 Atlassian 연동(Bitbucket)에 등록한 이메일. 저장된 Jira 이메일이 없을 때 미리 채운다 */
  suggestedEmail?: string | null
}

export default function JiraConnectDialog({
  status,
  onClose,
  onChanged,
  suggestedEmail
}: JiraConnectDialogProps): React.ReactNode {
  const [siteUrl, setSiteUrl] = useState(status?.siteUrl ?? '')
  const [email, setEmail] = useState(status?.email ?? suggestedEmail ?? '')
  const [apiToken, setApiToken] = useState('')
  const [expiresAt, setExpiresAt] = useState(status?.expiresAt ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState<string | null>(null)
  const [connected, setConnected] = useState(status?.connected === true)

  const canSubmit =
    siteUrl.trim() !== '' && email.trim() !== '' && apiToken.trim() !== '' && expiresAt !== ''

  const handleSave = async (): Promise<void> => {
    if (!canSubmit || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await window.api.jira.saveCredentials({
        siteUrl: siteUrl.trim(),
        email: email.trim(),
        apiToken: apiToken.trim(),
        expiresAt
      })
      if (result.success) {
        // 저장에 성공하면 입력한 토큰을 렌더러 state 에 남기지 않는다
        setApiToken('')
        setSuccess(`연결됨: ${result.accountName ?? email.trim()}`)
        setConnected(true)
        onChanged()
      } else {
        setError(result.error ?? 'Jira 토큰을 확인하지 못했습니다')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Jira 토큰을 확인하지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    if (!window.confirm(DISCONNECT_CONFIRM.jira)) return
    try {
      await window.api.jira.disconnect()
      setConnected(false)
      setApiToken('')
      setSuccess(null)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '연결을 해제하지 못했습니다')
    }
  }

  const today = new Date()
  // 기본 프로젝트 목록은 저장된 연결 기준으로 당긴다. 방금 연결했으면 연결된 것으로 본다
  const selectStatus: JiraConnectionStatus | null =
    connected && status ? { ...status, connected: true } : null

  return (
    <ConnectDialog
      title="Jira 연결"
      purpose="릴리스 노트와 프로젝트 싱크업이 Jira 이슈를 읽어 옵니다(읽기 전용)."
      scopes={JIRA_SCOPES}
      scopesNote="Atlassian API 토큰은 최대 1년까지 유효합니다. Bitbucket 과 같은 발급 페이지를 씁니다."
      issueUrl={ATLASSIAN_TOKEN_URL}
      issueLabel="발급 페이지 열기"
      busy={busy}
      canSubmit={canSubmit}
      onSubmit={() => void handleSave()}
      error={error}
      success={success}
      connectedAs={connected ? (status?.accountName ?? '') : null}
      onDisconnect={() => void handleDisconnect()}
      after={
        selectStatus?.connected ? (
          <div className="mt-3">
            <JiraDefaultProjectSelect status={selectStatus} onChanged={onChanged} />
          </div>
        ) : null
      }
      onClose={onClose}
    >
      <DialogField label="사이트 URL">
        <input
          type="text"
          value={siteUrl}
          onChange={(e) => setSiteUrl(e.target.value)}
          placeholder="https://your-site.atlassian.net"
          className={inputClass}
        />
      </DialogField>
      <DialogField label="Atlassian 계정 이메일">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@company.com"
          className={inputClass}
        />
      </DialogField>
      <DialogField label="API token">
        <input
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder={connected ? '새 토큰으로 교체하려면 입력' : 'Atlassian API token'}
          className={inputClass}
        />
      </DialogField>
      <DialogField label="토큰 만료일" hint="발급할 때 지정한 만료일을 그대로 입력합니다">
        <input
          type="date"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          min={format(addDays(today, 1), 'yyyy-MM-dd')}
          max={format(addYears(today, 1), 'yyyy-MM-dd')}
          className={inputClass}
        />
      </DialogField>
    </ConnectDialog>
  )
}
