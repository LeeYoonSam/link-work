import { describe, expect, it } from 'vitest'
import {
  addDays,
  isoToLocalDateTime,
  logicalDate,
  toHHmm,
  toLocalDateTime,
  toMinutes
} from './assistant-day'

// 로컬 시각으로 Date 를 만든다. 테스트가 실행 PC 의 시간대와 무관하게 동작한다.
function local(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  return new Date(y, mo - 1, d, h, mi, s)
}

describe('logicalDate', () => {
  it('날짜 경계 이전 시각이면 전날이다', () => {
    expect(logicalDate(local(2026, 11, 3, 3, 30), '04:00')).toBe('2026-11-02')
  })

  it('날짜 경계 시각부터는 당일이다', () => {
    expect(logicalDate(local(2026, 11, 3, 4, 0), '04:00')).toBe('2026-11-03')
    expect(logicalDate(local(2026, 11, 3, 23, 59), '04:00')).toBe('2026-11-03')
  })

  it('월·연 경계를 넘어 전날을 계산한다', () => {
    expect(logicalDate(local(2026, 1, 1, 1, 0), '04:00')).toBe('2025-12-31')
    expect(logicalDate(local(2026, 3, 1, 2, 0), '04:00')).toBe('2026-02-28')
  })

  it('경계가 00:00 이면 항상 당일이다', () => {
    expect(logicalDate(local(2026, 11, 3, 0, 0), '00:00')).toBe('2026-11-03')
  })

  it('경계 형식이 틀리면 04:00 을 쓴다', () => {
    expect(logicalDate(local(2026, 11, 3, 3, 59), 'abc')).toBe('2026-11-02')
    expect(logicalDate(local(2026, 11, 3, 4, 0), '25:00')).toBe('2026-11-03')
  })
})

describe('A12: 로컬 날짜·시각 형식', () => {
  it('A12: toLocalDateTime 은 로컬 YYYY-MM-DD HH:mm:ss 다', () => {
    expect(toLocalDateTime(local(2026, 11, 2, 9, 5, 7))).toBe('2026-11-02 09:05:07')
  })

  it('A12: toHHmm 은 로컬 HH:mm 다', () => {
    expect(toHHmm(local(2026, 11, 2, 9, 5))).toBe('09:05')
  })

  it('A12: isoToLocalDateTime 은 시간대 ISO 를 로컬 datetime 으로 바꾼다', () => {
    const expected = toLocalDateTime(new Date(Date.UTC(2026, 10, 2, 1, 0, 0)))
    expect(isoToLocalDateTime('2026-11-02T01:00:00.000Z')).toBe(expected)
    // Jira 는 콜론 없는 오프셋을 쓴다
    expect(isoToLocalDateTime('2026-11-02T10:00:00.000+0900')).toBe(expected)
    expect(isoToLocalDateTime('2026-11-02T10:00:00+09:00')).toBe(expected)
  })

  it('isoToLocalDateTime 은 해석할 수 없으면 null 이다', () => {
    expect(isoToLocalDateTime('')).toBeNull()
    expect(isoToLocalDateTime('not a date')).toBeNull()
  })
})

describe('addDays', () => {
  it('addDays 는 월·연 경계를 넘는다', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-11-02', 0)).toBe('2026-11-02')
  })

  it('형식이 틀린 날짜는 throw 한다', () => {
    expect(() => addDays('2026/11/02', 1)).toThrow()
  })
})

describe('toMinutes', () => {
  it("'HH:mm' 을 분으로 바꾸고 형식이 아니면 null 이다", () => {
    expect(toMinutes('08:30')).toBe(510)
    expect(toMinutes('24:00')).toBe(1440)
    expect(toMinutes('24:01')).toBeNull()
    expect(toMinutes('7:05')).toBe(425)
    expect(toMinutes('aa')).toBeNull()
    expect(toMinutes(null)).toBeNull()
  })
})
