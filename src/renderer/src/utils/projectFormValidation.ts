import type { ProjectPriority } from '../types'
import { calculateProjectStatus, type ProjectDateFields } from './projectStatus'

/**
 * 프로젝트 폼 저장 전 검증 규칙.
 *
 * "개발 중인 프로젝트는 우선순위가 반드시 있어야 한다"는 규칙은 저장 **결과** 상태를 보고
 * 판정해야 한다. 상태를 수동으로 골랐으면 그 값이, 자동(status_manual=0)이면 날짜에서
 * 계산된 값이 결과 상태다.
 */

/** 우선순위가 필수인 상태. 지금은 개발 중 하나뿐이다. */
export const PRIORITY_REQUIRED_STATUS = 'development'

export const PRIORITY_REQUIRED_MESSAGE = '개발 중 프로젝트는 우선순위를 지정해야 합니다'

export interface ProjectDraft extends ProjectDateFields {
  status: string
  status_manual: number
  priority?: ProjectPriority | null
}

/**
 * 저장했을 때 이 프로젝트가 갖게 될 상태.
 *
 * 날짜가 아직 다 채워지지 않은 동안에는 자동 계산이 빈 문자열 비교로 엉뚱한 상태
 * ('completed' 등)를 내놓는다. 그때는 계산하지 않고 폼에 들어있는 상태를 그대로 쓴다 —
 * 없는 근거로 저장을 막는 것보다 통과시키는 편이 낫다.
 */
export function resolveEffectiveStatus(draft: ProjectDraft, todayStr?: string): string {
  if (draft.status_manual === 1) return draft.status
  const dates = [
    draft.dev_start_date,
    draft.dev_end_date,
    draft.qa_start_date,
    draft.qa_end_date,
    draft.deploy_date
  ]
  if (dates.some((d) => !d)) return draft.status
  return calculateProjectStatus(draft, todayStr)
}

/** 저장을 막아야 하면 사용자에게 보여줄 메시지를, 통과면 null을 돌려준다. */
export function validateProjectDraft(draft: ProjectDraft, todayStr?: string): string | null {
  const status = resolveEffectiveStatus(draft, todayStr)
  if (status === PRIORITY_REQUIRED_STATUS && !draft.priority) return PRIORITY_REQUIRED_MESSAGE
  return null
}
