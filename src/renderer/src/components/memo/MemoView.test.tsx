import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Memo, MemoCategory } from '../../types'
import { useMemoStore } from '../../stores/memoStore'
import MemoView from './MemoView'
import MemoRail, { MemoRailDropdown } from './MemoRail'
import { buildRailItems } from './memoSearch'

// 화면 셸을 정적 HTML 로 검증한다. effect(조회·폭 측정·단축키)는 헤드리스 렌더에서 돌지 않으므로
// 기본 폭(3단)과 store 에 넣은 상태 그대로 그려진다.
// zustand 는 서버 렌더에서 getInitialState() 를 읽으므로, 훅이 현재 상태를 돌려주게 바꿔 끼운다
vi.mock('../../stores/memoStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../stores/memoStore')>()
  const hook = Object.assign(() => real.useMemoStore.getState(), real.useMemoStore)
  return { ...real, useMemoStore: hook }
})

const categories: MemoCategory[] = [
  { id: 1, name: '업무', color: '#22C55E', sort_order: 1, created_at: '', updated_at: '' },
  { id: 2, name: '빈 분류', color: '#EF4444', sort_order: 2, created_at: '', updated_at: '' }
]
const m = (id: number, content: string, over: Partial<Memo> = {}): Memo => ({
  id,
  content,
  is_archived: 0,
  is_important: 0,
  color: 'default',
  category_id: 1,
  created_at: '2026-11-01 00:00:00',
  updated_at: `2026-11-0${id} 00:00:00`,
  ...over
})
const memos = [
  m(1, '# 배포 절차\n빌드 후 복사', { is_important: 1 }),
  m(2, '# 회의록\n배포 일정 공유'),
  m(3, '# 점심\n메뉴', { category_id: null })
]
const archived = [m(4, '# 지난 메모\n옛 배포', { is_archived: 1 })]

beforeEach(() => {
  useMemoStore.setState({
    memos,
    archivedMemos: archived,
    categories,
    rail: 'all',
    query: '',
    scope: null,
    searchArchivedToo: false,
    selectedMemoId: 2,
    recentIds: [],
    railCollapsed: false,
    sortOrder: 'updated'
  })
})

function setState(partial: Partial<ReturnType<typeof useMemoStore.getState>>): void {
  useMemoStore.setState(partial)
}

describe('MemoView', () => {
  it('3단: 분류 레일(개수) · 검색 입력 · 목록 · 읽기 영역', () => {
    const html = renderToStaticMarkup(<MemoView />)
    expect(html).toContain('aria-label="메모 분류"')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('메모 검색 (제목·본문·분류)')
    expect(html).toContain('role="listbox"')
    // 중요 소구획이 맨 위
    expect(html.indexOf('★ 중요')).toBeLessThan(html.indexOf('회의록'))
    // 읽기 영역에 선택 메모 전문
    expect(html).toContain('배포 일정 공유')
    expect(html).toContain('aria-label="회의록"')
    expect(html).toContain('+ 새 메모')
  })

  it('검색 중이면 전체에서 n건, 분류 칩, 레일을 흐리게', () => {
    setState({ query: '배포', rail: 2 })
    const html = renderToStaticMarkup(<MemoView />)
    // 레일이 '빈 분류'여도 활성 메모 전체에서 찾는다
    expect(html).toMatch(/전체에서 <span[^>]*>2<\/span>건/)
    expect(html).toContain('aria-label="분류로 좁히기"')
    expect(html).toContain('검색 중 · 전체 대상')
    expect(html).toMatch(/<mark[^>]*>배포<\/mark>/)
  })

  it('보관함 레일에서 검색하면 보관 메모만 찾는다', () => {
    setState({ query: '배포', rail: 'archived', selectedMemoId: 4 })
    const html = renderToStaticMarkup(<MemoView />)
    expect(html).toMatch(/보관함에서 <span[^>]*>1<\/span>건/)
    expect(html).not.toContain('+ 새 메모')
  })

  it('0건이면 안내와 보관함에서도 찾기·검색어 지우기', () => {
    setState({ query: '옛' })
    const html = renderToStaticMarkup(<MemoView />)
    expect(html).toContain('와 일치하는 메모가 없어요')
    expect(html).toContain('보관함에서도 찾기')
    expect(html).toContain('검색어 지우기')
  })

  it('레일을 접으면 목록 머리에 분류 드롭다운과 펼치기 버튼', () => {
    setState({ railCollapsed: true })
    const html = renderToStaticMarkup(<MemoView />)
    expect(html).not.toContain('aria-label="메모 분류"')
    expect(html).toContain('분류 레일 펼치기')
    expect(html).toContain('분류:')
  })
})

describe('MemoRail', () => {
  it('전체·중요·최근 본·분류(0개 포함)·미분류·보관함·분류 관리, 선택은 aria-current', () => {
    const items = buildRailItems(memos, archived, categories)
    const html = renderToStaticMarkup(
      <MemoRail items={items} selected={1} dimmed={false} onSelect={() => {}} onManageCategories={() => {}} />
    )
    for (const label of ['전체', '중요', '최근 본', '업무', '빈 분류', '미분류', '보관함', '분류 관리']) {
      expect(html).toContain(label)
    }
    expect(html).toMatch(/aria-current="true"[^>]*>.*?업무/)
    expect(html).not.toContain('검색 중')
  })

  it('드롭다운 트리거는 현재 분류 이름을 보인다', () => {
    const items = buildRailItems(memos, archived, categories)
    const html = renderToStaticMarkup(
      <MemoRailDropdown items={items} selected="archived" onSelect={() => {}} onManageCategories={() => {}} />
    )
    expect(html).toContain('보관함')
    expect(html).toContain('aria-haspopup="menu"')
  })
})
