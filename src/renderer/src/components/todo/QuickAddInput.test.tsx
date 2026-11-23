import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TodoInput } from '../../types'
import { collect, click, textOf, type AnyElement } from '../today/testTree'

// DOM 테스트 환경이 없어 QuickAddInput 을 함수로 직접 부른다(today/testTree.ts 참고).
// useState·useRef 를 호출 순서별 칸에 값을 두는 단순 구현으로 바꿔, 다시 부르면 바뀐 상태로 그려지게 한다
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], i: 0 }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(init: T | (() => T)) => {
      const k = hooks.i++
      if (!(k in hooks.slots)) hooks.slots[k] = typeof init === 'function' ? (init as () => T)() : init
      const set = (v: unknown): void => {
        hooks.slots[k] = typeof v === 'function' ? (v as (p: unknown) => unknown)(hooks.slots[k]) : v
      }
      return [hooks.slots[k], set]
    },
    useRef: <T,>(init: T) => {
      const k = hooks.i++
      if (!(k in hooks.slots)) hooks.slots[k] = { current: init }
      return hooks.slots[k]
    },
    useEffect: () => {}
  }
})

const api = {
  todo: {
    create: vi.fn(async () => ({ id: 7 })),
    list: vi.fn(async () => []),
    listByTag: vi.fn(async () => []),
    listActive: vi.fn(async () => [])
  }
}
vi.stubGlobal('window', { api })

const { default: QuickAddInput } = await import('./QuickAddInput')
type Props = Parameters<typeof QuickAddInput>[0]
const { useTodoStore } = await import('../../stores/todoStore')

// 기준 시각: 2026-11-20(금) 10:00
const NOW = new Date(2026, 10, 20, 10, 0)

const flush = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

function render(props: Props): AnyElement[] {
  hooks.i = 0
  return collect(QuickAddInput(props))
}
const inputOf = (els: AnyElement[]): AnyElement => {
  const el = els.find((e) => e.type === 'input')
  if (!el) throw new Error('input 없음')
  return el
}
const enter = (over: Record<string, unknown> = {}) => ({
  key: 'Enter',
  metaKey: false,
  keyCode: 13,
  nativeEvent: { isComposing: false },
  preventDefault: vi.fn(),
  ...over
})

/** 글자를 넣고 다시 그린 뒤, 입력 요소에 가짜 DOM 요소를 붙인다(포커스 확인용) */
function typeText(props: Props, text: string): { input: AnyElement; focus: ReturnType<typeof vi.fn> } {
  const before = inputOf(render(props))
  ;(before.props.onChange as (e: unknown) => void)({ target: { value: text } })
  const input = inputOf(render(props))
  const focus = vi.fn()
  ;(input.props.ref as (el: unknown) => void)({ focus })
  return { input, focus }
}
const keyDown = (input: AnyElement, e: unknown): void => (input.props.onKeyDown as (e: unknown) => void)(e)

beforeEach(() => {
  hooks.slots.length = 0
  hooks.i = 0
  api.todo.create.mockClear()
})

afterEach(async () => {
  const { flushToasts } = await import('../ui/toastStore')
  flushToasts()
})

describe('QuickAddInput 저장', () => {
  it('제목만 치고 Enter 하면 todo.create 가 불리고 입력이 비며 포커스가 입력에 남는다', async () => {
    const props: Props = {
      tags: [],
      now: () => NOW,
      onSubmit: async (input: TodoInput) => {
        await useTodoStore.getState().createTodo(input)
      }
    }
    const { input, focus } = typeText(props, '보고서 작성')
    const e = enter()
    keyDown(input, e)
    expect(e.preventDefault).toHaveBeenCalled()
    await flush()
    expect(api.todo.create).toHaveBeenCalledWith({ title: '보고서 작성' })
    expect(inputOf(render(props)).props.value).toBe('')
    expect(focus).toHaveBeenCalled()
  })

  it('자연어 인식 결과를 구조화해 넘긴다. Cmd+Enter 는 openAfter', async () => {
    const onSubmit = vi.fn(async () => {})
    const props: Props = { tags: [{ id: 1, name: '업무', color: 'blue', created_at: '', updated_at: '' }], now: () => NOW, onSubmit }
    const { input } = typeText(props, '내일 3시 회의 준비 !높음 #업무')
    keyDown(input, enter({ metaKey: true }))
    await flush()
    expect(onSubmit).toHaveBeenCalledWith(
      { title: '회의 준비', priority: 'high', due_date: '2026-11-21 15:00', due_reminder: 1, tag_ids: [1] },
      { openAfter: true }
    )
  })

  it('한글 조합 중 Enter 는 무시한다', async () => {
    const onSubmit = vi.fn(async () => {})
    const props: Props = { tags: [], now: () => NOW, onSubmit }
    const { input } = typeText(props, '회의')
    keyDown(input, enter({ nativeEvent: { isComposing: true } }))
    keyDown(input, enter({ keyCode: 229 }))
    await flush()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(inputOf(render(props)).props.value).toBe('회의')
  })

  it('빈 입력의 Enter 는 저장하지 않는다', async () => {
    const onSubmit = vi.fn(async () => {})
    const props: Props = { tags: [], now: () => NOW, onSubmit }
    const { input } = typeText(props, '   ')
    keyDown(input, enter())
    await flush()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('저장에 실패하면 입력을 그대로 두고 오류 문구를 보인다', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('DB 잠김')
    })
    const props: Props = { tags: [], now: () => NOW, onSubmit }
    const { input } = typeText(props, '보고서 작성')
    keyDown(input, enter())
    await flush()
    const els = render(props)
    expect(inputOf(els).props.value).toBe('보고서 작성')
    const alert = els.find((e) => e.props.role === 'alert')
    expect(alert).toBeDefined()
    expect(textOf(alert)).toContain('할 일을 추가하지 못했어요. DB 잠김')
  })
})

