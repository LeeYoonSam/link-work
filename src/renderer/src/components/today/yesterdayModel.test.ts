import { describe, it, expect } from 'vitest'
import { formatDayLabel, hhmm, parseIso, parseLocalDateTime, previousWorkRange } from './yesterdayModel'

// 2026-11: 19일 목, 20일 금, 21일 토, 22일 일, 23일 월, 24일 화
const local = (d: number, h = 0, m = 0, month = 10): Date => new Date(2026, month, d, h, m)

describe('previousWorkRange', () => {
  it('화요일은 월요일 하루', () => {
    const r = previousWorkRange(local(24, 9))
    expect(r.from).toEqual(local(23))
    expect(r.to).toEqual(local(24))
    expect(r.multiDay).toBe(false)
    expect(r.label).toBe('11월 23일 (월)')
  })

  it('금요일은 목요일 하루', () => {
    const r = previousWorkRange(local(20, 23, 59))
    expect(r.from).toEqual(local(19))
    expect(r.label).toBe('11월 19일 (목)')
  })

  it('월요일은 금~일', () => {
    const r = previousWorkRange(local(23, 8))
    expect(r.from).toEqual(local(20))
    expect(r.to).toEqual(local(23))
    expect(r.multiDay).toBe(true)
    expect(r.label).toBe('11월 20일 (금) ~ 22일 (일)')
  })

  it('일요일은 금~토', () => {
    const r = previousWorkRange(local(22, 10))
    expect(r.from).toEqual(local(20))
    expect(r.to).toEqual(local(22))
    expect(r.multiDay).toBe(true)
    expect(r.label).toBe('11월 20일 (금) ~ 21일 (토)')
  })

  it('토요일은 금요일 하루', () => {
    const r = previousWorkRange(local(21, 10))
    expect(r.from).toEqual(local(20))
    expect(r.multiDay).toBe(false)
    expect(r.label).toBe('11월 20일 (금)')
  })

  it('달이 바뀌면 뒤에도 월을 쓴다', () => {
    // 2026-11-02 월 → 10/30 금 ~ 11/1 일
    const r = previousWorkRange(local(2, 9))
    expect(r.from).toEqual(new Date(2026, 9, 30))
    expect(r.label).toBe('10월 30일 (금) ~ 11월 1일 (일)')
  })

  it('월초 화요일은 전달 말일이 아니라 어제(월)', () => {
    // 2026-12-01 화 → 11/30 월
    const r = previousWorkRange(new Date(2026, 11, 1, 9))
    expect(r.from).toEqual(new Date(2026, 10, 30))
    expect(r.label).toBe('11월 30일 (월)')
  })
})

describe('parseLocalDateTime', () => {
  it('SQLite 로컬 시각을 로컬로 읽는다', () => {
    expect(parseLocalDateTime('2026-11-19 23:59:59')).toEqual(new Date(2026, 10, 19, 23, 59, 59))
    expect(parseLocalDateTime(null)).toBeNull()
    expect(parseLocalDateTime('엉터리')).toBeNull()
  })
})

describe('날짜 도우미', () => {
  it('formatDayLabel·hhmm·parseIso', () => {
    expect(formatDayLabel(local(20, 9))).toBe('11월 20일 (금)')
    expect(formatDayLabel(local(20, 9), false)).toBe('20일 (금)')
    expect(hhmm(local(20, 9, 5))).toBe('09:05')
    expect(parseIso('엉터리')).toBeNull()
    expect(parseIso(null)).toBeNull()
  })
})
