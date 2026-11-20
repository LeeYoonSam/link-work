import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Memo, MemoCategory } from '../types'
import { collect, click } from '../components/today/testTree'
import { createMobileApi, type FetchLike } from './api'
import { buildMemoBody } from './mobileModel'
import MobileMarkdown from './MobileMarkdown'
import { MemoComposer, MemoDetailView, MemoListView, type MemoListViewProps } from './MemosTab'

const memo = (over: Partial<Memo> & Pick<Memo, 'id'>): Memo => ({
  content: `메모 ${over.id}`,
  is_archived: 0,
  is_important: 0,
  color: '',
  category_id: null,
  created_at: '2026-11-18 10:33:10',
  updated_at: '2026-11-18 10:33:10',
  ...over
})

const cat = (id: number, name: string): MemoCategory => ({ id, name, color: '#3b82f6', sort_order: id, created_at: '', updated_at: '' })

const categories = [cat(1, '업무'), cat(2, '개인')]
const memos = [
  memo({ id: 1, content: '# 배포 회의\n체크리스트 정리', category_id: 1 }),
  memo({ id: 2, content: '장보기\n우유와 계란', category_id: 2, is_important: 1 }),
  memo({ id: 3, content: '아이디어 노트' })
]

const props = (over: Partial<MemoListViewProps> = {}): MemoListViewProps => ({
  memos,
  categories,
  filter: 'all',
  query: '',
  now: new Date('2026-11-19T00:00:00Z'),
  error: null,
  refreshing: false,
  onFilter: () => {},
  onQuery: () => {},
  onOpen: () => {},
  onNew: () => {},
  onRefresh: () => {},
  ...over
})

describe('MemoListView', () => {
  it('카테고리 칩(전체·중요·카테고리)과 목록을 그린다', () => {
    const html = renderToStaticMarkup(<MemoListView {...props()} />)
    for (const label of ['전체', '중요', '업무', '개인']) expect(html).toContain(label)
    expect(html).toContain('배포 회의')
    expect(html).toContain('장보기')
    expect(html).toContain('미분류')
    expect(html).toContain('m-clamp-3')
  })

  it('카테고리 칩을 누르면 그 id 로 onFilter, 필터가 목록에 걸린다', () => {
    const onFilter = vi.fn()
    const chip = collect(MemoListView(props({ onFilter }))).find((e) => e.type === 'button' && e.props['data-filter'] === '2')
    click(chip!)
    expect(onFilter).toHaveBeenCalledWith(2)
    const html = renderToStaticMarkup(<MemoListView {...props({ filter: 2 })} />)
    expect(html).toContain('장보기')
    expect(html).not.toContain('배포 회의')
    const important = renderToStaticMarkup(<MemoListView {...props({ filter: 'important' })} />)
    expect(important).toContain('장보기')
    expect(important).not.toContain('아이디어 노트')
  })

  it('검색은 본문까지 찾는다', () => {
    const html = renderToStaticMarkup(<MemoListView {...props({ query: '계란' })} />)
    expect(html).toContain('장보기')
    expect(html).not.toContain('배포 회의')
    expect(renderToStaticMarkup(<MemoListView {...props({ query: '없는말' })} />)).toContain('검색 결과가 없어요.')
  })

  it('UTC 로 저장된 시각을 로컬 시각으로 읽는다(9시간 이르게 보이지 않는다)', () => {
    const m = memo({ id: 9, created_at: '2026-11-18 10:33:10', updated_at: '2026-11-18 10:33:10' })
    const html = renderToStaticMarkup(<MemoDetailView memo={m} category={null} onBack={() => {}} />)
    const d = new Date(Date.UTC(2026, 10, 18, 10, 33, 10))
    const pad = (n: number): string => String(n).padStart(2, '0')
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    expect(html).toContain(`작성 ${expected}`)
  })
})

