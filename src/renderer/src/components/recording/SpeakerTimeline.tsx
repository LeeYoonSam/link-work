import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRecordingStore } from '../../stores/recordingStore'
import type { MeetingCut, MeetingSegment, MeetingSpeaker } from '../../types'
import { EmptyState, IconButton } from '../ui'

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
  const { current, reassignSegment, toggleCut, refreshCurrent } = useRecordingStore()
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
  onReassign
}: {
  segment: MeetingSegment
  speakers: MeetingSpeaker[]
  speakerMap: Map<number, MeetingSpeaker>
  enabledCuts: MeetingCut[]
  meetingId: number | undefined
  isActive: boolean
  onSeek: (ms: number) => void
  onReassign: (segId: number, spkId: number | null) => Promise<void>
}): React.ReactNode {
  const [reassigning, setReassigning] = useState(false)
  const [showReassign, setShowReassign] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)

  // 재생이 이 세그먼트에 진입하면 화면 중앙으로 부드럽게 스크롤
  useEffect(() => {
    if (isActive) rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [isActive])

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
      {/* 화자 칩 */}
      <button
        type="button"
        onClick={() => setShowReassign((v) => !v)}
        className="shrink-0 mt-0.5"
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

      {/* 타임스탬프 */}
      <button
        type="button"
        onClick={() => onSeek(segment.start_ms)}
        className="shrink-0 text-[11px] font-mono text-gray-400 hover:text-blue-500 transition-colors mt-0.5 tabular-nums"
        title="이 위치로 이동"
      >
        [{formatMs(segment.start_ms)}]
      </button>

      {/* 발언 텍스트 */}
      <p
        className={`flex-1 text-sm text-gray-700 leading-relaxed cursor-pointer hover:text-gray-900 ${
          isCut ? 'line-through' : ''
        }`}
        onClick={() => onSeek(segment.start_ms)}
        title="클릭하여 이 위치로 이동"
      >
        {segment.text || <span className="text-gray-300 italic">발언 없음</span>}
      </p>

      {/* 화자 재할당 드롭다운 */}
      {showReassign && (
        <div className="absolute z-10 mt-6 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[140px]">
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
        </div>
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
