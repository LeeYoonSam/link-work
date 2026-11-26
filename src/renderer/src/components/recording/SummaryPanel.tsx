import { useEffect, useMemo, useState } from 'react'
import { useRecordingStore } from '../../stores/recordingStore'
import { useMeetingNotesStore } from '../../stores/meetingNotesStore'
import { useNavigationStore } from '../../stores/navigationStore'
import type {
  ActionItem,
  MeetingMark,
  MeetingSummary,
  MeetingTemplateId,
  SummaryTemplateOption,
  SummaryTextItem,
  SummaryTopic
} from '../../types'
import { assignMarksToTopics } from '../../utils/assignMarksToTopics'
import { Badge, EmptyState, ProgressBar } from '../ui'
import { taskTag } from '../ui/tokens'

interface Props {
  summary: MeetingSummary | null
  meetingId: number
  // 시각 버튼을 누르면 그 시점부터 재생한다. 없으면 시각 버튼을 그리지 않는다.
  onSeek?: (ms: number) => void
  // 현재 재생 위치(ms). 요약 화면에서 메모를 더할 때 그 시각에 붙인다.
  currentMs?: number
}

// main 목록을 읽기 전·실패 시 쓰는 형식 이름(main services/meeting-templates.ts와 같은 이름)
const FALLBACK_TEMPLATES: SummaryTemplateOption[] = [
  { id: 'default', name: '기본' },
  { id: 'one_on_one', name: '1:1' },
  { id: 'standup', name: '스탠드업' },
  { id: 'review', name: '리뷰·회고' }
]

// 드롭다운에서 '자동'(null)을 나타내는 값
const AUTO_VALUE = ''

// 메모 시각 표기 [mm:ss] (녹음 화면과 같은 표기)
function formatMarkTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const sec = totalSec % 60
  const mmss = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return h > 0 ? `${h}:${mmss}` : mmss
}

// 형식 배지 접미사 — 형식을 누가 정했는지(manual=사용자 고정, title=제목 규칙, auto=모델 판단)
export function templateSourceSuffix(source: MeetingSummary['template_source']): string {
  if (source === 'auto') return ' · 자동'
  if (source === 'title') return ' · 제목 기준'
  if (source === 'manual') return ' · 직접 선택'
  return ''
}

