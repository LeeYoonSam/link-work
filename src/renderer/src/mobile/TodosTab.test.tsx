import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Todo } from '../types'
import { collect, click, findButton } from '../components/today/testTree'
import { createMobileApi, type FetchLike } from './api'
import { removeOptimistically } from './mobileModel'
import { addTodoFromInput, mobileTodoBody, TodoListView, type TodoAddBarProps, type TodoListViewProps } from './TodosTab'

const todo = (over: Partial<Todo> & Pick<Todo, 'id'>): Todo => ({
  title: `할 일 ${over.id}`,
  priority: 'medium',
  due_date: null,
  due_reminder: 0,
  is_completed: 0,
  completed_at: null,
  notes: null,
  source_link: null,
  created_at: '2026-11-01 00:00:00',
  updated_at: '2026-11-01 00:00:00',
  ...over
})

const list = [
  todo({ id: 1, title: '주간 보고', due_date: '2026-11-17', priority: 'high', tags: [{ id: 9, name: '팀', color: '#22c55e', created_at: '', updated_at: '' }] }),
  todo({ id: 2, title: '문서 정리', notes: '**초안** 먼저' })
]

const props = (over: Partial<TodoListViewProps> = {}): TodoListViewProps => ({
  todos: list,
  today: '2026-11-19',
  showCompleted: false,
  error: null,
  refreshing: false,
  onToggle: () => {},
  onShowCompleted: () => {},
  onRefresh: () => {},
  ...over
})

describe('TodoListView', () => {
  it('우선순위·지난 마감·태그·노트 미리보기를 그린다', () => {
    const html = renderToStaticMarkup(<TodoListView {...props()} />)
    expect(html).toContain('주간 보고')
    expect(html).toContain('높음')
    expect(html).toContain('11/17 지남')
    expect(html).toContain('팀')
    expect(html).toContain('초안 먼저')
    // 큰 원형 체크(터치 영역 44px 은 mobile.css .m-check)
    expect(html).toContain('class="m-check"')
    // 우선순위는 색 띠 + 글자
    expect(html).toContain('data-priority="high"')
  })

  it('체크하면 그 id 로 onToggle', () => {
    const onToggle = vi.fn()
    const boxes = collect(TodoListView(props({ onToggle }))).filter((e) => e.type === 'button' && e.props.role === 'checkbox')
    expect(boxes).toHaveLength(2)
    click(boxes[1])
    expect(onToggle).toHaveBeenCalledWith(2)
  })

  it('체크해 빠지는 중인 행은 체크 표시·전환 클래스를 갖고 다시 누를 수 없다', () => {
    const tree = TodoListView(props({ leavingIds: [2] }))
    const html = renderToStaticMarkup(tree)
    const row = html.slice(html.indexOf('data-todo="2"'))
    expect(row).toContain('m-leaving')
    const box = collect(tree).filter((e) => e.type === 'button' && e.props.role === 'checkbox')[1]
    expect(box.props['aria-checked']).toBe(true)
    expect(box.props.disabled).toBe(true)
  })

  it('완료 보기에는 되돌리기 버튼이 있다', () => {
    const onToggle = vi.fn()
    const done = [todo({ id: 3, title: '끝난 일', is_completed: 1, completed_at: '2026-11-18 10:00:00' })]
    const tree = TodoListView(props({ todos: done, showCompleted: true, onToggle }))
    click(findButton(tree, '되돌리기'))
    expect(onToggle).toHaveBeenCalledWith(3)
    expect(renderToStaticMarkup(tree)).toContain('11/18 완료')
  })

  it('체크 → complete 호출, 실패하면 항목이 되돌아오고 오류 문구가 보인다', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ({ ok: false, status: 500, json: async () => ({ error: '저장 실패' }) }))
    const api = createMobileApi(fetchImpl)
    let items: Todo[] = [...list]
    let error: string | null = null
    const ok = await removeOptimistically({
      id: 1,
      items,
      setItems: (fn) => {
        items = fn(items)
      },
      call: (id) => api.completeTodo(id),
      onError: (e) => {
        error = `완료하지 못했어요: ${(e as Error).message}`
      }
    })
    expect(ok).toBe(false)
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/todos/1/complete')
    expect(items.map((t) => t.id)).toEqual([1, 2])
    const html = renderToStaticMarkup(<TodoListView {...props({ todos: items, error })} />)
    expect(html).toContain('주간 보고')
    expect(html).toContain('role="alert"')
    expect(html).toContain('완료하지 못했어요: 저장 실패')
  })

})

