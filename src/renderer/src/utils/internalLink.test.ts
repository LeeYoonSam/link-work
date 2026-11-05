import { describe, expect, it } from 'vitest'
import { isInternalLink, parseInternalLink } from './internalLink'

describe('parseInternalLink — 신규 항목 링크', () => {
  it.each([
    ['linkwork://memo/12', { kind: 'memo', id: 12 }],
    ['linkwork://todo/3', { kind: 'todo', id: 3 }],
    ['linkwork://variable/4', { kind: 'variable', id: 4 }],
    ['linkwork://release/7', { kind: 'release', id: 7 }],
    ['linkwork://recording/3', { kind: 'recording', id: 3 }],
    ['linkwork://note/5', { kind: 'note', id: 5 }]
  ])('%s', (href, expected) => {
    expect(parseInternalLink(href)).toEqual(expected)
  })

  it('project/1/task/9 는 작업 id 를 담는다', () => {
    expect(parseInternalLink('linkwork://project/1/task/9')).toEqual({
      kind: 'project',
      id: 1,
      taskId: 9
    })
  })

  it('캘린더 날짜와 이벤트 id 를 읽는다', () => {
    expect(parseInternalLink('linkwork://calendar/2026-11-05')).toEqual({
      kind: 'calendar',
      date: '2026-11-05',
      eventId: null
    })
    expect(parseInternalLink('linkwork://calendar/2026-11-05/abc_D-1')).toEqual({
      kind: 'calendar',
      date: '2026-11-05',
      eventId: 'abc_D-1'
    })
  })

  it('캘린더 연도는 2000~2100 만 받는다', () => {
    expect(parseInternalLink('linkwork://calendar/1999-12-31')).toBeNull()
    expect(parseInternalLink('linkwork://calendar/2000-01-01')).toEqual({
      kind: 'calendar',
      date: '2000-01-01',
      eventId: null
    })
    expect(parseInternalLink('linkwork://calendar/2100-12-31')).toEqual({
      kind: 'calendar',
      date: '2100-12-31',
      eventId: null
    })
    expect(parseInternalLink('linkwork://calendar/2101-01-01')).toBeNull()
    expect(parseInternalLink('linkwork://calendar/0001-01-01')).toBeNull()
  })

  it('오늘 화면 영역·항목·회의를 읽는다', () => {
    expect(parseInternalLink('linkwork://today/inbox')).toEqual({
      kind: 'today',
      focus: { kind: 'inbox' }
    })
    expect(parseInternalLink('linkwork://today/briefing')).toEqual({
      kind: 'today',
      focus: { kind: 'briefing' }
    })
    expect(parseInternalLink('linkwork://today/timeline')).toEqual({
      kind: 'today',
      focus: { kind: 'timeline' }
    })
    expect(parseInternalLink('linkwork://today/item/7')).toEqual({
      kind: 'today',
      focus: { kind: 'item', id: '7' }
    })
    expect(parseInternalLink('linkwork://today/meeting/42')).toEqual({
      kind: 'today',
      focus: { kind: 'meeting', id: '42' }
    })
  })

  it('끝의 / 1개는 허용한다', () => {
    expect(parseInternalLink('linkwork://memo/12/')).toEqual({ kind: 'memo', id: 12 })
  })
})

describe('parseInternalLink — 레거시 링크', () => {
  it('project/1 은 작업 id 가 null 이다', () => {
    expect(parseInternalLink('linkwork://project/1')).toEqual({
      kind: 'project',
      id: 1,
      taskId: null
    })
  })

  it('document/2', () => {
    expect(parseInternalLink('linkwork://document/2')).toEqual({ kind: 'document', id: 2 })
  })

  it('view/todos', () => {
    expect(parseInternalLink('linkwork://view/todos')).toEqual({ kind: 'view', view: 'todos' })
  })

  it('view/dashboard 는 today 로 옮긴다', () => {
    expect(parseInternalLink('linkwork://view/dashboard')).toEqual({ kind: 'view', view: 'today' })
  })
})

describe('parseInternalLink — 잘못된 값은 null', () => {
  it.each([
    'linkwork://memo/abc',
    'linkwork://todo/',
    'linkwork://todo',
    'linkwork://memo/0',
    'linkwork://memo/1/2',
    'linkwork://memo//1',
    'linkwork://calendar/2026-13-99',
    'linkwork://calendar/2026-02-30',
    'linkwork://calendar/20261105',
    'linkwork://calendar/2026-11-05/a b',
    'linkwork://calendar/2026-11-05/a/b',
    'linkwork://project/1/task',
    'linkwork://project/1/task/x',
    'linkwork://project/1/doc/9',
    'linkwork://project/abc',
    'linkwork://view/unknown',
    'linkwork://view/constructor',
    'linkwork://today/item/abc',
    'linkwork://today/other',
    'linkwork://today/meeting/a.b',
    'linkwork://unknown/1',
    'linkwork://',
    'https://example.com/memo/1',
    'memo/1',
    ''
  ])('%s', (href) => {
    expect(parseInternalLink(href)).toBeNull()
  })
})

describe('isInternalLink', () => {
  it('linkwork:// 스킴만 true 다', () => {
    expect(isInternalLink('linkwork://memo/1')).toBe(true)
    expect(isInternalLink('https://example.com')).toBe(false)
    expect(isInternalLink('')).toBe(false)
  })
})
