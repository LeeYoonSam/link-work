import { useState } from 'react'
import type { Candidate, PlanExclusion, PlanItem } from '../../types'
import { InboxIcon, SectionTitle, button, surface } from '../ui'
import CandidatePicker from './CandidatePicker'
import InboxSection, { inboxSourceSummary, sortSuggestions } from './InboxSection'
import { SourceBadge, daysBetween, dueLabel } from './PlanItemRow'
import { EMPHASIS, SUBSECTION_TITLE } from './todayTokens'

// 계속 제외 기록과 같은 후보를 찾는다. id 가 같거나 Jira 키가 같으면 같은 후보다.
// 이유: task 가 생기면 같은 티켓의 후보 id 가 'jira:KEY' 에서 'task:N' 으로 바뀐다 (부록 M2)
export function candidateOfExclusion(
  exclusion: Pick<PlanExclusion, 'candidate_id' | 'jira_key'>,
  candidates: Candidate[]
): Candidate | null {
  const key = exclusion.jira_key?.toUpperCase() ?? null
  return (
    candidates.find((c) => c.id === exclusion.candidate_id) ??
    (key ? candidates.find((c) => c.jiraKey !== null && c.jiraKey.toUpperCase() === key) : undefined) ??
    null
  )
}

interface CandidatesCardProps {
  items: PlanItem[]
  candidates: Candidate[]
  candidatesLoading: boolean
  candidatesError: string
  exclusions: PlanExclusion[]
  logicalDate: string
  busy: boolean
  readOnly: boolean
  onAccept: (itemId: number) => void
  onDismiss: (itemId: number) => void
  onLoadCandidates: () => void
  onAdd: (candidateId: string) => void
  onRemoveExclusion: (candidateId: string) => void
  // 테스트용 첫 펼침 상태다. 기본은 둘 다 접힘이다
  candidatesOpenInitial?: boolean
  excludedOpenInitial?: boolean
}

interface ExclusionRowProps {
  exclusion: PlanExclusion
  candidate: Candidate | null
  logicalDate: string
  busy: boolean
  readOnly: boolean
  onAdd: (candidateId: string) => void
  onRemoveExclusion: (candidateId: string) => void
}

// 계속 제외한 항목 1개다. 후보를 불러왔으면 그 후보의 마감을 보인다
function ExclusionRow({
  exclusion,
  candidate,
  logicalDate,
  busy,
  readOnly,
  onAdd,
  onRemoveExclusion
}: ExclusionRowProps): React.ReactNode {
  const due = candidate?.dueDate ?? null
  const dueText = dueLabel(due, logicalDate)
  const gap = daysBetween(logicalDate, due)
  const urgent = gap !== null && gap <= 0
  return (
    <li className="flex items-center gap-3 px-5 py-2 border-t border-gray-100">
      <SourceBadge source={exclusion.source} />
      <span className="flex-1 min-w-0 break-words text-sm text-gray-800">{exclusion.title}</span>
      {dueText ? (
        <span
          className={`shrink-0 text-sm tabular-nums ${urgent ? EMPHASIS.urgentText : 'text-gray-500'}`}
        >
          {dueText}
        </span>
      ) : null}
      <button
        type="button"
        disabled={busy || readOnly}
        // 후보 id 가 바뀌었으면 지금 후보 id 로 넣는다
        onClick={() => onAdd(candidate?.id ?? exclusion.candidate_id)}
        className={`shrink-0 px-2.5 py-1 text-sm ${button.primary} disabled:opacity-50`}
      >
        다시 추가
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => onRemoveExclusion(exclusion.candidate_id)}
        className={`shrink-0 px-2.5 py-1 text-sm ${button.subtle} disabled:opacity-50`}
      >
        제외 해제
      </button>
    </li>
  )
}

