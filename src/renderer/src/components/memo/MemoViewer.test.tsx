import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Memo } from '../../types'
import MemoViewer from './MemoViewer'

// 메모 상세 헤더의 버튼 구성을 정적 HTML로 검증한다.
// 클릭 동작은 헤드리스 렌더로 검증할 수 없으므로 버튼 존재와 라벨만 확인한다.
const memo: Memo = {
  id: 1,
  content: '# 제목\n\n- 항목',
  is_archived: 0,
  is_important: 0,
  color: 'default',
  category_id: null,
  created_at: '2026-10-23T10:00:00',
  updated_at: '2026-10-23T10:00:00'
}

describe('MemoViewer', () => {
  it('onEdit을 받으면 메모 복사 버튼과 Edit 버튼을 함께 그린다', () => {
    const html = renderToStaticMarkup(
      <MemoViewer memo={memo} onClose={() => {}} onEdit={() => {}} />
    )
    expect(html).toContain('메모 복사')
    expect(html).toContain('Edit')
    // 메모 복사가 Edit 앞에 온다
    expect(html.indexOf('메모 복사')).toBeLessThan(html.indexOf('Edit'))
  })

  it('onEdit이 없어도 메모 복사 버튼은 그린다', () => {
    const html = renderToStaticMarkup(<MemoViewer memo={memo} onClose={() => {}} />)
    expect(html).toContain('메모 복사')
    expect(html).not.toContain('Edit')
  })
})
