import { describe, it, expect } from 'vitest'
import { morningStatusLine, parseMorningPart, morningStamp, morningCounts } from './morningStatus'

const ok = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'ok',
  attempts: 1,
  startedAt: '2026-11-02 08:00:30',
  finishedAt: '2026-11-02 08:01:00',
  error: null,
  newCount: 0,
  updatedCount: 0,
  reviewCount: 0,
  failedCount: 0,
  ...over
})

describe('morningStatus', () => {
  it('morningStatusLine: 시각·건수·실패를 1줄로 만든다. 오늘이 아니면 날짜를 붙인다', () => {
    const today = '2026-11-02'
    expect(morningStatusLine('아침 동기화', 'release', null, today, null)).toBeNull()
    expect(
      morningStatusLine('아침 동기화', 'release', parseMorningPart(ok({ newCount: 1, failedCount: 2 })), today, null)
    ).toBe('아침 동기화 08:01 · 새 1건 · 일부 실패 2건')
    expect(
      morningStatusLine(
        '아침 동기화',
        'release',
        parseMorningPart({ status: 'failed', attempts: 3, finishedAt: '2026-11-02 09:01:00', error: '네트워크 오류' }),
        today,
        null
      )
    ).toBe('아침 동기화 실패 09:01 · 네트워크 오류')
    expect(
      morningStatusLine('아침 동기화', 'release', parseMorningPart(ok({ newCount: 0 })), '2026-11-03', null)
    ).toBe('아침 동기화 11/2 08:01 · 변경 없음')
    expect(
      morningStatusLine(
        '아침 동기화',
        'release',
        parseMorningPart({ status: 'skipped', error: '기본 프로젝트 없음' }),
        today,
        null
      )
    ).toBe('아침 동기화 건너뜀 · 기본 프로젝트 없음')
  })

  it('morningStatusLine: 자동 실행이 꺼졌거나 오늘 실행 전이면 그 사실을 보인다', () => {
    const today = '2026-11-02'
    const part = parseMorningPart(ok())
    expect(morningStatusLine('아침 동기화', 'release', part, today, { enabled: false, at: '08:00', date: today })).toBe(
      '아침 동기화 꺼짐 · 마지막 08:01'
    )
    expect(
      morningStatusLine('아침 동기화', 'release', null, today, { enabled: true, at: '08:00', date: '2026-11-01' })
    ).toBe('아침 동기화 오늘 실행 전 · 08:00 예정')
  })

  it('parseMorningPart: 상태가 없거나 객체가 아니면 null 이다. 숫자가 아니면 0 이다', () => {
    expect(parseMorningPart(null)).toBeNull()
    expect(parseMorningPart('ok')).toBeNull()
    expect(parseMorningPart({ attempts: 1 })).toBeNull()
    const part = parseMorningPart({ status: 'ok', newCount: '3' })
    expect(part?.newCount).toBe(0)
    expect(morningCounts(part!)).toBe('변경 없음')
  })

  it('morningStamp: 오늘이면 HH:mm, 아니면 M/D HH:mm, 없으면 빈 문자열', () => {
    expect(morningStamp('2026-11-02 08:01:00', '2026-11-02')).toBe('08:01')
    expect(morningStamp('2026-11-02 08:01:00', '2026-11-03')).toBe('11/2 08:01')
    expect(morningStamp(null, '2026-11-02')).toBe('')
  })
})
