import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TodayDashboard, TodoRow } from './todayModel'
import { collect, click, findButton } from './testTree'

// DOM 환경이 없어 TodoCard 를 함수로 직접 부른다. 그래서 useState 만 단순 구현으로 바꾼다
// 세터는 호출을 기록한다. 실패 문구가 setError 로 가는지 본다
// states 에 값을 넣어 두면 useState 가 호출 순서대로 그 값을 돌려준다(입력 중 상태를 흉내 낸다)
const setters = vi.hoisted(() => ({ calls: [] as unknown[], states: [] as unknown[] }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(init: T | (() => T)) => [
      setters.states.length > 0 ? setters.states.shift() : typeof init === 'function' ? (init as () => T)() : init,
      (v: unknown) => setters.calls.push(v)
    ]
  }
})

const { default: TodoCard, handleQuickAddKey, todoDueText } = await import('./TodoCard')

const row = (over: Partial<TodoRow> & Pick<TodoRow, 'id'>): TodoRow => ({
  title: `할 일 ${over.id}`,
  priority: 'medium',
  dueDate: null,
  bucket: 'none',
  signaled: false,
  ...over
})

const todos = (over: Partial<TodayDashboard['todos']> = {}): TodayDashboard['todos'] => ({
  rows: [
    row({ id: 1, title: '주간 보고', dueDate: '2026-11-17', bucket: 'overdue', signaled: true }),
    row({ id: 2, title: '배포 체크리스트', dueDate: '2026-11-19', bucket: 'today', priority: 'high' }),
    row({ id: 3, title: '문서 정리' })
  ],
  moreCount: 2,
  doneTodayCount: 1,
  ...over
})

const noop = (): void => {}
// 2026-11-19(목) 10:00 로컬
const NOW = (): Date => new Date(2026, 10, 19, 10, 0)

