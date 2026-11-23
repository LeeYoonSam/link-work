import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Memo, MemoCategory } from '../../types'
import MemoReader, { memoTimeLine, openMemoTodo, type MemoReaderProps } from './MemoReader'
import { useQuickAddStore } from '../../stores/quickAddStore'

const memo: Memo = {
  id: 7,
  content: '# 배포 절차\n\n빌드 후 **복사**',
  is_archived: 0,
  is_important: 0,
  color: 'default',
  category_id: 1,
  created_at: '2026-11-05 10:00:00',
  updated_at: '2026-11-18 10:33:10'
}
const category: MemoCategory = { id: 1, name: '개발', color: '#3B82F6', sort_order: 1, created_at: '', updated_at: '' }
const noop = (): void => {}

const render = (props: Partial<MemoReaderProps> = {}): string =>
  renderToStaticMarkup(
    <MemoReader
      memo={memo}
      category={category}
      categories={[category]}
      onEdit={noop}
      onToggleImportant={noop}
      onArchive={noop}
      onRestore={noop}
      onDelete={noop}
      onChangeCategory={noop}
      onExpand={noop}
      {...props}
    />
  )

describe('MemoReader', () => {
  it('제목·분류·시각·마크다운 전문을 그린다', () => {
    const html = render()
    expect(html).toContain('배포 절차')
    expect(html).toContain('개발')
    expect(html).toMatch(/<strong[^>]*>복사<\/strong>/)
    expect(html).toMatch(/수정 2026-11-1[89] \d\d:\d\d · 작성 2026-11-05/)
  })

  it('활성 메모 툴바: 중요·편집·복사·크게 보기·보관, 분류 바꾸기', () => {
    const html = render()
    for (const label of ['중요 표시', '편집 (e)', '할 일로 만들기', '원문 복사', '크게 보기', '보관']) {
      expect(html).toContain(`aria-label="${label}"`)
    }
    expect(html).toContain('title="분류 바꾸기"')
    expect(html).not.toContain('aria-label="복원"')
  })

  it('보관 메모 툴바: 복원·영구 삭제, 편집·보관 없음', () => {
    const html = render({ memo: { ...memo, is_archived: 1 } })
    expect(html).toContain('aria-label="복원"')
    expect(html).toContain('aria-label="영구 삭제"')
    expect(html).not.toContain('aria-label="편집 (e)"')
    expect(html).not.toContain('aria-label="보관"')
    expect(html).not.toContain('aria-label="할 일로 만들기"')
    expect(html).toContain('보관됨')
  })

  it('중요 메모는 눌림 상태로 알린다', () => {
    const html = render({ memo: { ...memo, is_important: 1 } })
    expect(html).toContain('aria-label="중요 해제"')
    expect(html).toContain('aria-pressed="true"')
  })

  it('검색 중이면 일치 수를 보인다', () => {
    expect(render({ query: '배포', matchCount: 2 })).toContain('일치 2곳')
    expect(render({ query: '', matchCount: 2 })).not.toContain('일치')
  })

  it('1단이면 목록으로 돌아가기 버튼을 보인다', () => {
    expect(render({ onBack: noop })).toContain('목록')
  })

  it('메모가 없으면 안내와 최근 본 메모를 보인다', () => {
    const html = render({ memo: null, recent: [{ id: 1, title: '최근 메모' }], onOpenRecent: noop })
    expect(html).toContain('왼쪽 목록에서 메모를 고르세요')
    expect(html).toContain('최근 메모')
  })

  it('memoTimeLine 은 수정 안 한 메모면 작성만', () => {
    expect(memoTimeLine({ ...memo, updated_at: memo.created_at })).toMatch(/^작성 2026-11-05/)
  })

  it('할 일로 만들기: 첫 줄(마크다운 기호 뺌)과 메모 링크로 빠른 추가를 연다', () => {
    useQuickAddStore.getState().close()
    openMemoTodo(memo)
    expect(useQuickAddStore.getState()).toMatchObject({
      isOpen: true,
      initialText: '배포 절차',
      sourceLink: 'linkwork://memo/7'
    })
    useQuickAddStore.getState().close()
  })
})
