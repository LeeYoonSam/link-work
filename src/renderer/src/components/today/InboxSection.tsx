import { useState } from 'react'
import type { CandidateSource, PlanItem } from '../../types'
import { Badge, Card, InboxIcon, SectionTitle, button } from '../ui'
import { ItemLink, SOURCE_BADGE, SourceBadge, WorkTypeBadge, shortDate } from './PlanItemRow'

// 기본으로 보이는 제안 수 (부록 J.8, J-9). 나머지는 버튼으로 펼친다
export const INBOX_SHOWN = 5

// 제안 항목 정렬: 긴급 먼저, 그다음 점수 높은 순, 같으면 id 순
export function sortSuggestions(items: PlanItem[]): PlanItem[] {
  return items
    .filter((i) => i.status === 'suggested')
    .sort(
      (a, b) =>
        Number(b.urgent) - Number(a.urgent) || b.score - a.score || a.id - b.id
    )
}

const SOURCE_ORDER: CandidateSource[] = ['action_item', 'jira', 'task', 'todo', 'manual']

// 출처별 수. 많은 출처가 앞이다. 예: '액션아이템 12 · Jira 3'
export function inboxSourceSummary(items: PlanItem[]): string {
  const counts = new Map<CandidateSource, number>()
  for (const i of items) counts.set(i.source, (counts.get(i.source) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || SOURCE_ORDER.indexOf(a[0]) - SOURCE_ORDER.indexOf(b[0]))
    .map(([source, n]) => `${SOURCE_BADGE[source]?.label ?? source} ${n}`)
    .join(' · ')
}

interface InboxSectionProps {
  items: PlanItem[]
  busy: boolean
  readOnly?: boolean
  onAccept: (itemId: number) => void
  onDismiss: (itemId: number) => void
}

export default function InboxSection({
  items,
  busy,
  readOnly = false,
  onAccept,
  onDismiss
}: InboxSectionProps): React.ReactNode {
  const [expanded, setExpanded] = useState(false)
  const suggestions = sortSuggestions(items)
  if (suggestions.length === 0) return null

  const shown = expanded ? suggestions : suggestions.slice(0, INBOX_SHOWN)
  const hidden = suggestions.length - INBOX_SHOWN

  return (
    <Card padding="none">
      <div id="today-inbox" className="flex items-center gap-2 px-4 pt-4 pb-2">
        <InboxIcon size={16} className="text-gray-400" />
        <SectionTitle>새로 들어온 일</SectionTitle>
        <span className="text-xs text-gray-400">{suggestions.length}건</span>
        <span className="ml-auto text-[11px] text-gray-400 truncate">
          {inboxSourceSummary(suggestions)}
        </span>
      </div>
      <div>
        {shown.map((item) => (
          <div
            key={item.id}
            className={`flex items-center gap-3 px-4 py-2.5 border-t border-gray-100 ${
              item.urgent ? 'bg-red-50/40' : ''
            }`}
          >
            {item.urgent ? (
              <Badge color="bg-red-100 text-red-700" size="xs">
                긴급
              </Badge>
            ) : null}
            <SourceBadge source={item.source} />
            <WorkTypeBadge type={item.work_type} version={item.work_version} />
            <span className="flex-1 min-w-0 truncate text-sm text-gray-900" title={item.title}>
              {item.title}
            </span>
            {item.due_date ? (
              <span className="text-xs text-gray-500 shrink-0">마감 {shortDate(item.due_date)}</span>
            ) : null}
            <ItemLink link={item.link} />
            {readOnly ? null : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onAccept(item.id)}
                  className={`shrink-0 px-2.5 py-1 text-xs ${button.primary} disabled:opacity-50`}
                >
                  계획에 추가
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onDismiss(item.id)}
                  className={`shrink-0 px-2.5 py-1 text-xs ${button.subtle} disabled:opacity-50`}
                >
                  무시
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      {hidden > 0 ? (
        <div className="px-4 py-2 border-t border-gray-100">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className={`px-2.5 py-1 text-xs ${button.ghost}`}
          >
            {expanded ? '덜 보기' : `나머지 ${hidden}건 보기`}
          </button>
        </div>
      ) : null}
    </Card>
  )
}
