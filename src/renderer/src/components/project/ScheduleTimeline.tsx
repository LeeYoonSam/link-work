import { useEffect, useMemo, useRef } from 'react'
import { eachDayOfInterval, format, isSameDay, max, min, startOfDay } from 'date-fns'
import type { Project, Task } from '../../types'
import { filterBusinessDays, isKoreanHoliday, isNewWeekStart, isWeekend } from '../../utils/timeline'

interface Props {
  project: Project
  tasks: Task[]
  onCycleStatus?: (task: Task) => void
  variant?: 'compact' | 'full'
}

const statusLabels: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  done: 'Done'
}

const statusBadge: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-600',
  in_progress: 'bg-yellow-100 text-yellow-700',
  done: 'bg-green-100 text-green-700'
}

// Soft Status Pills: 파스텔 배경(100) + 톤 다운 보더(300), pending은 미착수 표시로 점선
const barStyle: Record<string, string> = {
  pending: 'bg-gray-100 border border-dashed border-gray-300',
  in_progress: 'bg-yellow-100 border border-yellow-300',
  done: 'bg-green-200/80 border border-green-300'
}

const dotStyle: Record<string, string> = {
  pending: 'bg-white border-2 border-gray-300',
  in_progress: 'bg-yellow-400 border border-yellow-500',
  done: 'bg-green-500 border border-green-600'
}

const dayNames = ['일', '월', '화', '수', '목', '금', '토']

