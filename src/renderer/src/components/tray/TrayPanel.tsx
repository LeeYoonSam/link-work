import { useEffect, useState } from 'react'

interface TrayProject {
  name: string
  status: string
  devEndDate: string
  deployDate: string
  devDaysLeft: number
  deployDaysLeft: number
  progress: number
  taskProgress: number
  doneTasks: number
  totalTasks: number
}

const statusLabels: Record<string, string> = {
  scheduled: 'Scheduled',
  development: 'Development',
  qa: 'QA',
  deploy: 'Deploy',
  completed: 'Completed',
  cancelled: 'Cancelled'
}

const statusColors: Record<string, string> = {
  scheduled: 'bg-slate-500',
  development: 'bg-green-500',
  qa: 'bg-orange-500',
  deploy: 'bg-red-500',
  completed: 'bg-blue-500',
  cancelled: 'bg-gray-400'
}

interface TrayEvent {
  summary: string
  time: string
  allDay: boolean
}

interface TrayData {
  projects: TrayProject[]
  events: TrayEvent[]
}

function getDdayText(days: number): string {
  if (days < 0) return `D+${Math.abs(days)}`
  if (days === 0) return 'D-Day'
  return `D-${days}`
}

function getUrgencyColor(daysLeft: number): string {
  if (daysLeft <= 3) return 'text-red-600'
  if (daysLeft <= 7) return 'text-yellow-600'
  return 'text-green-600'
}

function getBarColor(progress: number): string {
  if (progress <= 33) return 'bg-green-500'
  if (progress <= 66) return 'bg-blue-500'
  return 'bg-red-500'
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
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Active Projects
          </h3>
          {data.projects.length === 0 ? (
            <p className="text-xs text-gray-400">No active projects</p>
          ) : (
            <div className="space-y-2.5">
              {data.projects.map((project, i) => (
                <div key={i} className="bg-gray-50 rounded-lg p-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm font-medium text-gray-900 truncate mr-2">
                      {project.name}
                    </span>
                    <div className="flex gap-1.5 shrink-0 items-center">
                      <span
                        className={`text-xs font-medium px-1.5 py-0.5 rounded-full text-white ${statusColors[project.status] || 'bg-gray-400'}`}
                      >
                        {statusLabels[project.status] || project.status}
                      </span>
                      <span className={`text-xs font-bold ${getUrgencyColor(project.deployDaysLeft)}`}>
                        D{getDdayText(project.deployDaysLeft).slice(1)}
                      </span>
                    </div>
                  </div>
                  {project.devDaysLeft >= 0 && (
                    <>
                      <div className="w-full bg-gray-200 rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full transition-all ${getBarColor(project.progress)}`}
                          style={{ width: `${project.progress}%` }}
                        />
                      </div>
                      <div className="flex justify-between mt-1">
                        <span className="text-xs text-gray-400">{project.progress}%</span>
                        <span className="text-xs text-gray-400">
                          Dev ~{project.devEndDate} / Deploy {project.deployDate}
                        </span>
                      </div>
                    </>
                  )}
                  {project.devDaysLeft < 0 && (
                    <div className="mt-0.5">
                      <span className="text-xs text-gray-400">
                        Deploy {project.deployDate}
                      </span>
                    </div>
                  )}
                  {project.totalTasks > 0 && (
                    <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t border-gray-200">
                      <span className="text-xs text-gray-500">
                        Tasks: {project.doneTasks}/{project.totalTasks} done
                      </span>
                      <div className="flex items-center gap-1.5">
                        <div className="w-16 bg-gray-200 rounded-full h-1">
                          <div
                            className="h-1 rounded-full bg-green-500 transition-all"
                            style={{ width: `${project.taskProgress}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500">{project.taskProgress}%</span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-gray-100" />

        {/* Events Section */}
        <div className="px-4 py-3">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
            Today's Schedule
          </h3>
          {data.events.length === 0 ? (
            <p className="text-xs text-gray-400">No events today</p>
          ) : (
            <div className="space-y-1.5">
              {data.events.map((event, i) => (
                <div key={i} className="flex items-center gap-2 py-1">
                  <span className="text-xs font-medium text-gray-500 w-12 shrink-0 text-right">
                    {event.time}
                  </span>
                  <div className="w-0.5 h-4 bg-blue-400 rounded-full shrink-0" />
                  <span className="text-xs text-gray-800 truncate">{event.summary}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-gray-100 px-4 py-2 bg-gray-50 flex justify-between items-center">
        <span className="text-xs text-gray-400">
          {data.projects.length} projects / {data.events.length} events
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
          className="text-xs text-blue-500 hover:text-blue-700"
        >
          Refresh
        </button>
      </div>
    </div>
  )
}
