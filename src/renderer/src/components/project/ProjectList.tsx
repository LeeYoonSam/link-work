import { useEffect, useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { format } from 'date-fns'
import type { Project } from '../../types'
import MarkdownContent from '../memo/MarkdownContent'
import { Badge, Card, EmptyState, projectStatus, button } from '../ui'

export default function ProjectList(): React.ReactNode {
  const { projects, fetchProjects, setProjectView, setEditingProject, fetchProject, loading } =
    useProjectStore()
  const [filter, setFilter] = useState<string>('all')

  useEffect(() => {
    fetchProjects()
  }, [])

  const today = new Date().toISOString().split('T')[0]
  const sorted = [...projects].sort((a, b) => {
    const aExpired = a.deploy_date < today ? 1 : 0
    const bExpired = b.deploy_date < today ? 1 : 0
    if (aExpired !== bExpired) return aExpired - bExpired
    return b.created_at.localeCompare(a.created_at)
  })
  const filtered = filter === 'all' ? sorted : sorted.filter((p) => p.status === filter)

  const openDetail = (project: Project): void => {
    fetchProject(project.id)
    setProjectView('detail')
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-2">
          {['all', 'scheduled', 'development', 'qa', 'deploy', 'completed', 'cancelled'].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1.5 text-sm ${filter === s ? button.dark : button.subtle}`}
            >
              {s === 'all' ? 'All' : projectStatus[s].label}
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            setEditingProject(null)
            setProjectView('form')
          }}
          className={`px-4 py-2 text-sm ${button.primary}`}
        >
          + New Project
        </button>
      </div>

      {loading ? (
        <EmptyState>Loading...</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState>No projects found</EmptyState>
      ) : (
        <div className="grid gap-4">
          {filtered.map((project) => (
            <Card key={project.id} padding="sm" hover onClick={() => openDetail(project)}>
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-gray-900">{project.name}</h3>
                  {project.description && (
                    <div className="mt-1 text-gray-500 line-clamp-2 [&_*:not(a)]:!text-sm [&_*:not(a)]:!text-gray-500 [&_a]:!text-blue-600 [&_a]:!underline">
                      <MarkdownContent
                        content={project.description}
                        compact
                        preserveNewlines
                      />
                    </div>
                  )}
                </div>
                <Badge color={projectStatus[project.status].badge}>
                  {projectStatus[project.status].label}
                </Badge>
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
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