describe('메모 작성', () => {
  it('작성 → 계약 형식의 POST 본문', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ({ ok: true, status: 200, json: async () => ({ id: 77 }) }))
    const api = createMobileApi(fetchImpl)
    const built = buildMemoBody({ content: '# 새 메모\n- 할 것', categoryId: 1, important: true })
    if (!built.ok) throw new Error('본문 실패')
    expect(await api.createMemo(built.body)).toEqual({ id: 77 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/memos')
    expect((init?.headers as Record<string, string>)['X-LinkWork-Mobile']).toBe('1')
    expect(JSON.parse(String(init?.body))).toEqual({ content: '# 새 메모\n- 할 것', category_id: 1, is_important: 1 })
  })

  it('저장 중에는 본문·카테고리·중요·저장·취소를 잠그고, 끝나면(실패 포함) 풀린다', () => {
    const onChange = vi.fn()
    const draft = { content: '작성 중', categoryId: 1, important: false }
    const base = { draft, categories, error: null, onChange, onCancel: () => {}, onSave: () => {} }
    const locked = collect(MemoComposer({ ...base, saving: true }))
    const textarea = locked.find((e) => e.type === 'textarea')!
    expect(textarea.props.readOnly).toBe(true)
    ;(textarea.props.onChange as (e: unknown) => void)({ currentTarget: { value: '바뀐 글' } })
    expect(onChange).not.toHaveBeenCalled()
    expect(locked.find((e) => e.type === 'select')!.props.disabled).toBe(true)
    expect(locked.find((e) => e.type === 'button' && e.props.role === 'switch')!.props.disabled).toBe(true)
    for (const b of locked.filter((e) => e.type === 'button')) expect(b.props.disabled).toBe(true)

    // 실패 뒤 saving=false 로 돌아오면 다시 편집할 수 있고 초안은 그대로다
    const open = collect(MemoComposer({ ...base, saving: false, error: '저장하지 못했어요: 실패' }))
    const ta = open.find((e) => e.type === 'textarea')!
    expect(ta.props.readOnly).toBe(false)
    expect(ta.props.value).toBe('작성 중')
    expect(open.find((e) => e.type === 'select')!.props.disabled).toBe(false)
    ;(ta.props.onChange as (e: unknown) => void)({ currentTarget: { value: '고친 글' } })
    expect(onChange).toHaveBeenCalledWith({ ...draft, content: '고친 글' })
  })

  it('작성 화면: 빈 본문이면 저장 비활성, 저장 오류 문구를 보인다', () => {
    const html = renderToStaticMarkup(
      <MemoComposer
        draft={{ content: '', categoryId: null, important: false }}
        categories={categories}
        saving={false}
        error="저장하지 못했어요: 실패"
        onChange={() => {}}
        onCancel={() => {}}
        onSave={() => {}}
      />
    )
    expect(html).toMatch(/<button type="submit" disabled=""/)
    expect(html).toContain('저장하지 못했어요: 실패')
    expect(html).toContain('미분류')
    expect(html).toContain('업무')
  })
})

describe('메모 본문 살균', () => {
  const evil = [
    '안녕 <script>alert(1)</script>',
    '<img src=x onerror="alert(2)">',
    '<a href="javascript:alert(3)">html 링크</a>',
    '[md 링크](javascript:alert(4))',
    '<iframe src="https://evil.example"></iframe>',
    '[정상](https://example.com)'
  ].join('\n\n')

  it('<script>·onerror·javascript: 가 실행 가능한 요소로 렌더되지 않는다', () => {
    const html = renderToStaticMarkup(<MobileMarkdown content={evil} />)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<img[^>]*onerror/i)
    expect(html).not.toMatch(/onerror=/i)
    expect(html).not.toMatch(/<iframe/i)
    expect(html).not.toMatch(/href="javascript:/i)
    // 정상 링크는 새 탭 + noopener noreferrer
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('전체 보기도 같은 살균 경로를 쓴다', () => {
    const html = renderToStaticMarkup(<MemoDetailView memo={memo({ id: 5, content: evil })} category={null} onBack={() => {}} />)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/onerror=/i)
    expect(html).not.toMatch(/href="javascript:/i)
  })
})
