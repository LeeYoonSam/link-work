import { describe, it, expect } from 'vitest'
import { calculateProjectStatus, type ProjectStatusFields } from './project-dates'

// calculateProjectStatus는 내부에서 오늘(UTC 기준)을 읽으므로,
// 실행 시점과 무관하게 결정적으로 검증하려고 오늘을 기준으로 한 UTC 오프셋 날짜를 만든다.
function isoOffset(days: number): string {
  const base = new Date(new Date().toISOString().split('T')[0] + 'T00:00:00Z')
  base.setUTCDate(base.getUTCDate() + days)
  return base.toISOString().split('T')[0]
}

function fields(overrides: Partial<ProjectStatusFields>): ProjectStatusFields {
  return {
    status: 'development',
    status_manual: 0,
    dev_start_date: isoOffset(-1),
    dev_end_date: isoOffset(1),
    qa_start_date: isoOffset(3),
    qa_end_date: isoOffset(5),
    deploy_date: isoOffset(7),
    ...overrides
  }
}

describe('calculateProjectStatus', () => {
  it('개발 시작 전이면 scheduled', () => {
    expect(calculateProjectStatus(fields({ dev_start_date: isoOffset(1) }))).toBe('scheduled')
  })

  it('개발 기간 중이면 development', () => {
    expect(calculateProjectStatus(fields({}))).toBe('development')
  })

  it('개발 종료 ~ QA 시작 사이의 공백이면 qa_pending', () => {
    const p = fields({
      dev_start_date: isoOffset(-5),
      dev_end_date: isoOffset(-1),
      qa_start_date: isoOffset(1),
      qa_end_date: isoOffset(3),
      deploy_date: isoOffset(5)
    })
    expect(calculateProjectStatus(p)).toBe('qa_pending')
  })

  it('QA 기간 중이면 qa', () => {
    const p = fields({
      dev_start_date: isoOffset(-5),
      dev_end_date: isoOffset(-3),
      qa_start_date: isoOffset(-1),
      qa_end_date: isoOffset(1),
      deploy_date: isoOffset(3)
    })
    expect(calculateProjectStatus(p)).toBe('qa')
  })

  it('QA 종료 ~ 배포일 사이의 공백이면 deploy_pending', () => {
    const p = fields({
      dev_start_date: isoOffset(-6),
      dev_end_date: isoOffset(-4),
      qa_start_date: isoOffset(-3),
      qa_end_date: isoOffset(-1),
      deploy_date: isoOffset(1)
    })
    expect(calculateProjectStatus(p)).toBe('deploy_pending')
  })

  it('배포일 당일이면 deploy', () => {
    expect(calculateProjectStatus(fields({ deploy_date: isoOffset(0) }))).toBe('deploy')
  })

  it('배포일이 지났으면 completed', () => {
    expect(calculateProjectStatus(fields({ deploy_date: isoOffset(-1) }))).toBe('completed')
  })
})
