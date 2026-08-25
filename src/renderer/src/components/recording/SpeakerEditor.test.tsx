import { describe, it, expect } from 'vitest'
import { nextPresetName, buildNamePresets } from './SpeakerEditor'
import type { Attendee } from '../../types'

// 다인 면접에서 '면접관'/'지원자' 프리셋을 여러 화자에 눌렀을 때 이름이 충돌하지 않고
// '면접관 2', '면접관 3'…처럼 다음 빈 번호가 붙는지 고정한다.
describe('nextPresetName', () => {
  it('아무도 쓰지 않는 이름은 그대로 반환한다', () => {
    expect(nextPresetName('면접관', [])).toBe('면접관')
    expect(nextPresetName('지원자', ['면접관'])).toBe('지원자')
  })

  it('이미 쓰이는 이름이면 2부터 번호를 붙인다', () => {
    expect(nextPresetName('면접관', ['면접관'])).toBe('면접관 2')
    expect(nextPresetName('지원자', ['지원자', '면접관'])).toBe('지원자 2')
  })

  it('번호가 이미 쓰여 있으면 다음 빈 번호를 찾는다', () => {
    expect(nextPresetName('면접관', ['면접관', '면접관 2'])).toBe('면접관 3')
    // 중간이 비어 있으면 그 번호를 먼저 채운다
    expect(nextPresetName('면접관', ['면접관', '면접관 3'])).toBe('면접관 2')
  })

  it('공백·빈 이름은 사용 목록에서 무시한다', () => {
    expect(nextPresetName('면접관', ['', '  ', '지원자'])).toBe('면접관')
  })
})

// 화자 이름 프리셋 구성 — 회의는 참석자 이름만, 면접은 역할 프리셋 뒤에 참석자를 붙인다.
describe('buildNamePresets', () => {
  const at = (name: string): Attendee => ({ member_id: 1, name, role: null })

  it('회의는 참석자 이름만 프리셋으로 쓴다', () => {
    expect(buildNamePresets('meeting', [at('홍길동'), at('김철수')])).toEqual(['홍길동', '김철수'])
    expect(buildNamePresets('meeting', [])).toEqual([])
  })

  it('면접은 역할 프리셋 뒤에 참석자 이름을 붙인다', () => {
    expect(buildNamePresets('interview', [at('홍길동')])).toEqual(['면접관', '지원자', '홍길동'])
    // 참석자가 없어도 기존 역할 프리셋은 유지된다
    expect(buildNamePresets('interview', [])).toEqual(['면접관', '지원자'])
  })

  it('빈 이름·중복은 걸러내고 개수를 8개로 자른다', () => {
    expect(buildNamePresets('meeting', [at('홍길동'), at('  '), at('홍길동')])).toEqual(['홍길동'])
    // 역할 프리셋과 같은 이름의 참석자가 있어도 버튼이 두 번 나오지 않는다
    expect(buildNamePresets('interview', [at('면접관')])).toEqual(['면접관', '지원자'])

    const many = Array.from({ length: 12 }, (_, i) => at(`참석자${i}`))
    expect(buildNamePresets('meeting', many)).toHaveLength(8)
  })
})
