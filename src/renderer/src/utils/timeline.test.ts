import { describe, it, expect } from 'vitest'
import { isWeekend, isKoreanHoliday, filterBusinessDays, getDateMarkerType, isNewWeekStart } from './timeline'
import { eachDayOfInterval } from 'date-fns'

describe('isWeekend', () => {
  it('토요일은 주말로 판단한다', () => {
    // 2026-03-28 is Saturday
    expect(isWeekend(new Date(2026, 2, 28))).toBe(true)
  })

  it('일요일은 주말로 판단한다', () => {
    // 2026-03-29 is Sunday
    expect(isWeekend(new Date(2026, 2, 29))).toBe(true)
  })

  it('월요일은 주말이 아니다', () => {
    // 2026-03-30 is Monday
    expect(isWeekend(new Date(2026, 2, 30))).toBe(false)
  })

  it('금요일은 주말이 아니다', () => {
    // 2026-03-27 is Friday
    expect(isWeekend(new Date(2026, 2, 27))).toBe(false)
  })
})

describe('isKoreanHoliday', () => {
  it('신정(1/1)은 공휴일이다', () => {
    expect(isKoreanHoliday(new Date(2026, 0, 1))).toBe(true)
  })

  it('삼일절(3/1)은 공휴일이다', () => {
    expect(isKoreanHoliday(new Date(2026, 2, 1))).toBe(true)
  })

  it('어린이날(5/5)은 공휴일이다', () => {
    expect(isKoreanHoliday(new Date(2026, 4, 5))).toBe(true)
  })

  it('현충일(6/6)은 공휴일이다', () => {
    expect(isKoreanHoliday(new Date(2026, 5, 6))).toBe(true)
  })

  it('광복절(8/15)은 공휴일이다', () => {
    expect(isKoreanHoliday(new Date(2026, 7, 15))).toBe(true)
  })

  it('개천절(10/3)은 공휴일이다', () => {
    expect(isKoreanHoliday(new Date(2026, 9, 3))).toBe(true)
  })

  it('한글날(10/9)은 공휴일이다', () => {
    expect(isKoreanHoliday(new Date(2026, 9, 9))).toBe(true)
  })

  it('크리스마스(12/25)는 공휴일이다', () => {
    expect(isKoreanHoliday(new Date(2026, 11, 25))).toBe(true)
  })

  it('일반 평일은 공휴일이 아니다', () => {
    expect(isKoreanHoliday(new Date(2026, 2, 25))).toBe(false)
  })
})

describe('filterBusinessDays', () => {
  it('주말을 제거한다', () => {
    // 2026-03-23 (Mon) ~ 2026-03-29 (Sun) = 7 days, 5 weekdays
    const days = eachDayOfInterval({
      start: new Date(2026, 2, 23),
      end: new Date(2026, 2, 29)
    })
    const businessDays = filterBusinessDays(days)
    expect(businessDays).toHaveLength(5)
    businessDays.forEach((day) => {
      expect(day.getDay()).not.toBe(0) // not Sunday
      expect(day.getDay()).not.toBe(6) // not Saturday
    })
  })

  it('공휴일을 제거한다', () => {
    // 2026-03-01 is Sunday AND 삼일절, 2026-02-27 (Fri) ~ 2026-03-03 (Tue)
    // 2/27 Fri, 2/28 Sat(weekend), 3/1 Sun(weekend+holiday), 3/2 Mon, 3/3 Tue
    const days = eachDayOfInterval({
      start: new Date(2026, 1, 27),
      end: new Date(2026, 2, 3)
    })
    const businessDays = filterBusinessDays(days)
    // 2/27 Fri, 3/2 Mon, 3/3 Tue = 3 business days
    expect(businessDays).toHaveLength(3)
  })

  it('공휴일이 평일에 있으면 제거한다', () => {
    // 2026-06-06 is Saturday, let's use 2025-06-06 which is Friday (현충일)
    // Use a known weekday holiday: 2026-05-05 (Tue) 어린이날
    const days = eachDayOfInterval({
      start: new Date(2026, 4, 4), // Mon
      end: new Date(2026, 4, 8)    // Fri
    })
    const businessDays = filterBusinessDays(days)
    // Mon, Wed, Thu, Fri = 4 days (Tue 5/5 removed)
    expect(businessDays).toHaveLength(4)
    expect(businessDays.some((d) => d.getDate() === 5)).toBe(false)
  })

  it('빈 배열을 넘기면 빈 배열을 반환한다', () => {
    expect(filterBusinessDays([])).toHaveLength(0)
  })
})

