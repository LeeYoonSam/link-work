import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { format } from 'date-fns'
import type { Project, ProjectPriority } from '../../types'
import { STATUS_RANK, compareProjects } from '../../utils/projectOrder'
import MarkdownContent from '../memo/MarkdownContent'
import { Badge, Card, EmptyState, projectStatus, projectPriority, button, typo } from '../ui'
import PhaseHint from './PhaseHint'
import PriorityBadge from './PriorityBadge'
import ProjectExportModal from './ProjectExportModal'

// 상태 필터 옵션 — 'all'(전체) + STATUS_RANK의 진행 순서.
// 목록에 손으로 적어두면 상태가 늘 때마다 한쪽만 고쳐져 필터에서 빠진다(on_hold가 그랬다).
// 정렬 순위표에서 파생시켜 두면 상태가 추가되는 순간 필터에도 제자리로 들어온다.
const filterOptions = [
  'all',
  ...Object.keys(STATUS_RANK).sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b])
]

// 우선순위 그룹의 표시 순서. 미지정('none')은 항상 맨 뒤다.
const groupKeys: (ProjectPriority | 'none')[] = ['now', 'next', 'later', 'none']

const groupKeyOf = (p: Project): ProjectPriority | 'none' => p.priority ?? 'none'

export default function ProjectList(): React.ReactNode {
  const {
    projects,
    fetchProjects,
    setProjectView,
    setEditingProject,
    fetchProject,
    updateProject,
    reorderProjects,
    loading
  } = useProjectStore()
  const [filter, setFilter] = useState<string>('all')
  const [showExport, setShowExport] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const dragGroupRef = useRef<string | null>(null)

  useEffect(() => {
    fetchProjects()
  }, [])

  // 정렬 규칙은 utils/projectOrder.ts 하나뿐이다 — 목록·대시보드·트레이가 같은 순서를 본다.
  const sorted = [...projects].sort(compareProjects)
  const filtered = filter === 'all' ? sorted : sorted.filter((p) => p.status === filter)

  // 상태로 걸러낸 상태에서 끌면 화면에 없는 프로젝트를 건너뛴 인덱스가 sort_order로 저장돼
  // 순서가 뒤엉킨다. 순서 조정은 전체 목록을 보고 있을 때만 허용한다.
  const canReorder = filter === 'all'

  const groups = groupKeys
    .map((key) => ({ key, items: filtered.filter((p) => groupKeyOf(p) === key) }))
    .filter((g) => g.items.length > 0)

  const openDetail = (project: Project): void => {
    fetchProject(project.id)
    setProjectView('detail')
  }

  // 레벨을 바꾼 프로젝트는 새 그룹의 맨 뒤로 보낸다. sort_order를 그대로 들고 가면
  // 남의 그룹 한가운데로 끼어들어 사용자가 손으로 정해둔 순서를 흐트러뜨린다.
  const changePriority = (project: Project, next: ProjectPriority | null): void => {
    if ((project.priority ?? null) === next) return
    const lastInGroup = next
      ? projects
          .filter((p) => p.id !== project.id && p.priority === next)
          .reduce((max, p) => Math.max(max, p.sort_order ?? 0), -1)
      : -1
    updateProject(project.id, { priority: next, sort_order: lastInGroup + 1 })
  }

  const handleDragStart = (e: React.DragEvent, index: number, groupKey: string): void => {
    setDragIndex(index)
    dragGroupRef.current = groupKey
    e.dataTransfer.effectAllowed = 'move'
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5'
    }
  }

  const handleDragOver = (e: React.DragEvent, index: number, groupKey: string): void => {
    e.preventDefault()
    if (dragGroupRef.current !== groupKey) return
    e.dataTransfer.dropEffect = 'move'
    setOverIndex(index)
  }

  const handleDragEnd = (e: React.DragEvent, items: Project[]): void => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1'
    }
    if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
      const reordered = [...items]
      const [moved] = reordered.splice(dragIndex, 1)
      reordered.splice(overIndex, 0, moved)
      reorderProjects(reordered.map((item, i) => ({ id: item.id, sort_order: i })))
    }
    setDragIndex(null)
    setOverIndex(null)
    dragGroupRef.current = null
  }

  const renderProject = (
    project: Project,
    index: number,
    groupKey: string,
    items: Project[]
  ): React.ReactNode => {
    const status = projectStatus[project.status] ?? projectStatus.cancelled
    // 미지정 그룹은 상태순 자동 정렬이다 — compareProjects가 양쪽 priority가 있을 때만
    // sort_order를 보므로, 여기서 끌게 두면 저장은 되지만 화면은 제자리로 돌아온다.
    const draggable = canReorder && groupKey !== 'none'
    return (
      <div
        key={project.id}
        draggable={draggable}
        onDragStart={draggable ? (e) => handleDragStart(e, index, groupKey) : undefined}
        onDragOver={draggable ? (e) => handleDragOver(e, index, groupKey) : undefined}
        onDragEnd={draggable ? (e) => handleDragEnd(e, items) : undefined}
        onDragLeave={draggable ? () => setOverIndex(null) : undefined}
        className={`rounded-lg ${draggable ? 'cursor-grab active:cursor-grabbing' : ''} ${
          dragGroupRef.current === groupKey && overIndex === index
            ? 'border-t-2 border-blue-400'
            : ''
        }`}
      >
        <Card padding="sm" hover onClick={() => openDetail(project)}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-semibold text-gray-900">
                {draggable && <span className="mr-1.5 select-none text-xs text-gray-300">⠿</span>}
                {project.name}
              </h3>
              {project.description && (
                <div className="mt-1 text-gray-500 line-clamp-2 [&_*:not(a)]:!text-sm [&_*:not(a)]:!text-gray-500 [&_a]:!text-blue-600 [&_a]:!underline">
                  <MarkdownContent content={project.description} compact preserveNewlines />
                </div>
              )}
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <div className="flex items-center gap-1.5">
                <PriorityBadge
                  priority={project.priority ?? null}
                  size="xs"
                  onChange={(next) => changePriority(project, next)}
                />
                <Badge color={status.badge}>{status.label}</Badge>
              </div>
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
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-6">
        <label className="flex items-center gap-2 min-w-0">
          <span className={typo.microLabel}>Status</span>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="min-w-0 px-3 py-2 text-sm border border-gray-200 rounded-md bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            title="상태 필터"
          >
            {filterOptions.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'All' : (projectStatus[s] ?? projectStatus.cancelled).label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2 shrink-0">
          {/* 한글 라벨은 글자 단위로 개행된다 — nowrap 없이 두면 좁은 창에서 세로로 깨진다 */}
          <button
            onClick={() => setShowExport(true)}
            className={`px-4 py-2 text-sm whitespace-nowrap ${button.subtle}`}
          >
            내보내기
          </button>
          <button
            onClick={() => {
              setEditingProject(null)
              setProjectView('form')
            }}
            className={`px-4 py-2 text-sm whitespace-nowrap ${button.primary}`}
          >
            + New Project
          </button>
        </div>
      </div>

      {loading ? (
        <EmptyState>Loading...</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState>No projects found</EmptyState>
      ) : (
        <div className="space-y-6">
          {groups.map(({ key, items }) => {
            const style = projectPriority[key]
            return (
              // 미지정 그룹은 흐리게 둬서, 순위를 정한 프로젝트가 먼저 눈에 들어오게 한다.
              <section key={key} className={key === 'none' ? 'opacity-60' : ''}>
                <div className="mb-2 flex items-center gap-2 px-1">
                  <span className={`inline-block h-2 w-2 rounded-full ${style.dot}`} />
                  <span className={`${typo.microLabel} whitespace-nowrap`}>{style.label}</span>
                  <span className="text-xs text-gray-400">({items.length})</span>
                </div>
                <div className="grid gap-4">
                  {items.map((project, i) => renderProject(project, i, key, items))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      {/* 내보내기는 화면 필터와 무관하게 전체 프로젝트를 대상으로 한다 */}
      {showExport && <ProjectExportModal projects={sorted} onClose={() => setShowExport(false)} />}
    </div>
  )
}
