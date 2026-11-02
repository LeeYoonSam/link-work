import { describe, expect, it } from 'vitest'
import { resolveStartView, weekdayOf, type StartViewInput } from './startView'

// docs/ASSISTANT.md 부록 C.1 표의 7행을 각각 검증한다.
// 2026-11-02 는 월요일, 2026-11-06 은 금요일, 2026-11-07 은 토요일, 2026-11-08 은 일요일이다.
const MON = '2026-11-02'
const FRI = '2026-11-06'
const SAT = '2026-11-07'
const SUN = '2026-11-08'

const input = (over: Partial<StartViewInput> = {}): StartViewInput => ({
  startView: 'auto',
  enabled: true,
  planStatus: 'none',
  logicalDate: MON,
  ...over
})

describe('resolveStartView (부록 C.1)', () => {
  it('A24 행1: startView=dashboard 이면 계획·요일과 무관하게 dashboard', () => {
    expect(resolveStartView(input({ startView: 'dashboard' }))).toBe('dashboard')
    expect(resolveStartView(input({ startView: 'dashboard', planStatus: 'active' }))).toBe(
      'dashboard'
    )
  })

  it('A24 행2: startView=today 이면 비서가 꺼져 있고 주말이어도 today', () => {
    expect(resolveStartView(input({ startView: 'today' }))).toBe('today')
    expect(
      resolveStartView(
        input({ startView: 'today', enabled: false, planStatus: 'closed', logicalDate: SUN })
      )
    ).toBe('today')
  })

  it('A24 행3: auto 이고 enabled=false 이면 계획이 active 여도 dashboard', () => {
    expect(resolveStartView(input({ enabled: false }))).toBe('dashboard')
    expect(resolveStartView(input({ enabled: false, planStatus: 'active' }))).toBe('dashboard')
  })

  it('A24 행4: auto, 계획 active 이면 주말이어도 today', () => {
    expect(resolveStartView(input({ planStatus: 'active' }))).toBe('today')
    expect(resolveStartView(input({ planStatus: 'active', logicalDate: SAT }))).toBe('today')
  })

  it('A24 행5: auto, 계획 closed 이면 평일이어도 dashboard', () => {
    expect(resolveStartView(input({ planStatus: 'closed' }))).toBe('dashboard')
    expect(resolveStartView(input({ planStatus: 'closed', logicalDate: FRI }))).toBe('dashboard')
  })

  it('A24 행6: auto, 계획 없음, 월~금이면 today', () => {
    for (const d of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', FRI]) {
      expect(resolveStartView(input({ logicalDate: d }))).toBe('today')
    }
  })

  it('A24 행7: auto, 계획 없음, 토·일이면 dashboard', () => {
    expect(resolveStartView(input({ logicalDate: SAT }))).toBe('dashboard')
    expect(resolveStartView(input({ logicalDate: SUN }))).toBe('dashboard')
  })

  it('A24 잘못된 날짜 문자열이면 dashboard', () => {
    for (const d of ['', 'garbage', '2026-13-01', '2026-02-30', '2026/11/02', '2026-11-2']) {
      expect(resolveStartView(input({ logicalDate: d }))).toBe('dashboard')
    }
  })
})

describe('weekdayOf', () => {
  it('A24 YYYY-MM-DD 를 로컬 날짜로 읽어 UTC 파싱으로 하루 밀리지 않는다', () => {
    expect(weekdayOf(MON)).toBe(1)
    expect(weekdayOf(SAT)).toBe(6)
    expect(weekdayOf(SUN)).toBe(0)
    // 연·월 경계
    expect(weekdayOf('2026-01-01')).toBe(4)
    expect(weekdayOf('2025-12-31')).toBe(3)
  })

  it('형식이 틀리거나 없는 날짜면 null', () => {
    expect(weekdayOf('2026-02-29')).toBeNull()
    expect(weekdayOf('abc')).toBeNull()
  })
})
