import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Memo, MemoCategory } from '../../types'
import MemoListRow, { memoTimeTitle } from './MemoListRow'
import MemoList from './MemoList'
import { searchMemos, toListItem } from './memoSearch'
import { FOCUS_RING_CLASS } from '../../hooks/useFocusFlash'

// 행의 접근성 속성·하이라이트·시각을 정적 HTML 로 검증한다. 스크롤은 effect 라서 검증하지 않는다
const memo: Memo = {
  id: 12,
  content: '# 회의 준비\n\n- 자료 확인\n- 배포 일정 공유',
  is_archived: 0,
  is_important: 1,
  color: 'default',
  category_id: 3,
  created_at: '2026-11-05 10:00:00',
  updated_at: '2026-11-18 10:33:10'
}
const category: MemoCategory = {
  id: 3,
  name: '업무',
  color: '#22C55E',
  sort_order: 1,
  created_at: '',
  updated_at: ''
}
// UTC 10:33:10 의 2분 뒤
const now = new Date(Date.UTC(2026, 10, 18, 10, 35, 10))

const render = (props: Partial<Parameters<typeof MemoListRow>[0]> = {}): string =>
  renderToStaticMarkup(
    <MemoListRow
      item={toListItem(memo)}
      category={category}
      selected={false}
      showCategory
      now={now}
      onSelect={() => {}}
      onToggleImportant={() => {}}
      {...props}
    />
  )

describe('MemoListRow', () => {
  it('option 역할, memo-{id} DOM id, 선택 상태를 aria-selected 로 알린다', () => {
    const html = render()
    expect(html).toContain('role="option"')
    expect(html).toContain('id="memo-12"')
    expect(html).toContain('aria-selected="false"')
    expect(render({ selected: true })).toContain('aria-selected="true"')
    expect(render({ selected: true })).toContain('border-l-blue-600')
  })

  it('제목·발췌·분류 배지·상대 수정 시각을 보인다', () => {
    const html = render()
    expect(html).toContain('회의 준비')
    expect(html).toContain('자료 확인 배포 일정 공유')
    expect(html).toContain('업무')
    // DB 의 UTC 문자열을 UTC 로 읽으므로 2분 전이다(로컬로 읽으면 9시간 차이가 난다)
    expect(html).toContain('2분 전')
    expect(html).toContain('dateTime="2026-11-18T10:33:10.000Z"')
  })

  it('중요는 별과 함께 글자로도 알린다', () => {
    expect(render()).toContain('<span class="sr-only">중요</span>')
  })

  it('특정 분류 안에서는 분류 배지를 뺀다', () => {
    expect(render({ showCategory: false })).not.toContain('업무')
  })

  it('검색 일치를 mark 로 하이라이트한다', () => {
    const [r] = searchMemos([memo], [category], '배포')
    const html = render({ item: r })
    expect(html).toContain('<mark')
    expect(html).toMatch(/<mark[^>]*>배포<\/mark>/)
  })

  it('앱 내 링크로 찾아온 행이면 강조 클래스를 붙인다', () => {
    expect(render({ flashed: true })).toContain(FOCUS_RING_CLASS)
    expect(render()).not.toContain(FOCUS_RING_CLASS)
  })

  it('보관 메모는 흐리게 하고 보관됨을 글자로 표시하며 별 토글을 숨긴다', () => {
    const html = render({ item: toListItem({ ...memo, is_archived: 1 }) })
    expect(html).toContain('opacity-60')
    expect(html).toContain('보관됨')
    expect(html).not.toContain('중요 해제')
  })

  it('시각 툴팁은 수정·작성 절대 시각', () => {
    expect(memoTimeTitle('2026-11-05 10:00:00', '2026-11-05 10:00:00')).toMatch(/^작성 2026-11-05 \d\d:00$/)
    expect(memoTimeTitle('2026-11-05 10:00:00', '2026-11-18 10:33:10')).toMatch(/^수정 2026-11-1[89] .* · 작성 /)
  })
})

describe('MemoList', () => {
  it('listbox 와 섹션 머리, 빈 상태를 그린다', () => {
    const html = renderToStaticMarkup(
      <MemoList
        listboxId="lb"
        sections={[{ key: 'important', label: '★ 중요', items: [toListItem(memo)] }]}
        selectedId={12}
        flashId={null}
        categoryOf={() => category}
        showCategory
        now={now}
        onSelect={() => {}}
      />
    )
    expect(html).toContain('role="listbox"')
    expect(html).toContain('id="lb"')
    expect(html).toContain('aria-activedescendant="memo-12"')
    expect(html).toContain('★ 중요')

    const empty = renderToStaticMarkup(
      <MemoList
        listboxId="lb"
        sections={[{ key: 'x', label: null, items: [] }]}
        selectedId={null}
        flashId={null}
        categoryOf={() => null}
        showCategory
        now={now}
        onSelect={() => {}}
        empty={<p>비었음</p>}
      />
    )
    expect(empty).toContain('비었음')
    expect(empty).not.toContain('aria-activedescendant')
  })
})
