import type { DailyPlan } from '../../types'
import MarkdownContent from '../memo/MarkdownContent'
import { AlertTriangleIcon, Badge, Card, SectionTitle, button } from '../ui'
import { hhmmOf, openInternalLink } from './PlanItemRow'

interface BriefingCardProps {
  plan: DailyPlan
  // LLM 브리핑을 다시 만들 수 있으면 true
  canRegenerate: boolean
  busy: boolean
  onRegenerate: () => void
}

export default function BriefingCard({
  plan,
  canRegenerate,
  busy,
  onRegenerate
}: BriefingCardProps): React.ReactNode {
  const isLlm = plan.briefing_source === 'llm'
  const showRegenerate = canRegenerate || plan.briefing_error !== null

  return (
    <Card padding="sm">
      <div id="today-briefing" className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <SectionTitle>브리핑</SectionTitle>
          {plan.briefing_source ? (
            <Badge
              color={isLlm ? 'bg-purple-50 text-purple-600' : 'bg-slate-100 text-slate-600'}
              size="xs"
              title={isLlm && plan.briefing_model ? plan.briefing_model : undefined}
            >
              {isLlm ? 'AI 브리핑' : '규칙 브리핑'}
            </Badge>
          ) : null}
          {plan.briefing_at ? (
            <span className="text-[11px] text-gray-400">{hhmmOf(plan.briefing_at)}</span>
          ) : null}
        </div>
        {showRegenerate ? (
          <button
            type="button"
            disabled={busy}
            onClick={onRegenerate}
            className={`px-2.5 py-1 text-xs ${button.subtle} disabled:opacity-50`}
          >
            다시 생성
          </button>
        ) : null}
      </div>

      {plan.briefing_error ? (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3 text-xs text-amber-800">
          <AlertTriangleIcon size={14} className="shrink-0 mt-0.5" />
          <span>AI 브리핑을 만들지 못했습니다. {plan.briefing_error}</span>
        </div>
      ) : null}

      {plan.briefing_text ? (
        <MarkdownContent
          content={plan.briefing_text}
          compact
          onInternalLink={(href) => void openInternalLink(href)}
        />
      ) : (
        <p className="text-sm text-gray-400">브리핑이 아직 없습니다.</p>
      )}
    </Card>
  )
}
