import { useEffect, useState, useCallback } from 'react'
import type { Project, Task } from '../../types'
import { differenceInCalendarDays, format } from 'date-fns'
import ScheduleTimeline from '../project/ScheduleTimeline'
import { Badge, ProgressBar, projectStatus } from '../ui'
import PhaseHint from '../project/PhaseHint'
import PriorityBadge from '../project/PriorityBadge'
import { countLeafProgress } from '../../utils/taskTree'

export type ScheduleLevel = 'early' | 'mid' | 'late'

// 일정 진행률 색 (부록 M.12 R3). 공용 토큰을 쓰지 않는다.
// 이유: 이 카드는 요약 타일 바로 아래에 와서 타일 4색(파랑·초록·보라·청록)을 쓰면 다른 뜻으로 읽힌다.
// late 빨강은 '위험' 뜻이다. 오늘 화면의 마감 빨강과 뜻이 같다
export const SCHEDULE_TONE: Record<ScheduleLevel, { bar: string; text: string }> = {
  early: { bar: 'bg-lime-500', text: 'text-lime-700' },
  mid: { bar: 'bg-amber-500', text: 'text-amber-700' },
  late: { bar: 'bg-red-500', text: 'text-red-700' }
}

// 작업 진행률 막대 색 (R4). 카드 안 강조는 일정 진행률 1개만 둔다
export const TASK_PROGRESS_BAR = 'bg-slate-400'

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

export function scheduleLevel(progress: number): ScheduleLevel {
  if (progress <= 33) return 'early'
  if (progress <= 66) return 'mid'
  return 'late'
}

// 상태별 카드 색 (R2). 활성 상태끼리 서로 다르고, 요약 타일 4색·중요 메모 yellow 와도 다르다
export const statusCardBg: Record<string, string> = {
  scheduled: 'bg-slate-50 border-slate-200',
  development: 'bg-lime-50 border-lime-300',
  qa_pending: 'bg-pink-50 border-pink-200',
  qa: 'bg-orange-50 border-orange-200',
  deploy_pending: 'bg-fuchsia-50 border-fuchsia-200',
  deploy: 'bg-red-50 border-red-200',
  completed: 'bg-stone-50 border-stone-200',
  // 중단은 되돌아올 수 있는 상태다 — 끝난 취소(회색 실선)와 달리 점선으로 "멈춰 있음"을 낸다
  on_hold: 'bg-zinc-50 border-zinc-300 border-dashed',
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
  const tone = SCHEDULE_TONE[scheduleLevel(progress)]
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
              <span className={`text-2xl font-bold ${tone.text}`}>{progress}%</span>
            )}
            <Badge color={status.badge}>{status.label}</Badge>
            <PhaseHint project={project} today={today} />
          </div>
        </div>

        {!isDevOver && (
          <div className="mb-3">
            <ProgressBar percent={progress} color={tone.bar} height="h-2.5" />
          </div>
        )}

        {totalTasks > 0 ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-600 font-medium">
              Tasks: {doneTasks}/{totalTasks} done
            </span>
            <div className="flex items-center gap-2">
              <div className="w-24">
                <ProgressBar percent={taskProgress} color={TASK_PROGRESS_BAR} height="h-1.5" />
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
