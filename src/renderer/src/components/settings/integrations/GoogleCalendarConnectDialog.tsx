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

// 팝업에 번호 순서로 보이는 연결 안내. 리디렉션 URI 단계(4번)는 [복사] 버튼이 있어 컴포넌트가 따로 그린다.
export const GOOGLE_CONNECT_STEPS: string[] = [
  '[발급 페이지 열기]로 Google Cloud 콘솔을 열고 프로젝트를 고릅니다. 없으면 새로 만듭니다.',
  '처음이면 "API 및 서비스 > 라이브러리"에서 Google Calendar API 를 사용 설정하고 OAuth 동의 화면을 만듭니다. 회사 계정은 "내부", 개인 계정은 "외부"로 하고 테스트 사용자에 본인을 추가합니다.',
  '"사용자 인증 정보 만들기 > OAuth 클라이언트 ID"에서 유형을 "웹 애플리케이션"으로 고릅니다.',
  '만들어진 Client ID 와 Client Secret 을 아래에 붙여 넣고 [저장 후 Google 로그인]을 누릅니다.',
  '로그인 창에서 일정을 가져올 Google 계정을 고르고 캘린더 읽기를 허용합니다. 처음에는 그 계정의 기본 캘린더만 읽습니다. 연결 후 카드의 "가져올 캘린더"에서 다른 캘린더를 더 고를 수 있습니다.'
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
          <p className="text-xs font-medium text-gray-700 mb-1.5">연결 순서</p>
          <ol className="list-decimal pl-4 space-y-1.5">
            {GOOGLE_CONNECT_STEPS.slice(0, 3).map((step) => (
              <li key={step}>{step}</li>
            ))}
            <li>
              &ldquo;승인된 리디렉션 URI&rdquo;에 아래 주소를 추가합니다.
              <span className="flex items-center gap-2 mt-1">
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
              </span>
            </li>
            {GOOGLE_CONNECT_STEPS.slice(3).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="mt-2">
            예전에 만든 OAuth 클라이언트가 있으면 그대로 쓸 수 있습니다. Client Secret 이 보이지 않으면
            그 클라이언트에서 보안 비밀을 새로 추가하세요.
          </p>
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
