import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Card, XIcon, button } from '../ui'

// 토큰 등록 팝업의 공통 껍데기 (docs/SETTINGS.md).
// 한 화면에 순서대로 그린다: 용도 → 필요한 권한 → [발급 페이지 열기] → 입력 → [확인 후 저장] → 결과 → 저장 안내.
// 검증은 각 연동의 save IPC 가 저장 전에 한다. 이 껍데기는 상태를 갖지 않는다.

export interface ConnectScope {
  /** 범위 이름 또는 권한 이름 */
  scope: string
  /** 왜 필요한지 */
  reason: string
  /** 필수·권장 등 표시. 없으면 생략 */
  need?: string
}

/** Jira·Bitbucket 이 같이 쓰는 Atlassian API 토큰 발급 페이지 */
export const ATLASSIAN_TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens'

export const STORAGE_NOTICE =
  '이 Mac에만 암호화 저장되며 데이터 백업에 포함되지 않습니다. 새 PC에서는 다시 연결하세요.'

export const inputClass =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'

export function DialogField({
  label,
  hint,
  children
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}): React.ReactNode {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-700 mb-1">{label}</span>
      {children}
      {hint ? <span className="block mt-1 text-[11px] text-gray-500">{hint}</span> : null}
    </label>
  )
}

export interface ConnectDialogProps {
  title: string
  /** 용도 한 줄 */
  purpose: string
  /** 필요한 권한 표 제목. 기본 '필요한 권한' */
  scopesTitle?: string
  scopes: ConnectScope[]
  /** 권한 표 아래 보조 안내 */
  scopesNote?: ReactNode
  /** 권한 표 위에 둘 안내(커넥터 대안 등) */
  intro?: ReactNode
  issueUrl: string
  issueLabel: string
  /** 입력 칸 */
  children: ReactNode
  busy: boolean
  canSubmit: boolean
  onSubmit: () => void
  submitLabel?: string
  error: string
  /** 저장에 성공하면 "연결됨: {account}" 로 보인다 */
  success: string | null
  /** 이미 연결된 경우 위쪽에 보일 현재 연결 정보 */
  connectedAs?: string | null
  onDisconnect?: () => void
  /** 결과 아래에 덧붙일 내용(Jira 기본 프로젝트 등) */
  after?: ReactNode
  onClose: () => void
}

export default function ConnectDialog({
  title,
  purpose,
  scopesTitle = '필요한 권한',
  scopes,
  scopesNote,
  intro,
  issueUrl,
  issueLabel,
  children,
  busy,
  canSubmit,
  onSubmit,
  submitLabel = '확인 후 저장',
  error,
  success,
  connectedAs,
  onDisconnect,
  after,
  onClose
}: ConnectDialogProps): React.ReactNode {
  // Esc 로 닫는다. 저장 중에는 닫지 않는다(응답을 놓치지 않도록)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <Card padding="md" className="bg-white max-h-[85vh] overflow-auto">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-base font-semibold text-gray-900">{title}</h3>
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-700 transition-colors"
              title="닫기"
              aria-label="닫기"
            >
              <XIcon size={16} />
            </button>
          </div>
          <p className="text-xs text-gray-500 mb-3">{purpose}</p>

          {connectedAs !== undefined && connectedAs !== null && !success ? (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-3 flex items-center justify-between gap-2">
              <p className="text-sm text-green-800 min-w-0 break-all">
                연결됨{connectedAs ? `: ${connectedAs}` : ''}
                <span className="block text-[11px] text-green-700">
                  새 값을 입력하면 확인한 뒤 교체합니다
                </span>
              </p>
              {onDisconnect ? (
                <button
                  type="button"
                  onClick={onDisconnect}
                  className={`shrink-0 px-3 py-1.5 text-xs ${button.danger}`}
                >
                  연결 해제
                </button>
              ) : null}
            </div>
          ) : null}

          {intro}

          <div className="border border-gray-200 rounded-lg p-3 mb-3">
            <p className="text-xs font-medium text-gray-700 mb-2">{scopesTitle}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
              {scopes.map((s) => (
                <div key={s.scope} className="contents">
                  <dt>
                    <code className="px-1 bg-gray-100 rounded font-mono text-[11px] text-gray-800">
                      {s.scope}
                    </code>
                  </dt>
                  <dd className="text-gray-600">
                    {s.reason}
                    {s.need ? <span className="ml-1 text-gray-400">({s.need})</span> : null}
                  </dd>
                </div>
              ))}
            </dl>
            {scopesNote ? <div className="mt-2 text-[11px] text-gray-500">{scopesNote}</div> : null}
            <a
              href={issueUrl}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex items-center gap-1 mt-3 px-3 py-1.5 text-xs ${button.subtle}`}
            >
              {issueLabel} ↗
            </a>
          </div>

          {success ? null : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                if (canSubmit && !busy) onSubmit()
              }}
            >
              {children}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className={`px-4 py-2 text-sm ${button.subtle}`}
                >
                  닫기
                </button>
                <button
                  type="submit"
                  disabled={!canSubmit || busy}
                  className={`px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed ${button.primary}`}
                >
                  {busy ? '확인 중…' : submitLabel}
                </button>
              </div>
            </form>
          )}

          {error ? (
            <p
              className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5 break-all"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          {success ? (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-center justify-between gap-2">
              <p className="text-sm text-green-800 min-w-0 break-all">{success}</p>
              <button
                type="button"
                onClick={onClose}
                className={`shrink-0 px-3 py-1.5 text-xs ${button.primary}`}
              >
                닫기
              </button>
            </div>
          ) : null}

          {after}

          <p className="mt-3 text-[11px] text-gray-400">{STORAGE_NOTICE}</p>
        </Card>
      </div>
    </div>
  )
}