// 2026-11-19(목) 10:00 로컬
const NOW = new Date(2026, 10, 19, 10, 0)

const addProps = (over: Partial<TodoAddBarProps> = {}): TodoAddBarProps => ({
  draft: '',
  summary: '',
  busy: false,
  onDraft: () => {},
  onSubmit: () => {},
  ...over
})

describe('할 일 추가 입력 줄', () => {
  it('자연어를 알아본 구조화 필드를 POST /api/todos 로 보낸다', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ({ ok: true, status: 200, json: async () => ({ id: 31 }) }))
    const api = createMobileApi(fetchImpl)
    const out = await addTodoFromInput(api, '내일 3시 회의 준비 !높음', NOW)
    expect(out).toEqual({ id: 31 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/todos')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      title: '회의 준비',
      priority: 'high',
      due_date: '2026-11-20 15:00',
      due_reminder: 1
    })
  })

  it('날짜만 있으면 알림 0, 아무것도 알아보지 못하면 제목만, 빈 입력은 보내지 않는다', async () => {
    expect(mobileTodoBody('11/25 치과', NOW)).toEqual({ title: '치과', due_date: '2026-11-25', due_reminder: 0 })
    expect(mobileTodoBody('  장보기 ', NOW)).toEqual({ title: '장보기' })
    // 태그는 알아보지 않는다
    expect(mobileTodoBody('정리 #업무', NOW)).toEqual({ title: '정리 #업무' })
    expect(mobileTodoBody('   ', NOW)).toBeNull()
    const fetchImpl = vi.fn<FetchLike>()
    expect(await addTodoFromInput(createMobileApi(fetchImpl), '  ', NOW)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('실패하면 서버 문구로 reject 한다(화면은 입력을 남기고 문구를 보인다)', async () => {
    const api = createMobileApi(async () => ({ ok: false, status: 400, json: async () => ({ error: '할 일 제목을 입력하세요.' }) }))
    await expect(addTodoFromInput(api, '무언가', NOW)).rejects.toThrow('할 일 제목을 입력하세요.')
  })

  it('진행 중 목록 위에만 입력 줄과 인식 요약을 그리고, 제출하면 onSubmit', () => {
    const onSubmit = vi.fn()
    const onDraft = vi.fn()
    const add = addProps({ draft: '내일 3시 회의 준비 !높음', summary: '내일 15:00 · 높음', onSubmit, onDraft })
    const tree = TodoListView(props({ add }))
    const html = renderToStaticMarkup(tree)
    expect(html).toContain('aria-label="새 할 일"')
    expect(html).toContain('data-add-summary')
    expect(html).toContain('내일 15:00 · 높음')
    const form = collect(tree).find((e) => e.type === 'form')!
    const preventDefault = vi.fn()
    ;(form.props.onSubmit as (e: unknown) => void)({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const input = collect(tree).find((e) => e.type === 'input' && e.props['aria-label'] === '새 할 일')!
    ;(input.props.onChange as (e: unknown) => void)({ currentTarget: { value: '모레' } })
    expect(onDraft).toHaveBeenCalledWith('모레')
    // 한글 조합 중 Enter 는 제출을 막는다
    const keyPrevent = vi.fn()
    ;(input.props.onKeyDown as (e: unknown) => void)({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault: keyPrevent })
    expect(keyPrevent).toHaveBeenCalled()

    const done = renderToStaticMarkup(TodoListView(props({ add, showCompleted: true, todos: [] })))
    expect(done).not.toContain('aria-label="새 할 일"')
    // 빈 입력은 추가 버튼이 꺼져 있고 요약이 없다
    const empty = renderToStaticMarkup(TodoListView(props({ add: addProps() })))
    expect(empty).not.toContain('data-add-summary')
    expect(empty).toMatch(/<button type="submit" disabled=""/)
  })
})
