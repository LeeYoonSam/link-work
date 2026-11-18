import { useState } from 'react'
import ConnectDialog, { DialogField, inputClass, type ConnectScope } from '../ConnectDialog'
import { button } from '../../ui'

// Google 캘린더 연결 팝업. 자격 증명 저장과 OAuth 로그인을 한 번에 진행한다.
// calendar:saveSettings 다음에 바로 calendar:auth 를 부른다.

export const GOOGLE_REDIRECT_URI = 'http://localhost:8945/callback'
export const GOOGLE_CREDENTIALS_URL = 'https://console.cloud.google.com/apis/credentials'

export const GOOGLE_SCOPES: ConnectScope[] = [
  { scope: 'calendar.readonly', reason: '회의 일정을 읽기만 합니다', need: '필수' }
]

export interface GoogleCalendarConnectDialogProps {
  onClose: () => void
  onConnected: () => void
}

export default function GoogleCalendarConnectDialog({
  onClose,
  onConnected
}: GoogleCalendarConnectDialogProps): React.ReactNode {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const canSubmit = clientId.trim() !== '' && clientSecret.trim() !== ''

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(GOOGLE_REDIRECT_URI)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!canSubmit || busy) return
    setBusy(true)
    setError('')
    try {
      const saved = await window.api.calendar.saveSettings(clientId.trim(), clientSecret.trim())
      if (!saved.success) {
        setError('자격 증명을 저장하지 못했습니다')
        return
      }
      // 비밀값은 main 에 넘겼으니 렌더러 state 에 남기지 않는다
      setClientSecret('')
      const auth = await window.api.calendar.auth()
      if (auth.success) {
        setSuccess('연결됨: Google 캘린더')
        onConnected()
      } else {
        setError(
          auth.error
            ? `Google 로그인에 실패했습니다: ${auth.error}`
            : 'Google 로그인에 실패했습니다. 자격 증명은 저장되었으니 카드의 [Google 로그인]으로 다시 시도하세요'
        )
        onConnected()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Google 캘린더를 연결하지 못했습니다')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConnectDialog
      title="Google 캘린더 연결"
      purpose="캘린더 화면과 오늘 화면에 Google 캘린더의 회의 일정을 가져옵니다(읽기 전용)."
      scopes={GOOGLE_SCOPES}
      scopesNote={
        <div>
          <p className="mb-1">
            Google Cloud 콘솔에서 OAuth 클라이언트(데스크톱 또는 웹)를 만들고 아래 리디렉션 URI 를
            등록합니다.
          </p>
          <div className="flex items-center gap-2">
            <code className="px-1.5 py-0.5 bg-gray-100 rounded font-mono text-[11px] text-gray-800">
              {GOOGLE_REDIRECT_URI}
            </code>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className={`px-2 py-0.5 text-[11px] ${button.subtle}`}
            >
              {copied ? '복사됨' : '복사'}
            </button>
          </div>
        </div>
      }
      issueUrl={GOOGLE_CREDENTIALS_URL}
      issueLabel="발급 페이지 열기"
      busy={busy}
      canSubmit={canSubmit}
      onSubmit={() => void handleSave()}
      submitLabel="저장 후 Google 로그인"
      error={error}
      success={success}
      onClose={onClose}
    >
      <DialogField label="Client ID">
        <input
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="xxxx.apps.googleusercontent.com"
          className={inputClass}
        />
      </DialogField>
      <DialogField label="Client Secret">
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="Client Secret"
          className={inputClass}
        />
      </DialogField>
    </ConnectDialog>
  )
}
