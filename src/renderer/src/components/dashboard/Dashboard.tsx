import { useEffect } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useCalendarStore } from '../../stores/calendarStore'
import ProjectProgress from './ProjectProgress'
import TodaySchedule from './TodaySchedule'

export default function Dashboard(): React.ReactNode {
  const { projects, fetchProjects } = useProjectStore()
  const { events, status, fetchEvents, fetchStatus } = useCalendarStore()

  useEffect(() => {
    fetchProjects('active')
    fetchStatus()
  }, [])

  useEffect(() => {
    if (status.connected) {
      fetchEvents()
    }
  }, [status.connected])

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Active Projects</h3>
        {projects.length === 0 ? (
          <div className="text-center text-gray-400 py-8 bg-white border border-gray-200 rounded-lg">
            No active projects
          </div>
        ) : (
          <div className="grid gap-4">
            {projects
              .filter((p) => p.status === 'active')
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