// 후보 카드다 (부록 M.5.7, M10). 새로 들어온 제안, 후보 더 보기, 계속 제외한 항목을 한 카드에 둔다
export default function CandidatesCard({
  items,
  candidates,
  candidatesLoading,
  candidatesError,
  exclusions,
  logicalDate,
  busy,
  readOnly,
  onAccept,
  onDismiss,
  onLoadCandidates,
  onAdd,
  onRemoveExclusion,
  candidatesOpenInitial = false,
  excludedOpenInitial = false
}: CandidatesCardProps): React.ReactNode {
  const [candidatesOpen, setCandidatesOpen] = useState(candidatesOpenInitial)
  const [excludedOpen, setExcludedOpen] = useState(excludedOpenInitial)
  const suggestions = sortSuggestions(items)

  return (
    <section id="today-inbox" className={`${surface.card} pb-1`}>
      <div className="flex items-center gap-2 px-5 pt-5 pb-3 min-w-0">
        <InboxIcon size={18} className="text-gray-400 shrink-0" />
        <SectionTitle variant="page" className="shrink-0">
          후보
        </SectionTitle>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {suggestions.length > 0 ? (
            <span
              data-suggestion-count=""
              className={`rounded-full px-2 py-0.5 text-sm font-medium tabular-nums ${EMPHASIS.suggestionCount}`}
            >
              제안 {suggestions.length}
            </span>
          ) : null}
          {exclusions.length > 0 ? (
            <span className="text-sm text-gray-500 tabular-nums">제외 {exclusions.length}</span>
          ) : null}
        </div>
      </div>

      {suggestions.length > 0 ? (
        <div data-section="suggestions">
          <div className="flex items-center gap-2 min-w-0">
            <h4 className={`${SUBSECTION_TITLE} shrink-0`}>새로 들어온 제안</h4>
            <span className="ml-auto min-w-0 px-5 pt-4 pb-2 text-sm text-gray-500 tabular-nums break-words">
              {inboxSourceSummary(suggestions)}
            </span>
          </div>
          <InboxSection
            items={items}
            busy={busy}
            readOnly={readOnly}
            onAccept={onAccept}
            onDismiss={onDismiss}
            embedded
          />
        </div>
      ) : null}

      {/* 닫힌 날은 계획에 추가할 수 없다. 그래서 후보 더 보기를 그리지 않는다 */}
      {readOnly ? null : (
        <div data-section="candidates" className="border-t border-gray-100">
          <div className="flex items-center justify-between gap-2 pr-5">
            <h4 className={SUBSECTION_TITLE}>후보 더 보기</h4>
            <button
              type="button"
              aria-expanded={candidatesOpen}
              onClick={() => {
                const next = !candidatesOpen
                setCandidatesOpen(next)
                if (next) onLoadCandidates()
              }}
              className={`mt-2 px-2.5 py-1 text-sm ${button.subtle}`}
            >
              {candidatesOpen ? '접기' : '후보 불러오기'}
            </button>
          </div>
          {candidatesOpen ? (
            <div className="pb-2">
              <CandidatePicker
                candidates={candidates}
                items={items}
                loading={candidatesLoading}
                error={candidatesError}
                busy={busy}
                readOnly={readOnly}
                onLoad={onLoadCandidates}
                onAdd={onAdd}
                embedded
              />
            </div>
          ) : null}
        </div>
      )}

      {exclusions.length > 0 ? (
        <div data-section="excluded" className="border-t border-gray-100">
          <div className="flex items-center justify-between gap-2 pr-5">
            <h4 className={SUBSECTION_TITLE}>계속 제외한 항목 {exclusions.length}건</h4>
            <button
              type="button"
              aria-expanded={excludedOpen}
              onClick={() => setExcludedOpen((o) => !o)}
              className={`mt-2 px-2.5 py-1 text-sm ${button.ghost}`}
            >
              {excludedOpen ? '접기' : '펼치기'}
            </button>
          </div>
          {excludedOpen ? (
            <ul className="pb-2">
              {exclusions.map((e) => (
                <ExclusionRow
                  key={e.candidate_id}
                  exclusion={e}
                  candidate={candidateOfExclusion(e, candidates)}
                  logicalDate={logicalDate}
                  busy={busy}
                  readOnly={readOnly}
                  onAdd={onAdd}
                  onRemoveExclusion={onRemoveExclusion}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
