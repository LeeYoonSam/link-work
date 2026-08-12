import { useEffect, useMemo, useRef } from 'react'
import { eachDayOfInterval, format, isSameDay, max, min, startOfDay } from 'date-fns'
import type { Project, Task } from '../../types'
import { filterBusinessDays, isKoreanHoliday, isNewWeekStart, isWeekend } from '../../utils/timeline'
import { buildTaskTree } from '../../utils/taskTree'
import { Badge, TaskLabel, taskStatus, phase, typo } from '../ui'

interface Props {
  project: Project
  tasks: Task[]
  onCycleStatus?: (task: Task) => void
  variant?: 'compact' | 'full'
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
  // 작업명 2줄 수용을 위한 행 높이. 좌/중앙/우 3컬럼이 이 값을 공유해야 행이 정렬된다.
  const rowH = isFull ? 'h-9' : 'h-8'
  const barH = isFull ? 'h-5' : 'h-4'
  const dotSize = isFull ? 'w-3 h-3' : 'w-2.5 h-2.5'
  // 창을 넓히면 작업명 컬럼도 함께 넓어지도록 고정폭 대신 비율 기준 + 상하한
  const nameColW = isFull
    ? 'basis-[28%] min-w-[9rem] max-w-[22rem]'
    : 'basis-[30%] min-w-[7rem] max-w-[15rem]'
  // 2줄이 행 높이를 넘지 않도록 기본 line-height(16px)보다 좁힌다
  const nameLeading = isFull ? 'leading-[15px]' : 'leading-[14px]'
  // 라벨 박스를 2줄 높이로 고정한다 — 1줄/2줄에 따라 박스 높이가 달라지면
  // 행 간 시각 간격이 관계가 아니라 글자 수를 반영하게 된다(그룹 내부가 경계보다 넓어지는 역전).
  const labelBoxH = isFull ? 'h-[30px]' : 'h-7'
  // 관계가 가까울수록 간격이 좁다 — 그룹 내부(상위-하위, 형제)는 0, 그룹 경계에만 간격을 준다.
  // 좌/중앙/우 3컬럼에 똑같이 붙여야 간트 바와 상태 배지가 작업명과 어긋나지 않는다.
  const groupGap = isFull ? 'mt-2.5' : 'mt-2'

