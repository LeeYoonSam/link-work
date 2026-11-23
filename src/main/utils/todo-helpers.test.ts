import { describe, expect, it } from 'vitest'
import { normalizeSourceLink } from './todo-helpers'

describe('normalizeSourceLink — 허용', () => {
  it.each([
    'linkwork://memo/1',
    'linkwork://note/5',
    'https://x.atlassian.net/browse/AB-1'
  ])('%s 는 그대로 돌려준다', (link) => {
    expect(normalizeSourceLink(link)).toBe(link)
  })

  it('앞뒤 공백은 정리한다', () => {
    expect(normalizeSourceLink('  linkwork://memo/12  ')).toBe('linkwork://memo/12')
  })

  it('500자까지는 받는다', () => {
    const link = 'https://a.com/' + 'x'.repeat(500 - 'https://a.com/'.length)
    expect(link).toHaveLength(500)
    expect(normalizeSourceLink(link)).toBe(link)
  })
})

describe('normalizeSourceLink — 없음', () => {
  it.each([undefined, null, '', '   '])('%j 는 null', (value) => {
    expect(normalizeSourceLink(value)).toBeNull()
  })
})

describe('normalizeSourceLink — 거부', () => {
  it.each([
    'javascript:alert(1)',
    'http://a',
    'file:///etc/passwd',
    'linkwork://',
    'https://',
    'ftp://a.com/x',
    'https://a.com/ b'
  ])('%s 는 오류', (link) => {
    expect(() => normalizeSourceLink(link)).toThrow('출처 링크 형식이 올바르지 않습니다.')
  })

  it('501자 문자열은 오류', () => {
    const link = 'https://a.com/' + 'x'.repeat(501 - 'https://a.com/'.length)
    expect(link).toHaveLength(501)
    expect(() => normalizeSourceLink(link)).toThrow('출처 링크 형식이 올바르지 않습니다.')
  })

  it('문자열이 아닌 값은 오류', () => {
    expect(() => normalizeSourceLink(12)).toThrow('출처 링크 형식이 올바르지 않습니다.')
    expect(() => normalizeSourceLink({ href: 'https://a.com' })).toThrow('출처 링크 형식이 올바르지 않습니다.')
  })
})
