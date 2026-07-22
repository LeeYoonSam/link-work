import { useCallback, useEffect, useRef, useState } from 'react'
import { useRecordingStore } from '../../stores/recordingStore'
import { useProjectStore } from '../../stores/projectStore'
import type { MeetingStatus } from '../../types'
import { Badge, IconButton, ProgressBar, TrashIcon, PencilIcon, XIcon, LinkIcon, UndoIcon } from '../ui'
import AudioPlayer from './AudioPlayer'
import SpeakerTimeline from './SpeakerTimeline'
import SummaryPanel from './SummaryPanel'
import InterviewPanel from './InterviewPanel'
import SpeakerEditor from './SpeakerEditor'
import type { AudioPlayerHandle } from './AudioPlayer'

type Tab = 'timeline' | 'summary' | 'speakers'

const STATUS_STYLES: Record<MeetingStatus, { badge: string; label: string }> = {
  recording: { badge: 'bg-red-100 text-red-700', label: '녹음 중' },
  processing: { badge: 'bg-yellow-100 text-yellow-700', label: '처리 중' },
  transcribed: { badge: 'bg-blue-100 text-blue-700', label: '전사 완료' },
  summarized: { badge: 'bg-green-100 text-green-700', label: '요약 완료' },
  failed: { badge: 'bg-gray-100 text-gray-500', label: '실패' }
}

