import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Memo } from '../../types'
import MemoCard from './MemoCard'
import { memoVisibleInFilter } from './MemoView'
import { FOCUS_RING_CLASS } from '../../hooks/useFocusFlash'

// 앱 내 링크 포커스의 DOM id 와 강조 클래스를 정적 HTML 로 검증한다.
// 스크롤은 effect 라서 헤드리스 렌더로 검증하지 않는다
const memo: Memo = {
  id: 12,
  content: '# 회의 준비\n\n- 자료 확인',
  is_archived: 0,
  is_important: 0,
  color: 'default',
  category_id: null,
  created_at: '2026-11-05T10:00:00',
  updated_at: '2026-11-05T10:00:00'
}

describe('MemoCard 포커스', () => {
  it('루트에 memo-{id} DOM id 를 둔다', () => {
    const html = renderToStaticMarkup(<MemoCard memo={memo} />)
    expect(html).toContain('id="memo-12"')
    expect(html).not.toContain(FOCUS_RING_CLASS)
    expect(html).toContain('bg-white')
  })

  it('highlighted 이면 강조 클래스를 붙이고 bg-white 를 뺀다', () => {
    const html = renderToStaticMarkup(<MemoCard memo={memo} highlighted />)
    expect(html).toContain('id="memo-12"')
    expect(html).toContain(FOCUS_RING_CLASS)
    expect(html).not.toContain('bg-white ')
  })
})

describe('memoVisibleInFilter', () => {
  it('카테고리 필터가 메모를 숨기는지 판정한다', () => {
    const categorized = { ...memo, category_id: 3 }
    expect(memoVisibleInFilter(memo, 'all')).toBe(true)
    expect(memoVisibleInFilter(memo, 'uncategorized')).toBe(true)
    expect(memoVisibleInFilter(categorized, 'uncategorized')).toBe(false)
    expect(memoVisibleInFilter(categorized, 3)).toBe(true)
    expect(memoVisibleInFilter(categorized, 4)).toBe(false)
    expect(memoVisibleInFilter(memo, 4)).toBe(false)
  })
})
