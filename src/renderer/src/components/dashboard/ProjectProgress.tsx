import { useEffect, useState, useCallback } from 'react'
import type { Project, Task } from '../../types'
import { format } from 'date-fns'
import ScheduleTimeline from '../project/ScheduleTimeline'
import { Badge, ProgressBar, projectStatus } from '../ui'
import PhaseHint from '../project/PhaseHint'
import PriorityBadge from '../project/PriorityBadge'
import { countLeafProgress } from '../../utils/taskTree'
import { devScheduleProgress, localToday } from '../../utils/projectPhase'

export type ScheduleLevel = 'early' | 'mid' | 'late'

// 일정 막대 색 (부록 M.12 R3, M.13). 공용 토큰을 쓰지 않는다.
// 이유: 이 카드는 요약 타일 바로 아래에 와서 타일 4색(파랑·초록·보라·청록)을 쓰면 다른 뜻으로 읽힌다.
// late 빨강은 '위험' 뜻이다. 오늘 화면의 마감 빨강과 뜻이 같다
export const SCHEDULE_TONE: Record<ScheduleLevel, { bar: string; text: string }> = {
  early: { bar: 'bg-lime-500', text: 'text-lime-700' },
  mid: { bar: 'bg-amber-500', text: 'text-amber-700' },
  late: { bar: 'bg-red-500', text: 'text-red-700' }
}

// 작업 완료율 막대 색 (부록 M.13). 큰 숫자와 굵은 막대는 작업 완료율이다
export const TASK_PROGRESS_BAR = 'bg-slate-400'

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

  const today = localToday()
  // 일정은 영업일 기준이다(PhaseHint 의 N/M일차와 같다). 개발 기간 밖이면 null 이다
  const schedule = devScheduleProgress(project, today)
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
            {totalTasks > 0 && (
              <div className="flex items-baseline gap-1">
                <span className="text-[11px] text-gray-400">작업 완료</span>
                <span className="text-2xl font-bold text-slate-800">{taskProgress}%</span>
              </div>
            )}
            <Badge color={status.badge}>{status.label}</Badge>
            <PhaseHint project={project} today={today} />
          </div>
        </div>

        {totalTasks > 0 && (
          <div className="mb-3">
            <ProgressBar percent={taskProgress} color={TASK_PROGRESS_BAR} height="h-2.5" />
          </div>
        )}

        <div className="flex items-center justify-between">
          {totalTasks > 0 ? (
            <span className="text-xs text-gray-600 font-medium">
              작업 {doneTasks}/{totalTasks} 완료
            </span>
          ) : (
            <span className="text-xs text-gray-400">No tasks</span>
          )}
          {schedule && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">일정</span>
              <div className="w-24">
                <ProgressBar
                  percent={schedule.percent}
                  color={SCHEDULE_TONE[scheduleLevel(schedule.percent)].bar}
                  height="h-1.5"
                />
              </div>
              <span className="text-xs text-gray-500 tabular-nums">{schedule.percent}%</span>
            </div>
          )}
        </div>
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
