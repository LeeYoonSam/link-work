import { useEffect, useState } from 'react'
import type { Project, Task } from '../../types'
import { format } from 'date-fns'

type UrgencyLevel = 'early' | 'mid' | 'late'

function calculateProgress(startDate: string, endDate: string): number {
  const start = new Date(startDate)
  const end = new Date(endDate)
  const today = new Date()

  const total = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
  if (total <= 0) return 100

  const elapsed = Math.ceil((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
  if (elapsed < 0) return 0

  return Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)))
}

function getUrgencyLevel(progress: number): UrgencyLevel {
  if (progress <= 33) return 'early'
  if (progress <= 66) return 'mid'
  return 'late'
}

const urgencyConfig: Record<UrgencyLevel, { bg: string; bar: string; text: string; label: string }> = {
  early: { bg: 'bg-green-50', bar: 'bg-green-500', text: 'text-green-700', label: 'Early' },
  mid: { bg: 'bg-blue-50', bar: 'bg-blue-500', text: 'text-blue-700', label: 'Mid' },
  late: { bg: 'bg-red-50', bar: 'bg-red-500', text: 'text-red-700', label: 'Late' }
}

const taskStatusConfig: Record<string, { dot: string; badge: string; label: string }> = {
  pending: { dot: 'bg-gray-300', badge: 'bg-gray-100 text-gray-600', label: 'Pending' },
  in_progress: { dot: 'bg-yellow-400', badge: 'bg-yellow-100 text-yellow-700', label: 'In Progress' },
  done: { dot: 'bg-green-500', badge: 'bg-green-100 text-green-700', label: 'Done' }
}

interface Props {
  project: Project
}

export default function ProjectProgress({ project }: Props): React.ReactNode {
  const [tasks, setTasks] = useState<Task[]>([])
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    window.api.task.list(project.id).then(setTasks)
  }, [project.id])

  const progress = calculateProgress(project.dev_start_date, project.deploy_date)
  const level = getUrgencyLevel(progress)
  const config = urgencyConfig[level]

  const doneTasks = tasks.filter((t) => t.status === 'done').length
  const totalTasks = tasks.length
  const taskProgress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0

  const formatTaskDate = (date: string | null): string => {
    if (!date) return '-'
    return format(new Date(date), 'MM/dd')
  }

  return (
    <div className={`border rounded-lg ${config.bg} border-gray-200`}>
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
            <span className={`text-2xl font-bold ${config.text}`}>{progress}%</span>
            <span
              className={`block text-xs font-medium px-2 py-0.5 rounded-full mt-1 ${config.bar} text-white`}
            >
              {config.label}
            </span>
          </div>
        </div>

        <div className="w-full bg-gray-200 rounded-full h-2.5 mb-3">
          <div
            className={`h-2.5 rounded-full transition-all duration-500 ${config.bar}`}
            style={{ width: `${progress}%` }}
          />
        </div>

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
        <div className="border-t border-gray-200 px-4 py-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500">
                <th className="text-left py-1.5 font-medium w-8">#</th>
                <th className="text-left py-1.5 font-medium">Task</th>
                <th className="text-center py-1.5 font-medium w-20">Start</th>
                <th className="text-center py-1.5 font-medium w-20">End</th>
                <th className="text-center py-1.5 font-medium w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task, index) => {
                const statusCfg = taskStatusConfig[task.status]
                return (
                  <tr key={task.id} className="border-t border-gray-100">
                    <td className="py-1.5 text-gray-400">{index + 1}</td>
                    <td className="py-1.5 text-gray-800">{task.name}</td>
                    <td className="py-1.5 text-center text-gray-500">
                      {formatTaskDate(task.start_date)}
                    </td>
                    <td className="py-1.5 text-center text-gray-500">
                      {formatTaskDate(task.end_date)}
                    </td>
                    <td className="py-1.5 text-center">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusCfg.badge}`}
                      >
                        {statusCfg.label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
