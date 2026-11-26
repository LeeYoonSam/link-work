import { describe, expect, it } from 'vitest'
import { parseTimestamp } from './summary-spec'

// 회의 요약이 쓰는 시각 환산. 이 변환이 깨지면 "이 시점부터 듣기" 버튼과
// 회의록의 [mm:ss] 표기가 조용히 사라진다.
describe('parseTimestamp', () => {
  it('mm:ss 를 ms 로 환산한다 (1시간을 넘으면 분이 60을 넘는다)', () => {
    expect(parseTimestamp('00:03')).toBe(3000)
    expect(parseTimestamp('01:22')).toBe(82000)
    expect(parseTimestamp('75:20')).toBe(4520000)
    expect(parseTimestamp(' 1:05 ')).toBe(65000)
  })

  it('대괄호로 감싼 전사 표기를 받는다', () => {
    expect(parseTimestamp('[12:34]')).toBe(754000)
    expect(parseTimestamp('[1:02:03]')).toBe(3723000)
  })

  it('h:mm:ss 를 받는다', () => {
    expect(parseTimestamp('1:02:03')).toBe(3723000)
    expect(parseTimestamp('0:00:09')).toBe(9000)
  })

  it('형식이 어긋나거나 비어 있으면 null', () => {
    expect(parseTimestamp('00:75')).toBeNull()
    expect(parseTimestamp('3분 12초')).toBeNull()
    expect(parseTimestamp('1:75:00')).toBeNull()
    expect(parseTimestamp('12:34]')).toBeNull()
    expect(parseTimestamp('')).toBeNull()
    expect(parseTimestamp(null)).toBeNull()
    expect(parseTimestamp(undefined)).toBeNull()
  })
})
