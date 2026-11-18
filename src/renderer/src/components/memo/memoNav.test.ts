import { describe, it, expect } from 'vitest'
import {
  isTypingTarget,
  layoutMode,
  moveSelection,
  neighborAfterRemoval,
  pushRecent,
  readJson,
  sanitizeIds,
  writeJson,
  type KeyValueStorage
} from './memoNav'

describe('pushRecent', () => {
  it('맨 앞에 넣고 중복을 빼고 상한을 지킨다', () => {
    expect(pushRecent([], 1)).toEqual([1])
    expect(pushRecent([1, 2, 3], 3)).toEqual([3, 1, 2])
    expect(pushRecent([1, 2, 3], 4, 3)).toEqual([4, 1, 2])
  })
})

describe('moveSelection', () => {
  const ids = [10, 20, 30]
  it('↑↓ 이동하고 끝에서 멈춘다', () => {
    expect(moveSelection(ids, 20, 'down')).toBe(30)
    expect(moveSelection(ids, 30, 'down')).toBe(30)
    expect(moveSelection(ids, 20, 'up')).toBe(10)
    expect(moveSelection(ids, 10, 'up')).toBe(10)
  })
  it('Home/End', () => {
    expect(moveSelection(ids, 20, 'home')).toBe(10)
    expect(moveSelection(ids, 20, 'end')).toBe(30)
  })
  it('현재가 목록에 없으면 첫 항목, 빈 목록이면 null', () => {
    expect(moveSelection(ids, 99, 'down')).toBe(10)
    expect(moveSelection(ids, null, 'up')).toBe(10)
    expect(moveSelection([], 1, 'down')).toBeNull()
  })
})

describe('neighborAfterRemoval', () => {
  it('아래, 없으면 위, 혼자면 null', () => {
    expect(neighborAfterRemoval([1, 2, 3], 2)).toBe(3)
    expect(neighborAfterRemoval([1, 2, 3], 3)).toBe(2)
    expect(neighborAfterRemoval([1], 1)).toBeNull()
  })
})

describe('layoutMode', () => {
  it('경계 600 / 880', () => {
    expect(layoutMode(528)).toBe('one')
    expect(layoutMode(599)).toBe('one')
    expect(layoutMode(600)).toBe('two')
    expect(layoutMode(879)).toBe('two')
    expect(layoutMode(880)).toBe('three')
    expect(layoutMode(928)).toBe('three')
  })
})

describe('isTypingTarget', () => {
  it('input·textarea·select·contenteditable 만 참', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('저장소', () => {
  const mem = (): KeyValueStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>()
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
  }
  it('쓰고 읽는다', () => {
    const s = mem()
    writeJson(s, 'k', [1, 2])
    expect(readJson(s, 'k', [])).toEqual([1, 2])
  })
  it('저장소가 없거나 깨졌거나 예외를 던져도 기본값', () => {
    expect(readJson(null, 'k', 'x')).toBe('x')
    const s = mem()
    s.data.set('k', '{깨짐')
    expect(readJson(s, 'k', 'x')).toBe('x')
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      }
    }
    expect(readJson(throwing, 'k', 'x')).toBe('x')
    expect(() => writeJson(throwing, 'k', 1)).not.toThrow()
  })
  it('sanitizeIds 는 정수만 중복 없이 상한까지', () => {
    expect(sanitizeIds([3, '4', 3, 1.5, 7], 10)).toEqual([3, 7])
    expect(sanitizeIds('x')).toEqual([])
    expect(sanitizeIds([1, 2, 3], 2)).toEqual([1, 2])
  })
})
