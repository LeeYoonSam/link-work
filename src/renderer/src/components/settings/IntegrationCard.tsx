import type { ReactNode } from 'react'
import { Badge, Card, button } from '../ui'
import {
  CARD_ACTION_LABELS,
  formatCheckedAt,
  type CardActionId,
  type CardState,
  type CardTone
} from './integrationStatus'

// 연동 카드 한 장. 상태 배지, 계정, 마지막 확인 시각, 경고 한 줄, 상태별 버튼을 같은 틀로 그린다.

const BADGE: Record<CardTone, string> = {
  gray: 'bg-gray-100 text-gray-600',
  green: 'bg-green-100 text-green-700',
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700'
}

export interface IntegrationCardProps {
  title: string
  purpose: string
  state: CardState
  /** [연결 테스트] 진행 중 */
  verifying?: boolean
  /** 상태 조회 실패 문구 */
  statusError?: string | null
  onAction: (action: CardActionId) => void
  children?: ReactNode
}

export default function IntegrationCard({
  title,
  purpose,
  state,
  verifying = false,
  statusError,
  onAction,
  children
}: IntegrationCardProps): React.ReactNode {
  const checked = formatCheckedAt(state.checkedAt)
  return (
    <Card padding="sm" className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-gray-900">{title}</h4>
            <Badge color={BADGE[state.tone]} size="xs">
              {state.kind === 'checking' ? '확인 중…' : state.label}
            </Badge>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">{purpose}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {state.actions.map((a, i) => {
            const primary = i === 0
            const cls =
              a === 'disconnect'
                ? button.danger
                : primary
                  ? button.primary
                  : button.subtle
            const busy = a === 'test' && verifying
            return (
              <button
                key={a}
                type="button"
                disabled={busy}
                onClick={() => onAction(a)}
                className={`px-2.5 py-1 text-xs disabled:opacity-50 ${cls}`}
              >
                {busy ? '확인 중…' : CARD_ACTION_LABELS[a]}
              </button>
            )
          })}
        </div>
      </div>

      {state.account || state.detail || checked ? (
        <p className="text-xs text-gray-600 flex flex-wrap gap-x-3">
          {state.account ? <span className="break-all">{state.account}</span> : null}
          {state.detail ? <span>{state.detail}</span> : null}
          {checked ? <span className="text-gray-400">{checked}</span> : null}
        </p>
      ) : null}

      {state.warning ? (
        <p className={`text-xs ${state.tone === 'red' ? 'text-red-600' : 'text-amber-700'} break-all`}>
          {state.warning}
        </p>
      ) : null}
      {statusError ? <p className="text-xs text-red-600 break-all">{statusError}</p> : null}

      {children}
    </Card>
  )
}
