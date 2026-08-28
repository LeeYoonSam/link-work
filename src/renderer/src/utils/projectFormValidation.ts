import type { ProjectPriority } from '../types'
import { calculateProjectStatus, type ProjectDateFields } from './projectStatus'

/**
 * 프로젝트 상태·우선순위를 저장하기 전에 거치는 규칙들.
 *
 * "개발 중인 프로젝트는 우선순위가 반드시 있어야 한다"는 규칙은 저장 **결과** 상태를 보고
 * 판정해야 한다. 상태를 수동으로 골랐으면 그 값이, 자동(status_manual=0)이면 날짜에서
 * 계산된 값이 결과 상태다.
 */

/** 상태를 날짜 기반 자동 계산에 맡긴다는 뜻의 선택값. 실제 상태 이름이 아니다. */
export const AUTO_STATUS = 'auto'

/**
 * 상태 선택값을 프로젝트 저장 패치로 바꾼다.
 *
 * 'auto'만 자동 계산으로 돌아가고 나머지는 전부 수동 고정이다. 폼의 상태 select와
 * 상세 화면의 중단/재개 버튼이 같은 함수를 써야 "재개 = status_manual 0으로 복귀"라는
 * 뜻이 두 곳에서 갈라지지 않는다. status를 빼고 보내면 main의 project:update가 그 컬럼을
 * 건드리지 않으므로, 재개는 마지막 상태를 그대로 두고 자동 계산만 다시 켠다.
 */
export function statusSelectionPatch(value: string): { status?: string; status_manual: number } {
  if (value === AUTO_STATUS) return { status_manual: 0 }
  return { status: value, status_manual: 1 }
}

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
