import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Todo, TodoInput } from '../../types'
import { collect, textOf, type AnyElement } from '../today/testTree'

// 여러 줄 붙여넣기 확인 패널. DOM 테스트 환경이 없어 React 훅을 슬롯 배열 구현으로 바꾸고
// 컴포넌트를 함수로 불러 핸들러를 직접 부른다(TodoItem.test 와 같은 방식).
// todoParse·스토어는 실제 모듈이고 window.api 만 가짜다.

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

vi.mock('../../stores/todoStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../stores/todoStore')>()
  const hook = Object.assign((sel?: (s: unknown) => unknown) => {
    const s = real.useTodoStore.getState()
    return sel ? sel(s) : s
  }, real.useTodoStore)
  return { ...real, useTodoStore: hook }
})

const { default: BulkAddPanel } = await import('./BulkAddPanel')
const { splitPastedLines } = await import('./todoParse')
const { flushToasts } = await import('../ui/toastStore')

const NOW = (): Date => new Date(2026, 10, 20, 10, 0)

function stubApi() {
  const api = {
    create: vi.fn(async (_input: TodoInput) => ({ id: 1 })),
    list: vi.fn(async () => [] as Todo[]),
    listByTag: vi.fn(async () => [] as Todo[]),
    listActive: vi.fn(async () => [] as Todo[])
  }
  vi.stubGlobal('window', { api: { todo: api } })
  return api
}

let api: ReturnType<typeof stubApi>
let onClose: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  h.slots = []
  api = stubApi()
  onClose = vi.fn<() => void>()
})

afterEach(() => {
  flushToasts()
  vi.unstubAllGlobals()
})

const LINES = ['내일 3시 회의 준비', '보고서 !높음', '메일 답장']

const render = (lines = LINES): AnyElement[] => {
  h.i = 0
  return collect(<BulkAddPanel lines={lines} tags={[]} onClose={onClose} now={NOW} />)
}

const addButton = (els: AnyElement[]): AnyElement => {
  const el = els.find((e) => e.type === 'button' && /개 추가$/.test(textOf(e)))
  if (!el) throw new Error('추가 버튼 없음')
  return el
}

const checkbox = (els: AnyElement[], title: string): AnyElement => {
  const el = els.find((e) => e.type === 'input' && e.props['aria-label'] === `${title} 포함`)
  if (!el) throw new Error(`체크박스 없음: ${title}`)
  return el
}

describe('splitPastedLines', () => {
  it('글머리 기호와 빈 줄을 지운다', () => {
    expect(splitPastedLines('- 보고서\n* 회의\n\n• 메일\n1. 정리\n[ ] 청소\n[x] 빨래\n')).toEqual([
      '보고서',
      '회의',
      '메일',
      '정리',
      '청소',
      '빨래'
    ])
  })
})

describe('BulkAddPanel', () => {
  it('줄마다 인식 결과를 미리 보여 준다', () => {
    const els = render()
    const text = els.map((e) => textOf(e)).join(' ')
    expect(text).toContain('회의 준비')
    expect(text).toContain('보고서')
    expect(text).toContain('메일 답장')
    expect(textOf(addButton(els))).toBe('3개 추가')
  })

  it('뺀 줄을 빼고 선택한 줄만 순서대로 todo.create 한다. 끝에 한 번만 다시 읽고 닫는다', async () => {
    let els = render()
    ;(checkbox(els, '보고서').props.onChange as () => void)()
    els = render()
    expect(textOf(addButton(els))).toBe('2개 추가')
    await (addButton(els).props.onClick as () => Promise<void>)()

    expect(api.create).toHaveBeenCalledTimes(2)
    expect(api.create.mock.calls[0][0]).toEqual({ title: '회의 준비', due_date: '2026-11-21 15:00', due_reminder: 1 })
    expect(api.create.mock.calls[1][0]).toEqual({ title: '메일 답장' })
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.listActive).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })

  it('중간에 실패하면 멈추고 성공 건수와 남은 줄을 패널에 남긴다', async () => {
    api.create.mockResolvedValueOnce({ id: 1 }).mockRejectedValueOnce(new Error('DB 잠김'))
    let els = render()
    await (addButton(els).props.onClick as () => Promise<void>)()
    expect(api.create).toHaveBeenCalledTimes(2)
    expect(onClose).not.toHaveBeenCalled()

    els = render()
    const alert = els.find((e) => e.props.role === 'alert')
    expect(alert && textOf(alert)).toContain('1개를 추가했고 남은 2개는 추가하지 못했어요')
    expect(alert && textOf(alert)).toContain('DB 잠김')
    expect(textOf(addButton(els))).toBe('2개 추가')
    expect(els.some((e) => e.props['aria-label'] === '회의 준비 포함')).toBe(false)
    expect(els.some((e) => e.props['aria-label'] === '보고서 포함')).toBe(true)
  })

  it('취소는 아무것도 만들지 않고 닫는다', () => {
    const els = render()
    const cancel = els.find((e) => e.type === 'button' && textOf(e) === '취소')!
    ;(cancel.props.onClick as () => void)()
    expect(onClose).toHaveBeenCalled()
    expect(api.create).not.toHaveBeenCalled()
  })
})
