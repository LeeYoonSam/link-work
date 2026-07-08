import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRecordingStore } from '../../stores/recordingStore'
import type { MeetingCut, MeetingSegment, MeetingSpeaker } from '../../types'
import { EmptyState, PencilIcon } from '../ui'

interface Props {
  segments: MeetingSegment[]
  speakers: MeetingSpeaker[]
  cuts: MeetingCut[]
  // 현재 재생 위치(ms). 미니 타임라인 playhead·세그먼트 하이라이트·자동 스크롤에 사용
  currentMs: number
  onSeek: (ms: number) => void
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function speakerName(spk: MeetingSpeaker): string {
  return spk.display_name ?? spk.label
}

export default function SpeakerTimeline({
  segments,
  speakers,
  cuts,
  currentMs,
  onSeek
}: Props): React.ReactNode {
  const { current, reassignSegment, updateSegmentText, addSpeaker, toggleCut, refreshCurrent } =
    useRecordingStore()
  const meetingId = current?.meeting.id

  const speakerMap = useMemo(() => {
    const m = new Map<number, MeetingSpeaker>()
    speakers.forEach((s) => m.set(s.id, s))
    return m
  }, [speakers])

  // 전체 발언 시간 (화자별)
  const speakerTotals = useMemo(() => {
    const totals = new Map<number, number>()
    segments.forEach((seg) => {
      if (seg.speaker_id == null) return
      totals.set(seg.speaker_id, (totals.get(seg.speaker_id) ?? 0) + (seg.end_ms - seg.start_ms))
    })
    return totals
  }, [segments])

  const totalSpeechMs = useMemo(
    () => Array.from(speakerTotals.values()).reduce((a, b) => a + b, 0),
    [speakerTotals]
  )

  const sortedSegments = useMemo(
    () => [...segments].sort((a, b) => a.start_ms - b.start_ms),
    [segments]
  )

  // 세그먼트 사이 enabled cuts
  const enabledCuts = useMemo(() => cuts.filter((c) => c.enabled === 1), [cuts])

  // 미니 타임라인의 총 길이: 저장된 회의 길이와 마지막 세그먼트 끝 중 큰 값
  const durationMs = useMemo(() => {
    const fromMeeting = current?.meeting.duration_ms ?? 0
    const lastEnd = segments.reduce((max, s) => Math.max(max, s.end_ms), 0)
    return Math.max(fromMeeting, lastEnd)
  }, [current?.meeting.duration_ms, segments])

  // 현재 재생 위치가 속한 세그먼트(없으면 직전 세그먼트). 하이라이트·자동 스크롤 기준
  const activeSegId = useMemo(() => {
    let candidate: number | null = null
    for (const s of sortedSegments) {
      if (s.start_ms > currentMs) break
      if (currentMs < s.end_ms) return s.id
      candidate = s.id // 세그먼트 사이 공백이면 가장 최근에 지난 세그먼트를 유지
    }
    return candidate
  }, [sortedSegments, currentMs])

  // onReassign을 안정화해 currentMs 변동 시에도 SegmentRow memo가 깨지지 않게 한다
  const handleReassign = useCallback(
    async (segId: number, spkId: number | null) => {
      await reassignSegment(segId, spkId)
      await refreshCurrent()
    },
    [reassignSegment, refreshCurrent]
  )

  // 발언 텍스트 수동 수정 (store 액션이 refreshCurrent까지 수행)
  const handleUpdateText = useCallback(
    async (segId: number, text: string) => {
      await updateSegmentText(segId, text)
    },
    [updateSegmentText]
  )

  // 새 화자를 즉석 추가하고 해당 세그먼트를 그 화자로 재할당
  const handleAddSpeaker = useCallback(
    async (segId: number, name: string) => {
      if (meetingId == null) return
      const spkId = await addSpeaker(meetingId, name)
      if (spkId != null) await reassignSegment(segId, spkId)
    },
    [meetingId, addSpeaker, reassignSegment]
  )

  if (segments.length === 0) {
    return (
      <EmptyState compact>
        <p className="text-xs text-gray-400">
          전사가 완료되면 타임라인이 표시됩니다
        </p>
      </EmptyState>
    )
  }

  return (
    <div className="space-y-4">
      {/* 화자별 발언 비율 요약 바 */}
      {speakers.length > 0 && totalSpeechMs > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">화자 비율</p>
          <div className="flex h-2 rounded-full overflow-hidden gap-px">
            {speakers.map((spk) => {
              const ms = speakerTotals.get(spk.id) ?? 0
              const pct = totalSpeechMs > 0 ? (ms / totalSpeechMs) * 100 : 0
              if (pct < 0.5) return null
              return (
                <div
                  key={spk.id}
                  className="h-full transition-all"
                  style={{ width: `${pct}%`, backgroundColor: spk.color }}
                  title={`${speakerName(spk)}: ${Math.round(pct)}%`}
                />
              )
            })}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {speakers.map((spk) => {
              const ms = speakerTotals.get(spk.id) ?? 0
              const pct = totalSpeechMs > 0 ? (ms / totalSpeechMs) * 100 : 0
              return (
                <span key={spk.id} className="flex items-center gap-1 text-[11px] text-gray-500">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: spk.color }}
                  />
                  {speakerName(spk)}
                  <span className="text-gray-400">{Math.round(pct)}%</span>
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* 시간축 미니 타임라인: 화자색 세그먼트 + 재생 위치 playhead (클릭·드래그로 시킹) */}
      {durationMs > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">타임라인</p>
          <div className="relative h-6 bg-gray-100 rounded-md overflow-hidden">
            {sortedSegments.map((seg) => {
              const spk = seg.speaker_id != null ? speakerMap.get(seg.speaker_id) : null
              const left = (seg.start_ms / durationMs) * 100
              const width = Math.max(((seg.end_ms - seg.start_ms) / durationMs) * 100, 0.3)
              const isCut = enabledCuts.some(
                (c) => c.start_ms <= seg.start_ms && c.end_ms >= seg.end_ms
              )
              return (
                <div
                  key={seg.id}
                  className="absolute inset-y-0 pointer-events-none"
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    backgroundColor: isCut ? '#D1D5DB' : (spk?.color ?? '#9CA3AF'),
                    opacity: isCut ? 0.4 : seg.id === activeSegId ? 1 : 0.75
                  }}
                  title={`${spk ? speakerName(spk) : '?'} · ${formatMs(seg.start_ms)}`}
                />
              )
            })}
            {/* 재생 위치 playhead */}
            <div
              className="absolute inset-y-0 w-0.5 bg-gray-900 pointer-events-none z-10"
              style={{ left: `${Math.min((currentMs / durationMs) * 100, 100)}%` }}
            />
            {/* 클릭·드래그 시킹용 투명 슬라이더 */}
            <input
              type="range"
              min={0}
              max={durationMs}
              step={100}
              value={Math.min(currentMs, durationMs)}
              onChange={(e) => onSeek(Number(e.target.value))}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              aria-label="타임라인 재생 위치"
            />
          </div>
        </div>
      )}

      {/* 세그먼트 목록 */}
      <div className="space-y-1">
        {sortedSegments.map((seg) => (
          <SegmentRow
            key={seg.id}
            segment={seg}
            speakers={speakers}
            speakerMap={speakerMap}
            enabledCuts={enabledCuts}
            meetingId={meetingId}
            isActive={seg.id === activeSegId}
            onSeek={onSeek}
            onReassign={handleReassign}
            onUpdateText={handleUpdateText}
            onAddSpeaker={handleAddSpeaker}
          />
        ))}
      </div>

      {/* 컷 목록 */}
      {cuts.length > 0 && (
        <div className="space-y-1 pt-2 border-t border-gray-100">
          <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">
            컷 구간 ({cuts.length})
          </p>
          {cuts.map((cut) => (
            <CutRow
              key={cut.id}
              cut={cut}
              onToggle={async (id, enabled) => {
                await toggleCut(id, enabled)
                await refreshCurrent()
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const SegmentRow = memo(function SegmentRow({
  segment,
  speakers,
  speakerMap,
  enabledCuts,
  meetingId: _meetingId,
  isActive,
  onSeek,
  onReassign,
  onUpdateText,
  onAddSpeaker
}: {
  segment: MeetingSegment
  speakers: MeetingSpeaker[]
  speakerMap: Map<number, MeetingSpeaker>
  enabledCuts: MeetingCut[]
  meetingId: number | undefined
  isActive: boolean
  onSeek: (ms: number) => void
  onReassign: (segId: number, spkId: number | null) => Promise<void>
  onUpdateText: (segId: number, text: string) => Promise<void>
  onAddSpeaker: (segId: number, name: string) => Promise<void>
}): React.ReactNode {
  const [reassigning, setReassigning] = useState(false)
  const [showReassign, setShowReassign] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [newSpeakerName, setNewSpeakerName] = useState('')
  const rowRef = useRef<HTMLDivElement>(null)

  // 재생이 이 세그먼트에 진입하면 화면 중앙으로 부드럽게 스크롤 (편집 중에는 방해하지 않음)
  useEffect(() => {
    if (isActive && !editing) {
      rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [isActive, editing])

  const spk = segment.speaker_id != null ? speakerMap.get(segment.speaker_id) : null

  // 이 세그먼트가 컷 구간에 완전히 덮이는지
  const isCut = enabledCuts.some(
    (c) => c.start_ms <= segment.start_ms && c.end_ms >= segment.end_ms
  )

  const handleReassign = async (spkId: number | null): Promise<void> => {
    setReassigning(true)
    setShowReassign(false)
    try {
      await onReassign(segment.id, spkId)
    } finally {
      setReassigning(false)
    }
  }

  // 새 화자 즉석 추가 후 이 세그먼트에 바로 할당
  const submitNewSpeaker = async (): Promise<void> => {
    const name = newSpeakerName.trim()
    if (!name) return
    setReassigning(true)
    setShowReassign(false)
    try {
      await onAddSpeaker(segment.id, name)
      setNewSpeakerName('')
    } finally {
      setReassigning(false)
    }
  }

  const startEdit = (): void => {
    setDraft(segment.text)
    setEditing(true)
  }

  const saveEdit = async (): Promise<void> => {
    const next = draft.trim()
    if (next === segment.text) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await onUpdateText(segment.id, next)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      ref={rowRef}
      className={`group flex items-start gap-2 px-2 py-1.5 rounded-md transition-colors scroll-mt-2 ${
        isActive
          ? 'bg-blue-50 ring-1 ring-blue-200'
          : isCut
            ? 'opacity-40'
            : 'hover:bg-gray-100'
      }`}
    >
      {/* 화자 칩 + 재할당 드롭다운 */}
      <div className="relative shrink-0 mt-0.5">
        <button
          type="button"
          onClick={() => setShowReassign((v) => !v)}
          title="화자 변경"
          disabled={reassigning}
        >
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-white leading-none"
            style={{ backgroundColor: spk?.color ?? '#9CA3AF' }}
          >
            {spk ? (spk.display_name ?? spk.label) : '?'}
            {segment.speaker_corrected === 1 && (
              <span className="opacity-75 text-[8px]">*</span>
            )}
          </span>
        </button>
        {showReassign && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setShowReassign(false)} />
            <div className="absolute z-30 left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[180px]">
              <button
                type="button"
                onClick={() => handleReassign(null)}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
              >
                화자 없음
              </button>
              {speakers.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleReassign(s.id)}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 transition-colors flex items-center gap-2"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: s.color }}
                  />
                  <span className="text-gray-700">{s.display_name ?? s.label}</span>
                  {s.id === segment.speaker_id && (
                    <span className="ml-auto text-blue-500 text-[10px]">현재</span>
                  )}
                </button>
              ))}
              {/* 새 화자 즉석 추가 → 이 세그먼트에 바로 할당 */}
              <div className="border-t border-gray-100 mt-1 px-2 pt-1.5 pb-1">
                <div className="flex items-center gap-1">
                  <input
                    value={newSpeakerName}
                    onChange={(e) => setNewSpeakerName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void submitNewSpeaker()
                      } else if (e.key === 'Escape') {
                        setShowReassign(false)
                      }
                    }}
                    placeholder="새 화자 이름"
                    className="flex-1 min-w-0 text-xs px-1.5 py-1 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <button
                    type="button"
                    onClick={() => void submitNewSpeaker()}
                    disabled={!newSpeakerName.trim()}
                    className="shrink-0 text-xs px-2 py-1 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors disabled:opacity-40"
                  >
                    추가
                  </button>
                </div>
                <p className="text-[10px] text-gray-300 mt-0.5">같은 이름이 있으면 그 화자로 지정</p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 타임스탬프 */}
      <button
        type="button"
        onClick={() => onSeek(segment.start_ms)}
        className="shrink-0 text-[11px] font-mono text-gray-400 hover:text-blue-500 transition-colors mt-0.5 tabular-nums"
        title="이 위치로 이동"
      >
        [{formatMs(segment.start_ms)}]
      </button>

      {/* 발언 텍스트: 보기 ↔ 편집 */}
      {editing ? (
        <div className="flex-1 space-y-1">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void saveEdit()
              } else if (e.key === 'Escape') {
                setEditing(false)
              }
            }}
            autoFocus
            rows={Math.min(Math.max(Math.ceil(draft.length / 60), 1), 6)}
            disabled={saving}
            className="w-full text-sm text-gray-700 leading-relaxed px-2 py-1 border border-blue-300 rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 bg-white"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void saveEdit()}
              disabled={saving}
              className="text-[11px] px-2 py-0.5 rounded-md bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50"
            >
              저장
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="text-[11px] px-2 py-0.5 rounded-md text-gray-500 hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              취소
            </button>
            <span className="text-[10px] text-gray-300">Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소</span>
          </div>
        </div>
      ) : (
        <>
          <p
            className={`flex-1 text-sm text-gray-700 leading-relaxed cursor-pointer hover:text-gray-900 ${
              isCut ? 'line-through' : ''
            }`}
            onClick={() => onSeek(segment.start_ms)}
            onDoubleClick={startEdit}
            title="클릭: 이 위치로 이동 · 더블클릭: 내용 수정"
          >
            {segment.text || <span className="text-gray-300 italic">발언 없음</span>}
            {segment.text_corrected === 1 && (
              <span className="ml-1 text-[10px] text-gray-300 align-top" title="수동 수정됨">
                *
              </span>
            )}
          </p>
          {/* 내용 수정 버튼 (hover 시 노출) */}
          <button
            type="button"
            onClick={startEdit}
            className="shrink-0 mt-0.5 p-0.5 rounded text-gray-300 opacity-0 group-hover:opacity-100 hover:text-blue-500 hover:bg-blue-50 transition-all"
            title="내용 수정"
          >
            <PencilIcon size={12} />
          </button>
        </>
      )}
    </div>
  )
})

function CutRow({
  cut,
  onToggle
}: {
  cut: MeetingCut
  onToggle: (id: number, enabled: boolean) => Promise<void>
}): React.ReactNode {
  const [toggling, setToggling] = useState(false)

  const CUT_TYPE_LABELS: Record<MeetingCut['type'], string> = {
    silence: '침묵',
    filler: '필러',
    manual: '수동'
  }

  const handleToggle = async (): Promise<void> => {
    setToggling(true)
    try {
      await onToggle(cut.id, cut.enabled !== 1)
    } finally {
      setToggling(false)
    }
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 transition-colors">
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
          cut.enabled === 1
            ? 'bg-orange-100 text-orange-700'
            : 'bg-gray-100 text-gray-400'
        }`}
      >
        {CUT_TYPE_LABELS[cut.type]}
      </span>
      <span className="text-[11px] font-mono text-gray-400 tabular-nums">
        {formatMs(cut.start_ms)} – {formatMs(cut.end_ms)}
      </span>
      {cut.note && (
        <span className="text-[11px] text-gray-400 truncate max-w-[120px]">"{cut.note}"</span>
      )}
      <span className="flex-1" />
      <button
        type="button"
        onClick={handleToggle}
        disabled={toggling}
        className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
          cut.enabled === 1
            ? 'text-orange-600 hover:bg-orange-50'
            : 'text-gray-400 hover:bg-gray-100'
        } disabled:opacity-50`}
        title={cut.enabled === 1 ? '컷 비활성화' : '컷 활성화'}
      >
        {cut.enabled === 1 ? '비활성화' : '활성화'}
      </button>
    </div>
  )
}
