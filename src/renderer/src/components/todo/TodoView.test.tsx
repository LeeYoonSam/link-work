import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Todo, TodoTag } from '../../types'
import { findButton, click } from '../today/testTree'

// 할 일 화면 셸을 정적 HTML 로 검증한다. effect(조회·단축키·딥링크 상태 반영)는 헤드리스 렌더에서 돌지 않는다.
// 딥링크 뷰 전환은 렌더 중에 고르므로 정적 HTML 에서도 보인다.
// zustand 는 서버 렌더에서 getInitialState() 를 읽으므로, 훅이 현재 상태를 돌려주게 바꿔 끼운다(MemoView.test 와 같은 방식)
vi.mock('../../stores/todoStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../stores/todoStore')>()
  const hook = Object.assign((sel?: (s: unknown) => unknown) => {
    const s = real.useTodoStore.getState()
    return sel ? sel(s) : s
  }, real.useTodoStore)
  return { ...real, useTodoStore: hook }
})

const { default: TodoView, SectionHeader, visibleTodos, buildViewData, deepLinkView, hasOpenOverlay, OVERLAY_SELECTOR } =
  await import('./TodoView')
const { todoKeyAction } = await import('./todoKeys')
const { useTodoStore } = await import('../../stores/todoStore')
const { flushToasts, dismissToast, useToastStore } = await import('../ui/toastStore')

const NOW = new Date(2026, 10, 20, 9, 0)
const TODAY = '2026-11-20'

const tagWork: TodoTag = { id: 7, name: '업무', color: '#3B82F6', created_at: '', updated_at: '' }

const t = (id: number, title: string, over: Partial<Todo> = {}): Todo => ({
  id,
  title,
  priority: 'medium',
  due_date: null,
  due_reminder: 0,
  is_completed: 0,
  completed_at: null,
  notes: null,
  source_link: null,
  created_at: `2026-11-0${id} 09:00:00`,
  updated_at: `2026-11-0${id} 09:00:00`,
  tags: [],
  ...over
})

const active: Todo[] = [
  t(1, '지난 보고서', { due_date: '2026-11-18' }),
  t(2, '오늘 회의 준비', { due_date: '2026-11-20 15:00', due_reminder: 1, tags: [tagWork] }),
  t(3, '다음 주 발표', { due_date: '2026-11-25' }),
  t(4, '언젠가 정리', { notes: '서랍 보고서' })
]
const done: Todo[] = [t(5, '어제 끝낸 일', { is_completed: 1, completed_at: '2026-11-19 10:00:00' })]

beforeEach(() => {
  useTodoStore.setState({
    todos: active,
    completedTodos: done,
    tags: [tagWork],
    loading: false,
    filterTagId: null,
    selectedTodoId: null,
    pendingDeleteIds: [],
    showTagManager: false
  })
})

const render = (initialView?: 'today' | 'upcoming' | 'all' | 'done'): string =>
  renderToStaticMarkup(<TodoView now={NOW} initialView={initialView} />)

const rowIds = (html: string): number[] => [...html.matchAll(/data-todo-id="(\d+)"/g)].map((m) => Number(m[1]))
const selectedTab = (html: string): string | undefined =>
  html.match(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*data-view="(\w+)"/)?.[1]

