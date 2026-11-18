import { describe, it, expect } from 'vitest'
import { format } from 'date-fns'
import { formatDateSafe, formatUtcDbTime, parseUtcDbTime } from './date'

// datetime('now') 로 저장한 DB 시각은 오프셋 없는 UTC 다. 로컬로 읽으면 한국에서 9시간 이르게 보인다.
// 기대값은 시간대와 무관하게 Date.UTC 로 만든다
describe('parseUtcDbTime', () => {
  it("오프셋 없는 'YYYY-MM-DD HH:MM:SS' 는 UTC 로 읽는다", () => {
    expect(parseUtcDbTime('2026-11-02 09:15:00').getTime()).toBe(Date.UTC(2026, 10, 2, 9, 15, 0))
    expect(parseUtcDbTime('2026-11-02T09:15:00').getTime()).toBe(Date.UTC(2026, 10, 2, 9, 15, 0))
    expect(parseUtcDbTime('2026-11-02 09:15').getTime()).toBe(Date.UTC(2026, 10, 2, 9, 15, 0))
    expect(parseUtcDbTime(' 2026-11-02 09:15:00.250 ').getTime()).toBe(Date.UTC(2026, 10, 2, 9, 15, 0, 250))
  })

  it('Z·오프셋이 붙은 값은 그대로 읽는다', () => {
    expect(parseUtcDbTime('2026-11-02T09:15:00Z').getTime()).toBe(Date.UTC(2026, 10, 2, 9, 15, 0))
    expect(parseUtcDbTime('2026-11-02T18:15:00+09:00').getTime()).toBe(Date.UTC(2026, 10, 2, 9, 15, 0))
  })

  it('날짜만 있는 값은 기존 해석(new Date)을 바꾸지 않는다', () => {
    expect(parseUtcDbTime('2026-11-02').getTime()).toBe(new Date('2026-11-02').getTime())
  })

  it('빈 값·해석 불가 값은 Invalid Date 다', () => {
    for (const v of ['', null, undefined, '다음 주']) expect(Number.isNaN(parseUtcDbTime(v).getTime())).toBe(true)
  })
})

describe('formatUtcDbTime', () => {
  it('UTC 저장값을 로컬 시각으로 포맷한다', () => {
    expect(formatUtcDbTime('2026-11-02 09:15:00', 'M/d HH:mm')).toBe(
      format(new Date(Date.UTC(2026, 10, 2, 9, 15, 0)), 'M/d HH:mm')
    )
  })

  it('해석할 수 없으면 원문을 돌려준다', () => {
    expect(formatUtcDbTime('다음 주', 'M/d HH:mm')).toBe('다음 주')
  })
})

describe('formatDateSafe', () => {
  // 할 일 마감처럼 사용자가 로컬 시각으로 입력해 저장한 값은 로컬로 읽는다
  it('로컬 저장값은 로컬 시각 그대로 포맷한다', () => {
    expect(formatDateSafe('2026-11-02 09:15', 'yyyy-MM-dd HH:mm')).toBe('2026-11-02 09:15')
  })

  it('해석할 수 없으면 원문을 돌려준다', () => {
    expect(formatDateSafe('다음 주', 'yyyy-MM-dd')).toBe('다음 주')
  })
})
