import { describe, it, expect } from 'vitest'
import { isCommitEnter } from './imeEnter'

// 한글 조합 중 Enter 는 keydown 이 두 번 온다(조합 확정 isComposing=true/keyCode 229, 그다음 실제 Enter).
// 두 번 모두 처리하면 추가가 두 번 일어난다(구성원·용어집 중복 추가 버그).
describe('isCommitEnter', () => {
  it('조합 확정용 Enter 는 무시하고, 확정 뒤의 Enter 만 받는다', () => {
    const composing = { key: 'Enter', keyCode: 229, nativeEvent: { isComposing: true } }
    const committed = { key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false } }
    const events = [composing, committed]
    expect(events.filter(isCommitEnter)).toHaveLength(1)
    expect(isCommitEnter(committed)).toBe(true)
  })

  it('isComposing 이 빠져도 keyCode 229 면 조합 중으로 본다', () => {
    expect(isCommitEnter({ key: 'Enter', keyCode: 229, nativeEvent: {} })).toBe(false)
  })

  it('Enter 가 아니면 false', () => {
    expect(isCommitEnter({ key: 'a', keyCode: 65, nativeEvent: { isComposing: false } })).toBe(false)
  })
})
