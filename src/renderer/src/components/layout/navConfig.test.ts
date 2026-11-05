import { describe, expect, it } from 'vitest'
import { NAV_GROUPS, VIEW_IDS, VIEW_LABELS, normalizeView } from './navConfig'

describe('navConfig', () => {
  it('모든 ViewId 에 빈 문자열이 아닌 레이블이 있다', () => {
    for (const id of VIEW_IDS) {
      expect(VIEW_LABELS[id], id).toBeTruthy()
    }
    expect(Object.keys(VIEW_LABELS).sort()).toEqual([...VIEW_IDS].sort())
  })

  it('NAV_GROUPS 가 각 ViewId 를 정확히 1번씩 담는다', () => {
    const ids = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id))
    expect(ids.length).toBe(VIEW_IDS.length)
    expect([...ids].sort()).toEqual([...VIEW_IDS].sort())
  })

  it('메뉴 항목 레이블은 VIEW_LABELS 와 같다', () => {
    for (const g of NAV_GROUPS) {
      for (const i of g.items) expect(i.label).toBe(VIEW_LABELS[i.id])
    }
  })

  it('오늘은 전용 아이콘을 쓰고 캘린더 아이콘과 겹치지 않는다', () => {
    const items = NAV_GROUPS.flatMap((g) => g.items)
    expect(items.find((i) => i.id === 'today')?.icon).toBe('today')
    const icons = items.map((i) => i.icon)
    expect(new Set(icons).size).toBe(icons.length)
  })

  it('그룹은 2단계다. 첫 그룹만 제목이 없다', () => {
    expect(NAV_GROUPS[0].title).toBeNull()
    expect(NAV_GROUPS[0].items.map((i) => i.id)).toEqual(['today', 'ai'])
    for (const g of NAV_GROUPS.slice(1)) expect(g.title).toBeTruthy()
    for (const g of NAV_GROUPS) {
      expect(g.items.length).toBeGreaterThan(0)
      for (const i of g.items) {
        expect(Object.keys(i).sort()).toEqual(['icon', 'id', 'label'])
      }
    }
    expect(NAV_GROUPS.map((g) => g.title)).toEqual([null, '업무', '회의', '자료'])
  })

  it('normalizeView 는 알려진 값을 그대로 돌려준다', () => {
    for (const id of VIEW_IDS) expect(normalizeView(id)).toBe(id)
  })

  it('normalizeView 는 dashboard 를 today 로 옮긴다', () => {
    expect(normalizeView('dashboard')).toBe('today')
  })

  it('normalizeView 는 모르는 값이면 null 이다', () => {
    for (const v of ['', 'auto', 'Today', 'project', 'unknown', null, undefined, 1, {}]) {
      expect(normalizeView(v)).toBeNull()
    }
  })

  it('normalizeView 는 Object.prototype 멤버 이름이면 null 이다', () => {
    for (const v of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(normalizeView(v)).toBeNull()
    }
  })
})
