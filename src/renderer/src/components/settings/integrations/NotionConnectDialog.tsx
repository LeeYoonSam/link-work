import { useState } from 'react'
import ConnectDialog, { DialogField, inputClass, type ConnectScope } from '../ConnectDialog'
import { DISCONNECT_CONFIRM } from '../integrationStatus'

// Notion 내부 통합 토큰 등록 팝업.
// main 이 GET /v1/users/me 로 확인한 뒤에만 safeStorage 로 암호화 저장한다.

export const NOTION_INTEGRATIONS_URL = 'https://www.notion.so/my-integrations'

export const NOTION_SCOPES: ConnectScope[] = [
  { scope: '콘텐츠 읽기', reason: '내부 통합을 만들 때 이 권한만 켭니다', need: '필수' },
  { scope: '⋯ → 연결', reason: 'AI가 읽을 페이지에 만든 통합을 추가합니다(하위 페이지에 자동 적용)', need: '필수' }
]

export interface NotionConnectDialogProps {
  connected: boolean
  onClose: () => void
  onChanged: () => void
}

export default function NotionConnectDialog({
  connected: initialConnected,
  onClose,
  onChanged
}: NotionConnectDialogProps): React.ReactNode {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState<string | null>(null)
  const [connected, setConnected] = useState(initialConnected)

  const canSubmit = token.trim() !== ''

  const handleSave = async (): Promise<void> => {
    if (!canSubmit || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await window.api.ai.notionSaveToken(token.trim())
      if (result.success) {
        setToken('')
        setSuccess(`연결됨: ${result.workspace ?? 'Notion'}`)
        setConnected(true)
        onChanged()
      } else {
        setError(result.error ?? '토큰을 확인하지 못했습니다')
      }
    } catch {
      setError('토큰을 확인하지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    if (!window.confirm(DISCONNECT_CONFIRM.notion)) return
    try {
      await window.api.ai.notionDisconnect()
      setConnected(false)
      setSuccess(null)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : '연결을 해제하지 못했습니다')
    }
  }

  return (
    <ConnectDialog
      title="Notion 연결"
      purpose="AI 대화가 Notion 문서를 검색하고 내용을 읽습니다(읽기 전용)."
      intro={
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3 text-xs text-blue-900">
          <p className="font-medium mb-1">가장 간단한 방법: Claude 계정의 Notion 커넥터</p>
          <p>
            Claude 계정(claude.ai)에 Notion 커넥터가 연결되어 있으면 <b>여기서 아무 설정 없이</b>{' '}
            AI가 바로 Notion을 읽을 수 있습니다. 커넥터가 없다면{' '}
            <a
              href="https://claude.ai/settings/connectors"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              claude.ai → 설정 → 커넥터
            </a>
            에서 Notion을 연결하세요. 아래 토큰 방식은 커넥터를 쓰지 않을 때의 대안입니다.
          </p>
        </div>
      }
      scopes={NOTION_SCOPES}
      scopesNote="내부 통합(Internal Integration)을 만든 뒤 Internal Integration Secret 을 복사해 아래에 붙여 넣습니다."
      issueUrl={NOTION_INTEGRATIONS_URL}
      issueLabel="발급 페이지 열기"
      busy={busy}
      canSubmit={canSubmit}
      onSubmit={() => void handleSave()}
      error={error}
      success={success}
      connectedAs={connected ? '' : null}
      onDisconnect={() => void handleDisconnect()}
      onClose={onClose}
    >
      <DialogField label="Internal Integration Secret">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={connected ? '새 토큰으로 교체하려면 입력' : 'ntn_ 으로 시작하는 토큰'}
          className={inputClass}
        />
      </DialogField>
    </ConnectDialog>
  )
}
