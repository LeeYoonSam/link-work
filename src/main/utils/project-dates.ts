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
