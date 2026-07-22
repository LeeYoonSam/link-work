import { useEffect, useState } from 'react'
import { useRecordingStore } from '../../stores/recordingStore'
import type { InterviewCompetency, InterviewQaPair, MeetingSummary } from '../../types'
import { EmptyState, ProgressBar } from '../ui'

interface Props {
  summary: MeetingSummary | null
  meetingId: number
  // Q&A 항목 클릭 시 해당 질문 시점으로 오디오 재생 위치를 옮긴다
  onSeek?: (ms: number) => void
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export default function InterviewPanel({ summary, meetingId, onSeek }: Props): React.ReactNode {
  const { processing, summarizeMeeting, refreshCurrent } = useRecordingStore()
  // SummaryPanel과 동일한 규약: 회의 전환 시 언마운트되지 않으므로 boolean이 아닌
  // 대상 id로 진행 상태를 추적해 다른 녹음에 잔상이 남지 않게 한다.
  const [summarizingId, setSummarizingId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const summarizing = summarizingId === meetingId

  useEffect(() => {
    setError(null)
  }, [meetingId])

  const proc = processing[meetingId]
  const isProcessing =
    !!proc &&
    (proc.phase === 'summarize' ||
      proc.phase === 'transcribe' ||
      proc.phase === 'diarize' ||
      proc.phase === 'vad' ||
      proc.phase === 'merge')

  const handleSummarize = async (): Promise<void> => {
    const targetId = meetingId
    setSummarizingId(targetId)
    setError(null)
    try {
      await summarizeMeeting(targetId)
      await refreshCurrent()
    } catch (e) {
      setError(e instanceof Error ? e.message : '면접 기록 정리 실패')
    } finally {
      setSummarizingId((prev) => (prev === targetId ? null : prev))
    }
  }

  if (isProcessing) {
    const pct = Math.round((proc?.progress ?? 0) * 100)
    const phaseLabel: Record<string, string> = {
      transcribe: '전사 중',
      diarize: '화자 분리 중',
      vad: 'VAD 처리 중',
      merge: '병합 중',
      summarize: '면접 기록 정리 중'
    }
    return (
      <div className="space-y-3 py-4">
        <p className="text-sm text-gray-600">{phaseLabel[proc?.phase ?? ''] ?? '처리 중'}</p>
        <ProgressBar percent={pct} color="bg-blue-500" height="h-1.5" />
        {proc?.message && <p className="text-xs text-gray-400">{proc.message}</p>}
      </div>
    )
  }

  const hasContent =
    !!summary &&
    (!!summary.tldr ||
      summary.qa_pairs.length > 0 ||
      summary.competencies.length > 0 ||
      summary.follow_ups.length > 0 ||
      summary.fact_checks.length > 0)

  if (!hasContent) {
    return (
      <div className="py-6 space-y-3">
        <EmptyState compact>
          <p className="text-sm text-gray-500 mb-3">
            전사가 완료된 면접의 질문·답변 기록을 정리할 수 있습니다
          </p>
          <button
            type="button"
            onClick={handleSummarize}
            disabled={summarizing}
            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {summarizing ? '정리 중...' : '면접 기록 정리'}
          </button>
        </EmptyState>
        {error && <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-md">{error}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* 개요 */}
      {summary.tldr && (
        <Section title="면접 개요">
          <p className="text-sm text-gray-700 leading-relaxed">{summary.tldr}</p>
        </Section>
      )}

      {/* 질문 · 답변 */}
      {summary.qa_pairs.length > 0 && (
        <Section title={`질문 · 답변 (${summary.qa_pairs.length})`}>
          <ol className="space-y-3">
            {summary.qa_pairs.map((qa, i) => (
              <QaRow key={i} qa={qa} index={i} onSeek={onSeek} />
            ))}
          </ol>
        </Section>
      )}

      {/* 주제별 발언 근거 */}
      {summary.competencies.length > 0 && (
        <Section title="주제별 발언 근거">
          <div className="space-y-3">
            {summary.competencies.map((c, i) => (
              <CompetencyCard key={i} item={c} />
            ))}
          </div>
        </Section>
      )}

      {/* 추가 확인 필요 */}
      {summary.follow_ups.length > 0 && (
        <Section title="추가 확인이 필요한 지점">
          <ul className="space-y-1.5">
            {summary.follow_ups.map((f, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                <QuestionIcon />
                {f}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 사실 확인 필요 */}
      {summary.fact_checks.length > 0 && (
        <Section title="레퍼런스 체크 항목">
          <ul className="space-y-1.5">
            {summary.fact_checks.map((f, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                {f}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 판정 도구가 아님을 화면에서도 명시 */}
      <p className="text-[11px] text-gray-400 bg-gray-50 border border-gray-100 rounded-md px-3 py-2 leading-relaxed">
        이 기록은 답변 확인용 보조 자료입니다. AI가 정리한 내용에는 전사 오류가 섞일 수 있으니,
        판단 전에 해당 구간을 직접 들어 확인하세요.
      </p>

      <div className="pt-2 border-t border-gray-100">
        <span className="text-[11px] text-gray-400">
          생성: {formatDate(summary.generated_at)}
          {summary.model && ` · ${summary.model}`}
        </span>
      </div>

      {error && <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-md">{error}</p>}
    </div>
  )
}

function Section({
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

function QaRow({
  qa,
  index,
  onSeek
}: {
  qa: InterviewQaPair
  index: number
  onSeek?: (ms: number) => void
}): React.ReactNode {
  const seekable = qa.start_ms != null && !!onSeek

  return (
    <li className="border border-gray-100 rounded-lg p-3 bg-white space-y-1.5">
      <div className="flex items-start gap-2">
        <span className="text-[11px] font-mono text-gray-300 mt-0.5 shrink-0">
          Q{index + 1}
        </span>
        <p className="flex-1 text-sm font-medium text-gray-800 leading-snug">{qa.question}</p>
        {seekable && (
          <button
            type="button"
            onClick={() => onSeek?.(qa.start_ms as number)}
            title="이 질문 시점부터 듣기"
            className="shrink-0 flex items-center gap-1 text-[11px] font-mono text-blue-500 hover:text-blue-700 transition-colors"
          >
            <PlayIcon />
            {formatTime(qa.start_ms as number)}
          </button>
        )}
      </div>

      {qa.answer_summary && (
        <p className="text-sm text-gray-600 leading-relaxed pl-7">{qa.answer_summary}</p>
      )}

      {qa.quote && (
        <blockquote className="ml-7 border-l-2 border-gray-200 pl-2.5 text-[13px] text-gray-500 italic leading-relaxed">
          “{qa.quote}”
        </blockquote>
      )}
    </li>
  )
}

function CompetencyCard({ item }: { item: InterviewCompetency }): React.ReactNode {
  return (
    <div className="border border-gray-100 rounded-lg p-3 bg-white space-y-1.5">
      <p className="text-sm font-medium text-gray-800">{item.topic}</p>
      {item.evidence.length > 0 && (
        <ul className="space-y-1">
          {item.evidence.map((e, i) => (
            <li
              key={i}
              className="border-l-2 border-blue-200 pl-2.5 text-[13px] text-gray-600 leading-relaxed"
            >
              {e}
            </li>
          ))}
        </ul>
      )}
      {item.note && <p className="text-[11px] text-gray-400">{item.note}</p>}
    </div>
  )
}

function PlayIcon(): React.ReactNode {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <polygon points="6 4 20 12 6 20" />
    </svg>
  )
}

function QuestionIcon(): React.ReactNode {
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
      className="text-blue-400 mt-0.5 shrink-0"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}
