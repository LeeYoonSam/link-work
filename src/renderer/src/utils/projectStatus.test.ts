import { describe, expect, it } from 'vitest'
import { calculateProjectStatus, type ProjectDateFields } from './projectStatus'

// today를 주입할 수 있으므로 실행 시점에 기대지 않고 고정 날짜로 검증한다.
// (main/utils/project-dates.test.ts는 인자 1개 호출 경로를 따로 지킨다.)
const dates: ProjectDateFields = {
  dev_start_date: '2026-03-02',
  dev_end_date: '2026-03-10',
  qa_start_date: '2026-03-12',
  qa_end_date: '2026-03-16',
  deploy_date: '2026-03-20'
}

describe('calculateProjectStatus', () => {
  it.each([
    ['개발 시작 전', '2026-03-01', 'scheduled'],
    ['개발 시작 당일', '2026-03-02', 'development'],
    ['개발 기간 중', '2026-03-05', 'development'],
    ['개발 종료 당일', '2026-03-10', 'development'],
    ['개발 종료 ~ QA 시작 사이의 공백', '2026-03-11', 'qa_pending'],
    ['QA 시작 당일', '2026-03-12', 'qa'],
    ['QA 기간 중', '2026-03-14', 'qa'],
    ['QA 종료 당일', '2026-03-16', 'qa'],
    ['QA 종료 ~ 배포일 사이의 공백', '2026-03-18', 'deploy_pending'],
    ['배포일 당일', '2026-03-20', 'deploy'],
    ['배포일 이후', '2026-03-21', 'completed']
  ])('%s이면 %s → %s', (_label, today, expected) => {
    expect(calculateProjectStatus(dates, today)).toBe(expected)
  })

  it('today를 생략하면 오늘(UTC) 기준으로 계산한다', () => {
    const today = new Date().toISOString().split('T')[0]
    // 오늘이 개발 기간 한가운데가 되도록 날짜를 맞춘 프로젝트
    const around: ProjectDateFields = {
      dev_start_date: '2000-01-01',
      dev_end_date: '2999-12-30',
      qa_start_date: '2999-12-31',
      qa_end_date: '2999-12-31',
      deploy_date: '2999-12-31'
    }
    expect(calculateProjectStatus(around)).toBe('development')
    expect(calculateProjectStatus(around)).toBe(calculateProjectStatus(around, today))
  })

  it('날짜 5종 외의 필드가 붙어 있어도 그대로 동작한다', () => {
    const row = { ...dates, id: 7, name: '프로젝트', status: 'cancelled', status_manual: 1 }
    expect(calculateProjectStatus(row, '2026-03-14')).toBe('qa')
  })
})
