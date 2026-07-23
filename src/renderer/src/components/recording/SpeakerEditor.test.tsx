import { describe, it, expect } from 'vitest'
import { nextPresetName } from './SpeakerEditor'

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