describe('TodoView 뷰', () => {
  it('기본 뷰는 오늘: 지난 항목 + 오늘 구획. 상단 입력·뷰 탭(개수)·검색이 있다', () => {
    const html = render()
    expect(selectedTab(html)).toBe('today')
    expect(rowIds(html)).toEqual([1, 2])
    expect(html.indexOf('data-section="overdue"')).toBeLessThan(html.indexOf('data-section="today"'))
    expect(html).toContain('aria-label="할 일 추가"')
    expect(html).toContain('aria-label="할 일 검색"')
    expect(html).toContain('모두 오늘로')
    // 탭 개수: 오늘 2 · 예정 1 · 전체 4 · 완료 1
    const counts = [...html.matchAll(/role="tab"[^>]*>[^<]*<span[^>]*>(\d+)<\/span>/g)].map((m) => Number(m[1]))
    expect(counts).toEqual([2, 1, 4, 1])
    expect(html).not.toContain('TODO')
  })

  it('뷰를 바꾸면 구획 구성이 바뀐다', () => {
    const upcoming = render('upcoming')
    expect(selectedTab(upcoming)).toBe('upcoming')
    expect(rowIds(upcoming)).toEqual([3])
    expect(upcoming).toContain('data-section="date:2026-11-25"')

    const all = render('all')
    expect(rowIds(all)).toEqual([1, 2, 3, 4])
    const order = ['overdue', 'today', 'later', 'none'].map((k) => all.indexOf(`data-section="${k}"`))
    expect(order.every((p) => p >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    const doneHtml = render('done')
    expect(rowIds(doneHtml)).toEqual([5])
    expect(doneHtml).toContain('data-section="done:2026-11-19"')
  })

  it('오늘 뷰가 비면 안내와 전체 뷰로 가는 버튼', () => {
    useTodoStore.setState({ todos: [active[3]] })
    const html = render()
    expect(html).toContain('오늘 할 일이 없어요')
    expect(html).toContain('전체 할 일 보기')
  })

  it('삭제 대기(pendingDeleteIds) 항목은 목록과 개수에서 숨긴다', () => {
    useTodoStore.setState({ pendingDeleteIds: [2] })
    const html = render()
    expect(rowIds(html)).toEqual([1])
    const counts = [...html.matchAll(/role="tab"[^>]*>[^<]*<span[^>]*>(\d+)<\/span>/g)].map((m) => Number(m[1]))
    expect(counts).toEqual([1, 1, 3, 1])
  })
})

describe('TodoView 딥링크(selectedTodoId)', () => {
  it('완료 항목이면 완료 뷰, 예정 항목이면 예정 뷰, 날짜 없는 항목이면 전체 뷰로 바꾸고 그 행을 그린다', () => {
    for (const [id, view] of [
      [5, 'done'],
      [3, 'upcoming'],
      [4, 'all'],
      [1, 'today']
    ] as const) {
      useTodoStore.setState({ selectedTodoId: id })
      const html = render()
      expect(selectedTab(html), String(id)).toBe(view)
      expect(rowIds(html), String(id)).toContain(id)
      // 강조 표시
      expect(html).toMatch(new RegExp(`data-todo-id="${id}"[^>]*class="[^"]*ring-blue-300`))
    }
  })

  it('아직 목록에 없으면(조회 전) 현재 뷰를 유지한다', () => {
    useTodoStore.setState({ selectedTodoId: 99 })
    expect(selectedTab(render())).toBe('today')
    expect(deepLinkView(99, active, done, TODAY)).toBeNull()
  })
})

describe('TodoView 태그 필터·검색', () => {
  it('태그 필터는 현재 뷰 안에서 걸린다(개수도 같이)', () => {
    useTodoStore.setState({ filterTagId: 7 })
    const html = render()
    expect(rowIds(html)).toEqual([2])
    expect(render('all')).not.toContain('data-todo-id="4"')
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*업무/)
  })

  it('검색은 제목·메모·태그 이름에서 찾고, 뷰 구획과 개수에 함께 걸린다', () => {
    const filter = { search: '보고서', filterTagId: null, pendingDeleteIds: [] }
    const data = buildViewData({
      todos: visibleTodos(active, filter),
      completedTodos: visibleTodos(done, filter),
      today: TODAY
    })
    // '지난 보고서'(제목) · '언젠가 정리'(메모에 보고서)
    expect(data.counts).toEqual({ today: 1, upcoming: 0, all: 2, done: 0 })
    expect(data.sections.today.map((s) => s.key)).toEqual(['overdue'])
    expect(data.sections.all.flatMap((s) => s.todos.map((x) => x.id))).toEqual([1, 4])

    const byTag = visibleTodos(active, { search: '업무', filterTagId: null, pendingDeleteIds: [] })
    expect(byTag.map((x) => x.id)).toEqual([2])
    const withTagFilter = visibleTodos(active, { search: '정리', filterTagId: 7, pendingDeleteIds: [] })
    expect(withTagFilter).toEqual([])
  })
})

describe("구획 머리 '모두 오늘로'", () => {
  function stubApi() {
    const api = {
      update: vi.fn(async () => ({})),
      list: vi.fn(async () => active),
      listByTag: vi.fn(async () => active),
      listActive: vi.fn(async () => active)
    }
    vi.stubGlobal('window', { api: { todo: api } })
    return api
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  afterEach(async () => {
    flushToasts()
    await flush()
    vi.unstubAllGlobals()
  })

  it('지난 항목을 오늘로 옮기고(시각 유지), 실행 취소하면 이전 마감으로 되돌린다', async () => {
    const api = stubApi()
    const overdue = [
      t(1, '지난 보고서', { due_date: '2026-11-18' }),
      t(6, '지난 통화', { due_date: '2026-11-17 10:30', due_reminder: 1 })
    ]
    const header = SectionHeader({
      section: { key: 'overdue', title: '지난 항목', kind: 'overdue', todos: overdue },
      onAllToToday: (list) => void useTodoStore.getState().rescheduleWithUndo(list, TODAY)
    })
    click(findButton(header, '모두 오늘로'))
    await flush()
    expect(api.update.mock.calls).toEqual([
      [1, { due_date: '2026-11-20', due_reminder: 0 }],
      [6, { due_date: '2026-11-20 10:30', due_reminder: 1 }]
    ])

    const toasts = useToastStore.getState().toasts
    dismissToast(toasts[toasts.length - 1].id, 'action')
    await flush()
    expect(api.update.mock.calls.slice(2)).toEqual([
      [1, { due_date: '2026-11-18', due_reminder: 0 }],
      [6, { due_date: '2026-11-17 10:30', due_reminder: 1 }]
    ])
  })

  it('지난 항목이 아닌 구획에는 버튼이 없다', () => {
    const header = SectionHeader({
      section: { key: 'today', title: '오늘', kind: 'today', todos: [active[1]] },
      onAllToToday: () => {}
    })
    expect(() => findButton(header, '모두 오늘로')).toThrow()
  })
})

describe('떠 있는 대화상자가 있으면 단축키를 멈춘다', () => {
  // 빠른 추가 팝오버(role=dialog, aria-modal=true)가 열린 문서를 흉내 낸다
  const docWith = (selectors: string[]): Pick<ParentNode, 'querySelector'> => ({
    querySelector: ((sel: string) =>
      sel
        .split(',')
        .map((x) => x.trim())
        .some((x) => selectors.includes(x))
        ? ({} as Element)
        : null) as ParentNode['querySelector']
  })

  it('aria-modal 또는 role=dialog 요소가 있으면 overlay 로 본다', () => {
    expect(OVERLAY_SELECTOR).toContain('[aria-modal="true"]')
    expect(OVERLAY_SELECTOR).toContain('[role="dialog"]')
    expect(hasOpenOverlay(docWith(['[aria-modal="true"]']))).toBe(true)
    expect(hasOpenOverlay(docWith(['[role="dialog"]']))).toBe(true)
    expect(hasOpenOverlay(docWith([]))).toBe(false)
  })

  it('팝오버가 열린 상태의 keydown(j/k/Space/1~3/Meta+Backspace/Esc)은 무시한다', () => {
    const overlayOpen = hasOpenOverlay(docWith(['[aria-modal="true"]', '[role="dialog"]']))
    const keys = [
      { key: 'j' },
      { key: 'k' },
      { key: ' ' },
      { key: '1' },
      { key: '2' },
      { key: '3' },
      { key: 'Backspace', metaKey: true },
      { key: 'Escape' }
    ]
    for (const e of keys) expect(todoKeyAction(e, { typing: false, overlayOpen }), e.key).toBeNull()
    // 팝오버가 없으면 같은 키가 동작한다
    expect(todoKeyAction({ key: 'j' }, { typing: false, overlayOpen: hasOpenOverlay(docWith([])) })).toBe('next')
  })
})

describe('할 일 폴더 소스', () => {
  it('확인 창(window.confirm)과 옛 TodoForm 이 없고, 화면 문구에 TODO 표기가 없다', () => {
    const dir = resolve(__dirname)
    expect(existsSync(resolve(dir, 'TodoForm.tsx'))).toBe(false)
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx') && !n.includes('.test.'))) {
      const src = readFileSync(resolve(dir, f), 'utf8')
      expect(src, f).not.toMatch(/\bconfirm\(/)
      expect(src, f).not.toContain('TodoForm')
      // 문자열·JSX 글자 안의 'TODO' 표기
      const strings = src.match(/'[^'\n]*'|`[^`\n]*`|>[^<>{}\n]+</g) ?? []
      for (const s of strings) expect(s, f).not.toMatch(/\bTODO\b/)
    }
  })
})
