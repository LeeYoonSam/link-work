import { describe, it, expect, vi, afterEach } from 'vitest'
import { devScheduleProgress, getPhaseHint, localToday } from './projectPhase'
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

// 2026년 11월 기준 요일: 9(월) 10(화) 14(토) 15(일) 20(금) 23(월) 24(화). 이 기간에 공휴일은 없다
describe('devScheduleProgress (부록 M.13)', () => {
  const DEV = { dev_start_date: '2026-11-10', dev_end_date: '2026-11-23' }

  it('기간 안이면 영업일 N/M 과 반올림 % 를 돌려준다', () => {
    // 11/10~11/23 은 영업일 10일이다. 11/11 은 2일째다
    expect(devScheduleProgress(DEV, '2026-11-11')).toEqual({ current: 2, total: 10, percent: 20 })
    expect(devScheduleProgress(DEV, '2026-11-10')).toEqual({ current: 1, total: 10, percent: 10 })
    expect(devScheduleProgress(DEV, '2026-11-23')).toEqual({ current: 10, total: 10, percent: 100 })
  })

  it('시작 전이면 null 이다', () => {
    expect(devScheduleProgress(DEV, '2026-11-09')).toBeNull()
  })

  it('종료 후면 null 이다', () => {
    expect(devScheduleProgress(DEV, '2026-11-24')).toBeNull()
  })

  it('기간 중 주말이면 직전 영업일 차수다', () => {
    // 11/14(토)·11/15(일) 은 11/13(금) 까지 4일째다
    expect(devScheduleProgress(DEV, '2026-11-14')).toEqual({ current: 4, total: 10, percent: 40 })
    expect(devScheduleProgress(DEV, '2026-11-15')).toEqual({ current: 4, total: 10, percent: 40 })
  })

  it('주말에 시작하면 첫날은 1일째다', () => {
    // 11/14(토)~11/20(금) 은 영업일 5일이다
    expect(devScheduleProgress({ dev_start_date: '2026-11-14', dev_end_date: '2026-11-20' }, '2026-11-14')).toEqual({
      current: 1,
      total: 5,
      percent: 20
    })
  })

  it('PhaseHint 의 N/M일차와 같은 값이다', () => {
    const p = project({ status: 'development', ...DEV })
    for (const day of ['2026-11-10', '2026-11-11', '2026-11-14', '2026-11-23']) {
      const s = devScheduleProgress(p, day)
      expect(getPhaseHint(p, day)).toEqual({ kind: 'day', text: `${s?.current}/${s?.total}일차` })
    }
  })
})

describe('localToday (부록 M.13)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('로컬 오전 8시에도 로컬 날짜다', () => {
    expect(localToday(new Date(2026, 10, 11, 8, 0))).toBe('2026-11-11')
    expect(localToday(new Date(2026, 10, 11, 0, 30))).toBe('2026-11-11')
  })

  it('getPhaseHint 의 오늘 기본값은 로컬 날짜다', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 11, 8, 0))
    const p = project({ status: 'development', dev_start_date: '2026-11-10', dev_end_date: '2026-11-23' })
    expect(getPhaseHint(p)).toEqual({ kind: 'day', text: '2/10일차' })
  })
})
