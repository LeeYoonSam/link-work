import type { OrderableProject } from '../../utils/projectOrder'
import { ACTIVE_STATUSES, compareProjects } from '../../utils/projectOrder'

/**
 * 대시보드 "지금 할 일" 카드의 선정 규칙.
 *
 * 후보를 늘어놓으면 대시보드를 볼 때마다 다시 고르게 된다. 정렬 1등 하나만 크게 내보내고
 * 나머지는 이름 한 줄로 줄인다. 순서 규칙 자체는 utils/projectOrder.ts 하나뿐이다.
 */

/** "다음:" 줄에 이름만 노출하는 후순위 개수 */
const UP_NEXT_COUNT = 2

/** 대시보드에 노출할 진행 중 프로젝트를 골라 정렬한다. */
export function sortActiveProjects<T extends OrderableProject>(projects: T[]): T[] {
  const active: readonly string[] = ACTIVE_STATUSES
  return projects.filter((p) => active.includes(p.status)).sort(compareProjects)
}

export interface FocusSelection<T> {
  /** 크게 보여줄 1등. 우선순위가 지정된 진행 중 프로젝트가 없으면 null */
  focus: T | null
  /** 그 다음 순위 (최대 UP_NEXT_COUNT개) */
  upNext: T[]
  /** 개발 중인데 우선순위가 비어 있는 건수. 날짜에 따른 자동 상태 전이로 생긴다 */
  unprioritizedDevCount: number
}

/**
 * 진행 중 프로젝트 목록에서 포커스 대상을 고른다. 입력이 정렬돼 있지 않아도 된다.
 *
 * 미지정(priority=null)은 정렬상 항상 뒤로 밀리므로 1등이 미지정이라는 건 지정된 것이
 * 하나도 없다는 뜻이다. 그때는 아무것도 내세우지 않고 빈 상태로 안내한다.
 */
export function selectFocus<T extends OrderableProject>(activeProjects: T[]): FocusSelection<T> {
  const sorted = activeProjects.slice().sort(compareProjects)
  const prioritized = sorted.filter((p) => p.priority)

  return {
    focus: prioritized[0] ?? null,
    upNext: prioritized.slice(1, 1 + UP_NEXT_COUNT),
    unprioritizedDevCount: sorted.filter((p) => p.status === 'development' && !p.priority).length
  }
}
