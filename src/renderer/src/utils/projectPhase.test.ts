import { describe, it, expect } from 'vitest'
import { getPhaseHint } from './projectPhase'
import type { Project } from '../types'

// 2026년 6월 기준 요일: 23(화) 24(수) 25(목) 26(금) 27(토) 28(일) 29(월) 30(화)
function project(overrides: Partial<Project>): Project {
  return {
    id: 1,
    name: 't',
    description: null,
    dev_start_date: '2026-06-23',
    dev_end_date: '2026-06-24',
    qa_start_date: '2026-06-26',
    qa_end_date: '2026-06-29',
    deploy_date: '2026-06-30',
    deploy_version: null,
    status: 'qa',
    status_manual: 0,
    created_at: '',
    updated_at: '',
    ...overrides
  } as Project
}

describe('getPhaseHint', () => {
  it('QA는 영업일 기준 N/M일차 (주말 제외)', () => {
    // QA 06/26(금)~06/29(월): 영업일 2일(금·월). 오늘 06/29 = 2일째.
    expect(getPhaseHint(project({ status: 'qa' }), '2026-06-29')).toEqual({
      text: '2/2일차',
      kind: 'day'
    })
  })

  it('QA 첫날은 1/2일차', () => {
    expect(getPhaseHint(project({ status: 'qa' }), '2026-06-26')).toEqual({
      text: '1/2일차',
      kind: 'day'
    })
  })

  it('QA 기간 중 주말이면 직전 영업일 차수로 표시', () => {
    // 06/27(토)은 영업일 아님 → 06/26(금)까지 1일째
    expect(getPhaseHint(project({ status: 'qa' }), '2026-06-27')).toEqual({
      text: '1/2일차',
      kind: 'day'
    })
  })

  it('Development도 영업일 기준 N/M일차', () => {
    // Dev 06/23(화)~06/24(수): 영업일 2일. 오늘 06/24 = 2일째.
    expect(getPhaseHint(project({ status: 'development' }), '2026-06-24')).toEqual({
      text: '2/2일차',
      kind: 'day'
    })
  })

  it('qa_pending은 QA 시작까지 D-day (라벨/디데이 분리)', () => {
    expect(getPhaseHint(project({ status: 'qa_pending' }), '2026-06-25')).toEqual({
      kind: 'countdown',
      label: 'QA',
      dday: 'D-1',
      daysLeft: 1
    })
  })

  it('deploy_pending은 배포까지 D-day', () => {
    expect(getPhaseHint(project({ status: 'deploy_pending' }), '2026-06-29')).toEqual({
      kind: 'countdown',
      label: '배포',
      dday: 'D-1',
      daysLeft: 1
    })
  })

  it('scheduled는 개발 시작까지 D-day', () => {
    expect(getPhaseHint(project({ status: 'scheduled' }), '2026-06-20')).toEqual({
      kind: 'countdown',
      label: '시작',
      dday: 'D-3',
      daysLeft: 3
    })
  })

  it('deploy/completed/cancelled는 힌트 없음', () => {
    expect(getPhaseHint(project({ status: 'deploy' }), '2026-06-30')).toBeNull()
    expect(getPhaseHint(project({ status: 'completed' }), '2026-07-01')).toBeNull()
    expect(getPhaseHint(project({ status: 'cancelled' }), '2026-06-29')).toBeNull()
  })
})
