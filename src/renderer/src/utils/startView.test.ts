import { describe, expect, it } from 'vitest'
import { START_VIEWS, resolveStartView } from './startView'

// docs/ASSISTANT.md 부록 C.1 새 표의 각 행을 검증한다.
// 첫 화면은 today·projects·calendar 3값이다. 요일·계획 판정은 없앴다
describe('resolveStartView (부록 C.1)', () => {
  it('A24 행1: startView=today 이면 today', () => {
    expect(resolveStartView('today')).toBe('today')
  })

  it('A24 행2: startView=projects 이면 projects', () => {
    expect(resolveStartView('projects')).toBe('projects')
  })

  it('A24 행3: startView=calendar 이면 calendar', () => {
    expect(resolveStartView('calendar')).toBe('calendar')
  })

  it('A24 행4: 예전 값 auto 는 today', () => {
    expect(resolveStartView('auto')).toBe('today')
  })

  it('A24 행5: 예전 값 dashboard 는 today', () => {
    expect(resolveStartView('dashboard')).toBe('today')
  })

  it('A24 행6: 모르는 값·빈 값·문자열이 아닌 값은 today', () => {
    for (const v of ['', 'Today', 'todos', 'garbage', null, undefined, 0, {}]) {
      expect(resolveStartView(v)).toBe('today')
    }
  })

  it('A24 첫 화면 후보는 정확히 3값이다', () => {
    expect([...START_VIEWS]).toEqual(['today', 'projects', 'calendar'])
  })
})
