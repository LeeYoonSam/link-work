import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FOCUS_REQUEST_TTL_MS, useFocusStore } from './focusStore'

describe('focusStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useFocusStore.setState({ request: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('요청마다 nonce 가 증가한다', () => {
    const { requestFocus } = useFocusStore.getState()
    requestFocus({ entity: 'memo', id: 1 })
    const first = useFocusStore.getState().request
    requestFocus({ entity: 'memo', id: 1 })
    const second = useFocusStore.getState().request
    expect(first?.nonce).toBeTypeOf('number')
    expect(second!.nonce).toBeGreaterThan(first!.nonce)
    expect(second).toMatchObject({ entity: 'memo', id: 1 })
  })

  it('캘린더 요청은 날짜와 이벤트 id 를 담는다', () => {
    useFocusStore.getState().requestFocus({ entity: 'calendar', date: '2026-11-05', eventId: 'abc' })
    expect(useFocusStore.getState().request).toMatchObject({
      entity: 'calendar',
      date: '2026-11-05',
      eventId: 'abc'
    })
  })

  it('같은 nonce 로 consume 하면 지운다', () => {
    useFocusStore.getState().requestFocus({ entity: 'task', id: 9 })
    const nonce = useFocusStore.getState().request!.nonce
    useFocusStore.getState().consume(nonce)
    expect(useFocusStore.getState().request).toBeNull()
  })

  it('다른 nonce 로 consume 하면 요청을 유지한다', () => {
    useFocusStore.getState().requestFocus({ entity: 'task', id: 9 })
    const nonce = useFocusStore.getState().request!.nonce
    useFocusStore.getState().consume(nonce - 1)
    expect(useFocusStore.getState().request).toMatchObject({ entity: 'task', id: 9, nonce })
  })

  it('TTL 이 지나면 소비하지 않은 요청을 지운다', () => {
    useFocusStore.getState().requestFocus({ entity: 'variable', id: 4 })
    vi.advanceTimersByTime(FOCUS_REQUEST_TTL_MS - 1)
    expect(useFocusStore.getState().request).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(useFocusStore.getState().request).toBeNull()
  })

  it('새 요청은 이전 요청의 TTL 에 지워지지 않는다', () => {
    const { requestFocus } = useFocusStore.getState()
    requestFocus({ entity: 'memo', id: 1 })
    vi.advanceTimersByTime(FOCUS_REQUEST_TTL_MS - 100)
    requestFocus({ entity: 'memo', id: 2 })
    vi.advanceTimersByTime(200)
    expect(useFocusStore.getState().request).toMatchObject({ entity: 'memo', id: 2 })
    vi.advanceTimersByTime(FOCUS_REQUEST_TTL_MS)
    expect(useFocusStore.getState().request).toBeNull()
  })
})