describe('QuickAddInput 인식 칩', () => {
  it('인식한 토큰을 칩으로 보이고 x 로 일반 글자로 되돌린다', async () => {
    const onSubmit = vi.fn(async () => {})
    const props: Props = { tags: [], now: () => NOW, onSubmit }
    typeText(props, '내일 3시 회의')
    let els = render(props)
    const cancelTime = els.find((e) => e.type === 'button' && e.props['aria-label'] === '15:00 인식 취소')
    expect(cancelTime).toBeDefined()
    expect(els.some((e) => e.type === 'button' && e.props['aria-label'] === '내일 인식 취소')).toBe(true)
    click(cancelTime as AnyElement)
    els = render(props)
    expect(els.some((e) => e.type === 'button' && e.props['aria-label'] === '15:00 인식 취소')).toBe(false)
    keyDown(inputOf(els), enter())
    await flush()
    expect(onSubmit).toHaveBeenCalledWith({ title: '3시 회의', due_date: '2026-11-21', due_reminder: 0 }, { openAfter: false })
  })
})

describe('QuickAddInput 붙여넣기·Esc', () => {
  const pasteEvent = (text: string) => ({
    clipboardData: { getData: () => text },
    preventDefault: vi.fn()
  })

  it('여러 줄 붙여넣기는 기본 동작을 막고 글머리를 지운 줄 목록을 넘긴다', () => {
    const onBulkPaste = vi.fn()
    const props: Props = { tags: [], now: () => NOW, onSubmit: async () => {}, onBulkPaste }
    const input = inputOf(render(props))
    const e = pasteEvent('- 첫째\n\n* 둘째\n')
    ;(input.props.onPaste as (e: unknown) => void)(e)
    expect(e.preventDefault).toHaveBeenCalled()
    expect(onBulkPaste).toHaveBeenCalledWith(['첫째', '둘째'])
  })

  it('한 줄 붙여넣기·onBulkPaste 없음은 기본 붙여넣기다', () => {
    const onBulkPaste = vi.fn()
    const input = inputOf(render({ tags: [], now: () => NOW, onSubmit: async () => {}, onBulkPaste }))
    const one = pasteEvent('한 줄\n')
    ;(input.props.onPaste as (e: unknown) => void)(one)
    expect(one.preventDefault).not.toHaveBeenCalled()
    expect(onBulkPaste).not.toHaveBeenCalled()

    const input2 = inputOf(render({ tags: [], now: () => NOW, onSubmit: async () => {} }))
    const multi = pasteEvent('a\nb')
    ;(input2.props.onPaste as (e: unknown) => void)(multi)
    expect(multi.preventDefault).not.toHaveBeenCalled()
  })

  it('Escape 는 onEscape', () => {
    const onEscape = vi.fn()
    const input = inputOf(render({ tags: [], now: () => NOW, onSubmit: async () => {}, onEscape }))
    keyDown(input, { key: 'Escape', nativeEvent: { isComposing: false }, preventDefault: vi.fn() })
    expect(onEscape).toHaveBeenCalledTimes(1)
  })
})

describe('QuickAddInput 미리 채우기', () => {
  it('initialValue 를 처음 값으로 쓰고, 그대로 Enter 하면 그 글자로 저장한다', async () => {
    const onSubmit = vi.fn(async (_input: TodoInput, _opts: { openAfter: boolean }) => {})
    const props: Props = { tags: [], now: () => NOW, onSubmit, initialValue: '배포 절차 정리' }
    const input = inputOf(render(props))
    expect(input.props.value).toBe('배포 절차 정리')
    keyDown(input, enter())
    await flush()
    expect(onSubmit).toHaveBeenCalledWith({ title: '배포 절차 정리' }, { openAfter: false })
  })

  it('initialValue 가 없으면 빈 입력이다', () => {
    expect(inputOf(render({ tags: [], now: () => NOW, onSubmit: async () => {} })).props.value).toBe('')
  })
})
