import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Todo, TodoTag } from '../../types'
import { collect, textOf, type AnyElement } from '../today/testTree'

// 행 펼침 편집과 실행 취소(완료·삭제)를 잠근다.
// 이 저장소에는 DOM 테스트 환경이 없다. 그래서 React 훅을 슬롯 배열에 값을 두는 단순 구현으로 바꾸고,
// 컴포넌트를 함수로 불러 반환 트리의 핸들러를 직접 부른다. 상태를 바꾼 뒤에는 render() 로 다시 그린다.
// 스토어·토스트·todoModel 은 실제 모듈이고 window.api 만 가짜다.

const h = vi.hoisted(() => ({ slots: [] as unknown[], i: 0 }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const slot = <T,>(make: () => T): [number, T] => {
    const i = h.i++
    if (!(i in h.slots)) h.slots[i] = make()
    return [i, h.slots[i] as T]
  }
  return {
    ...actual,
    useState: <T,>(init: T | (() => T)) => {
      const [i, v] = slot(() => (typeof init === 'function' ? (init as () => T)() : init))
      const set = (next: T | ((p: T) => T)): void => {
        h.slots[i] = typeof next === 'function' ? (next as (p: T) => T)(h.slots[i] as T) : next
      }
      return [v, set]
    },
    useRef: <T,>(init: T) => slot(() => ({ current: init }))[1],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: <T,>(f: () => T) => f(),
    useCallback: <T,>(f: T) => f
  }
})

// zustand 훅은 렌더 밖에서 부를 수 없다. 훅이 현재 상태를 돌려주게 바꿔 끼운다(MemoView.test 와 같은 방식)
vi.mock('../../stores/todoStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../stores/todoStore')>()
  const hook = Object.assign((sel?: (s: unknown) => unknown) => {
    const s = real.useTodoStore.getState()
    return sel ? sel(s) : s
  }, real.useTodoStore)
  return { ...real, useTodoStore: hook }
})

// 출처 칩의 앱 안 링크 열기를 지켜본다
const link = vi.hoisted(() => ({ open: vi.fn(async (_href: string) => {}) }))
vi.mock('../../utils/openInternalLink', () => ({ openInternalLink: link.open }))

const { default: TodoItem, splitDue, dueFromDateInput, dueFromTimeInput } = await import('./TodoItem')
const { useTodoStore } = await import('../../stores/todoStore')
const { flushToasts, dismissToast, useToastStore } = await import('../ui/toastStore')

const TODAY = '2026-11-20'
const NOW = (): Date => new Date(2026, 10, 20, 10, 0)

const tags: TodoTag[] = [
  { id: 1, name: '업무', color: '#3B82F6', created_at: '', updated_at: '' },
  { id: 2, name: '개인', color: '#22C55E', created_at: '', updated_at: '' }
]

const todo = (over: Partial<Todo> = {}): Todo => ({
  id: 7,
  title: '보고서 쓰기',
  priority: 'medium',
  due_date: null,
  due_reminder: 0,
  is_completed: 0,
  completed_at: null,
  notes: null,
  source_link: null,
  created_at: '2026-11-01 09:00:00',
  updated_at: '2026-11-01 09:00:00',
  tags: [tags[0]],
  ...over
})

const windowOpen = vi.fn()

function stubApi() {
  const api = {
    create: vi.fn(async () => ({ id: 99 })),
    list: vi.fn(async () => [] as Todo[]),
    listByTag: vi.fn(async () => [] as Todo[]),
    listActive: vi.fn(async () => [] as Todo[]),
    update: vi.fn(async () => ({})),
    complete: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    setCompletedAt: vi.fn(async () => {})
  }
  vi.stubGlobal('window', {
    api: { todo: api, todoTag: { list: vi.fn(async () => []) } },
    open: windowOpen,
    addEventListener: () => {},
    removeEventListener: () => {}
  })
  return api
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

let api: ReturnType<typeof stubApi>
let onExpand: ReturnType<typeof vi.fn<() => void>>
let onCollapse: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  h.slots = []
  link.open.mockClear()
  windowOpen.mockClear()
  api = stubApi()
  onExpand = vi.fn<() => void>()
  onCollapse = vi.fn<() => void>()
  useTodoStore.setState({ pendingDeleteIds: [], todos: [], completedTodos: [] })
})

