import { describe, it, expect } from 'vitest'
import { todoKeyAction, type TodoKeyAction } from './todoKeys'

const FREE = { typing: false, overlayOpen: false }
const key = (k: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; isComposing?: boolean } = {}) => ({
  key: k,
  ...mods
})

describe('todoKeyAction 매핑', () => {
  const cases: [string, TodoKeyAction][] = [
    ['n', 'focusAdd'],
    ['/', 'focusSearch'],
    ['ArrowDown', 'next'],
    ['j', 'next'],
    ['ArrowUp', 'prev'],
    ['k', 'prev'],
    [' ', 'toggleComplete'],
    ['Enter', 'expand'],
    ['Escape', 'collapse'],
    ['t', 'toToday'],
    ['1', 'priorityHigh'],
    ['2', 'priorityMedium'],
    ['3', 'priorityLow']
  ]
  it.each(cases)('%j → %s', (k, action) => {
    expect(todoKeyAction(key(k), FREE)).toBe(action)
  })

  it('CapsLock 대문자도 같은 동작', () => {
    expect(todoKeyAction(key('N'), FREE)).toBe('focusAdd')
    expect(todoKeyAction(key('J'), FREE)).toBe('next')
  })

  it('모르는 키는 null', () => {
    expect(todoKeyAction(key('x'), FREE)).toBeNull()
    expect(todoKeyAction(key('Tab'), FREE)).toBeNull()
    expect(todoKeyAction(key('4'), FREE)).toBeNull()
  })
})

describe('todoKeyAction 삭제', () => {
  it('Meta+Backspace 만 삭제다', () => {
    expect(todoKeyAction(key('Backspace', { metaKey: true }), FREE)).toBe('delete')
    expect(todoKeyAction(key('Backspace'), FREE)).toBeNull()
    expect(todoKeyAction(key('Delete'), FREE)).toBeNull()
    expect(todoKeyAction(key('Delete', { metaKey: true }), FREE)).toBeNull()
    expect(todoKeyAction(key('Backspace', { ctrlKey: true }), FREE)).toBeNull()
    expect(todoKeyAction(key('Backspace', { metaKey: true, altKey: true }), FREE)).toBeNull()
    expect(todoKeyAction(key('Backspace', { metaKey: true, ctrlKey: true }), FREE)).toBeNull()
  })
})

describe('todoKeyAction 가드', () => {
  it('입력 중이면 모두 null (Escape 포함)', () => {
    const typing = { typing: true, overlayOpen: false }
    for (const k of ['n', '/', 'j', ' ', 'Enter', 'Escape', 't', '1']) expect(todoKeyAction(key(k), typing)).toBeNull()
    expect(todoKeyAction(key('Backspace', { metaKey: true }), typing)).toBeNull()
  })

  it('떠 있는 층이 있으면 모두 null (Escape 포함)', () => {
    const overlay = { typing: false, overlayOpen: true }
    for (const k of ['n', 'ArrowDown', 'Enter', 'Escape']) expect(todoKeyAction(key(k), overlay)).toBeNull()
    expect(todoKeyAction(key('Backspace', { metaKey: true }), overlay)).toBeNull()
  })

  it('한글 조합 중이면 null', () => {
    expect(todoKeyAction(key('Enter', { isComposing: true }), FREE)).toBeNull()
    expect(todoKeyAction(key('Escape', { isComposing: true }), FREE)).toBeNull()
  })

  it('수식키 조합은 null (앱·편집 단축키와 겹치지 않게)', () => {
    expect(todoKeyAction(key('n', { metaKey: true }), FREE)).toBeNull()
    expect(todoKeyAction(key('k', { ctrlKey: true }), FREE)).toBeNull()
    expect(todoKeyAction(key('1', { altKey: true }), FREE)).toBeNull()
    expect(todoKeyAction(key('Enter', { metaKey: true }), FREE)).toBeNull()
    expect(todoKeyAction(key('ArrowDown', { metaKey: true }), FREE)).toBeNull()
  })

  it('입력도 층도 없을 때 Escape 는 collapse', () => {
    expect(todoKeyAction(key('Escape'), FREE)).toBe('collapse')
  })
})
