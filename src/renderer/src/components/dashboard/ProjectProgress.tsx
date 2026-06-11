import { useEffect, useState, useCallback } from 'react'
import type { Project, Task } from '../../types'
import { differenceInCalendarDays, format } from 'date-fns'
import ScheduleTimeline from '../project/ScheduleTimeline'

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

const urgencyConfig: Record<
  UrgencyLevel,
  { bar: string; text: string; label: string }
> = {
  early: { bar: 'bg-green-500', text: 'text-green-700', label: 'Early' },
  mid: { bar: 'bg-blue-500', text: 'text-blue-700', label: 'Mid' },
  late: { bar: 'bg-red-500', text: 'text-red-700', label: 'Late' }
}

const statusCardBg: Record<string, string> = {
  scheduled: 'bg-slate-50 border-slate-200',
  development: 'bg-green-50 border-green-200',
  qa: 'bg-orange-50 border-orange-200',
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
  const config = urgencyConfig[level]

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

  const doneTasks = tasks.filter((t) => t.status === 'done').length
  const totalTasks = tasks.length
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
            </div>
            <div className="flex gap-3 text-xs text-gray-500 mt-1 ml-5">
              <span>
                Dev: {format(new Date(project.dev_start_date), 'MM/dd')} ~{' '}
                {format(new Date(project.dev_end_date), 'MM/dd')}
              </span>
              <span>Deploy: {format(new Date(project.deploy_date), 'MM/dd')}</span>
            </div>
          </div>
          <div className="text-right">
            {!isDevOver && (
              <span className={`text-2xl font-bold ${config.text}`}>{progress}%</span>
            )}
            <span
              className={`block text-xs font-medium px-2 py-0.5 rounded-full mt-1 ${statusColors[project.status] || 'bg-gray-400'} text-white`}
            >
              {statusLabels[project.status] || project.status}
            </span>
          </div>
        </div>

        {!isDevOver && (
          <div className="w-full bg-gray-200 rounded-full h-2.5 mb-3">
            <div
              className={`h-2.5 rounded-full transition-all duration-500 ${config.bar}`}
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {totalTasks > 0 ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-600 font-medium">
              Tasks: {doneTasks}/{totalTasks} done
            </span>
            <div className="flex items-center gap-2">
              <div className="w-24 bg-gray-200 rounded-full h-1.5">
                <div
                  className="h-1.5 rounded-full bg-green-500 transition-all duration-500"
                  style={{ width: `${taskProgress}%` }}
                />
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