export default function ScheduleTimeline({
  project,
  tasks,
  onCycleStatus,
  variant = 'compact'
}: Props): React.ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null)
  const isFull = variant === 'full'
  const minCell = isFull ? 28 : 22
  const rowH = isFull ? 'h-8' : 'h-7'
  const barH = isFull ? 'h-5' : 'h-4'
  const dotSize = isFull ? 'w-3 h-3' : 'w-2.5 h-2.5'
  const nameColW = isFull ? 'w-44' : 'w-32'

  const { days, dayKeys } = useMemo(() => {
    const taskDateStrs = tasks
      .flatMap((t) => [t.start_date, t.end_date])
      .filter((d): d is string => !!d)
    const taskDateSet = new Set(taskDateStrs)
    const taskDays = taskDateStrs.map((d) => startOfDay(new Date(d)))
    const devStart = startOfDay(new Date(project.dev_start_date))
    const deployEnd = startOfDay(new Date(project.deploy_date))
    const allDays = eachDayOfInterval({
      start: min([devStart, ...taskDays]),
      end: max([deployEnd, ...taskDays])
    })
    const businessDays = filterBusinessDays(allDays, taskDateSet)
    return { days: businessDays, dayKeys: businessDays.map((d) => format(d, 'yyyy-MM-dd')) }
  }, [tasks, project.dev_start_date, project.deploy_date])

  const n = days.length
  const today = startOfDay(new Date())
  const todayIdx = days.findIndex((d) => isSameDay(d, today))
  const gridTemplate = { gridTemplateColumns: `repeat(${n}, minmax(${minCell}px, 1fr))` }

  // 주말/공휴일이 필터링된 축이므로 정확히 일치하는 날이 없으면 가장 가까운 칸으로 클램프
  const spanStart = (dateStr: string): number => dayKeys.findIndex((k) => k >= dateStr)
  const spanEnd = (dateStr: string): number => {
    for (let i = n - 1; i >= 0; i--) if (dayKeys[i] <= dateStr) return i
    return -1
  }

  const monthGroups = useMemo(() => {
    const groups: { label: string; start: number; span: number }[] = []
    days.forEach((d, i) => {
      const label = format(d, "M'월'")
      const last = groups[groups.length - 1]
      if (last && last.label === label) last.span++
      else groups.push({ label, start: i, span: 1 })
    })
    return groups
  }, [days])

  // 펼침/데이터 변경 시 오늘 날짜를 스크롤 영역 가운데로 정렬
  useEffect(() => {
    const container = scrollRef.current
    if (!container || n === 0 || todayIdx < 0) return
    const total = container.scrollWidth
    const visible = container.clientWidth
    if (total <= visible) return
    const cellWidth = total / n
    const target = cellWidth * (todayIdx + 0.5) - visible / 2
    container.scrollLeft = Math.max(0, Math.min(total - visible, target))
  }, [n, todayIdx])

  if (n === 0 || tasks.length === 0) return null

  const devS = spanStart(project.dev_start_date)
  const devE = spanEnd(project.dev_end_date)
  const qaS = project.qa_start_date ? spanStart(project.qa_start_date) : -1
  const qaE = project.qa_end_date ? spanEnd(project.qa_end_date) : -1
  const deployIdx = spanEnd(project.deploy_date)

  const dayTooltip = (day: Date): string => `${format(day, 'MM/dd')}(${dayNames[day.getDay()]})`

  return (
    <div>
      {isFull && (
        <div className="flex items-center gap-4 mb-3 text-[11px] text-gray-500">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
            Done
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
            In Progress
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-white border-2 border-gray-300" />
            Pending
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 bg-red-500 rotate-45 rounded-[1px]" />
            Deploy
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-0.5 h-3 bg-blue-500 rounded-full" />
            Today
          </span>
        </div>
      )}

      <div className="flex">
        {/* Left: task names (fixed) */}
        <div className={`${nameColW} shrink-0 pr-2`}>
          <div className="h-9 flex items-end pb-0.5">
            <span className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">
              Task
            </span>
          </div>
          {tasks.map((task) => (
            <div key={task.id} className={`${rowH} flex items-center`}>
              <span className="text-xs text-gray-800 truncate" title={task.name}>
                {task.name}
              </span>
            </div>
          ))}
          <div className="h-6 mt-1.5" />
        </div>

        {/* Middle: timeline (scrollable) */}
        <div ref={scrollRef} className="flex-1 min-w-0 overflow-x-auto">
          <div style={{ minWidth: `${n * minCell}px` }}>
            {/* Month row */}
            <div className="grid h-4" style={gridTemplate}>
              {monthGroups.map((g) => (
                <div
                  key={g.start}
                  className="text-[10px] font-medium text-gray-400 pl-1 border-l border-gray-200 leading-4 truncate"
                  style={{ gridColumn: `${g.start + 1} / span ${g.span}`, gridRow: 1 }}
                >
                  {g.span >= 2 ? g.label : ''}
                </div>
              ))}
            </div>

            {/* Day row */}
            <div className="grid h-5" style={gridTemplate}>
              {days.map((day, idx) => {
                const key = dayKeys[idx]
                const isToday = idx === todayIdx
                const offDay = isWeekend(day) || isKoreanHoliday(day)
                const dayColor =
                  key === project.deploy_date
                    ? 'text-red-600 font-bold'
                    : key === project.dev_end_date
                      ? 'text-purple-600 font-semibold'
                      : key === project.qa_start_date || key === project.qa_end_date
                        ? 'text-orange-500 font-semibold'
                        : offDay
                          ? 'text-gray-300'
                          : 'text-gray-400'
                return (
                  <div
                    key={key}
                    className="flex items-center justify-center"
                    title={dayTooltip(day)}
                  >
                    {isToday ? (
                      <span className="w-4 h-4 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center">
                        {format(day, 'd')}
                      </span>
                    ) : (
                      <span className={`text-[10px] ${dayColor}`}>{format(day, 'd')}</span>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Rows region: bg columns + today line + task rows + phase band */}
            <div className="relative">
              <div className="absolute inset-0 grid" style={gridTemplate}>
                {days.map((day, idx) => {
                  const offDay = isWeekend(day) || isKoreanHoliday(day)
                  const inQa = qaS >= 0 && qaE >= qaS && idx >= qaS && idx <= qaE
                  return (
                    <div
                      key={dayKeys[idx]}
                      className={`${isNewWeekStart(day, idx) ? 'border-l border-gray-200/70' : ''} ${
                        inQa ? 'bg-orange-50/80' : offDay ? 'bg-gray-100/60' : ''
                      }`}
                    />
                  )
                })}
              </div>

              {todayIdx >= 0 && (
                <div
                  className="absolute inset-y-0 w-0.5 bg-blue-500/70 rounded-full pointer-events-none z-10"
                  style={{ left: `calc(${(((todayIdx + 0.5) / n) * 100).toFixed(4)}% - 1px)` }}
                />
              )}

              {tasks.map((task) => {
                const startStr = task.start_date ?? task.end_date
                const endStr = task.end_date ?? task.start_date
                let content: React.ReactNode = null

                if (startStr && endStr) {
                  const sIdx = spanStart(startStr)
                  const eIdx = spanEnd(endStr)
                  if (sIdx >= 0 && eIdx >= sIdx) {
                    if (startStr === endStr) {
                      content = (
                        <div
                          className="flex items-center justify-center"
                          style={{ gridColumn: `${sIdx + 1}`, gridRow: 1 }}
                          title={`${task.name} · ${dayTooltip(days[sIdx])} · ${statusLabels[task.status]}`}
                        >
                          <span className={`${dotSize} rounded-full shadow-sm ${dotStyle[task.status]}`} />
                        </div>
                      )
                    } else {
                      const elapsed =
                        task.status === 'in_progress' && todayIdx >= sIdx
                          ? Math.min(1, (todayIdx - sIdx + 1) / (eIdx - sIdx + 1))
                          : 0
                      content = (
                        <div
                          className={`relative overflow-hidden mx-[1px] rounded-full ${barH} ${barStyle[task.status]}`}
                          style={{ gridColumn: `${sIdx + 1} / span ${eIdx - sIdx + 1}`, gridRow: 1 }}
                          title={`${task.name} · ${format(new Date(startStr), 'MM/dd')} ~ ${format(new Date(endStr), 'MM/dd')} · ${statusLabels[task.status]}`}
                        >
                          {elapsed > 0 && (
                            <div
                              className="absolute inset-y-0 left-0 bg-yellow-300/80 rounded-full"
                              style={{ width: `${(elapsed * 100).toFixed(2)}%` }}
                            />
                          )}
                        </div>
                      )
                    }
                  }
                }

                return (
                  <div key={task.id} className={`relative grid ${rowH} items-center`} style={gridTemplate}>
                    {content}
                  </div>
                )
              })}

              {/* Phase band: Dev/QA 기간 + Deploy 마일스톤 */}
              <div className="grid h-6 mt-1.5 items-center" style={gridTemplate}>
                {devS >= 0 && devE >= devS && (
                  <div
                    className="h-4 mx-[1px] rounded-full bg-purple-100/80 flex items-center justify-center text-[9px] font-semibold text-purple-600 overflow-hidden"
                    style={{ gridColumn: `${devS + 1} / span ${devE - devS + 1}`, gridRow: 1 }}
                    title={`Dev ${format(new Date(project.dev_start_date), 'MM/dd')} ~ ${format(new Date(project.dev_end_date), 'MM/dd')}`}
                  >
                    Dev
                  </div>
                )}
                {qaS >= 0 && qaE >= qaS && (
                  <div
                    className="h-4 mx-[1px] rounded-full bg-orange-100 flex items-center justify-center text-[9px] font-semibold text-orange-600 overflow-hidden"
                    style={{ gridColumn: `${qaS + 1} / span ${qaE - qaS + 1}`, gridRow: 1 }}
                    title={`QA ${format(new Date(project.qa_start_date), 'MM/dd')} ~ ${format(new Date(project.qa_end_date), 'MM/dd')}`}
                  >
                    QA
                  </div>
                )}
                {deployIdx >= 0 && (
                  <div
                    className="flex items-center justify-center"
                    style={{ gridColumn: `${deployIdx + 1}`, gridRow: 1 }}
                    title={`Deploy ${format(new Date(project.deploy_date), 'MM/dd')}`}
                  >
                    <span className="w-2.5 h-2.5 bg-red-500 rotate-45 rounded-[2px] shadow-sm" />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right: status badges (fixed) */}
        <div className="w-[92px] shrink-0 pl-2">
          <div className="h-9 flex items-end justify-center pb-0.5">
            <span className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">
              Status
            </span>
          </div>
          {tasks.map((task) => (
            <div key={task.id} className={`${rowH} flex items-center justify-center`}>
              {onCycleStatus ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onCycleStatus(task)
                  }}
                  className={`px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap cursor-pointer hover:opacity-70 transition-opacity ${statusBadge[task.status]}`}
                  title="Click to change status"
                >
                  {statusLabels[task.status]}
                </button>
              ) : (
                <span
                  className={`px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${statusBadge[task.status]}`}
                >
                  {statusLabels[task.status]}
                </span>
              )}
            </div>
          ))}
          <div className="h-6 mt-1.5" />
        </div>
      </div>
    </div>
  )
}
