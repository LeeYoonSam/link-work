import type { ProjectPriority } from '../types'

/**
 * 프로젝트 목록의 단일 정렬 규칙.
 *
 * 목록·대시보드·트레이 위젯이 각자 상태 순위표를 복사해 두고 있었고, 한쪽만 고치면
 * 같은 프로젝트가 화면마다 다른 자리에 놓였다. 세 화면 모두 여기서만 가져다 쓴다.
 * main 프로세스(services/tray-widget.ts)도 이 파일을 import한다 — 렌더러 전용 API를
 * 쓰지 말 것.
 */

export const PRIORITY_RANK: Record<ProjectPriority, number> = {
  now: 0,
  next: 1,
  later: 2
}

/** 우선순위 미지정 프로젝트가 놓이는 자리. 지정된 세 레벨 뒤에 온다. */
const UNPRIORITIZED_RANK = 3

export const STATUS_RANK: Record<string, number> = {
  development: 0,
  qa: 1,
  qa_pending: 2,
  deploy_pending: 3,
  deploy: 4,
  scheduled: 5,
  // 중단(수동 전용)은 진행 중인 상태 뒤, 끝난 상태(completed/cancelled) 앞에 온다 —
  // 손을 놓은 것이지 끝난 것은 아니라 다시 집어들 후보로 먼저 눈에 띄어야 한다.
  on_hold: 6,
  completed: 7,
  cancelled: 8
}

/**
 * 진행 중으로 간주해 대시보드·트레이 위젯에 노출하는 상태.
 * on_hold는 의도적으로 빠져 있다 — 중단한 프로젝트는 진행 중 화면에서 사라진다.
 */
export const ACTIVE_STATUSES = [
  'development',
  'qa',
  'qa_pending',
  'deploy_pending',
  'deploy',
  'scheduled'
] as const

export interface OrderableProject {
  priority?: ProjectPriority | null
  sort_order?: number
  status: string
  created_at: string
}

export function priorityRankOf(p: OrderableProject): number {
  const priority = p.priority
  if (!priority) return UNPRIORITIZED_RANK
  return PRIORITY_RANK[priority] ?? UNPRIORITIZED_RANK
}

export function compareProjects(a: OrderableProject, b: OrderableProject): number {
  const priorityDiff = priorityRankOf(a) - priorityRankOf(b)
  if (priorityDiff !== 0) return priorityDiff

  // sort_order는 사용자가 손으로 끌어 정한 순서라, 우선순위를 지정한 항목끼리만 의미가 있다.
  // 미지정 그룹은 기본값 0이 모두 같아 아래 상태 순으로 넘어간다.
  if (a.priority && b.priority && (a.sort_order ?? 0) !== (b.sort_order ?? 0)) {
    return (a.sort_order ?? 0) - (b.sort_order ?? 0)
  }

  const statusDiff = (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99)
  if (statusDiff !== 0) return statusDiff

  return b.created_at.localeCompare(a.created_at)
}
