import { useState } from 'react'
import type { Candidate, PlanItem } from '../../types'
import { Card, SectionTitle, button } from '../ui'
import { ItemLink, SourceBadge, shortDate } from './PlanItemRow'

// 계획에 아직 없는 후보만 남긴다. 무시한 제안도 같은 행이 있으므로 뺀다
export function candidatesNotInPlan(candidates: Candidate[], items: PlanItem[]): Candidate[] {
  const taken = new Set(items.map((i) => i.candidate_id))
  return candidates.filter((c) => !taken.has(c.id))
}

interface CandidatePickerProps {
  candidates: Candidate[]
  items: PlanItem[]
  loading: boolean
  error: string
  busy: boolean
  onLoad: () => void
  onAdd: (candidateId: string) => void
}

export default function CandidatePicker({
  candidates,
  items,
  loading,
  error,
  busy,
  onLoad,
  onAdd
}: CandidatePickerProps): React.ReactNode {
  const [open, setOpen] = useState(false)
  const rest = candidatesNotInPlan(candidates, items)

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

      {open ? (
        <div className="mt-3">
          {loading ? (
            <p className="text-xs text-gray-400">후보를 불러오는 중…</p>
          ) : error ? (
            <p className="text-xs text-red-600">{error}</p>
          ) : rest.length === 0 ? (
            <p className="text-xs text-gray-400">계획에 넣지 않은 후보가 없습니다.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {rest.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2">
                  <SourceBadge source={c.source} />
                  <span className="flex-1 min-w-0 truncate text-sm text-gray-800" title={c.title}>
                    {c.title}
                    {c.projectName ? (
                      <span className="ml-2 text-xs text-gray-400">{c.projectName}</span>
                    ) : null}
                  </span>
                  {c.dueDate ? (
                    <span className="text-xs text-gray-500 shrink-0">마감 {shortDate(c.dueDate)}</span>
                  ) : null}
                  <ItemLink link={c.link} />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAdd(c.id)}
                    className={`shrink-0 px-2.5 py-1 text-xs ${button.primary} disabled:opacity-50`}
                  >
                    추가
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </Card>
  )
}
