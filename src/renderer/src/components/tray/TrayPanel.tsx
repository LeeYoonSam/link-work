import { useEffect, useState } from 'react'
import { Badge, button } from '../ui'

interface TrayEvent {
  summary: string
  time: string
  allDay: boolean
  kind: 'event' | 'todo'
  isCompleted: boolean
}

// 메인 tray-widget.ts 의 TrayData 와 같은 모양 (docs/ASSISTANT.md §10)
interface TrayData {
  events: TrayEvent[]
}

/** 트레이 오늘 일정 목록 */
export function TrayEventList({ events }: { events: TrayEvent[] }): React.ReactNode {
  return (
    <div className="px-4 py-3">
      <h3 className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">
        Today&apos;s Schedule
      </h3>
      {events.length === 0 ? (
        <p className="text-xs text-gray-400">No events today</p>
      ) : (
        <div className="space-y-1.5">
          {events.map((event, i) => (
            <div key={i} className={`flex items-center gap-2 py-1 ${event.isCompleted ? 'opacity-60' : ''}`}>
              <span className={`text-xs font-medium w-12 shrink-0 text-right ${
                event.kind === 'todo' && event.isCompleted
                  ? 'text-green-500'
                  : event.kind === 'todo'
                    ? 'text-green-600'
                    : 'text-gray-500'
              }`}>
                {event.time}
              </span>
              <div className={`w-0.5 h-4 rounded-full shrink-0 ${
                event.kind === 'todo' ? 'bg-green-400' : 'bg-blue-400'
              }`} />
              <span className={`text-xs truncate ${
                event.isCompleted ? 'line-through text-gray-400' : 'text-gray-800'
              }`}>
                {event.summary}
              </span>
              {event.kind === 'todo' ? (
                <Badge
                  color={event.isCompleted ? 'bg-green-100 text-green-700' : 'bg-green-50 text-green-600'}
                  size="xs"
                >
                  {event.isCompleted ? '완료' : 'TODO'}
                </Badge>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 옛 메인이 보내던 assistant 필드는 무시한다
const normalize = (d: unknown): TrayData => ({
  events: Array.isArray((d as Partial<TrayData> | null)?.events) ? (d as TrayData).events : []
})

export default function TrayPanel(): React.ReactNode {
  const [data, setData] = useState<TrayData>({ events: [] })
  const [loading, setLoading] = useState(true)

  const reload = (): Promise<void> =>
    window.api.tray.getData().then((d) => {
      setData(normalize(d))
    }).catch(() => {
      // getData failed - keep previous data
    })

  useEffect(() => {
    window.api.tray.getData().then((d) => {
      setData(normalize(d))
    }).catch(() => {
      // getData failed - show empty state instead of infinite loading
    }).finally(() => {
      setLoading(false)
    })

    // Listen for pushed data updates from main process (e.g. when panel is shown)
    const unsubscribe = window.api.tray.onData((d) => {
      setData(normalize(d))
      setLoading(false)
    })
    return unsubscribe
  }, [])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-white rounded-xl">
        <span className="text-gray-400 text-sm">Loading...</span>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="bg-gray-900 text-white px-4 py-3 flex items-center justify-between">
        <span className="font-bold text-sm">LinkWork</span>
        <button
          onClick={() => window.api.tray.openApp()}
          className="text-xs text-gray-400 hover:text-white transition-colors"
        >
          Open App
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <TrayEventList events={data.events} />
      </div>

      {/* Footer */}
      <div className="border-t border-gray-100 px-4 py-2 bg-gray-50 flex justify-between items-center">
        <span className="text-xs text-gray-400">
          {data.events.length} schedules
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void window.api.tray.openToday().catch(() => undefined)}
            className={`text-xs ${button.ghost}`}
          >
            오늘 보기
          </button>
          <button
            onClick={() => {
              setLoading(true)
              reload().finally(() => {
                setLoading(false)
              })
            }}
            className={`text-xs ${button.ghost}`}
          >
            Refresh
          </button>
        </div>
      </div>
    </div>
  )
}
