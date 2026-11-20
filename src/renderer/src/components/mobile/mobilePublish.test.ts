import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import type { MobileTodaySnapshot } from '../../mobile/contract'
import type { Todo } from '../../types'
import { buildTodayDashboard } from '../today/todayModel'
import {
  PUBLISH_DEBOUNCE_MS,
  PUBLISH_TICK_MS,
  RELOAD_MIN_INTERVAL_MS,
  buildMobileSnapshot,
  snapshotKey,
  startMobilePublisher,
  type MobilePublisherDeps,
  type MobileTodayInputs
} from './mobilePublish'

// 휴대폰 열람의 오늘 대시보드 발행 로직을 고정한다 (docs/MOBILE_VIEW.md).
// 시계·타이머는 가짜 타이머로, 스토어·IPC 는 deps 로 바꿔 끼운다.

const NOW = new Date(2026, 10, 19, 9, 30) // 11월 19일 (목) 09:30 로컬

const todo = (id: number, title: string): Todo =>
  ({
    id,
    title,
    completed: 0,
    completed_at: null,
    due_date: null,
    created_at: '2026-11-18 09:00:00',
    updated_at: '2026-11-18 09:00:00'
  }) as unknown as Todo

const baseInputs = (): MobileTodayInputs => ({
  events: [],
  calendarConnected: true,
  snapshot: null,
  boardErrorCode: null,
  boardLoading: false,
  boardError: null,
  notes: [],
  activeTodos: [todo(1, '문서 정리')],
  completedTodos: [],
  loading: false,
  synced: true
})

interface Harness {
  deps: MobilePublisherDeps
  inputs: MobileTodayInputs
  publish: Mock<(s: MobileTodaySnapshot) => Promise<unknown>>
  reload: Mock<() => Promise<void>>
  unsubStores: Mock<() => void>
  unsubRequested: Mock<() => void>
  storeChanged: () => void
  requestPublish: () => void
}

function harness(): Harness {
  let storeCb: (() => void) | null = null
  let requestCb: (() => void) | null = null
  const h = {
    inputs: baseInputs(),
    publish: vi.fn(async (_s: MobileTodaySnapshot) => ({ success: true })),
    reload: vi.fn(async () => {}),
    unsubStores: vi.fn<() => void>(),
    unsubRequested: vi.fn<() => void>(),
    storeChanged: () => storeCb?.(),
    requestPublish: () => requestCb?.()
  } as Omit<Harness, 'deps'> as Harness
  h.deps = {
    readInputs: () => h.inputs,
    publish: h.publish,
    reload: h.reload,
    onPublishRequested: (cb) => {
      requestCb = cb
      return h.unsubRequested
    },
    subscribeStores: (cb) => {
      storeCb = cb
      return h.unsubStores
    },
    now: () => new Date()
  }
  return h
}

const lastSnapshot = (h: Harness): MobileTodaySnapshot => h.publish.mock.calls.at(-1)![0] as MobileTodaySnapshot

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('buildMobileSnapshot', () => {
  it('v:1·date·heading·dashboard 를 담고 facts 는 뺀다', () => {
    const s = buildMobileSnapshot(baseInputs(), NOW)
    expect(s.v).toBe(1)
    expect(s.date).toBe('2026-11-19')
    expect(s.heading).toBe('11월 19일 (목)')
    expect(s.dashboard.date).toBe('2026-11-19')
    expect(s.publishedAt).toBe(NOW.toISOString())
    expect('briefingSource' in s).toBe(false)
    expect(s.loading).toBe(false)
    expect(s.dashboard.todos.rows.length).toBeGreaterThan(0)
    expect(Array.isArray(s.dashboard.hiddenSignals)).toBe(true)
    expect('allSignals' in s.dashboard).toBe(false)
    expect('facts' in s.dashboard).toBe(false)
  })

  it('headline·신호 문구는 오늘 화면과 같은 규칙 문구다', () => {
    const s = buildMobileSnapshot(baseInputs(), NOW)
    const rules = buildTodayDashboard({ ...baseInputs(), now: NOW })
    expect(s.dashboard.headline).toBe(rules.headline)
    expect(s.dashboard.signals).toEqual(rules.signals)
  })

  it('첫 로드 전(아직 불러온 적 없음)이면 loading 으로 표시한다', () => {
    expect(buildMobileSnapshot({ ...baseInputs(), synced: false }, NOW).loading).toBe(true)
    expect(buildMobileSnapshot({ ...baseInputs(), loading: true }, NOW).loading).toBe(true)
  })

  it('비교 키는 발행 시각을 무시한다', () => {
    const a = buildMobileSnapshot(baseInputs(), NOW)
    expect(snapshotKey({ ...a, publishedAt: 'x' })).toBe(snapshotKey(a))
  })
})

