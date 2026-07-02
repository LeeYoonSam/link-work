import { useEffect, useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { format } from 'date-fns'
import type { Project } from '../../types'
import MarkdownContent from '../memo/MarkdownContent'
import { Badge, Card, EmptyState, projectStatus, button } from '../ui'
import PhaseHint from './PhaseHint'

export default function ProjectList(): React.ReactNode {
  const { projects, fetchProjects, setProjectView, setEditingProject, fetchProject, loading } =
    useProjectStore()
  const [filter, setFilter] = useState<string>('all')

  useEffect(() => {
    fetchProjects()
  }, [])

  // 진행 중(development/qa)을 최상단, 그다음 대기·배포 임박(qa_pending/deploy_pending/deploy),
  // 이후 예정(scheduled), 완료/취소 순. 같은 그룹 내에서는 최신 생성순.
  const statusOrder: Record<string, number> = {
    development: 0,
    qa: 1,
    qa_pending: 2,
    deploy_pending: 3,
    deploy: 4,
    scheduled: 5,
    completed: 6,
    cancelled: 7
  }
  const sorted = [...projects].sort((a, b) => {
    const ao = statusOrder[a.status] ?? 99
    const bo = statusOrder[b.status] ?? 99
    if (ao !== bo) return ao - bo
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
          {['all', 'scheduled', 'development', 'qa_pending', 'qa', 'deploy_pending', 'deploy', 'completed', 'cancelled'].map((s) => (
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
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Badge color={projectStatus[project.status].badge}>
                    {projectStatus[project.status].label}
                  </Badge>
                  <PhaseHint project={project} />
                </div>
              </div>
              {/* 단계별 색상은 상태 배지와 동일한 의미 체계 (개발=초록/QA=주황/배포=빨강 — ui/tokens.ts) */}
              <div className="mt-3 flex flex-wrap gap-4 text-xs">
                <span className="text-green-700">
                  <span className="font-medium">Dev:</span>{' '}
                  {format(new Date(project.dev_start_date), 'MM/dd')} ~{' '}
                  {format(new Date(project.dev_end_date), 'MM/dd')}
                </span>
                <span className="text-orange-700">
                  <span className="font-medium">QA:</span>{' '}
                  {format(new Date(project.qa_start_date), 'MM/dd')} ~{' '}
                  {format(new Date(project.qa_end_date), 'MM/dd')}
                </span>
                <span className="text-red-700">
                  <span className="font-medium">Deploy:</span>{' '}
                  {format(new Date(project.deploy_date), 'MM/dd')}
                </span>
                {project.deploy_version && (
                  <span className="px-1.5 py-0.5 -my-0.5 rounded bg-gray-100 text-gray-600 font-medium">
                    v{project.deploy_version}
                  </span>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