function formatDuration(ms: number): string {
  if (!ms) return ''
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}시간 ${m}분 ${s}초`
  if (m > 0) return `${m}분 ${s}초`
  return `${s}초`
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

interface Props {
  onClose: () => void
}

export default function MeetingDetailView({ onClose }: Props): React.ReactNode {
  const {
    current,
    processing,
    renameMeeting,
    removeMeeting,
    linkProject,
    reprocessMeeting,
    summarizeMeeting,
    setExpectedSpeakers,
    refreshCurrent
  } = useRecordingStore()
  const { projects, fetchProjects } = useProjectStore()

  const [tab, setTab] = useState<Tab>('timeline')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleValue, setTitleValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [linkingProject, setLinkingProject] = useState(false)
  // 재처리/재분리는 회의별로 독립 실행되므로, 어느 회의에 대해 트리거됐는지 id로 추적한다.
  // (MeetingDetailView는 회의 전환 시 언마운트되지 않고 재사용되므로 boolean을 쓰면
  //  다른 회의 버튼에도 "처리 중…" 잔상이 남는다.)
  const [reprocessingId, setReprocessingId] = useState<number | null>(null)
  const [showReprocessMenu, setShowReprocessMenu] = useState(false)
  const [speakerCount, setSpeakerCount] = useState('')
  // 현재 재생 위치(ms) — AudioPlayer가 보고하고 SpeakerTimeline 하이라이트/싱크에 사용
  const [currentMs, setCurrentMs] = useState(0)

  const audioRef = useRef<AudioPlayerHandle>(null)

  // 타임라인 → 프로그레스바 시킹. ref가 안정적이라 빈 deps로 고정해 SegmentRow memo를 유지한다.
  const handleSeek = useCallback((ms: number) => audioRef.current?.seekTo(ms), [])

  const meeting = current?.meeting
  const speakers = current?.speakers ?? []
  const segments = current?.segments ?? []
  const cuts = current?.cuts ?? []
  const summary = current?.summary ?? null

  // 제목 편집 초기화
  useEffect(() => {
    if (meeting) {
      setTitleValue(meeting.title)
      setEditingTitle(false)
      setConfirmDelete(false)
      setCurrentMs(0)
    }
  }, [meeting?.id])

  // 탭 자동 전환: 상태에 따라
  useEffect(() => {
    if (!meeting) return
    if (meeting.status === 'summarized' && summary) {
      setTab('summary')
    } else if (segments.length > 0) {
      setTab('timeline')
    }
  }, [meeting?.id, meeting?.status])

  // 프로젝트 목록 로드 (연결 드롭다운용)
  useEffect(() => {
    void fetchProjects()
  }, [])

  // 참석 인원 입력값을 현재 회의 값으로 동기화
  useEffect(() => {
    setSpeakerCount(meeting?.expected_speakers ? String(meeting.expected_speakers) : '')
  }, [meeting?.id, meeting?.expected_speakers])

  if (!meeting) return null

  const statusStyle = STATUS_STYLES[meeting.status] ?? STATUS_STYLES.failed
  // 현재 보고 있는 회의가 재처리 트리거 대상일 때만 버튼을 "처리 중"으로 표시한다.
  const reprocessing = reprocessingId === meeting.id
  const proc = processing[meeting.id]
  const isProcessing =
    !!proc && proc.phase !== 'done' && proc.phase !== 'error'
  const processingPct = Math.round((proc?.progress ?? 0) * 100)

  const phaseLabel: Record<string, string> = {
    transcribe: '전사 중',
    diarize: '화자 분리 중',
    vad: 'VAD 처리 중',
    merge: '병합 중',
    summarize: 'AI 요약 생성 중'
  }

  const handleTitleSave = async (): Promise<void> => {
    setEditingTitle(false)
    const trimmed = titleValue.trim()
    if (!trimmed || trimmed === meeting.title) return
    await renameMeeting(meeting.id, trimmed)
    await refreshCurrent()
  }

  const handleDelete = async (): Promise<void> => {
    setDeleting(true)
    try {
      await removeMeeting(meeting.id)
      onClose()
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const handleLinkProject = async (projectId: number | null): Promise<void> => {
    setLinkingProject(true)
    try {
      await linkProject(meeting.id, projectId)
    } finally {
      setLinkingProject(false)
    }
  }

  const handleReprocess = async (fast: boolean): Promise<void> => {
    const targetId = meeting.id
    setReprocessingId(targetId)
    try {
      await reprocessMeeting(targetId, fast)
    } finally {
      setReprocessingId((prev) => (prev === targetId ? null : prev))
    }
  }

  // 참석 인원을 저장하고 그 수로 화자를 다시 분리(재전사 없이 빠른 재적용)
  const handleReprocessWithSpeakers = async (): Promise<void> => {
    const parsed = speakerCount.trim() === '' ? null : parseInt(speakerCount, 10)
    const n = parsed && parsed > 0 ? parsed : null
    const targetId = meeting.id
    setReprocessingId(targetId)
    try {
      await setExpectedSpeakers(targetId, n)
      await reprocessMeeting(targetId, true)
    } finally {
      setReprocessingId((prev) => (prev === targetId ? null : prev))
    }
  }

  // AI 요약만 다시 생성 (전사 재사용)
  const handleSummarizeFromMenu = async (): Promise<void> => {
    const targetId = meeting.id
    setReprocessingId(targetId)
    try {
      await summarizeMeeting(targetId)
    } finally {
      setReprocessingId((prev) => (prev === targetId ? null : prev))
    }
  }

  // 재처리/재생성 진행 중 여부 (메뉴 항목 비활성화에 사용)
  const busy = reprocessing || isProcessing

  // 면접 녹음은 요약 스키마와 상세 패널이 다르다 (meetings.kind)
  const isInterview = meeting.kind === 'interview'
  const kindNoun = isInterview ? '면접' : '회의'

  const TABS: { id: Tab; label: string }[] = [
    { id: 'timeline', label: `타임라인 (${segments.length})` },
    { id: 'summary', label: isInterview ? '면접 기록' : '요약' },
    { id: 'speakers', label: `화자 (${speakers.length})` }
  ]

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 헤더 */}
      <div className="px-5 pt-4 pb-3 bg-white border-b border-gray-200 shrink-0">
        <div className="flex items-start gap-2 mb-2">
          {/* 제목 인라인 편집 */}
          {editingTitle ? (
            <input
              type="text"
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleTitleSave()
                if (e.key === 'Escape') {
                  setTitleValue(meeting.title)
                  setEditingTitle(false)
                }
              }}
              autoFocus
              className="flex-1 text-base font-semibold text-gray-900 border-b-2 border-blue-400 focus:outline-none bg-transparent pb-0.5"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              className="flex-1 text-left text-base font-semibold text-gray-900 hover:text-gray-700 transition-colors leading-snug"
              title="클릭하여 제목 편집"
            >
              {meeting.title}
            </button>
          )}

          <div className="flex items-center gap-0.5 shrink-0">
            {/* 재생성 메뉴: 화자 재분리 / 요약 재생성 / 전체 재처리 / 빠른 재적용 통합 */}
            {meeting.status !== 'recording' && meeting.audio_path && (
              <div className="relative">
                <IconButton
                  title="다시 처리 · 재생성"
                  onClick={() => setShowReprocessMenu((v) => !v)}
                  tone="primary"
                  active={showReprocessMenu}
                >
                  <span className={busy ? 'inline-block animate-spin' : ''}>
                    <UndoIcon size={14} />
                  </span>
                </IconButton>
                {showReprocessMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-20"
                      onClick={() => setShowReprocessMenu(false)}
                    />
                    <div className="absolute z-30 right-0 top-8 w-64 bg-white border border-gray-200 rounded-xl shadow-lg py-1.5">
                      {/* 화자 다시 분리 (참석 인원) */}
                      <div className="px-3 py-2 border-b border-gray-100">
                        <p className="text-[11px] font-medium text-gray-500 mb-1.5">화자 다시 분리</p>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min={1}
                            max={20}
                            value={speakerCount}
                            onChange={(e) => setSpeakerCount(e.target.value)}
                            placeholder="자동"
                            disabled={busy}
                            title="참석 인원을 지정하면 그 수만큼 화자를 분리합니다 (비우면 자동 추정)"
                            className="w-14 text-xs px-1.5 py-1 border border-gray-200 rounded text-center focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50"
                          />
                          <span className="text-[11px] text-gray-400">명</span>
                          <button
                            type="button"
                            onClick={() => {
                              setShowReprocessMenu(false)
                              void handleReprocessWithSpeakers()
                            }}
                            disabled={busy}
                            className="ml-auto text-xs px-2.5 py-1 rounded-md bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors disabled:opacity-50"
                          >
                            재분리
                          </button>
                        </div>
                        <p className="text-[10px] text-gray-400 mt-1">비우면 자동 추정 · 재전사 없음</p>
                      </div>

                      <ReprocessMenuItem
                        title={isInterview ? '면접 기록 다시 정리' : 'AI 요약 다시 생성'}
                        desc={
                          isInterview
                            ? '전사 기반 질문·답변 재정리'
                            : '전사 기반 5분류 요약 재생성'
                        }
                        disabled={busy}
                        onClick={() => {
                          setShowReprocessMenu(false)
                          void handleSummarizeFromMenu()
                        }}
                      />
                      <ReprocessMenuItem
                        title="전체 다시 처리"
                        desc="재전사 포함 · 가장 정확 · 느림"
                        disabled={busy}
                        onClick={() => {
                          setShowReprocessMenu(false)
                          void handleReprocess(false)
                        }}
                      />
                      <ReprocessMenuItem
                        title="빠른 재적용"
                        desc="정제 · 화자 분리만 · 빠름"
                        disabled={busy}
                        onClick={() => {
                          setShowReprocessMenu(false)
                          void handleReprocess(true)
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
            <IconButton title="제목 편집" onClick={() => setEditingTitle(true)} tone="default">
              <PencilIcon size={14} />
            </IconButton>
            <IconButton title="삭제" onClick={() => setConfirmDelete(true)} tone="danger">
              <TrashIcon size={14} />
            </IconButton>
            <IconButton title="닫기" onClick={onClose} tone="default">
              <XIcon size={14} />
            </IconButton>
          </div>
        </div>

        {/* 메타 정보 */}
        <div className="flex items-center gap-2 flex-wrap">
          {isInterview && (
            <Badge color="bg-purple-100 text-purple-700" size="xs">
              면접
            </Badge>
          )}
          <Badge color={statusStyle.badge} size="xs">
            {statusStyle.label}
          </Badge>
          <span className="text-[11px] text-gray-400">{formatDateTime(meeting.started_at)}</span>
          {meeting.duration_ms > 0 && (
            <span className="text-[11px] text-gray-400">{formatDuration(meeting.duration_ms)}</span>
          )}
          {meeting.source === 'mic+system' && (
            <span className="text-[11px] text-gray-400">마이크 + 시스템</span>
          )}

          {/* 프로젝트 연결 (값 없음 = 미연결) */}
          <div className="flex items-center gap-1">
            <LinkIcon
              size={11}
              className={meeting.project_id ? 'text-blue-500' : 'text-gray-400'}
            />
            <select
              value={meeting.project_id ?? ''}
              onChange={(e) =>
                void handleLinkProject(e.target.value ? Number(e.target.value) : null)
              }
              disabled={linkingProject}
              title="프로젝트 연결"
              className={`text-[11px] bg-transparent border-none focus:outline-none cursor-pointer disabled:opacity-50 max-w-[180px] ${
                meeting.project_id
                  ? 'text-blue-600 font-medium'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
            >
              <option value="">프로젝트 미연결</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

        </div>

        {/* 처리 중 프로그레스 */}
        {isProcessing && (
          <div className="mt-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">
                {phaseLabel[proc?.phase ?? ''] ?? '처리 중'}
              </span>
              <span className="text-xs text-gray-400">{processingPct}%</span>
            </div>
            <ProgressBar percent={processingPct} color="bg-blue-500" height="h-1" />
            {proc?.message && (
              <p className="text-[11px] text-gray-400">{proc.message}</p>
            )}
          </div>
        )}

        {/* 실패 배너 */}
        {meeting.status === 'failed' && meeting.error && (
          <div className="mt-2 flex items-start gap-2 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            <p className="text-xs text-red-600 flex-1">{meeting.error}</p>
            <button
              type="button"
              onClick={() => handleReprocess(false)}
              disabled={reprocessing}
              className="text-xs text-red-600 hover:text-red-800 underline shrink-0 disabled:opacity-50"
            >
              {reprocessing ? '재처리 중...' : '다시 처리'}
            </button>
          </div>
        )}

      </div>

      {/* 오디오 플레이어 */}
      <div className="px-5 py-2 bg-white border-b border-gray-100 shrink-0">
        <AudioPlayer
          ref={audioRef}
          audioPath={meeting.audio_path}
          cuts={cuts}
          durationMs={meeting.duration_ms}
          onPositionChange={setCurrentMs}
        />
      </div>

      {/* 탭 네비게이션 */}
      <div className="flex border-b border-gray-200 bg-white shrink-0 px-5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.id
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 탭 콘텐츠 */}
      <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
        {tab === 'timeline' && (
          <SpeakerTimeline
            segments={segments}
            speakers={speakers}
            cuts={cuts}
            currentMs={currentMs}
            onSeek={handleSeek}
          />
        )}
        {tab === 'summary' &&
          (isInterview ? (
            <InterviewPanel summary={summary} meetingId={meeting.id} onSeek={handleSeek} />
          ) : (
            <SummaryPanel summary={summary} meetingId={meeting.id} />
          ))}
        {tab === 'speakers' && (
          <SpeakerEditor speakers={speakers} meetingId={meeting.id} kind={meeting.kind} />
        )}
      </div>

      {/* 삭제 확인 모달 */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setConfirmDelete(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl p-6 w-80 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold text-gray-800">{kindNoun} 삭제</p>
            <p className="text-sm text-gray-600">
              <span className="font-medium">"{meeting.title}"</span>을(를) 삭제합니다.
              오디오 파일과 전사 내용이 모두 삭제되며 복구할 수 없습니다.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={deleting}
                className="px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {deleting ? '삭제 중...' : '삭제'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// 재생성 메뉴의 단일 항목 (제목 + 설명)
function ReprocessMenuItem({
  title,
  desc,
  onClick,
  disabled
}: {
  title: string
  desc: string
  onClick: () => void
  disabled?: boolean
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="block w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <span className="block text-xs text-gray-700">{title}</span>
      <span className="block text-[10px] text-gray-400">{desc}</span>
    </button>
  )
}
