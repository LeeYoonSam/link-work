import { useEffect, useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { format } from 'date-fns'
import type { Project } from '../../types'

const statusLabels: Record<string, string> = {
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled'
}

const statusColors: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  completed: 'bg-blue-100 text-blue-800',
  cancelled: 'bg-gray-100 text-gray-600'
}

export default function ProjectList(): React.ReactNode {
  const { projects, fetchProjects, setProjectView, setEditingProject, fetchProject, loading } =
    useProjectStore()
  const [filter, setFilter] = useState<string>('all')

  useEffect(() => {
    fetchProjects()
  }, [])

  const filtered = filter === 'all' ? projects : projects.filter((p) => p.status === filter)

  const openDetail = (project: Project): void => {
    fetchProject(project.id)
    setProjectView('detail')
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-2">
          {['all', 'active', 'completed', 'cancelled'].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                filter === s
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {s === 'all' ? 'All' : statusLabels[s]}
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            setEditingProject(null)
            setProjectView('form')
          }}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors"
        >
          + New Project
        </button>
      </div>

      {loading ? (
        <div className="text-center text-gray-500 py-12">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center text-gray-400 py-12">No projects found</div>
      ) : (
        <div className="grid gap-4">
          {filtered.map((project) => (
            <div
              key={project.id}
              onClick={() => openDetail(project)}
              className="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow cursor-pointer"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-gray-900">{project.name}</h3>
                  {project.description && (
                    <p className="text-sm text-gray-500 mt-1">{project.description}</p>
                  )}
                </div>
                <span
                  className={`px-2 py-0.5 text-xs rounded-full font-medium ${statusColors[project.status]}`}
                >
                  {statusLabels[project.status]}
                </span>
              </div>
              <div className="mt-3 flex gap-4 text-xs text-gray-500">
                <span>
                  Dev: {format(new Date(project.dev_start_date), 'MM/dd')} ~{' '}
                  {format(new Date(project.dev_end_date), 'MM/dd')}
                </span>
                <span>
                  QA: {format(new Date(project.qa_start_date), 'MM/dd')} ~{' '}
                  {format(new Date(project.qa_end_date), 'MM/dd')}
                </span>
                <span>Deploy: {format(new Date(project.deploy_date), 'MM/dd')}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
