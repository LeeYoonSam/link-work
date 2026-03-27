import { useEffect } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useCalendarStore } from '../../stores/calendarStore'
import { useMemoStore } from '../../stores/memoStore'
import ProjectProgress from './ProjectProgress'
import TodaySchedule from './TodaySchedule'
import { format } from 'date-fns'

export default function Dashboard(): React.ReactNode {
  const { projects, fetchProjects } = useProjectStore()
  const { events, status, fetchEvents, fetchStatus } = useCalendarStore()
  const { importantMemos, fetchImportantMemos } = useMemoStore()

  useEffect(() => {
    fetchProjects()
    fetchStatus()
    fetchImportantMemos()
  }, [])

  useEffect(() => {
    if (status.connected) {
      fetchEvents()
    }
  }, [status.connected])

  return (
    <div className="space-y-6">
      {importantMemos.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-gray-900 mb-4">★ Important Memos</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {importantMemos.map((memo) => (
              <div
                key={memo.id}
                className="bg-yellow-50 border border-yellow-200 rounded-lg p-4"
              >
                <div className="whitespace-pre-wrap text-sm text-gray-800 line-clamp-4">
                  {memo.content}
                </div>
                <div className="text-xs text-gray-400 mt-2">
                  {format(new Date(memo.created_at), 'yyyy-MM-dd HH:mm:ss')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Active Projects</h3>
        {projects.length === 0 ? (
          <div className="text-center text-gray-400 py-8 bg-white border border-gray-200 rounded-lg">
            No active projects
          </div>
        ) : (
          <div className="grid gap-4">
            {projects
              .filter((p) => ['scheduled', 'development', 'qa', 'deploy'].includes(p.status))
              .map((project) => (
                <ProjectProgress key={project.id} project={project} />
              ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Today's Schedule</h3>
        <TodaySchedule events={events} connected={status.connected} />
      </div>
    </div>
  )
}
