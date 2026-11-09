import { useState } from 'react'
import type { Candidate, PlanItem, PlanItemStatus } from '../../types'
import { Card, SectionTitle, button } from '../ui'
import { ItemLink, SourceBadge, WorkTypeBadge, shortDate } from './PlanItemRow'

// 이 상태의 계획 항목이 있는 후보는 후보 목록에서 뺀다 (부록 M.5.7).
// 제외·미룸·무시 항목은 후보에 남긴다. 이유: 후보에서 다시 추가할 수 있다
const TAKEN_STATUSES: ReadonlySet<PlanItemStatus> = new Set([
  'planned',
  'in_progress',
  'done',
  'suggested'
])

// 오늘 계획에서 살아 있는 후보만 뺀다
export function candidatesNotInPlan(candidates: Candidate[], items: PlanItem[]): Candidate[] {
  const taken = new Set(
    items.filter((i) => TAKEN_STATUSES.has(i.status)).map((i) => i.candidate_id)
  )
  return candidates.filter((c) => !taken.has(c.id))
}

// 후보 더 보기 목록이다. 계속 제외한 후보는 뺀다. 이유: 후보 카드의 제외 구역이 따로 보인다
export function pickableCandidates(candidates: Candidate[], items: PlanItem[]): Candidate[] {
  return candidatesNotInPlan(candidates, items).filter((c) => !c.excluded)
}

interface CandidatePickerProps {
  candidates: Candidate[]
  items: PlanItem[]
  loading: boolean
  error: string
  busy: boolean
  // true 면 '추가' 버튼이 비활성이다
  readOnly?: boolean
  onLoad: () => void
  onAdd: (candidateId: string) => void
  // true 면 바깥 Card 와 머리를 그리지 않고 목록을 바로 그린다.
  // 펼침과 불러오기는 부르는 쪽이 맡는다 (후보 카드 구역 2)
  embedded?: boolean
}

function CandidateList({
  candidates,
  items,
  loading,
  error,
  busy,
  readOnly,
  onAdd,
  inset
}: Omit<CandidatePickerProps, 'onLoad' | 'embedded'> & { inset: boolean }): React.ReactNode {
  const rest = pickableCandidates(candidates, items)
  const pad = inset ? 'px-5' : ''
  if (loading) return <p className={`${pad} py-2 text-sm text-gray-400`}>후보를 불러오는 중…</p>
  if (error) return <p className={`${pad} py-2 text-sm text-red-600`}>{error}</p>
  if (rest.length === 0) {
    return <p className={`${pad} py-2 text-sm text-gray-400`}>계획에 넣지 않은 후보가 없어요.</p>
  }
  return (
    <ul className="divide-y divide-gray-100">
      {rest.map((c) => (
        <li key={c.id} className={`flex items-center gap-3 py-2 ${pad}`}>
          <SourceBadge source={c.source} />
          <WorkTypeBadge type={c.workType} version={c.workVersion} />
          <span className="flex-1 min-w-0 break-words text-sm text-gray-800">
            {c.title}
            {(c.groupName ?? c.projectName) ? (
              <span className="ml-2 text-xs text-gray-400">{c.groupName ?? c.projectName}</span>
            ) : null}
          </span>
          {c.dueDate ? (
            <span className="text-sm text-gray-500 tabular-nums shrink-0">
              마감 {shortDate(c.dueDate)}
            </span>
          ) : null}
          <ItemLink link={c.link} />
          <button
            type="button"
            disabled={busy || readOnly}
            onClick={() => onAdd(c.id)}
            className={`shrink-0 px-2.5 py-1 text-sm ${button.primary} disabled:opacity-50`}
          >
            추가
          </button>
        </li>
      ))}
    </ul>
  )
}

export default function CandidatePicker({
  candidates,
  items,
  loading,
  error,
  busy,
  readOnly = false,
  onLoad,
  onAdd,
  embedded = false
}: CandidatePickerProps): React.ReactNode {
  const [open, setOpen] = useState(false)
  const list = (inset: boolean): React.ReactNode => (
    <CandidateList
      candidates={candidates}
      items={items}
      loading={loading}
      error={error}
      busy={busy}
      readOnly={readOnly}
      onAdd={onAdd}
      inset={inset}
    />
  )

  if (embedded) return list(true)

  return (
    <Card padding="sm">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle>후보 더 보기</SectionTitle>
        <button
          type="button"
          onClick={() => {
            const next = !open
            setOpen(next)
            if (next) onLoad()
          }}
          className={`px-2.5 py-1 text-xs ${button.subtle}`}
        >
          {open ? '접기' : '후보 불러오기'}
        </button>
      </div>
      {open ? <div className="mt-3">{list(false)}</div> : null}
    </Card>
  )
}
