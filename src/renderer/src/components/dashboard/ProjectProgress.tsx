import { useEffect, useState, useCallback } from 'react'
import type { Project, Task } from '../../types'
import { format, eachDayOfInterval, isSameDay, isWithinInterval, isBefore, startOfDay } from 'date-fns'

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

      {expanded && totalTasks > 0 && (() => {
        const projectStart = startOfDay(new Date(project.dev_start_date))
        const projectEnd = startOfDay(new Date(project.deploy_date))
        const timelineDays = eachDayOfInterval({ start: projectStart, end: projectEnd })
        const today = startOfDay(new Date())

        const taskBarColor: Record<string, string> = {
          pending: 'bg-gray-300',
          in_progress: 'bg-yellow-400',
          done: 'bg-green-400'
        }

        return (
          <div className="border-t border-gray-200 px-4 py-3 overflow-x-auto">
            <div className="min-w-fit">
              {/* Header: task name column + day columns + status */}
              <div className="flex items-end gap-0 mb-1">
                <div className="w-32 shrink-0 text-xs font-medium text-gray-500 pr-2">Task</div>
                <div className="flex gap-px flex-1">
                  {timelineDays.map((day) => {
                    const isToday = isSameDay(day, today)
                    const showDate = isToday ||
                      day.getDate() === 1 ||
                      timelineDays.indexOf(day) === 0 ||
                      day.getDate() % 5 === 0
                    return (
                    <div
                      key={day.toISOString()}
                      className={`text-center text-xs leading-tight ${
                        isToday ? 'font-bold text-blue-600 bg-blue-100 rounded' : 'text-gray-400'
                      }`}
                      style={{ width: '20px', minWidth: '20px' }}
                    >
                      {isToday
                        ? format(day, 'd')
                        : showDate
                          ? (day.getDate() === 1 || timelineDays.indexOf(day) === 0)
                            ? format(day, 'M/d')
                            : format(day, 'd')
                          : ''}
                    </div>
                    )
                  })}
                </div>
                <div className="w-20 shrink-0 text-xs font-medium text-gray-500 text-center pl-2">
                  Status
                </div>
              </div>

              {/* Task rows */}
              {tasks.map((task) => {
                const statusCfg = taskStatusConfig[task.status]
                const taskStart = task.start_date ? startOfDay(new Date(task.start_date)) : null
                const taskEnd = task.end_date ? startOfDay(new Date(task.end_date)) : null

                return (
                  <div key={task.id} className="flex items-center gap-0 py-0.5">
                    <div
                      className="w-32 shrink-0 text-xs text-gray-800 pr-2 truncate"
                      title={task.name}
                    >
                      {task.name}
                    </div>
                    <div className="flex gap-px flex-1">
                      {timelineDays.map((day) => {
                        const isInRange =
                          taskStart &&
                          taskEnd &&
                          isWithinInterval(day, { start: taskStart, end: taskEnd })
                        const isToday = isSameDay(day, today)
                        const isPast = isBefore(day, today)
                        const isFirst = taskStart && isSameDay(day, taskStart)
                        const isLast = taskEnd && isSameDay(day, taskEnd)

                        let cellClass = 'bg-gray-100'
                        if (isInRange) {
                          if (task.status === 'done') {
                            cellClass = 'bg-green-400'
                          } else if (task.status === 'in_progress') {
                            cellClass = isPast || isToday ? 'bg-yellow-400' : 'bg-yellow-200'
                          } else {
                            cellClass = 'bg-gray-300'
                          }
                        }

                        return (
                          <div
                            key={day.toISOString()}
                            className={`h-5 ${cellClass} ${
                              isToday ? 'ring-1 ring-blue-500 ring-inset' : ''
                            } ${isFirst ? 'rounded-l' : ''} ${isLast ? 'rounded-r' : ''}`}
                            style={{ width: '20px', minWidth: '20px' }}
                            title={`${format(day, 'MM/dd')}${isInRange ? ` - ${task.name}` : ''}`}
                          />
                        )
                      })}
                    </div>
                    <div className="w-20 shrink-0 text-center pl-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          cycleStatus(task)
                        }}
                        className={`inline-block px-1.5 py-0.5 rounded-full text-xs font-medium cursor-pointer hover:opacity-70 transition-opacity ${statusCfg.badge}`}
                        title="Click to change status"
                      >
                        {statusCfg.label}
                      </button>
                    </div>
                  </div>
                )
              })}

              {/* Today marker label */}
              <div className="flex items-center gap-0 mt-2">
                <div className="w-32 shrink-0" />
                <div className="flex gap-px flex-1">
                  {timelineDays.map((day) => (
                    <div
                      key={day.toISOString()}
                      className="text-center"
                      style={{ width: '20px', minWidth: '20px' }}
                    >
                      {isSameDay(day, today) && (
                        <div className="text-xs text-blue-600 font-bold">▲</div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="w-20 shrink-0" />
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
