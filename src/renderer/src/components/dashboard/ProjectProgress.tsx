import { useEffect, useState, useCallback } from 'react'
import type { Project, Task } from '../../types'
import { differenceInCalendarDays, format } from 'date-fns'
import ScheduleTimeline from '../project/ScheduleTimeline'
import { Badge, ProgressBar, projectStatus, urgency } from '../ui'
import PhaseHint from '../project/PhaseHint'
import PriorityBadge from '../project/PriorityBadge'
import { countLeafProgress } from '../../utils/taskTree'

type UrgencyLevel = 'early' | 'mid' | 'late'

function calculateProgress(startDate: string, endDate: string): number {
  const start = new Date(startDate)
  const end = new Date(endDate)
  const today = new Date()

  const total = differenceInCalendarDays(end, start)
  if (total <= 0) return 100

  const elapsed = differenceInCalendarDays(today, start)
  if (elapsed < 0) return 0

  return Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)))
}

function getUrgencyLevel(progress: number): UrgencyLevel {
  if (progress <= 33) return 'early'
  if (progress <= 66) return 'mid'
  return 'late'
}

const statusCardBg: Record<string, string> = {
  scheduled: 'bg-slate-50 border-slate-200',
  development: 'bg-green-50 border-green-200',
  qa_pending: 'bg-teal-50 border-teal-200',
  qa: 'bg-orange-50 border-orange-200',
  deploy_pending: 'bg-amber-50 border-amber-200',
  deploy: 'bg-red-50 border-red-200',
  completed: 'bg-blue-50 border-blue-200',
  cancelled: 'bg-gray-50 border-gray-200'
}

interface Props {
  project: Project
  initialTasks?: Task[]
}

export default function ProjectProgress({ project, initialTasks }: Props): React.ReactNode {
  const [tasks, setTasks] = useState<Task[]>(initialTasks ?? [])
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    // 부모(Dashboard)가 배치 로드 결과를 내려주면 그대로 사용.
    // 카드 단독 렌더 경로(다른 곳에서 사용)와의 호환을 위해 fallback fetch 유지.
    if (initialTasks) {
      setTasks(initialTasks)
      return
    }
    window.api.task.list(project.id).then(setTasks)
  }, [project.id, initialTasks])

  const cycleStatus = useCallback(async (task: Task) => {
    const nextStatus: Record<string, string> = {
      pending: 'in_progress',
      in_progress: 'done',
      done: 'pending'
    }
    await window.api.task.update(task.id, { status: nextStatus[task.status] })
    const updated = await window.api.task.list(project.id)
    setTasks(updated)
  }, [project.id])

  const today = new Date().toISOString().split('T')[0]
  const isDevOver = today > project.dev_end_date

  const progress = calculateProgress(project.dev_start_date, project.dev_end_date)
  const level = getUrgencyLevel(progress)
  const config = urgency[level]
  const status = projectStatus[project.status] ?? projectStatus.cancelled

  // 하위를 가진 상위는 롤업 대상에서 제외하고 leaf만 집계
  const { done: doneTasks, total: totalTasks } = countLeafProgress(tasks)
  const taskProgress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0

  return (
    <div className={`border rounded-lg ${statusCardBg[project.status] || 'bg-gray-50 border-gray-200'} min-w-0 overflow-hidden`}>
      <div
        className="p-4 cursor-pointer select-none"
        onClick={() => totalTasks > 0 && setExpanded(!expanded)}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="flex items-center gap-2">
              {totalTasks > 0 && (
                <span className="text-gray-400 text-xs">{expanded ? '▼' : '▶'}</span>
              )}
              <h4 className="font-semibold text-gray-900">{project.name}</h4>
              {/* 카드가 overflow-hidden이라 드롭다운이 잘린다 — 변경은 프로젝트 목록에서 한다 */}
              <PriorityBadge priority={project.priority ?? null} size="xs" />
            </div>
            <div className="flex gap-3 text-xs text-gray-500 mt-1 ml-5">
              <span>
                Dev: {format(new Date(project.dev_start_date), 'MM/dd')} ~{' '}
                {format(new Date(project.dev_end_date), 'MM/dd')}
              </span>
              <span>Deploy: {format(new Date(project.deploy_date), 'MM/dd')}</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            {!isDevOver && (
              <span className={`text-2xl font-bold ${config.text}`}>{progress}%</span>
            )}
            <Badge color={status.badge}>{status.label}</Badge>
            <PhaseHint project={project} today={today} />
          </div>
        </div>

        {!isDevOver && (
          <div className="mb-3">
            <ProgressBar percent={progress} color={config.bar} height="h-2.5" />
          </div>
        )}

        {totalTasks > 0 ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-600 font-medium">
              Tasks: {doneTasks}/{totalTasks} done
            </span>
            <div className="flex items-center gap-2">
              <div className="w-24">
                <ProgressBar percent={taskProgress} color="bg-green-500" height="h-1.5" />
              </div>
              <span className="text-xs text-gray-500">{taskProgress}%</span>
            </div>
          </div>
        ) : (
          <span className="text-xs text-gray-400">No tasks</span>
        )}
      </div>

      {expanded && totalTasks > 0 && (
        <div className="border-t border-gray-200 bg-white/60 px-4 py-3">
          <ScheduleTimeline
            project={project}
            tasks={tasks}
            onCycleStatus={cycleStatus}
            variant="compact"
          />
        </div>
      )}
    </div>
  )
}