  // 상위→하위 순으로 평탄화한 렌더 순서. 바/도트 로직은 그대로 재사용하고
  // 행 순서와 이름 라벨 들여쓰기만 계층 기준으로 바꾼다.
  // isGroupStart는 "앞 그룹과의 경계" 표시라 첫 그룹에는 붙지 않는다.
  const orderedTasks = useMemo(() => {
    const flat: { task: Task; isChild: boolean; isGroupStart: boolean }[] = []
    for (const node of buildTaskTree(tasks)) {
      flat.push({ task: node.task, isChild: false, isGroupStart: flat.length > 0 })
      for (const child of node.children) {
        flat.push({ task: child, isChild: true, isGroupStart: false })
      }
    }
    return flat
  }, [tasks])

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
          {(['done', 'in_progress', 'pending'] as const).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className={`w-2.5 h-2.5 rounded-full ${taskStatus[s].dot}`} />
              {taskStatus[s].label}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rotate-45 rounded-[1px] ${phase.deploy.marker}`} />
            Deploy
          </span>
          <span className="flex items-center gap-1.5">
            <span className={`w-0.5 h-3 rounded-full ${phase.today.line}`} />
            Today
          </span>
        </div>
      )}

      <div className="flex">
        {/* Left: task names (flexible) */}
        <div className={`${nameColW} shrink-0 grow-0 pr-2`}>
          <div className="h-9 flex items-end pb-0.5">
            <span className={typo.microLabel}>Task</span>
          </div>
          {orderedTasks.map(({ task, isChild, isGroupStart }) => (
            <div
              key={task.id}
              className={`${rowH} flex items-center${isGroupStart ? ` ${groupGap}` : ''}${
                isChild ? ' pl-3' : ''
              }`}
            >
              {/* 바깥 상자는 2줄분 고정 높이다. 1줄 라벨도 같은 높이를 차지해야
                  행마다 여백이 달라지지 않는다 — 그러지 않으면 간격이 관계가 아니라
                  글자 수를 반영해 그룹 경계가 묻힌다. 안에서 중앙 정렬해 간트 바와 맞춘다. */}
              <div className={`${labelBoxH} flex-1 min-w-0 flex items-center`}>
                {/* 글리프는 라벨과 한 상자에 묶어 items-start로 첫 줄에 붙인다.
                    필요한 오프셋이 줄 수에 따라 달라져 고정값으로는 못 맞춘다. */}
                <div className="min-w-0 flex-1 flex items-start">
                  {/* 하위 글리프는 TaskLabel 밖에 둔다 — 이름에 섞으면 대괄호 접두사 파싱이 깨진다 */}
                  {isChild && (
                    <span className={`shrink-0 mr-0.5 text-xs text-gray-400 ${nameLeading}`}>↳</span>
                  )}
                  <TaskLabel
                    name={task.name}
                    lines={2}
                    leading={nameLeading}
                    className={`min-w-0 text-xs ${
                      isChild ? 'text-gray-500' : 'font-medium text-gray-800'
                    }`}
                  />
                </div>
              </div>
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
                    ? `${phase.deploy.text} font-bold`
                    : key === project.dev_end_date
                      ? `${phase.dev.text} font-semibold`
                      : key === project.qa_start_date || key === project.qa_end_date
                        ? `${phase.qa.text} font-semibold`
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
                      <span
                        className={`w-4 h-4 rounded-full ${phase.today.accent} text-white text-[10px] font-bold flex items-center justify-center`}
                      >
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
                        inQa ? phase.qa.tint : offDay ? 'bg-gray-100/60' : ''
                      }`}
                    />
                  )
                })}
              </div>

              {todayIdx >= 0 && (
                <div
                  className={`absolute inset-y-0 w-0.5 ${phase.today.line} rounded-full pointer-events-none z-10`}
                  style={{ left: `calc(${(((todayIdx + 0.5) / n) * 100).toFixed(4)}% - 1px)` }}
                />
              )}

              {orderedTasks.map(({ task, isGroupStart }) => {
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
                          title={`${task.name} · ${dayTooltip(days[sIdx])} · ${taskStatus[task.status].label}`}
                        >
                          <span className={`${dotSize} rounded-full shadow-sm ${taskStatus[task.status].dot}`} />
                        </div>
                      )
                    } else {
                      const elapsed =
                        task.status === 'in_progress' && todayIdx >= sIdx
                          ? Math.min(1, (todayIdx - sIdx + 1) / (eIdx - sIdx + 1))
                          : 0
                      content = (
                        <div
                          className={`relative overflow-hidden mx-[1px] rounded-full ${barH} ${taskStatus[task.status].bar}`}
                          style={{ gridColumn: `${sIdx + 1} / span ${eIdx - sIdx + 1}`, gridRow: 1 }}
                          title={`${task.name} · ${format(new Date(startStr), 'MM/dd')} ~ ${format(new Date(endStr), 'MM/dd')} · ${taskStatus[task.status].label}`}
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
                  <div
                    key={task.id}
                    className={`relative grid ${rowH} items-center${isGroupStart ? ` ${groupGap}` : ''}`}
                    style={gridTemplate}
                  >
                    {content}
                  </div>
                )
              })}

              {/* Phase band: Dev/QA 기간 + Deploy 마일스톤 */}
              <div className="grid h-6 mt-1.5 items-center" style={gridTemplate}>
                {devS >= 0 && devE >= devS && (
                  <div
                    className={`h-4 mx-[1px] rounded-full ${phase.dev.band} flex items-center justify-center text-[9px] font-semibold overflow-hidden`}
                    style={{ gridColumn: `${devS + 1} / span ${devE - devS + 1}`, gridRow: 1 }}
                    title={`Dev ${format(new Date(project.dev_start_date), 'MM/dd')} ~ ${format(new Date(project.dev_end_date), 'MM/dd')}`}
                  >
                    Dev
                  </div>
                )}
                {qaS >= 0 && qaE >= qaS && (
                  <div
                    className={`h-4 mx-[1px] rounded-full ${phase.qa.band} flex items-center justify-center text-[9px] font-semibold overflow-hidden`}
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
                    <span className={`w-2.5 h-2.5 ${phase.deploy.marker} rotate-45 rounded-[2px] shadow-sm`} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right: status badges (fixed) */}
        <div className="w-[92px] shrink-0 pl-2">
          <div className="h-9 flex items-end justify-center pb-0.5">
            <span className={typo.microLabel}>Status</span>
          </div>
          {orderedTasks.map(({ task, isGroupStart }) => (
            <div
              key={task.id}
              className={`${rowH} flex items-center justify-center${isGroupStart ? ` ${groupGap}` : ''}`}
            >
              <Badge
                color={taskStatus[task.status].badge}
                size="xs"
                title={onCycleStatus ? 'Click to change status' : undefined}
                onClick={
                  onCycleStatus
                    ? (e) => {
                        e.stopPropagation()
                        onCycleStatus(task)
                      }
                    : undefined
                }
              >
                {taskStatus[task.status].label}
              </Badge>
            </div>
          ))}
          <div className="h-6 mt-1.5" />
        </div>
      </div>
    </div>
  )
}
