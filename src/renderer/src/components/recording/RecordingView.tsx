import { useEffect, useState } from 'react'
import type { KindFilter } from '../../stores/recordingStore'
import { useRecordingStore } from '../../stores/recordingStore'
import { useRecorderStore } from '../../stores/recorderStore'
import RecordingList from './RecordingList'
import RecorderControls from './RecorderControls'
import RecognitionAidsPanel from './RecognitionAidsPanel'
import MeetingDetailView from './MeetingDetail'
import { button } from '../ui'

const FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'meeting', label: '회의' },
  { id: 'interview', label: '면접' }
]

export default function RecordingView(): React.ReactNode {
  const {
    meetings,
    current,
    loading,
    kindFilter,
    setKindFilter,
    fetchMeetings,
    closeMeeting,
    subscribeStream
  } = useRecordingStore()
  const [showRecorder, setShowRecorder] = useState(false)
  // 용어집·구성원 관리 패널. 녹음 컨트롤과 같은 자리(목록 위 인라인 드롭다운)에 편다.
  const [showAids, setShowAids] = useState(false)
  // 다른 메뉴에 다녀와도 녹음이 진행 중이면 컨트롤 패널을 다시 펼쳐서 보여준다.
  const recorderActive = useRecorderStore((s) => s.state !== 'idle')

  const countOf = (f: KindFilter): number =>
    f === 'all' ? meetings.length : meetings.filter((m) => m.kind === f).length

  useEffect(() => {
    fetchMeetings()
    const unsubscribe = subscribeStream()
    return unsubscribe
  }, [])

  return (
    <div className="flex h-full gap-0 min-h-0">
      {/* 좌측 목록 패널 */}
      <div
        className={`flex flex-col border-r border-gray-200 bg-white transition-all duration-200 ${
          current ? 'w-64 shrink-0' : 'flex-1'
        }`}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <span className="text-sm font-semibold text-gray-800">녹음</span>
          <div className="flex items-center gap-1.5">
            {/* 용어집·구성원 — 전사 정확도를 올리는 입력이라 녹음 시작 옆에 둔다 */}
            <button
              type="button"
              onClick={() => setShowAids((v) => !v)}
              title="사내 용어와 구성원을 등록해 전사·요약 정확도를 높입니다"
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                showAids ? 'bg-gray-900 text-white' : button.subtle
              }`}
            >
              인식 보조
            </button>
            <button
              onClick={() => setShowRecorder(true)}
              className={`px-3 py-1.5 text-xs font-medium ${button.primary} flex items-center gap-1.5`}
            >
              <MicDotIcon />새 녹음
            </button>
          </div>
        </div>

        {/* 녹음 컨트롤 (인라인 드롭다운) */}
        {(showRecorder || recorderActive) && (
          <div className="border-b border-gray-100 bg-gray-50">
            <RecorderControls onDone={() => setShowRecorder(false)} />
          </div>
        )}

        {/* 인식 보조 (인라인 드롭다운) */}
        {showAids && (
          <div className="border-b border-gray-100 bg-gray-50">
            <RecognitionAidsPanel onClose={() => setShowAids(false)} />
          </div>
        )}

        {/* 종류 필터 — 회의/면접을 한 목록에서 갈라 본다 */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-100">
          {FILTERS.map((f) => {
            const active = kindFilter === f.id
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setKindFilter(f.id)}
                className={`px-2.5 py-1 text-xs rounded-md font-medium transition-colors ${
                  active
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'
                }`}
              >
                {f.label}
                <span className={`ml-1.5 tabular-nums ${active ? 'text-gray-400' : 'text-gray-300'}`}>
                  {countOf(f.id)}
                </span>
              </button>
            )
          })}
        </div>

        {/* 목록 */}
        <div className="flex-1 overflow-y-auto">
          {loading && meetings.length === 0 ? (
            <div className="text-center text-gray-400 text-xs py-8">불러오는 중...</div>
          ) : (
            <RecordingList />
          )}
        </div>
      </div>

      {/* 우측 상세 패널 */}
      {current && (
        <div className="flex-1 flex flex-col min-w-0 bg-gray-50">
          <MeetingDetailView onClose={closeMeeting} />
        </div>
      )}
    </div>
  )
}

function MicDotIcon(): React.ReactNode {
  return (
    <span className="relative flex h-2 w-2">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
    </span>
  )
}