describe('TodoCard', () => {
  it('행·마감·강조 표식·완료 수·빠른 추가·외 n건 을 그린다', () => {
    const html = renderToStaticMarkup(
      <TodoCard todos={todos()} onComplete={noop} onAdd={noop} onOpenTodo={noop} onOpenTodos={noop} />
    )
    expect(html).toContain('주간 보고')
    expect(html).toContain('11/17 지남')
    expect(html).toContain('>오늘</span>')
    expect(html).toContain('오늘 완료 1')
    expect(html).toContain('할 일 빠른 추가')
    expect(html).toContain('외 2건 →')
    // 우선순위는 점이 아닌 글자 배지다
    expect(html).toMatch(/title="우선순위 높음">높음<\/span>/)
    // 긴 제목이 한 글자만 넘어가지 않도록 낱말 단위 줄바꿈
    expect(html).toContain('break-keep text-pretty')
    const first = html.slice(html.indexOf('data-todo="1"'), html.indexOf('data-todo="2"'))
    expect(first).toContain('먼저 챙길 항목')
  })

  it('빈 목록이면 안내를 보이고 빠른 추가는 남는다', () => {
    const html = renderToStaticMarkup(
      <TodoCard todos={todos({ rows: [], moreCount: 0, doneTodayCount: 0 })} onComplete={noop} onAdd={noop} onOpenTodo={noop} onOpenTodos={noop} />
    )
    expect(html).toContain('남은 할 일이 없어요')
    expect(html).toContain('할 일 빠른 추가')
    expect(html).toContain('할 일 화면 →')
  })

  it('체크하면 그 id 로 onComplete 를 부른다', async () => {
    const onComplete = vi.fn(async () => {})
    const tree = TodoCard({ todos: todos(), onComplete, onAdd: noop, onOpenTodo: noop, onOpenTodos: noop })
    const boxes = collect(tree).filter((e) => e.type === 'button' && e.props.role === 'checkbox')
    expect(boxes).toHaveLength(3)
    click(boxes[1])
    await Promise.resolve()
    await Promise.resolve()
    expect(onComplete).toHaveBeenCalledWith(2)
  })

  it('제목을 누르면 onOpenTodo, 외 n건 은 onOpenTodos', () => {
    const onOpenTodo = vi.fn()
    const onOpenTodos = vi.fn()
    const tree = TodoCard({ todos: todos(), onComplete: noop, onAdd: noop, onOpenTodo, onOpenTodos })
    click(findButton(tree, '문서 정리'))
    expect(onOpenTodo).toHaveBeenCalledWith(3)
    click(findButton(tree, '외 2건'))
    expect(onOpenTodos).toHaveBeenCalledTimes(1)
  })

  it('빠른 추가: Enter 면 다듬은 제목으로 추가하고 성공 뒤 입력을 비운다. 빈 값·조합 중·다른 키는 무시한다', async () => {
    const onAdd = vi.fn(async (_input: unknown) => {})
    const onCleared = vi.fn()
    const ev = (value: string, key = 'Enter', isComposing = false) => ({
      key,
      nativeEvent: { isComposing },
      currentTarget: { value },
      preventDefault: vi.fn()
    })
    const e1 = ev('  배포 노트 확인 ')
    await handleQuickAddKey(e1, onAdd, undefined, { now: NOW, onCleared })
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '배포 노트 확인' }))
    // 날짜를 적지 않으면 마감은 오늘(시각·알림 없음)
    expect(onAdd.mock.calls[0][0]).toHaveProperty('due_date', '2026-11-19')
    expect(e1.currentTarget.value).toBe('')
    expect(onCleared).toHaveBeenCalledTimes(1)
    await handleQuickAddKey(ev('   '), onAdd)
    await handleQuickAddKey(ev('조합', 'Enter', true), onAdd)
    await handleQuickAddKey(ev('a', 'a'), onAdd)
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('빠른 추가: 날짜·시각·우선순위·태그를 알아본 TodoInput 을 넘긴다', async () => {
    const onAdd = vi.fn(async (_input: unknown) => {})
    const e = { key: 'Enter', nativeEvent: { isComposing: false }, currentTarget: { value: '내일 3시 배포 준비 !높음 #업무' }, preventDefault: vi.fn() }
    await handleQuickAddKey(e, onAdd, undefined, { now: NOW, tags: [{ id: 7, name: '업무' }] })
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: '배포 준비', due_date: '2026-11-20 15:00', due_reminder: 1, priority: 'high', tag_ids: [7] })
    )
    // 태그 목록이 없으면 #업무 는 제목에 남는다
    const e2 = { key: 'Enter', nativeEvent: { isComposing: false }, currentTarget: { value: '정리 #업무' }, preventDefault: vi.fn() }
    await handleQuickAddKey(e2, onAdd, undefined, { now: NOW })
    expect(onAdd).toHaveBeenLastCalledWith(expect.objectContaining({ title: '정리 #업무' }))
  })

  it('입력 중이면 알아본 내용을 입력 아래 한 줄로 보인다', () => {
    setters.states.push([], '', '내일 3시 회의 준비 !높음')
    const html = renderToStaticMarkup(
      <TodoCard todos={todos()} onComplete={noop} onAdd={noop} onOpenTodo={noop} onOpenTodos={noop} now={NOW} />
    )
    setters.states.length = 0
    expect(html).toContain('data-quick-add-summary')
    expect(html).toContain('내일 15:00 · 높음')
    // 입력이 비어 있으면 요약이 없다
    const empty = renderToStaticMarkup(
      <TodoCard todos={todos()} onComplete={noop} onAdd={noop} onOpenTodo={noop} onOpenTodos={noop} now={NOW} />
    )
    expect(empty).not.toContain('data-quick-add-summary')
  })

  it('빠른 추가 실패: 입력을 그대로 두고 실패 문구를 넘긴다', async () => {
    const onError = vi.fn()
    const e = { key: 'Enter', nativeEvent: { isComposing: false }, currentTarget: { value: '새 일' }, preventDefault: vi.fn() }
    await handleQuickAddKey(e, async () => { throw new Error('DB 잠김') }, onError)
    expect(e.currentTarget.value).toBe('새 일')
    expect(onError).toHaveBeenCalledWith('할 일을 추가하지 못했어요. DB 잠김')
  })

  it('체크 실패는 카드 안 실패 문구로 남긴다', async () => {
    setters.calls.length = 0
    const tree = TodoCard({
      todos: todos(),
      onComplete: async () => { throw new Error('IPC 끊김') },
      onAdd: noop,
      onOpenTodo: noop,
      onOpenTodos: noop
    })
    const box = collect(tree).find((e) => e.type === 'button' && e.props.role === 'checkbox')!
    click(box)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(setters.calls).toContain('할 일을 완료하지 못했어요. IPC 끊김')
  })

  it('빠른 추가 입력의 onKeyDown 이 onAdd 로 이어진다', async () => {
    const onAdd = vi.fn(async (_input: unknown) => {})
    const tree = TodoCard({ todos: todos(), onComplete: noop, onAdd, onOpenTodo: noop, onOpenTodos: noop })
    const input = collect(tree).find((e) => e.type === 'input')!
    ;(input.props.onKeyDown as (e: unknown) => void)({
      key: 'Enter',
      nativeEvent: { isComposing: false },
      currentTarget: { value: '새 할 일' },
      preventDefault: () => {}
    })
    await Promise.resolve()
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '새 할 일' }))
  })

  it('todoDueText', () => {
    expect(todoDueText({ dueDate: null, bucket: 'none' })).toBeNull()
    expect(todoDueText({ dueDate: '2026-11-17 18:00:00', bucket: 'overdue' })?.text).toBe('11/17 지남')
    expect(todoDueText({ dueDate: '2026-11-25', bucket: 'later' })?.text).toBe('11/25')
  })
})
