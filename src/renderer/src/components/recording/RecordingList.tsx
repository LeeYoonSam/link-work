import { useRecordingStore } from '../../stores/recordingStore'
import type { Meeting, MeetingStatus } from '../../types'
import { Badge, EmptyState } from '../ui'

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
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return dateStr
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}

function MeetingCard({ meeting }: { meeting: Meeting }): React.ReactNode {
  const { current, openMeeting, processing, cancelling, cancelProcessing } = useRecordingStore()
  const isActive = current?.meeting.id === meeting.id
  const proc = processing[meeting.id]
  const isProcessing = !!proc
  const isCancelling = !!cancelling?.[meeting.id]
  const statusStyle = STATUS_STYLES[meeting.status] ?? STATUS_STYLES.failed

  // 취소 버튼을 중첩하기 위해 카드 루트는 button이 아니라 role="button" div로 둔다
  // (button 안에 button은 유효하지 않은 마크업).
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openMeeting(meeting.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openMeeting(meeting.id)
        }
      }}
      className={`w-full text-left px-4 py-3 border-b border-gray-100 transition-colors hover:bg-gray-50 cursor-pointer ${
        isActive ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span
          className={`text-sm font-medium leading-snug truncate flex-1 ${
            isActive ? 'text-blue-700' : 'text-gray-800'
          }`}
          title={meeting.title}
        >
          {meeting.title}
        </span>
        {meeting.kind === 'interview' && (
          <Badge color="bg-purple-100 text-purple-700" size="xs">
            면접
          </Badge>
        )}
        <Badge color={statusStyle.badge} size="xs">
          {statusStyle.label}
        </Badge>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-gray-400">
        <span>{formatDate(meeting.started_at)}</span>
        {meeting.duration_ms > 0 && (
          <>
            <span className="text-gray-200">·</span>
            <span>{formatDuration(meeting.duration_ms)}</span>
          </>
        )}
        {meeting.source === 'mic+system' && (
          <>
            <span className="text-gray-200">·</span>
            <span className="text-gray-400">시스템</span>
          </>
        )}
        {meeting.calendar_event_title && (
          <>
            <span className="text-gray-200">·</span>
            <span className="text-blue-400 truncate max-w-[80px]" title={meeting.calendar_event_title}>
              {meeting.calendar_event_title}
            </span>
          </>
        )}
      </div>

      {/* 처리 중 미니 프로그레스 + 취소 */}
      {isProcessing && (
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 bg-gray-200 rounded-full h-0.5">
            <div
              className="h-0.5 rounded-full bg-blue-500 transition-all duration-500"
              style={{ width: `${Math.round((proc.progress ?? 0) * 100)}%` }}
            />
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void cancelProcessing(meeting.id)
            }}
            disabled={isCancelling}
            className="shrink-0 text-[11px] text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50 disabled:hover:text-gray-400"
          >
            {isCancelling ? '취소 중…' : '취소'}
          </button>
        </div>
      )}

      {meeting.error && (
        <p className="mt-1 text-[11px] text-red-500 truncate" title={meeting.error}>
          {meeting.error}
        </p>
      )}
    </div>
  )
}

export default function RecordingList(): React.ReactNode {
  const { meetings, kindFilter } = useRecordingStore()

  const visible =
    kindFilter === 'all' ? meetings : meetings.filter((m) => m.kind === kindFilter)

  if (visible.length === 0) {
    // 녹음이 아예 없는 것과, 필터에 걸려 안 보이는 것은 다른 상황이다
    const filtered = meetings.length > 0
    return (
      <EmptyState>
        <div className="mb-2 text-gray-300">
          <MicOffIcon />
        </div>
        {filtered ? (
          <>
            <p>{kindFilter === 'interview' ? '면접' : '회의'} 녹음이 없습니다</p>
            <p className="text-[11px] mt-1 text-gray-300">
              전체 탭에서 다른 녹음을 볼 수 있습니다
            </p>
          </>
        ) : (
          <>
            <p>녹음된 항목이 없습니다</p>
            <p className="text-[11px] mt-1 text-gray-300">상단 버튼으로 첫 녹음을 시작하세요</p>
          </>
        )}
      </EmptyState>
    )
  }

  return (
    <div>
      {visible.map((m) => (
        <MeetingCard key={m.id} meeting={m} />
      ))}
    </div>
  )
}

function MicOffIcon(): React.ReactNode {
  return (
    <svg
      width={28}
      height={28}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
      <path d="M5 10v2a7 7 0 0 0 12 4.9" />
      <path d="M8 8V6a4 4 0 0 1 7.09-2.52" />
      <path d="M12 12V6" />
      <line x1="12" x2="12" y1="19" y2="22" />
      <line x1="8" x2="16" y1="22" y2="22" />
    </svg>
  )
}
