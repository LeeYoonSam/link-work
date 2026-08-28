import { addBusinessDays } from 'date-fns'
import {
  calculateProjectStatus,
  type ProjectDateFields
} from '../../renderer/src/utils/projectStatus'

// 상태 계산 규칙 자체는 renderer/src/utils/projectStatus.ts에 있다 — 렌더러 폼 미리보기와
// 같은 함수를 써야 "어디서 보든 같은 상태"가 성립하기 때문이다. main 쪽 호출부가 계속
// 이 모듈에서 가져다 쓸 수 있도록 여기서 다시 내보낸다.
export { calculateProjectStatus }
export type { ProjectDateFields }

// 개발 종료일 기준 QA/배포 기본 일정 계산.
// renderer 폼(project:calculateDates)과 AI 쓰기 도구(create_project)가 공용으로 사용한다.
export function calculateQaDates(devEndDate: string): {
  qaStart: string
  qaEnd: string
  deployDate: string
} {
  const devEnd = new Date(devEndDate)
  const qaStart = new Date(devEnd)
  qaStart.setDate(qaStart.getDate() + 1)

  const qaEnd = addBusinessDays(qaStart, 2)

  const deployDate = new Date(qaEnd)
  deployDate.setDate(deployDate.getDate() + 1)

  return {
    qaStart: qaStart.toISOString().split('T')[0],
    qaEnd: qaEnd.toISOString().split('T')[0],
    deployDate: deployDate.toISOString().split('T')[0]
  }
}

// 자동 상태 계산에 필요한 프로젝트 필드 — 날짜 5종에 저장된 상태·수동 여부를 더한 것.
export interface ProjectStatusFields extends ProjectDateFields {
  status: string
  status_manual: number
}

// status_manual=0(자동)인 프로젝트만 계산된 상태로 덮어쓴다. 수동 상태는 그대로 둔다.
export function applyProjectAutoStatus<T extends ProjectStatusFields>(p: T): T {
  return p.status_manual === 0 ? { ...p, status: calculateProjectStatus(p) } : p
}
