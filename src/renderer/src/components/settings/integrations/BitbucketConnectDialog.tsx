import { useState } from 'react'
import type { AiBitbucketStatus } from '../../../types'
import ConnectDialog, {
  ATLASSIAN_TOKEN_URL,
  DialogField,
  inputClass,
  type ConnectScope
} from '../ConnectDialog'
import { DISCONNECT_CONFIRM } from '../integrationStatus'

// Bitbucket Cloud 범위 지정 API token 등록 팝업.
// main 이 GET /2.0/user 로 확인한 뒤에만 safeStorage 로 암호화 저장한다.

const BITBUCKET_SCOPES: ConnectScope[] = [
  { scope: 'read:repository:bitbucket', reason: '저장소 파일 읽기', need: '필수' },
  { scope: 'read:pullrequest:bitbucket', reason: 'PR 링크 읽기·나에게 온 리뷰 요청 모으기', need: '권장' },
  { scope: 'read:user:bitbucket', reason: '연결 계정 이름 표시', need: '권장' }
]

interface BitbucketConnectDialogProps {
  status: AiBitbucketStatus
  onClose: () => void
  onChanged: () => void
  /** 다른 Atlassian 연동(Jira)에 등록한 이메일. 저장된 Bitbucket 이메일이 없을 때 미리 채운다 */
  suggestedEmail?: string | null
}

export default function BitbucketConnectDialog({
  status,
  onClose,
  onChanged,
  suggestedEmail
}: BitbucketConnectDialogProps): React.ReactNode {
  const [email, setEmail] = useState(status.email ?? suggestedEmail ?? '')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState<string | null>(null)
  const [connected, setConnected] = useState(status.connected)
  const [workspace, setWorkspace] = useState(status.workspace ?? '')
  const [savedWorkspace, setSavedWorkspace] = useState(status.workspace ?? '')
  const [workspaceBusy, setWorkspaceBusy] = useState(false)

  // 리뷰 요청을 찾을 워크스페이스. token 과 따로 저장한다(이미 연결돼 있으면 token 을 다시 넣지 않아도 된다)
  const handleSaveWorkspace = async (): Promise<void> => {
    if (workspaceBusy) return
    setWorkspaceBusy(true)
    setError('')
    try {
      const result = await window.api.ai.bitbucketSetWorkspace(workspace.trim())
      if (result.success) {
        setWorkspace(result.workspace ?? '')
        setSavedWorkspace(result.workspace ?? '')
        setSuccess(result.workspace ? `워크스페이스 저장: ${result.workspace}` : '워크스페이스를 지웠습니다')
        onChanged()
      } else {
        setError(result.error || '워크스페이스를 저장하지 못했습니다')
      }
    } catch {
      setError('워크스페이스를 저장하지 못했습니다')
    } finally {
      setWorkspaceBusy(false)
    }
  }

  const canSubmit = email.trim() !== '' && token.trim() !== ''

  const handleSave = async (): Promise<void> => {
    if (!canSubmit || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await window.api.ai.bitbucketSaveToken(email.trim(), token.trim())
      if (result.success) {
        setToken('')
        setSuccess(`연결됨: ${result.account}`)
        setConnected(true)
        onChanged()
      } else {
        setError(result.error || 'token 을 확인하지 못했습니다')
      }
    } catch {
      setError('token 을 확인하지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    if (!window.confirm(DISCONNECT_CONFIRM.bitbucket)) return
    try {
      await window.api.ai.bitbucketDisconnect()
      setConnected(false)
      setToken('')
      setSuccess(null)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '연결을 해제하지 못했습니다')
    }
  }

  return (
    <ConnectDialog
      title="Bitbucket 연결"
      purpose="AI 대화가 Bitbucket 저장소의 파일과 폴더를 읽고, 오늘 화면이 나에게 온 리뷰 요청을 모읍니다(읽기 전용)."
      scopesTitle="필요한 권한 — 'Bitbucket 용 범위 지정 API token' 을 만들 때 고릅니다"
      scopes={BITBUCKET_SCOPES}
      scopesNote="쓰기(write) 범위는 필요 없습니다. 읽기 범위만 고르세요."
      issueUrl={ATLASSIAN_TOKEN_URL}
      issueLabel="발급 페이지 열기"
      busy={busy}
      canSubmit={canSubmit}
      onSubmit={() => void handleSave()}
      error={error}
      success={success}
      connectedAs={connected ? (status.email ?? '') : null}
      onDisconnect={() => void handleDisconnect()}
      onClose={onClose}
    >
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
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={connected ? '새 token 으로 교체하려면 입력' : 'API token'}
          className={inputClass}
        />
      </DialogField>
      <DialogField
        label="리뷰 요청을 찾을 워크스페이스 (선택)"
        hint="최근 갱신된 저장소 30개에서 나를 리뷰어로 둔 열린 PR 을 오늘 화면에 모읍니다."
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            placeholder="워크스페이스 이름 또는 https://bitbucket.org/이름"
            className={inputClass}
          />
          <button
            type="button"
            onClick={() => void handleSaveWorkspace()}
            disabled={workspaceBusy || workspace.trim() === savedWorkspace}
            className="shrink-0 rounded-md bg-gray-100 px-3 text-xs font-medium text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            저장
          </button>
        </div>
      </DialogField>
    </ConnectDialog>
  )
}
