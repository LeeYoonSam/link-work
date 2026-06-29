import { useEffect, useState } from 'react'
import { Badge, StatusDot, projectStatus, button } from '../ui'
import PhaseHint from '../project/PhaseHint'

interface TrayProject {
  name: string
  status: string
  dev_start_date: string
  dev_end_date: string
  qa_start_date: string
  qa_end_date: string
  deploy_date: string
  daysLeft: number
}

interface TrayEvent {
  summary: string
  time: string
  allDay: boolean
  kind: 'event' | 'todo'
  isCompleted: boolean
}

interface TrayData {
  projects: TrayProject[]
  events: TrayEvent[]
}

// 'YYYY-MM-DD' → 'MM-DD' (좁은 위젯용 압축 표기)
function md(dateStr: string): string {
  return dateStr.slice(5)
}

export default function TrayPanel(): React.ReactNode {
  const [data, setData] = useState<TrayData>({ projects: [], events: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.api.tray.getData().then((d) => {
      setData(d as TrayData)
    }).catch(() => {
      // getData failed - show empty state instead of infinite loading
    }).finally(() => {
      setLoading(false)
    })

    // Listen for pushed data updates from main process (e.g. when panel is shown)
    const unsubscribe = window.api.tray.onData((d) => {
      setData(d as TrayData)
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
        {/* Projects Section */}
        <div className="px-4 py-3">
          <h3 className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">
            Active Projects
          </h3>
          {data.projects.length === 0 ? (
            <p className="text-xs text-gray-400">No active projects</p>
          ) : (
            <div className="space-y-2">
              {data.projects.map((project, i) => {
                const st = projectStatus[project.status]
                return (
                  <div
                    key={i}
                    className="rounded-lg bg-gray-50 border border-gray-100 px-2.5 py-2"
                  >
                    {/* Row 1: 이름 + 상태 배지 */}
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-gray-900 truncate flex-1 min-w-0">
                        {project.name}
                      </span>
                      {st ? (
                        <Badge color={st.badge} size="xs">
                          <StatusDot color={st.dot} size="sm" />
                          <span className="ml-1">{st.label}</span>
                        </Badge>
                      ) : (
                        <Badge color="bg-gray-100 text-gray-600" size="xs">
                          {project.status}
                        </Badge>
                      )}
                    </div>

                    {/* Row 2: 현재 상태 기준 진행 일차 / 다음 단계 D-day + 배포일 */}
                    <div className="flex items-center gap-2 mt-1">
                      <PhaseHint project={project} className="text-[11px]" />
                      <span className="text-[11px] text-gray-400 shrink-0 tabular-nums">
                        Deploy {md(project.deploy_date)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-gray-100" />

        {/* Events Section */}
        <div className="px-4 py-3">
          <h3 className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">
            Today&apos;s Schedule
          </h3>
          {data.events.length === 0 ? (
            <p className="text-xs text-gray-400">No events today</p>
          ) : (
            <div className="space-y-1.5">
              {data.events.map((event, i) => (
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
      </div>

      {/* Footer */}
      <div className="border-t border-gray-100 px-4 py-2 bg-gray-50 flex justify-between items-center">
        <span className="text-xs text-gray-400">
          {data.projects.length} projects / {data.events.length} schedules
        </span>
        <button
          onClick={() => {
            setLoading(true)
            window.api.tray.getData().then((d) => {
              setData(d as TrayData)
            }).catch(() => {
              // getData failed - keep previous data
            }).finally(() => {
              setLoading(false)
            })
          }}
          className={`text-xs ${button.ghost}`}
        >
          Refresh
        </button>
      </div>
    </div>
  )
}
