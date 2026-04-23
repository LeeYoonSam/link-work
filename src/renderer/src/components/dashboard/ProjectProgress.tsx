import { useEffect, useMemo, useState, useCallback } from 'react'
import type { Project, Task } from '../../types'
import { differenceInCalendarDays, format, eachDayOfInterval, isSameDay, isWithinInterval, isBefore, startOfDay, min, max } from 'date-fns'
import { filterBusinessDays, getDateMarkerType, isNewWeekStart } from '../../utils/timeline'

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

const taskStatusConfig: Record<string, { dot: string; badge: string; label: string }> = {
  pending: { dot: 'bg-gray-300', badge: 'bg-gray-100 text-gray-600', label: 'Pending' },
  in_progress: { dot: 'bg-yellow-400', badge: 'bg-yellow-100 text-yellow-700', label: 'In Progress' },
  done: { dot: 'bg-green-500', badge: 'bg-green-100 text-green-700', label: 'Done' }
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

  // expanded 분기 내에서 매 렌더마다 재계산되던 타임라인 파생값을 tasks/프로젝트 경계 기준으로 메모
  const timeline = useMemo(() => {
    const taskDateStrs = tasks
      .flatMap((t) => [t.start_date, t.end_date])
      .filter((d): d is string => !!d)
    const taskDateSet = new Set(taskDateStrs)
    const taskDays = taskDateStrs.map((d) => startOfDay(new Date(d)))
    const devStart = startOfDay(new Date(project.dev_start_date))
    const deployEnd = startOfDay(new Date(project.deploy_date))
    const projectStart = min([devStart, ...taskDays])
    const projectEnd = max([deployEnd, ...taskDays])
    const allDays = eachDayOfInterval({ start: projectStart, end: projectEnd })
    const timelineDays = filterBusinessDays(allDays, taskDateSet)
    return { taskDateSet, timelineDays }
  }, [tasks, project.dev_start_date, project.deploy_date])

  const formatTaskDate = (date: string | null): string => {
    if (!date) return '-'
    return format(new Date(date), 'MM/dd')
  }
  void formatTaskDate

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

      {expanded && totalTasks > 0 && (() => {
        const { taskDateSet, timelineDays } = timeline
        const today = startOfDay(new Date())

        const taskBarColor: Record<string, string> = {
          pending: 'bg-gray-300',
          in_progress: 'bg-yellow-400',
          done: 'bg-green-400'
        }

        const minCellWidth = 20
        const totalMinWidth = timelineDays.length * minCellWidth

        const getDayBorder = (day: Date, idx: number): string =>
          isNewWeekStart(day, idx) ? 'border-l-2 border-l-gray-300' : ''

        const getMarkerBg = (marker: ReturnType<typeof getDateMarkerType>): string => {
          if (marker === 'deploy') return 'bg-red-100'
          if (marker === 'dev_end') return 'bg-purple-100'
          if (marker === 'qa' || marker === 'qa_start' || marker === 'qa_end') return 'bg-orange-100'
          return ''
        }

        const rowH = 'h-6'
        const dayNames = ['일', '월', '화', '수', '목', '금', '토']

        return (
          <div className="border-t border-gray-200 py-3">
            <div className="flex">
              {/* Left: Task names (fixed, no scroll) */}
              <div className="w-32 shrink-0 pl-4 pr-2">
                <div className={`${rowH} flex items-end mb-1`}>
                  <span className="text-xs font-medium text-gray-500">Task</span>
                </div>
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className={`${rowH} flex items-center py-0.5`}
                  >
                    <span className="text-xs text-gray-800 truncate" title={task.name}>
                      {task.name}
                    </span>
                  </div>
                ))}
                <div className={`${rowH} mt-2`} />
              </div>

              {/* Middle: Timeline (scrollable) */}
              <div className="flex-1 min-w-0 overflow-x-auto">
                <div style={{ minWidth: `${totalMinWidth}px` }}>
                  {/* Date header */}
                  <div className={`${rowH} flex items-end gap-0.5 mb-1`}>
                    {timelineDays.map((day, idx) => {
                      const isToday = isSameDay(day, today)
                      const marker = getDateMarkerType(day, project)
                      const dayBorder = getDayBorder(day, idx)
                      const tooltipDate = `${format(day, 'MM/dd')}(${dayNames[day.getDay()]})`
                      const dayStr = format(day, 'yyyy-MM-dd')
                      const isTaskBoundary = taskDateSet.has(dayStr)
                      const showDate =
                        isToday ||
                        marker !== null ||
                        day.getDate() === 1 ||
                        idx === 0 ||
                        day.getDate() % 5 === 0 ||
                        isTaskBoundary
                      const isQaMarker = marker === 'qa' || marker === 'qa_start' || marker === 'qa_end'
                      const markerColorClass =
                        marker === 'deploy'
                          ? 'font-bold text-red-600'
                          : marker === 'dev_end'
                            ? 'font-bold text-purple-600'
                            : isQaMarker
                              ? 'font-bold text-orange-500'
                              : isToday
                                ? 'font-bold text-blue-600 bg-blue-100 rounded'
                                : 'text-gray-400'
                      return (
                        <div
                          key={day.toISOString()}
                          className={`text-center text-xs leading-tight flex-1 ${markerColorClass} ${dayBorder}`}
                          style={{ minWidth: `${minCellWidth}px` }}
                          title={tooltipDate}
                        >
                          {isToday
                            ? format(day, 'd')
                            : showDate
                              ? day.getDate() === 1 || idx === 0
                                ? format(day, 'M/d')
                                : format(day, 'd')
                              : ''}
                        </div>
                      )
                    })}
                  </div>

                  {/* Timeline cells */}
                  {tasks.map((task) => {
                    const taskStart = task.start_date ? startOfDay(new Date(task.start_date)) : null
                    const taskEnd = task.end_date ? startOfDay(new Date(task.end_date)) : null
                    return (
                      <div key={task.id} className={`${rowH} flex items-center gap-0.5 py-0.5`}>
                        {timelineDays.map((day, idx) => {
                          const isInRange =
                            taskStart &&
                            taskEnd &&
                            isWithinInterval(day, { start: taskStart, end: taskEnd })
                          const isToday = isSameDay(day, today)
                          const isPast = isBefore(day, today)
                          const isFirst = taskStart && isSameDay(day, taskStart)
                          const isLast = taskEnd && isSameDay(day, taskEnd)
                          const dayBorder = getDayBorder(day, idx)
                          const marker = getDateMarkerType(day, project)
                          const tooltipDate = `${format(day, 'MM/dd')}(${dayNames[day.getDay()]})${isInRange ? ` - ${task.name}` : ''}`

                          const markerBg = getMarkerBg(marker)
                          let cellClass = markerBg || 'bg-gray-100'
                          if (isInRange) {
                            if (task.status === 'done') {
                              cellClass = 'bg-green-400'
                            } else if (task.status === 'in_progress') {
                              cellClass = isPast || isToday ? 'bg-yellow-400' : 'bg-yellow-200'
                            } else {
                              cellClass = 'bg-gray-300'
                            }
                          }
                          const todayRing = isToday ? 'ring-2 ring-blue-500 ring-inset' : ''
                          return (
                            <div
                              key={day.toISOString()}
                              className={`h-5 flex-1 ${cellClass} ${todayRing} ${isFirst ? 'rounded-l' : ''} ${isLast ? 'rounded-r' : ''} ${dayBorder}`}
                              style={{ minWidth: `${minCellWidth}px` }}
                              title={tooltipDate}
                            />
                          )
                        })}
                      </div>
                    )
                  })}

                  {/* Today marker */}
                  <div className={`${rowH} flex items-center gap-0.5 mt-2`}>
                    {timelineDays.map((day, idx) => (
                      <div
                        key={day.toISOString()}
                        className={`text-center flex-1 ${getDayBorder(day, idx)}`}
                        style={{ minWidth: `${minCellWidth}px` }}
                      >
                        {isSameDay(day, today) ? (
                          <div className="text-xs text-blue-600 font-bold">▲</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Right: Status (fixed, no scroll) */}
              <div className="w-20 shrink-0 pl-2 pr-4">
                <div className={`${rowH} flex items-end justify-center mb-1`}>
                  <span className="text-xs font-medium text-gray-500">Status</span>
                </div>
                {tasks.map((task) => {
                  const statusCfg = taskStatusConfig[task.status]
                  return (
                    <div key={task.id} className={`${rowH} flex items-center justify-center py-0.5`}>
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
                  )
                })}
                <div className={`${rowH} mt-2`} />
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
