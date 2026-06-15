import { useEffect, useState } from 'react'
import { useRecordingStore } from '../../stores/recordingStore'
import RecordingList from './RecordingList'
import RecorderControls from './RecorderControls'
import MeetingDetailView from './MeetingDetail'
import { button } from '../ui'

export default function RecordingView(): React.ReactNode {
  const { meetings, current, loading, fetchMeetings, closeMeeting, subscribeStream } =
    useRecordingStore()
  const [showRecorder, setShowRecorder] = useState(false)

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
          <span className="text-sm font-semibold text-gray-800">회의 녹음</span>
          <button
            onClick={() => setShowRecorder(true)}
            className={`px-3 py-1.5 text-xs font-medium ${button.primary} flex items-center gap-1.5`}
          >
            <MicDotIcon />새 녹음
          </button>
        </div>

        {/* 녹음 컨트롤 (인라인 드롭다운) */}
        {showRecorder && (
          <div className="border-b border-gray-100 bg-gray-50">
            <RecorderControls onDone={() => setShowRecorder(false)} />
          </div>
        )}

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