// 시각 버튼용 m:ss 표기
function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function SummaryPanel({
  summary,
  meetingId,
  onSeek,
  currentMs
}: Props): React.ReactNode {
  const {
    current,
    processing,
    summarizeMeeting,
    actionItemToTodo,
    refreshCurrent,
    setSummaryTemplate,
    addMark,
    updateMark,
    deleteMark
  } = useRecordingStore()
  // 이 회의의 상세가 열려 있을 때만 형식·메모를 읽는다
  const detail = current?.meeting.id === meetingId ? current : null
  const meetingTemplate: MeetingTemplateId | null = detail?.meeting.summary_template ?? null
  const marks = useMemo<MeetingMark[]>(
    () => [...(detail?.marks ?? [])].sort((a, b) => a.at_ms - b.at_ms || a.id - b.id),
    [detail?.marks]
  )
  const hasMarks = marks.length > 0
  const [templateOptions, setTemplateOptions] = useState<SummaryTemplateOption[]>(FALLBACK_TEMPLATES)
  // 형식 변경 확인창에 띄울 새 형식(undefined=닫힘, null=자동)
  const [pendingTemplate, setPendingTemplate] = useState<MeetingTemplateId | null | undefined>(
    undefined
  )
  // 메모를 더하거나 고친 뒤 아직 요약에 반영하지 않았는지(자동 재생성은 하지 않는다)
  const [marksDirty, setMarksDirty] = useState(false)
  const [addingMark, setAddingMark] = useState(false)
  const [newMarkText, setNewMarkText] = useState('')
  const [markError, setMarkError] = useState<string | null>(null)
  // 요약 재생성은 회의별로 독립 실행된다. SummaryPanel은 회의 전환 시 언마운트되지 않고
  // 재사용되므로, boolean 대신 트리거된 회의 id로 추적해 다른 회의에 "재생성 중…" 잔상이
  // 남지 않게 한다.
  const [summarizingId, setSummarizingId] = useState<number | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const summarizing = summarizingId === meetingId

  // 회의를 전환하면 이전 회의의 에러 메시지와 '복사됨' 표시가 남지 않도록 초기화한다.
  useEffect(() => {
    setSummaryError(null)
    setCopied(false)
    setMarksDirty(false)
    setAddingMark(false)
    setNewMarkText('')
    setMarkError(null)
    setPendingTemplate(undefined)
  }, [meetingId])

  // 형식 이름은 main 목록에서 읽는다. 실패하면 고정 목록 그대로.
  useEffect(() => {
    let alive = true
    window.api.recording
      .listSummaryTemplates()
      .then((list) => {
        if (alive && list.length > 0) setTemplateOptions(list)
      })
      .catch((e) => console.warn('[SummaryPanel] 요약 형식 목록 실패', e))
    return () => {
      alive = false
    }
  }, [])

  const templateName = (id: MeetingTemplateId | null | undefined): string =>
    templateOptions.find((t) => t.id === (id ?? 'default'))?.name ??
    FALLBACK_TEMPLATES.find((t) => t.id === (id ?? 'default'))?.name ??
    '기본'

  // 회의록 메뉴의 'Markdown 복사'와 같은 Markdown을 복사한다.
  const handleCopy = async (): Promise<void> => {
    try {
      const md = await window.api.meetingNotes.markdown(meetingId)
      await navigator.clipboard.writeText(md)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      console.warn('[SummaryPanel] 회의 내용 복사 실패', e)
    }
  }

  const proc = processing[meetingId]
  const isProcessing =
    !!proc &&
    (proc.phase === 'summarize' || proc.phase === 'transcribe' ||
      proc.phase === 'diarize' || proc.phase === 'vad' || proc.phase === 'merge')

  const handleSummarize = async (): Promise<void> => {
    const targetId = meetingId
    setSummarizingId(targetId)
    setSummaryError(null)
    try {
      await summarizeMeeting(targetId)
      await refreshCurrent()
      setMarksDirty(false)
    } catch (e) {
      setSummaryError(e instanceof Error ? e.message : '요약 생성 실패')
    } finally {
      setSummarizingId((prev) => (prev === targetId ? null : prev))
    }
  }

  // 형식 변경 확인 → 형식 저장 → 다시 요약
  const handleConfirmTemplate = async (): Promise<void> => {
    if (pendingTemplate === undefined) return
    const next = pendingTemplate
    setPendingTemplate(undefined)
    const ok = await setSummaryTemplate(meetingId, next)
    if (!ok) {
      setSummaryError('요약 형식을 바꾸지 못했습니다.')
      return
    }
    await handleSummarize()
  }

  const handleAddMark = async (): Promise<void> => {
    const text = newMarkText.trim()
    if (!text) return
    const id = await addMark({ meetingId, raw_ms: currentMs ?? 0, text, origin: 'post' })
    if (id == null) {
      setMarkError('메모를 저장하지 못했습니다.')
      return
    }
    setMarkError(null)
    setNewMarkText('')
    setAddingMark(false)
    setMarksDirty(true)
  }

  const handleUpdateMark = async (id: number, text: string): Promise<boolean> => {
    const ok = await updateMark({ id, text })
    setMarkError(ok ? null : '메모를 저장하지 못했습니다.')
    if (ok) setMarksDirty(true)
    return ok
  }

  const handleDeleteMark = async (id: number): Promise<void> => {
    const ok = await deleteMark(id)
    setMarkError(ok ? null : '메모를 지우지 못했습니다.')
    if (ok) setMarksDirty(true)
  }

  if (isProcessing) {
    const pct = Math.round((proc?.progress ?? 0) * 100)
    const phaseLabel: Record<string, string> = {
      transcribe: '전사 중',
      diarize: '화자 분리 중',
      vad: 'VAD 처리 중',
      merge: '병합 중',
      summarize: 'AI 요약 생성 중'
    }
    const label = phaseLabel[proc?.phase ?? ''] ?? '처리 중'
    return (
      <div className="space-y-3 py-4">
        <p className="text-sm text-gray-600">{label}</p>
        <ProgressBar percent={pct} color="bg-blue-500" height="h-1.5" />
        {proc?.message && (
          <p className="text-xs text-gray-400">{proc.message}</p>
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

  const { byTopic } = assignMarksToTopics(summary.topics, marks)

  return (
    <div className="space-y-5">
      {/* 요약 형식 · 형식 바꿔 다시 요약 · 메모 반영 */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge color="bg-gray-100 text-gray-600" size="xs">
          형식: {templateName(summary.template_id)}
          {templateSourceSuffix(summary.template_source)}
        </Badge>
        {summary.template_reason && summary.template_source === 'auto' && (
          <span className="text-[11px] text-gray-400">자동 선택 이유: {summary.template_reason}</span>
        )}
        {summary.template_reason && summary.template_source === 'title' && (
          <span className="text-[11px] text-gray-400">제목 기준: {summary.template_reason}</span>
        )}
        <label className="flex items-center gap-1 text-[11px] text-gray-400">
          <span>형식 바꿔 다시 요약</span>
          <select
            value={meetingTemplate ?? AUTO_VALUE}
            onChange={(e) =>
              setPendingTemplate(
                e.target.value === AUTO_VALUE ? null : (e.target.value as MeetingTemplateId)
              )
            }
            disabled={summarizing}
            className="text-[11px] text-gray-600 border border-gray-200 rounded px-1 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50"
          >
            <option value={AUTO_VALUE}>자동(내용으로 판단)</option>
            {templateOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {marksDirty && (
          <button
            type="button"
            onClick={() => void handleSummarize()}
            disabled={summarizing}
            className="px-2 py-0.5 text-[11px] font-medium rounded-md bg-amber-100 text-amber-800 hover:bg-amber-200 transition-colors disabled:opacity-50"
          >
            {summarizing ? '요약 중…' : '메모를 반영해 다시 요약'}
          </button>
        )}
        {hasMarks && (
          <span className="ml-auto text-[10px] text-gray-400">
            <span className="text-amber-400">▌</span>내 메모 · AI 요약
          </span>
        )}
      </div>

      {/* 키워드 (표시 전용) */}
      {summary.keywords.length > 0 && (
        <SummarySection title="키워드">
          <div className="flex flex-wrap gap-1.5">
            {summary.keywords.map((k, i) => (
              <Badge key={i} color={taskTag.domain} size="xs">{k}</Badge>
            ))}
          </div>
        </SummarySection>
      )}

      {/* 내 메모 — 사용자가 직접 남긴 원문. AI 요약과 구분되게 왼쪽 강조선을 둔다 */}
      {hasMarks && (
        <SummarySection title="내 메모">
          <ul className="space-y-1">
            {marks.map((m) => (
              <MarkRow
                key={m.id}
                mark={m}
                onSeek={onSeek}
                onSave={(text) => handleUpdateMark(m.id, text)}
                onDelete={() => void handleDeleteMark(m.id)}
              />
            ))}
          </ul>
          {addingMark ? (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={newMarkText}
                onChange={(e) => setNewMarkText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleAddMark()
                  } else if (e.key === 'Escape') {
                    setAddingMark(false)
                    setNewMarkText('')
                  }
                }}
                autoFocus
                maxLength={500}
                placeholder={`[${formatMarkTime(currentMs ?? 0)}] 메모 입력 후 Enter`}
                className="flex-1 min-w-0 text-sm px-2 py-1 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingMark(true)}
              className="text-[11px] text-blue-500 hover:text-blue-700 transition-colors"
            >
              + 메모 추가
            </button>
          )}
          {markError && <p className="text-[11px] text-red-500">{markError}</p>}
        </SummarySection>
      )}

      {/* TL;DR */}
      {summary.tldr && (
        <SummarySection title="TL;DR">
          <p className="text-sm text-gray-700 leading-relaxed">{summary.tldr}</p>
        </SummarySection>
      )}

      {/* 핵심 포인트 (구버전 요약에만 값이 있다) */}
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
              <TextItemRow key={i} item={d} icon={<CheckmarkIcon />} onSeek={onSeek} />
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
                onSeek={onSeek}
              />
            ))}
          </ul>
        </SummarySection>
      )}

      {/* 미결 질문 */}
      {summary.open_questions.length > 0 && (
        <SummarySection title="미결 질문">
          <ul className="space-y-1.5">
            {summary.open_questions.map((q, i) => (
              <TextItemRow key={i} item={q} icon={<QuestionIcon />} onSeek={onSeek} />
            ))}
          </ul>
        </SummarySection>
      )}

      {/* 다음 단계 (구버전 요약에만 값이 있다) */}
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

      {/* 주제별 요약 */}
      {summary.topics.length > 0 && (
        <SummarySection title="주제별 요약">
          <ol className="space-y-3">
            {summary.topics.map((t, i) => (
              <TopicRow
                key={i}
                topic={t}
                index={i}
                onSeek={onSeek}
                marks={byTopic.get(i) ?? []}
                showAiTag={hasMarks}
              />
            ))}
          </ol>
        </SummarySection>
      )}

      {/* 생성 정보 (요약 재생성은 상단 ↻ 메뉴에서) */}
      <div className="pt-2 border-t border-gray-100 flex items-center justify-between gap-2">
        <span className="text-[11px] text-gray-400">
          생성: {formatDate(summary.generated_at)}
          {summary.model && ` · ${summary.model}`}
        </span>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleCopy}
            className="text-[11px] font-medium text-blue-600 hover:text-blue-700"
          >
            {copied ? '복사됨' : '내용 복사'}
          </button>
          <button
            type="button"
            onClick={() => {
              useMeetingNotesStore.getState().select(meetingId)
              useNavigationStore.getState().setView('notes')
            }}
            className="text-[11px] font-medium text-blue-600 hover:text-blue-700"
          >
            회의록으로 보기
          </button>
        </div>
      </div>

      {summaryError && (
        <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-md">{summaryError}</p>
      )}

      {/* 요약 형식 변경 확인 */}
      {pendingTemplate !== undefined && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setPendingTemplate(undefined)}
        >
          <div
            className="bg-white rounded-xl shadow-xl p-6 w-80 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold text-gray-800">요약 형식 변경</p>
            <p className="text-sm text-gray-600">
              현재 요약을 덮어씁니다. 할 일로 옮긴 항목은 같은 문장이면 연결을 유지합니다.{' '}
              {pendingTemplate === null
                ? '내용으로 형식을 다시 고릅니다.'
                : '이 회의는 그 형식으로 고정됩니다.'}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setPendingTemplate(undefined)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmTemplate()}
                className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
              >
                다시 요약
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// 내 메모 한 줄 — [mm:ss] 시각, 원문(북마크는 칩), 인라인 수정(Enter 저장·Esc 취소)·삭제
function MarkRow({
  mark,
  onSeek,
  onSave,
  onDelete
}: {
  mark: MeetingMark
  onSeek?: (ms: number) => void
  onSave: (text: string) => Promise<boolean>
  onDelete: () => void
}): React.ReactNode {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(mark.text)

  const save = async (): Promise<void> => {
    const text = draft.trim()
    if (text === mark.text) {
      setEditing(false)
      return
    }
    if (await onSave(text)) setEditing(false)
  }

  return (
    <li className="group flex items-start gap-2 border-l-2 border-amber-400 pl-2 text-sm">
      <MarkTime ms={mark.at_ms} onSeek={onSeek} />
      {editing ? (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') {
              e.preventDefault()
              void save()
            } else if (e.key === 'Escape') {
              setDraft(mark.text)
              setEditing(false)
            }
          }}
          autoFocus
          maxLength={500}
          placeholder="비우면 북마크"
          className="flex-1 min-w-0 text-sm px-1.5 py-0.5 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
      ) : (
        <span className="flex-1 min-w-0 leading-snug">
          {mark.text === '' ? (
            <Badge color="bg-amber-50 text-amber-700" size="xs">
              북마크
            </Badge>
          ) : (
            mark.text
          )}
        </span>
      )}
      {!editing && (
        <span className="shrink-0 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={() => {
              setDraft(mark.text)
              setEditing(true)
            }}
            className="text-[11px] text-gray-400 hover:text-gray-600"
          >
            수정
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="text-[11px] text-gray-400 hover:text-red-500"
          >
            삭제
          </button>
        </span>
      )}
    </li>
  )
}

