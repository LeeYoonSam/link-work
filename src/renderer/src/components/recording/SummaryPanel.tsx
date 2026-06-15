import { useState } from 'react'
import { useRecordingStore } from '../../stores/recordingStore'
import type { ActionItem, MeetingSummary } from '../../types'
import { EmptyState, ProgressBar } from '../ui'

interface Props {
  summary: MeetingSummary | null
  meetingId: number
}

export default function SummaryPanel({ summary, meetingId }: Props): React.ReactNode {
  const { processing, summarizeMeeting, actionItemToTodo, refreshCurrent } = useRecordingStore()
  const [summarizing, setSummarizing] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  const isProcessing =
    processing?.meetingId === meetingId &&
    (processing.phase === 'summarize' || processing.phase === 'transcribe' ||
      processing.phase === 'diarize' || processing.phase === 'vad' || processing.phase === 'merge')

  const handleSummarize = async (): Promise<void> => {
    setSummarizing(true)
    setSummaryError(null)
    try {
      await summarizeMeeting(meetingId)
      await refreshCurrent()
    } catch (e) {
      setSummaryError(e instanceof Error ? e.message : '요약 생성 실패')
    } finally {
      setSummarizing(false)
    }
  }

  if (isProcessing) {
    const pct = Math.round((processing?.progress ?? 0) * 100)
    const phaseLabel: Record<string, string> = {
      transcribe: '전사 중',
      diarize: '화자 분리 중',
      vad: 'VAD 처리 중',
      merge: '병합 중',
      summarize: 'AI 요약 생성 중'
    }
    const label = phaseLabel[processing?.phase ?? ''] ?? '처리 중'
    return (
      <div className="space-y-3 py-4">
        <p className="text-sm text-gray-600">{label}</p>
        <ProgressBar percent={pct} color="bg-blue-500" height="h-1.5" />
        {processing?.message && (
          <p className="text-xs text-gray-400">{processing.message}</p>
        )}
      </div>
    )
  }

  if (!summary) {
    return (
      <div className="py-6 space-y-3">
        <EmptyState compact>
          <p className="text-sm text-gray-500 mb-3">
            전사가 완료된 회의의 AI 요약을 생성할 수 있습니다
          </p>
          <button
            type="button"
            onClick={handleSummarize}
            disabled={summarizing}
            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {summarizing ? '요약 생성 중...' : 'AI 요약 생성'}
          </button>
        </EmptyState>
        {summaryError && (
          <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-md">{summaryError}</p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* TL;DR */}
      {summary.tldr && (
        <SummarySection title="TL;DR">
          <p className="text-sm text-gray-700 leading-relaxed">{summary.tldr}</p>
        </SummarySection>
      )}

      {/* 핵심 포인트 */}
      {summary.key_points.length > 0 && (
        <SummarySection title="핵심 포인트">
          <ul className="space-y-1.5">
            {summary.key_points.map((pt, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                {pt}
              </li>
            ))}
          </ul>
        </SummarySection>
      )}

      {/* 결정사항 */}
      {summary.decisions.length > 0 && (
        <SummarySection title="결정사항">
          <ul className="space-y-1.5">
            {summary.decisions.map((d, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                <CheckmarkIcon />
                {d}
              </li>
            ))}
          </ul>
        </SummarySection>
      )}

      {/* 액션아이템 */}
      {summary.action_items.length > 0 && (
        <SummarySection title="액션아이템">
          <ul className="space-y-2">
            {summary.action_items.map((item, i) => (
              <ActionItemRow
                key={i}
                item={item}
                index={i}
                meetingId={meetingId}
                onAdded={refreshCurrent}
                onTodo={async (mid, idx) => { await actionItemToTodo(mid, idx) }}
              />
            ))}
          </ul>
        </SummarySection>
      )}

      {/* 다음 단계 */}
      {summary.next_steps.length > 0 && (
        <SummarySection title="다음 단계">
          <ul className="space-y-1.5">
            {summary.next_steps.map((ns, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                <ArrowIcon />
                {ns}
              </li>
            ))}
          </ul>
        </SummarySection>
      )}

      {/* 재생성 버튼 */}
      <div className="pt-2 border-t border-gray-100 flex items-center justify-between">
        <span className="text-[11px] text-gray-400">
          생성: {formatDate(summary.generated_at)}
          {summary.model && ` · ${summary.model}`}
        </span>
        <button
          type="button"
          onClick={handleSummarize}
          disabled={summarizing}
          className="text-xs text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
        >
          {summarizing ? '재생성 중...' : '다시 생성'}
        </button>
      </div>

      {summaryError && (
        <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-md">{summaryError}</p>
      )}
    </div>
  )
}

function SummarySection({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">{title}</p>
      {children}
    </div>
  )
}

function ActionItemRow({
  item,
  index,
  meetingId,
  onAdded,
  onTodo
}: {
  item: ActionItem
  index: number
  meetingId: number
  onAdded: () => Promise<void>
  onTodo: (meetingId: number, index: number) => Promise<void>
}): React.ReactNode {
  const [adding, setAdding] = useState(false)
  const [added, setAdded] = useState(item.todo_id != null)

  const handleAdd = async (): Promise<void> => {
    setAdding(true)
    try {
      await onTodo(meetingId, index)
      setAdded(true)
      await onAdded()
    } catch {
      // 실패 시 조용히 처리
    } finally {
      setAdding(false)
    }
  }

  return (
    <li className="flex items-start gap-2 group">
      <span className="mt-1 w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-700 leading-snug">{item.text}</p>
        {(item.assignee ?? item.due) && (
          <div className="flex items-center gap-2 mt-0.5">
            {item.assignee && (
              <span className="text-[11px] text-gray-400">{item.assignee}</span>
            )}
            {item.due && (
              <span className="text-[11px] text-gray-400 font-mono">{item.due}</span>
            )}
          </div>
        )}
      </div>
      {added || item.todo_id != null ? (
        <span className="shrink-0 text-[11px] text-green-600 flex items-center gap-0.5 mt-0.5">
          <MiniCheckIcon />
          TODO 추가됨
        </span>
      ) : (
        <button
          type="button"
          onClick={handleAdd}
          disabled={adding}
          className="shrink-0 text-[11px] text-blue-500 hover:text-blue-700 transition-colors disabled:opacity-50 mt-0.5 opacity-0 group-hover:opacity-100"
          title="TODO로 추가"
        >
          {adding ? '추가 중...' : '+ TODO'}
        </button>
      )}
    </li>
  )
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function CheckmarkIcon(): React.ReactNode {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-green-500 mt-0.5 shrink-0"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function ArrowIcon(): React.ReactNode {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-gray-400 mt-0.5 shrink-0"
      aria-hidden
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function MiniCheckIcon(): React.ReactNode {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
