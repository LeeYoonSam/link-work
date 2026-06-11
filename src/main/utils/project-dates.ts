import { addBusinessDays } from 'date-fns'

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

// 자동 상태 계산에 필요한 프로젝트 필드.
export interface ProjectStatusFields {
  status: string
  status_manual: number
  dev_start_date: string
  qa_start_date: string
  qa_end_date: string
  deploy_date: string
}

// 오늘 날짜를 기준으로 프로젝트의 진행 단계를 계산한다.
// project.ipc(메뉴), AI 조회 도구, 승인 카드 미리보기가 공용으로 사용해
// "어디서 보든 같은 상태"를 보장한다.
export function calculateProjectStatus(p: ProjectStatusFields): string {
  const today = new Date().toISOString().split('T')[0]
  if (today < p.dev_start_date) return 'scheduled'
  if (today > p.deploy_date) return 'completed'
  if (today === p.deploy_date) return 'deploy'
  if (today >= p.qa_start_date && today <= p.qa_end_date) return 'qa'
  return 'development'
}

// status_manual=0(자동)인 프로젝트만 계산된 상태로 덮어쓴다. 수동 상태는 그대로 둔다.
export function applyProjectAutoStatus<T extends ProjectStatusFields>(p: T): T {
  return p.status_manual === 0 ? { ...p, status: calculateProjectStatus(p) } : p
}
