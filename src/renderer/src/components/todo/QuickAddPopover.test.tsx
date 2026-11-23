import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TodoTag } from '../../types'
import { collect, textOf, type AnyElement } from '../today/testTree'

// DOM 테스트 환경이 없어 팝오버를 함수로 직접 부른다(today/testTree.ts 참고).
// useState·useRef 는 호출 순서별 칸에 값을 두는 단순 구현, useEffect 는 부르지 않는다
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

// 스토어 훅(zustand)은 렌더 밖에서 부를 수 없어 같은 모양의 가짜로 바꾼다
const store = vi.hoisted(() => ({
  state: {
    tags: [] as TodoTag[],
    createTodo: vi.fn(async (_input: unknown) => 7),
    fetchTags: vi.fn(async () => {})
  }
}))
vi.mock('../../stores/todoStore', () => ({
  useTodoStore: Object.assign((sel: (s: typeof store.state) => unknown) => sel(store.state), {
    getState: () => store.state
  })
}))
const link = vi.hoisted(() => ({ open: vi.fn(async (_href: string) => {}) }))
vi.mock('../../utils/openInternalLink', () => ({ openInternalLink: link.open }))
// 열림 상태 스토어는 실제 모듈을 쓰고, 훅만 현재 상태를 돌려주게 바꾼다
vi.mock('../../stores/quickAddStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../stores/quickAddStore')>()
  const hook = Object.assign((sel?: (s: unknown) => unknown) => {
    const s = real.useQuickAddStore.getState()
    return sel ? sel(s) : s
  }, real.useQuickAddStore)
  return { ...real, useQuickAddStore: hook }
})

const { default: QuickAddPopover, isQuickAddShortcut } = await import('./QuickAddPopover')
const { useQuickAddStore } = await import('../../stores/quickAddStore')
const toast = await import('../ui/toastStore')

const flush = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

const isOpen = (): boolean => useQuickAddStore.getState().isOpen

function render(): AnyElement[] {
  hooks.i = 0
  return collect(QuickAddPopover())
}
const inputOf = (els: AnyElement[]): AnyElement => {
  const el = els.find((e) => e.type === 'input')
  if (!el) throw new Error('input 없음')
  return el
}
const dialogOf = (els: AnyElement[]): AnyElement => {
  const el = els.find((e) => e.props.role === 'dialog')
  if (!el) throw new Error('dialog 없음')
  return el
}

/** 글자를 넣고 Enter 를 누른다. capture 단계(대화상자) → 입력 순서로 keydown 을 보낸다 */
async function typeAndEnter(text: string, mods: { shiftKey?: boolean; metaKey?: boolean } = {}): Promise<void> {
  ;(inputOf(render()).props.onChange as (e: unknown) => void)({ target: { value: text } })
  const els = render()
  const e = {
    key: 'Enter',
    shiftKey: mods.shiftKey === true,
    metaKey: mods.metaKey === true,
    keyCode: 13,
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn()
  }
  ;(dialogOf(els).props.onKeyDownCapture as (e: unknown) => void)(e)
  ;(inputOf(els).props.onKeyDown as (e: unknown) => void)(e)
  await flush()
}

beforeEach(() => {
  hooks.slots.length = 0
  hooks.i = 0
  useQuickAddStore.setState({ isOpen: false, initialText: '', sourceLink: null, seq: 0 })
  useQuickAddStore.getState().open()
  store.state.createTodo.mockClear()
  link.open.mockClear()
  toast.flushToasts()
})

afterEach(() => {
  toast.flushToasts()
})