// 메모 시각 [mm:ss]. onSeek가 있으면 그 시점으로 이동하는 버튼
function MarkTime({ ms, onSeek }: { ms: number; onSeek?: (ms: number) => void }): React.ReactNode {
  const label = `[${formatMarkTime(ms)}]`
  if (!onSeek) {
    return <span className="shrink-0 text-[11px] font-mono text-gray-400 mt-0.5">{label}</span>
  }
  return (
    <button
      type="button"
      onClick={() => onSeek(ms)}
      title="메모 시점부터 듣기"
      className="shrink-0 text-[11px] font-mono text-blue-500 hover:text-blue-700 transition-colors mt-0.5"
    >
      {label}
    </button>
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
  onTodo,
  onSeek
}: {
  item: ActionItem
  index: number
  meetingId: number
  onAdded: () => Promise<void>
  onTodo: (meetingId: number, index: number) => Promise<void>
  onSeek?: (ms: number) => void
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
        {(item.assignee || item.due || (item.at_ms != null && onSeek)) && (
          <div className="flex items-center gap-2 mt-0.5">
            {item.assignee && (
              <span className="text-[11px] text-gray-400">{item.assignee}</span>
            )}
            {item.due && (
              <span className="text-[11px] text-gray-400 font-mono">{item.due}</span>
            )}
            <SeekButton ms={item.at_ms} onSeek={onSeek} />
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

// 시각 버튼: 시각이 있고 onSeek가 주어졌을 때만 그린다.
function SeekButton({
  ms,
  onSeek
}: {
  ms: number | null | undefined
  onSeek?: (ms: number) => void
}): React.ReactNode {
  if (ms == null || !onSeek) return null
  return (
    <button
      type="button"
      onClick={() => onSeek(ms)}
      title="이 시점부터 듣기"
      className="shrink-0 flex items-center gap-1 text-[11px] font-mono text-blue-500 hover:text-blue-700 transition-colors"
    >
      <PlayIcon />
      {formatTime(ms)}
    </button>
  )
}

function TextItemRow({
  item,
  icon,
  onSeek
}: {
  item: SummaryTextItem
  icon: React.ReactNode
  onSeek?: (ms: number) => void
}): React.ReactNode {
  return (
    <li className="flex items-start gap-2 text-sm text-gray-700">
      {icon}
      <span className="flex-1 min-w-0">{item.text}</span>
      <SeekButton ms={item.at_ms} onSeek={onSeek} />
    </li>
  )
}

function TopicRow({
  topic,
  index,
  onSeek,
  marks,
  showAiTag
}: {
  topic: SummaryTopic
  index: number
  onSeek?: (ms: number) => void
  // 이 주제 구간에 배정된 내 메모
  marks: MeetingMark[]
  // 메모가 있는 회의에서만 AI 요약 줄에 'AI' 표식을 단다
  showAiTag: boolean
}): React.ReactNode {
  return (
    <li className="space-y-1">
      <div className="flex items-start gap-2">
        <span className="text-[11px] font-mono text-gray-300 mt-0.5 shrink-0">{index + 1}</span>
        <p className="flex-1 text-sm font-medium text-gray-800 leading-snug">{topic.title}</p>
        <SeekButton ms={topic.start_ms} onSeek={onSeek} />
      </div>
      {topic.points.length > 0 && (
        <ul className="space-y-1 pl-5">
          {topic.points.map((pt, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-gray-600">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-gray-300 shrink-0" />
              <span className="flex-1 min-w-0">{pt}</span>
              {showAiTag && <span className="shrink-0 mt-0.5 text-[9px] text-gray-300">AI</span>}
            </li>
          ))}
        </ul>
      )}
      {marks.length > 0 && (
        <ul className="space-y-1 pl-5">
          {marks.map((m) => (
            <li
              key={m.id}
              className="flex items-start gap-2 border-l-2 border-amber-400 pl-2 text-sm text-gray-800"
            >
              <MarkTime ms={m.at_ms} onSeek={onSeek} />
              <span className="flex-1 min-w-0 leading-snug">
                {m.text === '' ? (
                  <Badge color="bg-amber-50 text-amber-700" size="xs">
                    북마크
                  </Badge>
                ) : (
                  m.text
                )}
              </span>
            </li>
          ))}
        </ul>
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
      className="text-amber-500 mt-0.5 shrink-0"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
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
