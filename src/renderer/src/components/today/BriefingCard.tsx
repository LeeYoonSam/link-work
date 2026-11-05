import type { DailyPlan } from '../../types'
import { AlertTriangleIcon, Badge, button } from '../ui'
import { hhmmOf } from './PlanItemRow'

// 마크다운 제목 줄 '#'~'######'
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/
// 줄 전체가 굵은 글씨인 제목 줄. 예: '**오늘 할 일 5건**', '**오늘 할 일**:'
const BOLD_HEADING = /^ {0,3}\*\*([^*]+)\*\*\s*:?\s*$/
// 표 줄. 구분선 줄도 '|' 로 시작한다
const TABLE_ROW = /^\s*\|/
// 가로줄 '---', '***', '___'
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
// 목록 기호. 산문 줄 앞의 점으로 바꾼다
const LIST_MARK = /^\s*[-*+]\s+/
// 인용 기호
const QUOTE_MARK = /^\s*>\s?/
// 이 글자가 든 제목의 절은 '오늘 할 일' 카드와 겹쳐서 뺀다
const TODO_WORD = '할 일'

// 줄 안의 마크다운 문법을 글자로 바꾼다. 링크는 글자만, 굵게 기호는 지우고, 이스케이프는 푼다
function plainInline(line: string): string {
  const linked = line.replace(/(^|[^\\])\[([^\]]*)\]\([^)]*\)/g, '$1$2')
  let out = ''
  for (let i = 0; i < linked.length; i++) {
    const ch = linked[i]
    const next = linked[i + 1]
    if (ch === '\\' && next !== undefined && /[\\`*_{}[\]()#+\-.!|>~]/.test(next)) {
      out += next
      i++
    } else if (ch === '*' && next === '*') {
      i++
    } else if (ch === '`') {
      continue
    } else {
      out += ch
    }
  }
  return out
}

// 제목 줄이면 제목 글자를, 아니면 null 을 돌려준다
function headingText(line: string): string | null {
  const h = HEADING.exec(line)
  if (h) return h[2] ?? ''
  const b = BOLD_HEADING.exec(line)
  return b ? b[1] : null
}

// 하루 브리핑 요약 (2차 개편 V2). 표 줄과 제목에 '할 일' 이 든 절을 뺀다.
// 제목 기호를 지우고 제목 글자는 다음 문단의 첫 줄로 남긴다. 목록 기호는 '· ' 로 바꾼다.
// 문단은 빈 줄 1개로 나눈다. 남은 산문이 없으면 빈 문자열이다
export function briefingSummary(text: string): string {
  const paragraphs: string[][] = []
  let current: string[] = []
  let skipping = false
  // current 에 제목 글자만 있고 본문이 아직 없으면 true
  let headingPending = false
  const flush = (): void => {
    // 본문 없는 제목은 버린다
    if (current.length > 0 && !headingPending) paragraphs.push(current)
    current = []
    headingPending = false
  }

  for (const raw of text.split('\n')) {
    const heading = headingText(raw)
    if (heading !== null) {
      flush()
      skipping = heading.includes(TODO_WORD)
      const label = plainInline(heading).trim()
      if (!skipping && label !== '') {
        current.push(label)
        headingPending = true
      }
      continue
    }
    if (skipping || TABLE_ROW.test(raw) || RULE.test(raw)) continue
    if (raw.trim() === '') {
      // 제목 바로 뒤의 빈 줄은 문단을 나누지 않는다. 제목이 다음 문단의 첫 줄이 된다
      if (!headingPending) flush()
      continue
    }
    const listed = LIST_MARK.test(raw)
    const body = plainInline(raw.replace(QUOTE_MARK, '').replace(LIST_MARK, '')).trim()
    if (body === '') continue
    current.push(listed ? `· ${body}` : body)
    headingPending = false
  }
  flush()
  return paragraphs.map((p) => p.join('\n')).join('\n\n')
}

interface BriefingCardProps {
  plan: DailyPlan
  // LLM 브리핑을 다시 만들 수 있으면 true
  canRegenerate: boolean
  busy: boolean
  onRegenerate: () => void
}

// DayHeader 카드 안에 들어가는 하루 브리핑 요약 블록 (2차 개편 V1).
// 요약이 빈 문자열이면 아무것도 그리지 않는다
export default function BriefingCard({
  plan,
  canRegenerate,
  busy,
  onRegenerate
}: BriefingCardProps): React.ReactNode {
  const summary = briefingSummary(plan.briefing_text ?? '')
  if (summary === '') return null
  const isLlm = plan.briefing_source === 'llm'
  const showRegenerate = canRegenerate || plan.briefing_error !== null

  return (
    <div id="today-briefing">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-gray-500">브리핑</span>
          {plan.briefing_source ? (
            <Badge
              color={isLlm ? 'bg-purple-50 text-purple-600' : 'bg-slate-100 text-slate-600'}
              title={isLlm && plan.briefing_model ? plan.briefing_model : undefined}
            >
              {isLlm ? 'AI 브리핑' : '규칙 브리핑'}
            </Badge>
          ) : null}
          {plan.briefing_at ? (
            <span className="text-xs text-gray-500 tabular-nums">{hhmmOf(plan.briefing_at)}</span>
          ) : null}
        </div>
        {showRegenerate ? (
          <button
            type="button"
            disabled={busy}
            onClick={onRegenerate}
            className={`shrink-0 px-3 py-1.5 text-sm ${button.subtle} disabled:opacity-50`}
          >
            다시 생성
          </button>
        ) : null}
      </div>

      {plan.briefing_error ? (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-2 text-sm text-amber-800">
          <AlertTriangleIcon size={16} className="shrink-0 mt-0.5" />
          <span>AI 브리핑을 만들지 못했습니다. {plan.briefing_error}</span>
        </div>
      ) : null}

      <div className="space-y-2">
        {summary.split('\n\n').map((p, i) => (
          <p key={i} className="text-base text-gray-700 whitespace-pre-line break-words">
            {p}
          </p>
        ))}
      </div>
    </div>
  )
}