describe('startMobilePublisher', () => {
  it('켜지면 1회 발행한다', () => {
    const h = harness()
    const p = startMobilePublisher(h.deps)
    expect(h.publish).toHaveBeenCalledTimes(1)
    expect(lastSnapshot(h).v).toBe(1)
    p.stop()
  })

  it('스토어가 바뀌어도 내용이 같으면 다시 발행하지 않고, 다르면 디바운스 뒤 발행한다', () => {
    const h = harness()
    const p = startMobilePublisher(h.deps)
    h.storeChanged()
    h.storeChanged()
    vi.advanceTimersByTime(PUBLISH_DEBOUNCE_MS)
    expect(h.publish).toHaveBeenCalledTimes(1)

    h.inputs = { ...h.inputs, activeTodos: [...h.inputs.activeTodos, todo(2, '리뷰 답변')] }
    h.storeChanged()
    vi.advanceTimersByTime(PUBLISH_DEBOUNCE_MS - 1)
    expect(h.publish).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(h.publish).toHaveBeenCalledTimes(2)
    p.stop()
  })

  it('60초마다는 내용이 같아도 발행한다', () => {
    const h = harness()
    const p = startMobilePublisher(h.deps)
    vi.advanceTimersByTime(PUBLISH_TICK_MS)
    expect(h.publish).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(PUBLISH_TICK_MS)
    expect(h.publish).toHaveBeenCalledTimes(3)
    p.stop()
  })

  it('재발행 요청을 받으면 불러온 뒤 발행하고, 30초 안의 재요청은 불러오기를 생략한다', async () => {
    const h = harness()
    const p = startMobilePublisher(h.deps)
    h.requestPublish()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(h.publish).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(1000)
    h.requestPublish()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(h.publish).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(RELOAD_MIN_INTERVAL_MS)
    h.requestPublish()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.reload).toHaveBeenCalledTimes(2)
    p.stop()
  })

  it('스토어가 비어 있으면(첫 로드 전) 시작 때 불러오기를 1번 하고 loading 으로 발행한다', () => {
    const h = harness()
    h.inputs = { ...h.inputs, synced: false }
    const p = startMobilePublisher(h.deps)
    expect(lastSnapshot(h).loading).toBe(true)
    expect(h.reload).toHaveBeenCalledTimes(1)
    p.stop()
  })

  it('자정을 넘기면 다시 불러오고 새 날짜로 발행한다', async () => {
    const h = harness()
    vi.setSystemTime(new Date(2026, 10, 19, 23, 59, 30))
    const p = startMobilePublisher(h.deps)
    expect(lastSnapshot(h).date).toBe('2026-11-19')
    await vi.advanceTimersByTimeAsync(PUBLISH_TICK_MS)
    expect(lastSnapshot(h).date).toBe('2026-11-20')
    expect(lastSnapshot(h).heading).toBe('11월 20일 (금)')
    expect(h.reload).toHaveBeenCalledTimes(1)
    p.stop()
  })

  it('해제하면 구독 해제 함수를 부르고 더는 발행하지 않는다', () => {
    const h = harness()
    const p = startMobilePublisher(h.deps)
    h.inputs = { ...h.inputs, activeTodos: [] }
    h.storeChanged()
    p.stop()
    expect(h.unsubStores).toHaveBeenCalledTimes(1)
    expect(h.unsubRequested).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(PUBLISH_TICK_MS * 2)
    h.requestPublish()
    expect(h.publish).toHaveBeenCalledTimes(1)
  })
})