afterEach(async () => {
  flushToasts()
  await flush()
  vi.unstubAllGlobals()
})

const render = (t: Todo, expanded = true): AnyElement[] => {
  h.i = 0
  return collect(
    <TodoItem
      todo={t}
      today={TODAY}
      tags={tags}
      expanded={expanded}
      onExpand={onExpand}
      onCollapse={onCollapse}
      now={NOW}
    />
  )
}

const byLabel = (els: AnyElement[], type: string, label: string): AnyElement => {
  const el = els.find((e) => e.type === type && e.props['aria-label'] === label)
  if (!el) throw new Error(`${type}[aria-label=${label}] 없음`)
  return el
}

const button = (els: AnyElement[], text: string): AnyElement => {
  const el = els.find((e) => e.type === 'button' && textOf(e).trim() === text)
  if (!el) throw new Error(`button 없음: ${text}`)
  return el
}

const call = (el: AnyElement, handler: string, event: unknown = {}): unknown =>
  (el.props[handler] as (e: unknown) => unknown)({ stopPropagation: () => {}, preventDefault: () => {}, ...(event as object) })

describe('TodoItem 접힌 행', () => {
  it('체크박스·제목·값 있는 메타만 보인다. 편집 영역은 없다', () => {
    const els = render(todo({ priority: 'high', due_date: '2026-11-21', notes: '메모' }), false)
    expect(els.some((e) => e.props.role === 'checkbox')).toBe(true)
    const text = els.map((e) => textOf(e)).join(' ')
    expect(text).toContain('보고서 쓰기')
    expect(text).toContain('높음')
    expect(text).toContain('업무')
    expect(text).toContain('내일')
    expect(els.some((e) => e.props['aria-label'] === '메모 있음')).toBe(true)
    expect(els.some((e) => e.props['aria-label'] === '제목')).toBe(false)
  })

  it('행을 누르면 그 자리에서 펼친다. 체크박스 클릭은 펼치지 않는다', () => {
    const els = render(todo(), false)
    const row = els.find((e) => e.type === 'div' && typeof e.props.onClick === 'function')!
    call(row, 'onClick', { target: { closest: () => null } })
    expect(onExpand).toHaveBeenCalledTimes(1)
    call(byLabel(els, 'button', '보고서 쓰기 완료'), 'onClick')
    expect(onExpand).toHaveBeenCalledTimes(1)
  })
})

