import { useState } from 'react'
import type { DailyPlan, RecoveryState } from '../../types'
import MarkdownContent from '../memo/MarkdownContent'
import { AlertTriangleIcon, Badge, Card, SectionTitle, button } from '../ui'
import { hhmmOf, openInternalLink } from './PlanItemRow'

interface RecoveryCardProps {
  plan: Pick<DailyPlan, 'recovery_text' | 'recovery_source' | 'recovery_at'>
  state: RecoveryState
  busy: boolean
  // settings.enabled. false 면 버튼을 숨긴다
  canGenerate: boolean
  onGenerate: () => void
}

// 본문이 있으면 '다시 만들기', 없으면 '만들기' (부록 F.2)
export function recoveryButtonLabel(hasText: boolean): string {
  return hasText ? '다시 만들기' : '만들기'
}

// 맥락 복구 카드 (부록 F.7). 오늘 계획이 있을 때만 그린다
export default function RecoveryCard({
  plan,
  state,
  busy,
  canGenerate,
  onGenerate
}: RecoveryCardProps): React.ReactNode {
  const [collapsed, setCollapsed] = useState(false)
  const hasText = !!plan.recovery_text
  const isLlm = plan.recovery_source === 'llm'
  // 본문이나 오류가 있을 때만 접을 내용이 있다
  const hasBody = hasText || !!state.error

  return (
    <Card>
      <div id="today-recovery" className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <SectionTitle variant="page">맥락 복구</SectionTitle>
          {hasText ? (
            <Badge
              color={isLlm ? 'bg-purple-50 text-purple-600' : 'bg-slate-100 text-slate-600'}
             
            >
              {isLlm ? 'AI 복구' : '규칙 복구'}
            </Badge>
          ) : null}
          {hasText && plan.recovery_at ? (
            <span className="text-xs text-gray-500 tabular-nums">{hhmmOf(plan.recovery_at)}</span>
          ) : null}
          {state.inFlight ? <span className="text-sm text-gray-500">만드는 중…</span> : null}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {hasBody ? (
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              className={`px-3 py-1.5 text-sm ${button.ghost}`}
            >
              {collapsed ? '펼치기' : '접기'}
            </button>
          ) : null}
          {canGenerate ? (
            <button
              type="button"
              disabled={busy || state.inFlight}
              onClick={onGenerate}
              className={`px-3 py-1.5 text-sm ${button.subtle} disabled:opacity-50`}
            >
              {recoveryButtonLabel(hasText)}
            </button>
          ) : null}
        </div>
      </div>

      {hasBody && !collapsed ? (
        <div className="mt-4">
          {state.error ? (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3 text-sm text-amber-800">
              <AlertTriangleIcon size={16} className="shrink-0 mt-0.5" />
              <span>맥락 복구를 마치지 못했습니다. {state.error}</span>
            </div>
          ) : null}
          {plan.recovery_text ? (
            <MarkdownContent
              content={plan.recovery_text}
              compact
              onInternalLink={(href) => void openInternalLink(href)}
            />
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}