describe('getDateMarkerType', () => {
  const project = {
    dev_end_date: '2026-04-03',
    qa_start_date: '2026-04-06',
    qa_end_date: '2026-04-10',
    deploy_date: '2026-04-15'
  }

  it('dev 완료일에 해당하면 dev_end를 반환한다', () => {
    const result = getDateMarkerType(new Date(2026, 3, 3), project)
    expect(result).toBe('dev_end')
  })

  it('deploy 일자에 해당하면 deploy를 반환한다', () => {
    const result = getDateMarkerType(new Date(2026, 3, 15), project)
    expect(result).toBe('deploy')
  })

  it('QA 시작일에 해당하면 qa_start를 반환한다', () => {
    const result = getDateMarkerType(new Date(2026, 3, 6), project)
    expect(result).toBe('qa_start')
  })

  it('QA 종료일에 해당하면 qa_end를 반환한다', () => {
    const result = getDateMarkerType(new Date(2026, 3, 10), project)
    expect(result).toBe('qa_end')
  })

  it('QA 기간 중간 날짜는 qa를 반환한다', () => {
    const result = getDateMarkerType(new Date(2026, 3, 8), project)
    expect(result).toBe('qa')
  })

  it('어느 것에도 해당하지 않으면 null을 반환한다', () => {
    const result = getDateMarkerType(new Date(2026, 3, 13), project)
    expect(result).toBeNull()
  })

  it('dev_end와 deploy가 같은 날이면 deploy를 우선한다', () => {
    const sameDay = {
      dev_end_date: '2026-04-15',
      qa_start_date: '2026-04-06',
      qa_end_date: '2026-04-10',
      deploy_date: '2026-04-15'
    }
    const result = getDateMarkerType(new Date(2026, 3, 15), sameDay)
    expect(result).toBe('deploy')
  })

  it('QA 날짜 없이도 동작한다 (하위호환)', () => {
    const noQa = {
      dev_end_date: '2026-04-03',
      deploy_date: '2026-04-15'
    }
    const result = getDateMarkerType(new Date(2026, 3, 8), noQa)
    expect(result).toBeNull()
  })
})

describe('isNewWeekStart', () => {
  it('월요일이면서 첫 번째 날이 아니면 true를 반환한다', () => {
    // filterBusinessDays 후 월요일이 중간에 있는 경우
    const businessDays = filterBusinessDays(eachDayOfInterval({
      start: new Date(2026, 2, 23), // Mon
      end: new Date(2026, 3, 3)     // Fri
    }))
    // 3/23(Mon), 3/24(Tue), ..., 3/27(Fri), 3/30(Mon), 3/31(Tue), 4/1(Wed), 4/2(Thu), 4/3(Fri)
    // index 0 = 3/23 Mon (first, should be false)
    // index 5 = 3/30 Mon (new week, should be true)
    expect(isNewWeekStart(businessDays[0], 0)).toBe(false)
    expect(isNewWeekStart(businessDays[5], 5)).toBe(true)
  })

  it('월요일이 아닌 날은 false를 반환한다', () => {
    // 2026-03-24 is Tuesday
    expect(isNewWeekStart(new Date(2026, 2, 24), 1)).toBe(false)
  })

  it('첫 번째 날이 월요일이면 false를 반환한다', () => {
    expect(isNewWeekStart(new Date(2026, 2, 23), 0)).toBe(false)
  })
})