describe('TodoItem 펼친 편집: 고치면 todo.update 가 불린다', () => {
  it('제목: blur 에 저장', async () => {
    const els = render(todo())
    call(byLabel(els, 'input', '제목'), 'onBlur', { currentTarget: { value: '  주간 보고서  ' } })
    await flush()
    expect(api.update).toHaveBeenCalledWith(7, { title: '주간 보고서' })
  })

  it('제목을 비우거나 그대로면 저장하지 않는다', async () => {
    const els = render(todo())
    call(byLabel(els, 'input', '제목'), 'onBlur', { currentTarget: { value: '   ' } })
    call(byLabel(els, 'input', '제목'), 'onBlur', { currentTarget: { value: '보고서 쓰기' } })
    await flush()
    expect(api.update).not.toHaveBeenCalled()
  })

  it('메모: ⌘Enter 에 저장하고 접는다', async () => {
    const els = render(todo())
    call(byLabel(els, 'textarea', '메모'), 'onKeyDown', {
      key: 'Enter',
      metaKey: true,
      nativeEvent: { isComposing: false },
      currentTarget: { value: '목차부터' }
    })
    await flush()
    expect(api.update).toHaveBeenCalledWith(7, { notes: '목차부터' })
    expect(onCollapse).toHaveBeenCalled()
  })

  it('Esc 는 저장 없이 접는다(뒤따르는 blur 도 저장하지 않는다)', async () => {
    const els = render(todo())
    const input = byLabel(els, 'input', '제목')
    call(input, 'onKeyDown', { key: 'Escape', nativeEvent: { isComposing: false }, currentTarget: { value: '바뀐 제목' } })
    call(input, 'onBlur', { currentTarget: { value: '바뀐 제목' } })
    await flush()
    expect(onCollapse).toHaveBeenCalled()
    expect(api.update).not.toHaveBeenCalled()
  })

  it('마감: 빠른 날짜 버튼은 즉시, 날짜·시각 입력은 blur 에 저장한다(시각이 있으면 알림 1)', async () => {
    let els = render(todo())
    call(button(els, '내일'), 'onClick')
    await flush()
    expect(api.update).toHaveBeenLastCalledWith(7, { due_date: '2026-11-21', due_reminder: 0 })

    els = render(todo({ due_date: '2026-11-21' }))
    // 값이 그대로면 저장하지 않는다
    call(byLabel(els, 'input', '마감 시각'), 'onBlur', { target: { value: '' } })
    await flush()
    expect(api.update).toHaveBeenCalledTimes(1)
    call(byLabel(els, 'input', '마감 시각'), 'onBlur', { target: { value: '15:00' } })
    await flush()
    expect(api.update).toHaveBeenLastCalledWith(7, { due_date: '2026-11-21 15:00', due_reminder: 1 })

    els = render(todo({ due_date: '2026-11-21 15:00', due_reminder: 1 }))
    call(byLabel(els, 'input', '마감 날짜'), 'onBlur', { target: { value: '2026-11-24' } })
    await flush()
    expect(api.update).toHaveBeenLastCalledWith(7, { due_date: '2026-11-24 15:00', due_reminder: 1 })

    call(button(els, '날짜 없음'), 'onClick')
    await flush()
    expect(api.update).toHaveBeenLastCalledWith(7, { due_date: null, due_reminder: 0 })
  })

  it('우선순위·태그 버튼은 즉시 저장한다', async () => {
    const els = render(todo())
    call(button(els, '높음'), 'onClick')
    await flush()
    expect(api.update).toHaveBeenLastCalledWith(7, { priority: 'high' })
    call(button(els, '개인'), 'onClick')
    await flush()
    expect(api.update).toHaveBeenLastCalledWith(7, { tag_ids: [1, 2] })
    call(button(els, '업무'), 'onClick')
    await flush()
    expect(api.update).toHaveBeenLastCalledWith(7, { tag_ids: [] })
  })

  it('저장 실패는 펼친 영역에 문구로 보인다', async () => {
    api.update.mockRejectedValueOnce(new Error('DB 잠김'))
    let els = render(todo())
    call(button(els, '높음'), 'onClick')
    await flush()
    els = render(todo())
    const alert = els.find((e) => e.props.role === 'alert')
    expect(alert && textOf(alert)).toContain('DB 잠김')
  })

  it('완료 항목은 완료 날짜 편집과 되돌리기를 보인다', async () => {
    const els = render(todo({ is_completed: 1, completed_at: '2026-11-19 18:30:00' }))
    expect(byLabel(els, 'input', '완료 날짜').props.value).toBe('2026-11-19T18:30')
    call(button(els, '완료 날짜 저장'), 'onClick')
    await flush()
    expect(api.setCompletedAt).toHaveBeenCalledWith(7, '2026-11-19 18:30:00')
    call(button(els, '진행 중으로 되돌리기'), 'onClick')
    await flush()
    expect(api.restore).toHaveBeenCalledWith(7)
  })
})

