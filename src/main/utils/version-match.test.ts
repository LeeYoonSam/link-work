import { describe, expect, it } from 'vitest'
import { isSameVersion, normalizeVersionName } from './version-match'

describe('normalizeVersionName', () => {
  it('앞뒤 공백을 제거한다', () => {
    expect(normalizeVersionName('  4.164.0 ')).toBe('4.164.0')
  })

  it('선행 v/V를 제거한다', () => {
    expect(normalizeVersionName('v4.164.0')).toBe('4.164.0')
    expect(normalizeVersionName('V4.164.0')).toBe('4.164.0')
  })

  it('소문자로 맞춘다', () => {
    expect(normalizeVersionName('4.164.0-RC1')).toBe('4.164.0-rc1')
  })

  it('중간의 v는 건드리지 않는다', () => {
    expect(normalizeVersionName('4.164.0-v2')).toBe('4.164.0-v2')
  })
})

describe('isSameVersion — 같다고 봐야 하는 것', () => {
  it('완전히 같은 버전 이름', () => {
    expect(isSameVersion('4.164.0', '4.164.0')).toBe(true)
  })

  it('한쪽에만 v 접두사가 있는 경우', () => {
    expect(isSameVersion('v4.164.0', '4.164.0')).toBe(true)
    expect(isSameVersion('4.164.0', 'V4.164.0')).toBe(true)
  })

  it('앞뒤 공백이 섞인 경우', () => {
    expect(isSameVersion(' 4.164.0', '4.164.0 ')).toBe(true)
    expect(isSameVersion('  v4.164.0  ', '4.164.0')).toBe(true)
  })

  it('대소문자만 다른 경우', () => {
    expect(isSameVersion('2.8.2-HOTFIX', '2.8.2-hotfix')).toBe(true)
  })
})

describe('isSameVersion — 추측 매칭 금지', () => {
  // 여기가 이 함수의 핵심이다. 잘못 연결된 릴리스 노트는 사용자가 알아채기 어렵다.
  it('자릿수가 다르면 다르다 (4.164.0 ≠ 4.164)', () => {
    expect(isSameVersion('4.164.0', '4.164')).toBe(false)
    expect(isSameVersion('4.164', '4.164.0')).toBe(false)
  })

  it('패치 번호가 다르면 다르다', () => {
    expect(isSameVersion('4.164.0', '4.164.1')).toBe(false)
  })

  it('마이너 번호가 다르면 다르다', () => {
    expect(isSameVersion('4.164.0', '4.163.0')).toBe(false)
  })

  it('접미사가 붙으면 다르다', () => {
    expect(isSameVersion('4.164.0', '4.164.0-rc1')).toBe(false)
    expect(isSameVersion('4.164.0', '4.164.0 (hotfix)')).toBe(false)
  })

  it('부분 문자열이어도 다르다', () => {
    expect(isSameVersion('2.8.2', '12.8.2')).toBe(false)
    expect(isSameVersion('2.8.2', '2.8.20')).toBe(false)
  })

  it('빈 값은 무엇과도 같지 않다 — 버전 없음끼리 묶이면 안 된다', () => {
    expect(isSameVersion('', '')).toBe(false)
    expect(isSameVersion('   ', '')).toBe(false)
    expect(isSameVersion('', '4.164.0')).toBe(false)
    expect(isSameVersion('4.164.0', '')).toBe(false)
  })
})
