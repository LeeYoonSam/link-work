import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dismissToast, flushToasts, showToast, useToastStore } from './toastStore'

beforeEach(() => {
  vi.useFakeTimers()
  flushToasts()
})

afterEach(() => {
  flushToasts()
  vi.useRealTimers()
})

const shown = (): string[] => useToastStore.getState().toasts.map((t) => t.message)

describe('toastStore', () => {
  it('기본 5초 뒤 만료되어 onExpire 를 부르고 사라진다', () => {
    const onExpire = vi.fn()
    const onAction = vi.fn()
    showToast({ message: '삭제했어요', actionLabel: '실행 취소', onAction, onExpire })
    expect(shown()).toEqual(['삭제했어요'])
    expect(useToastStore.getState().toasts[0].actionLabel).toBe('실행 취소')
    vi.advanceTimersByTime(4999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onAction).not.toHaveBeenCalled()
    expect(shown()).toEqual([])
  })

  it('durationMs 를 따른다', () => {
    const onExpire = vi.fn()
    showToast({ message: 'a', onExpire, durationMs: 1000 })
    vi.advanceTimersByTime(1000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('동작을 누르면 onAction 만 부르고 onExpire 는 부르지 않는다', () => {
    const onExpire = vi.fn()
    const onAction = vi.fn()
    const id = showToast({ message: 'a', actionLabel: '실행 취소', onAction, onExpire })
    dismissToast(id, 'action')
    expect(onAction).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(onExpire).not.toHaveBeenCalled()
    expect(shown()).toEqual([])
  })

  it('닫으면(기본 사유) onExpire 를 부른다. 두 번 닫아도 한 번이다', () => {
    const onExpire = vi.fn()
    const id = showToast({ message: 'a', onExpire })
    dismissToast(id)
    dismissToast(id)
    vi.advanceTimersByTime(10_000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('flushToasts 는 떠 있는 토스트를 모두 즉시 만료 처리한다', () => {
    const a = vi.fn()
    const b = vi.fn()
    showToast({ message: 'a', onExpire: a })
    showToast({ message: 'b', onExpire: b })
    flushToasts()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(shown()).toEqual([])
    vi.advanceTimersByTime(10_000)
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('콜백 오류는 삼킨다', async () => {
    const id = showToast({
      message: 'a',
      onAction: () => {
        throw new Error('x')
      }
    })
    expect(() => dismissToast(id, 'action')).not.toThrow()
    const id2 = showToast({ message: 'b', onExpire: async () => Promise.reject(new Error('y')) })
    expect(() => dismissToast(id2)).not.toThrow()
    await Promise.resolve()
  })

  it('최대 3개까지 보이고 넘치면 가장 오래된 것을 만료 처리한다', () => {
    const first = vi.fn()
    showToast({ message: '1', onExpire: first })
    showToast({ message: '2' })
    showToast({ message: '3' })
    showToast({ message: '4' })
    expect(shown()).toEqual(['2', '3', '4'])
    expect(first).toHaveBeenCalledTimes(1)
  })
})