describe('TodoItem 실행 취소', () => {
  const lastToastId = (): number => {
    const toasts = useToastStore.getState().toasts
    return toasts[toasts.length - 1].id
  }

  it('삭제: 토스트가 끝나기 전에는 todo.delete 를 부르지 않고 목록에서만 숨긴다. flushToasts 가 확정한다', async () => {
    const els = render(todo())
    call(button(els, '삭제'), 'onClick')
    expect(onCollapse).toHaveBeenCalled()
    expect(useTodoStore.getState().pendingDeleteIds).toEqual([7])
    await flush()
    expect(api.delete).not.toHaveBeenCalled()
    flushToasts()
    await flush()
    expect(api.delete).toHaveBeenCalledWith(7)
  })

  it('삭제 실행 취소: 숨김만 풀고 todo.delete 를 부르지 않는다', async () => {
    const els = render(todo())
    call(button(els, '삭제'), 'onClick')
    dismissToast(lastToastId(), 'action')
    await flush()
    expect(useTodoStore.getState().pendingDeleteIds).toEqual([])
    flushToasts()
    await flush()
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('완료: 체크하면 바로 todo.complete, 실행 취소하면 todo.restore', async () => {
    const els = render(todo(), false)
    call(byLabel(els, 'button', '보고서 쓰기 완료'), 'onClick')
    await flush()
    expect(api.complete).toHaveBeenCalledWith(7)
    dismissToast(lastToastId(), 'action')
    await flush()
    expect(api.restore).toHaveBeenCalledWith(7)
  })
})

describe('마감 입력 변환', () => {
  it('splitDue·dueFromDateInput·dueFromTimeInput', () => {
    expect(splitDue('2026-11-21 09:30')).toEqual({ date: '2026-11-21', time: '09:30' })
    expect(splitDue(null)).toEqual({ date: '', time: '' })
    expect(dueFromDateInput('2026-11-21 09:30', '')).toEqual({ due_date: null, due_reminder: 0 })
    expect(dueFromTimeInput(null, '09:00', TODAY)).toEqual({ due_date: '2026-11-20 09:00', due_reminder: 1 })
    expect(dueFromTimeInput('2026-11-21 09:00', '', TODAY)).toEqual({ due_date: '2026-11-21', due_reminder: 0 })
  })
})

describe('TodoItem 출처 링크', () => {
  const chipOf = (els: AnyElement[]): AnyElement | undefined =>
    els.find((e) => e.type === 'button' && String(e.props['aria-label'] ?? '').startsWith('출처 열기'))

  it('앱 안 출처는 접힌 행에 라벨 칩을 보이고, 누르면 그 링크를 앱 안에서 연다', () => {
    const els = render(todo({ source_link: 'linkwork://memo/12' }), false)
    const chip = chipOf(els)
    expect(chip && textOf(chip)).toBe('메모')
    call(chip as AnyElement, 'onClick')
    expect(link.open).toHaveBeenCalledWith('linkwork://memo/12')
    expect(onExpand).not.toHaveBeenCalled()
  })

  it('Jira 출처는 키를 라벨로 보이고, 누르면 브라우저로 연다', () => {
    const url = 'https://x.atlassian.net/browse/AB-1'
    const els = render(todo({ source_link: url }), false)
    const chip = chipOf(els)
    expect(chip && textOf(chip)).toBe('AB-1')
    call(chip as AnyElement, 'onClick')
    expect(windowOpen).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer')
    expect(link.open).not.toHaveBeenCalled()
  })

  it('안전하지 않은 링크·출처 없음은 칩을 보이지 않는다', () => {
    expect(chipOf(render(todo({ source_link: 'javascript:alert(1)' }), false))).toBeUndefined()
    expect(chipOf(render(todo({ source_link: 'http://a.com' }), false))).toBeUndefined()
    expect(chipOf(render(todo(), false))).toBeUndefined()
  })

  it('펼친 영역의 출처 연결 해제는 update({ source_link: null }) 를 부른다', async () => {
    const els = render(todo({ source_link: 'linkwork://note/5' }))
    call(button(els, '출처 연결 해제'), 'onClick')
    await flush()
    expect(api.update).toHaveBeenCalledWith(7, { source_link: null })
  })

  it('출처가 없으면 연결 해제 버튼이 없다', () => {
    const els = render(todo())
    expect(els.some((e) => e.type === 'button' && textOf(e).trim() === '출처 연결 해제')).toBe(false)
  })
})
