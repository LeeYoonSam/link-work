import { useEffect, useState } from 'react'
import { useMeetingNotesStore } from '../../stores/meetingNotesStore'
import { useProjectStore } from '../../stores/projectStore'
import { useRecordingStore } from '../../stores/recordingStore'
import { EmptyState, button } from '../ui'
import { formatDuration } from './MeetingNoteList'

function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000)
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

// 요약 완료 회의를 읽기 전용 문서로 보여준다. 편집은 녹음 뷰에서 한다.
export default function MeetingNoteDoc(): React.ReactNode {
  const { detail, selectedId, items } = useMeetingNotesStore()
  const projects = useProjectStore((s) => s.projects)
  const [copied, setCopied] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)

  useEffect(() => {
    setShowTranscript(false)
    setCopied(false)
  }, [selectedId])

  if (!detail || detail.meeting.id !== selectedId) {
    return <EmptyState>불러오는 중…</EmptyState>
  }

  const { meeting, summary, speakers, segments, attendees } = detail
  const isInterview = meeting.kind === 'interview'
  const projectName =
    items.find((n) => n.id === meeting.id)?.project_name ??
    projects.find((p) => p.id === meeting.project_id)?.name ??
    null
  const speakerName = (id: number | null): string => {
    const sp = speakers.find((s) => s.id === id)
    return sp ? (sp.display_name ?? sp.label) : '알 수 없음'
  }

  const copyMarkdown = async (): Promise<void> => {
    const md = await window.api.meetingNotes.markdown(meeting.id)
    await navigator.clipboard.writeText(md)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const exportMarkdown = async (): Promise<void> => {
    const md = await window.api.meetingNotes.markdown(meeting.id)
    await window.api.export.saveMarkdown(md, `${meeting.title}.md`)
  }

  const openInRecordings = (): void => {
    useRecordingStore.getState().openMeeting(meeting.id)
    useProjectStore.getState().setView('recordings')
  }

  const meta = [
    meeting.started_at.slice(0, 16),
    formatDuration(meeting.duration_ms),
    attendees.length > 0 ? `참석: ${attendees.map((a) => a.name).join(', ')}` : null,
    projectName
  ].filter(Boolean)

  return (
    <article className="max-w-3xl mx-auto px-8 py-6">
      <div className="flex justify-end gap-1.5 mb-4">
        <button type="button" onClick={copyMarkdown} className={`px-3 py-1.5 text-xs ${button.subtle}`}>
          {copied ? '복사됨' : 'Markdown 복사'}
        </button>
        <button type="button" onClick={exportMarkdown} className={`px-3 py-1.5 text-xs ${button.subtle}`}>
          .md 내보내기
        </button>
        <button type="button" onClick={openInRecordings} className={`px-3 py-1.5 text-xs ${button.subtle}`}>
          녹음에서 열기
        </button>
      </div>

      <h1 className="text-2xl font-bold text-gray-900">{meeting.title}</h1>
      <p className="mt-1 text-xs text-gray-400">{meta.join(' · ')}</p>

      {!summary ? (
        <EmptyState>요약이 없습니다</EmptyState>
      ) : isInterview ? (
        <>
          {summary.tldr && <Section title="면접 개요"><p>{summary.tldr}</p></Section>}
          {summary.qa_pairs.length > 0 && (
            <Section title="질문과 답변">
              <div className="space-y-3">
                {summary.qa_pairs.map((qa, i) => (
                  <div key={i}>
                    <p className="font-medium text-gray-800">Q. {qa.question}</p>
                    <p className="mt-0.5">{qa.answer_summary}</p>
                    {qa.quote && <p className="mt-0.5 text-xs text-gray-500 italic">“{qa.quote}”</p>}
                  </div>
                ))}
              </div>
            </Section>
          )}
          {summary.competencies.length > 0 && (
            <Section title="역량별 근거">
              <div className="space-y-3">
                {summary.competencies.map((c, i) => (
                  <div key={i}>
                    <p className="font-medium text-gray-800">{c.topic}</p>
                    <List items={c.evidence} />
                    {c.note && <p className="mt-0.5 text-xs text-gray-500">{c.note}</p>}
                  </div>
                ))}
              </div>
            </Section>
          )}
          {summary.follow_ups.length > 0 && <Section title="후속 질문"><List items={summary.follow_ups} /></Section>}
          {summary.fact_checks.length > 0 && <Section title="확인 필요"><List items={summary.fact_checks} /></Section>}
        </>
      ) : (
        <>
          {summary.tldr && <Section title="TL;DR"><p>{summary.tldr}</p></Section>}
          {summary.key_points.length > 0 && <Section title="핵심 포인트"><List items={summary.key_points} /></Section>}
          {summary.decisions.length > 0 && <Section title="결정사항"><List items={summary.decisions} /></Section>}
          {summary.action_items.length > 0 && (
            <Section title="액션아이템">
              <ul className="space-y-1">
                {summary.action_items.map((a, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={a.todo_id ? 'text-green-600' : 'text-gray-300'}>
                      {a.todo_id ? '☑' : '☐'}
                    </span>
                    <span>
                      {a.text}
                      {(a.assignee || a.due) && (
                        <span className="ml-1 text-xs text-gray-400">
                          ({[a.assignee, a.due].filter(Boolean).join(' · ')})
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {summary.next_steps.length > 0 && <Section title="다음 단계"><List items={summary.next_steps} /></Section>}
        </>
      )}

      {segments.length > 0 && (
        <section className="mt-8 border-t border-gray-100 pt-4">
          <button
            type="button"
            onClick={() => setShowTranscript((v) => !v)}
            className="text-sm font-semibold text-gray-600 hover:text-gray-800"
          >
            {showTranscript ? '▾' : '▸'} 전사 전문
          </button>
          {showTranscript && (
            <div className="mt-3 space-y-2">
              {segments.map((seg) => (
                <div key={seg.id} className="text-sm">
                  <span className="font-medium text-gray-700">{speakerName(seg.speaker_id)}</span>
                  <span className="ml-1.5 text-[11px] text-gray-400">{formatClock(seg.start_ms)}</span>
                  <p className="text-gray-700">{seg.text}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </article>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactNode {
  return (
    <section className="mt-6">
      <h2 className="text-base font-semibold text-gray-900 mb-2">{title}</h2>
      <div className="text-sm text-gray-700 leading-relaxed">{children}</div>
    </section>
  )
}

function List({ items }: { items: string[] }): React.ReactNode {
  return (
    <ul className="list-disc pl-5 space-y-1">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  )
}