describe('isQuickAddShortcut', () => {
  it('Cmd+Shift+A (대소문자 무시) 만 받는다', () => {
    expect(isQuickAddShortcut({ key: 'a', metaKey: true, shiftKey: true })).toBe(true)
    expect(isQuickAddShortcut({ key: 'A', metaKey: true, shiftKey: true })).toBe(true)
    expect(isQuickAddShortcut({ key: 'a', metaKey: true })).toBe(false)
    expect(isQuickAddShortcut({ key: 'a', shiftKey: true })).toBe(false)
    expect(isQuickAddShortcut({ key: 'a', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(isQuickAddShortcut({ key: 'a', metaKey: true, shiftKey: true, altKey: true })).toBe(false)
    expect(isQuickAddShortcut({ key: 's', metaKey: true, shiftKey: true })).toBe(false)
  })
})

describe('QuickAddPopover', () => {
  it('닫혀 있으면 아무것도 그리지 않는다', () => {
    useQuickAddStore.getState().close()
    hooks.i = 0
    expect(QuickAddPopover()).toBeNull()
  })

  it('열리면 입력에 포커스가 가는 대화상자를 그린다', () => {
    const els = render()
    expect(dialogOf(els).props['aria-label']).toBe('할 일 빠른 추가')
    // 할 일 화면 단축키가 팝오버 아래 목록에 걸리지 않도록 모달로 표시한다(TodoView 의 OVERLAY_SELECTOR)
    expect(dialogOf(els).props['aria-modal']).toBe('true')
    expect(inputOf(els).props.autoFocus).toBe(true)
  })

  it('Enter: 저장하고 닫으며 추가했어요 토스트를 띄운다. 열기는 그 할 일로 이동한다', async () => {
    await typeAndEnter('내일 보고서 작성')
    expect(store.state.createTodo).toHaveBeenCalledWith({ title: '보고서 작성', due_date: expect.any(String), due_reminder: 0 })
    expect(isOpen()).toBe(false)
    const t = toast.useToastStore.getState().toasts.find((x) => x.message === '추가했어요')
    expect(t?.actionLabel).toBe('열기')
    toast.dismissToast((t as { id: number }).id, 'action')
    await flush()
    expect(link.open).toHaveBeenCalledWith('linkwork://todo/7')
  })

  it('Shift+Enter: 저장하고 닫지 않는다(계속 입력)', async () => {
    await typeAndEnter('보고서 작성', { shiftKey: true })
    expect(store.state.createTodo).toHaveBeenCalledWith({ title: '보고서 작성' })
    expect(isOpen()).toBe(true)
    expect(inputOf(render()).props.value).toBe('')
  })

  it('Cmd+Enter: 저장하고 닫은 뒤 그 할 일로 이동한다', async () => {
    await typeAndEnter('보고서 작성', { metaKey: true })
    expect(isOpen()).toBe(false)
    expect(link.open).toHaveBeenCalledWith('linkwork://todo/7')
  })

  it('저장에 실패하면 닫지 않는다', async () => {
    store.state.createTodo.mockRejectedValueOnce(new Error('실패'))
    await typeAndEnter('보고서 작성')
    expect(isOpen()).toBe(true)
    expect(inputOf(render()).props.value).toBe('보고서 작성')
  })

  it('Esc 로 닫는다', () => {
    const els = render()
    ;(inputOf(els).props.onKeyDown as (e: unknown) => void)({
      key: 'Escape',
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn()
    })
    expect(isOpen()).toBe(false)
  })

  it('배경을 누르면 닫고, 패널 안을 누르면 닫지 않는다', () => {
    hooks.i = 0
    const root = QuickAddPopover() as AnyElement
    const onMouseDown = root.props.onMouseDown as (e: unknown) => void
    const inside = {}
    onMouseDown({ target: inside, currentTarget: {} })
    expect(isOpen()).toBe(true)
    const self = {}
    onMouseDown({ target: self, currentTarget: self })
    expect(isOpen()).toBe(false)
  })

  it('toggle: 닫혀 있으면 빈 팝오버를 열고, 열려 있으면 닫는다(Cmd+Shift+A)', () => {
    useQuickAddStore.getState().open({ text: '남은 글자', sourceLink: 'linkwork://memo/1' })
    useQuickAddStore.getState().toggle()
    expect(isOpen()).toBe(false)
    useQuickAddStore.getState().toggle()
    expect(useQuickAddStore.getState()).toMatchObject({ isOpen: true, initialText: '', sourceLink: null })
  })
})

describe('QuickAddPopover 미리 채우기(할 일로 만들기)', () => {
  const chipOf = (els: AnyElement[]): AnyElement | undefined =>
    els.find((e) => e.type === 'span' && textOf(e).startsWith('출처:'))

  it('open({ text, sourceLink }) 로 열면 입력에 글자가 있고 출처 칩이 보인다. Enter 저장에 source_link 가 들어간다', async () => {
    useQuickAddStore.getState().open({ text: '배포 절차 정리', sourceLink: 'linkwork://memo/12' })
    hooks.slots.length = 0
    const els = render()
    expect(inputOf(els).props.value).toBe('배포 절차 정리')
    expect(textOf(chipOf(els) as AnyElement)).toContain('출처: 메모')

    const e = { key: 'Enter', shiftKey: false, metaKey: false, keyCode: 13, nativeEvent: { isComposing: false }, preventDefault: vi.fn() }
    ;(dialogOf(els).props.onKeyDownCapture as (e: unknown) => void)(e)
    ;(inputOf(els).props.onKeyDown as (e: unknown) => void)(e)
    await flush()
    expect(store.state.createTodo).toHaveBeenCalledWith({ title: '배포 절차 정리', source_link: 'linkwork://memo/12' })
    expect(isOpen()).toBe(false)
  })

  it('칩의 x 를 누르고 저장하면 source_link 가 없다', async () => {
    useQuickAddStore.getState().open({ text: '[AB-1] 로그인 오류', sourceLink: 'https://x.atlassian.net/browse/AB-1' })
    hooks.slots.length = 0
    let els = render()
    expect(textOf(chipOf(els) as AnyElement)).toContain('출처: AB-1')
    const x = els.find((e) => e.type === 'button' && e.props['aria-label'] === '출처 빼기')
    ;(x?.props.onClick as () => void)()
    els = render()
    expect(chipOf(els)).toBeUndefined()

    const e = { key: 'Enter', shiftKey: false, metaKey: false, keyCode: 13, nativeEvent: { isComposing: false }, preventDefault: vi.fn() }
    ;(dialogOf(els).props.onKeyDownCapture as (e: unknown) => void)(e)
    ;(inputOf(els).props.onKeyDown as (e: unknown) => void)(e)
    await flush()
    const arg = store.state.createTodo.mock.calls[0][0] as Record<string, unknown>
    expect(arg.title).toBe('[AB-1] 로그인 오류')
    expect('source_link' in arg).toBe(false)
  })

  it('안전하지 않은 출처는 칩을 보이지 않고 저장에도 넣지 않는다', async () => {
    useQuickAddStore.getState().open({ text: '보고서', sourceLink: 'javascript:alert(1)' })
    hooks.slots.length = 0
    const els = render()
    expect(chipOf(els)).toBeUndefined()
    await typeAndEnter('보고서')
    expect(store.state.createTodo).toHaveBeenCalledWith({ title: '보고서' })
  })
})
