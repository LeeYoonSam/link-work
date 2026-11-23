import { describe, it, expect, vi, beforeEach } from 'vitest'

// 오늘 대시보드 스토어의 불러오기 조율을 고정한다.
// 기존 스토어는 가짜로 바꾸고 window.api(calendar.range·meetingNotes.list)만 흉내 낸다.

type Fn = ReturnType<typeof vi.fn>
const fakes = {
  assistantLoad: vi.fn(async () => {}),
  fetchActiveTodos: vi.fn(async () => {}),
  fetchCompletedTodos: vi.fn(async () => {}),
  jiraLoad: vi.fn(async () => {}),
  jiraSync: vi.fn(async (_mode: string) => {}),
  fetchAllReleaseNotes: vi.fn(async () => {}),
  syncChanges: vi.fn(async (_force: boolean) => {})
}

vi.mock('./assistantStore', () => ({
  useAssistantStore: { getState: () => ({ load: fakes.assistantLoad }) }
}))
vi.mock('./todoStore', () => ({
  useTodoStore: { getState: () => ({ fetchActiveTodos: fakes.fetchActiveTodos, fetchCompletedTodos: fakes.fetchCompletedTodos }) }
}))
vi.mock('./jiraBoardStore', () => ({
  useJiraBoardStore: { getState: () => ({ load: fakes.jiraLoad, sync: fakes.jiraSync }) }
}))
vi.mock('./releaseNoteStore', () => ({
  useReleaseNoteStore: {
    getState: () => ({ fetchAllReleaseNotes: fakes.fetchAllReleaseNotes, syncChanges: fakes.syncChanges })
  }
}))

function deferred<T = unknown>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const EVENT = { id: 'e1', summary: '스크럼', start: '2026-11-19T01:00:00.000Z', end: '2026-11-19T01:15:00.000Z', allDay: false }

const PAST_EVENT = { id: 'p1', summary: '어제 회의', start: '2026-11-18T01:00:00.000Z', end: '2026-11-18T01:30:00.000Z', allDay: false }
const NOTE = { id: 7, title: '어제 회의 기록', started_at: '2026-11-18 10:00:00', tldr: '요약' }

type RangeFn = (from: string, to: string, force: boolean) => unknown

let api: { calendar: { range: Fn }; meetingNotes: { list: Fn } }

const { useTodayStore, resetTodayStoreInternals, calendarRange, CALENDAR_RANGE_DAYS } = await import('./todayStore')
const { previousWorkRange } = await import('../components/today/yesterdayModel')

/** 오늘 범위 요청인가(지난 근무일 요청과 구분) */
const isTodayRange = (from: string): boolean => from === calendarRange(new Date()).from
const initial = useTodayStore.getState()

beforeEach(() => {
  for (const f of Object.values(fakes)) f.mockReset().mockResolvedValue(undefined)
  api = {
    calendar: {
      range: vi.fn(async (from: string) => ({
        success: true,
        events: isTodayRange(from) ? [EVENT] : [PAST_EVENT],
        fetchedAt: '2026-11-19T02:00:00Z'
      }))
    },
    meetingNotes: { list: vi.fn(async () => [NOTE]) }
  }
  vi.stubGlobal('window', { api })
  resetTodayStoreInternals()
  useTodayStore.setState(initial, true)
})

describe('calendarRange', () => {
  it('오늘 로컬 0시부터 21일', () => {
    const r = calendarRange(new Date(2026, 10, 19, 11, 20))
    expect(new Date(r.from).getTime()).toBe(new Date(2026, 10, 19).getTime())
    expect(new Date(r.to).getTime()).toBe(new Date(2026, 10, 19 + CALENDAR_RANGE_DAYS).getTime())
  })
})

describe('load / refresh', () => {
  it('load 는 캐시를 허용하며 모든 출처를 부른다', async () => {
    await useTodayStore.getState().load()
    expect(fakes.assistantLoad).toHaveBeenCalledTimes(1)
    expect(fakes.fetchActiveTodos).toHaveBeenCalledTimes(1)
    expect(fakes.fetchCompletedTodos).toHaveBeenCalledTimes(1)
    expect(fakes.jiraLoad).toHaveBeenCalledTimes(1)
    expect(fakes.jiraSync).not.toHaveBeenCalled()
    expect(fakes.fetchAllReleaseNotes).toHaveBeenCalledTimes(1)
    expect(fakes.syncChanges).toHaveBeenCalledWith(false)
    expect(api.calendar.range).toHaveBeenCalledWith(expect.any(String), expect.any(String), false)
    const s = useTodayStore.getState()
    expect(s.events).toEqual([EVENT])
    expect(s.eventsError).toBeNull()
    expect(s.loading).toBe(false)
    expect(s.lastSyncedAt).not.toBeNull()
  })

  it('refresh 는 일정·Jira·릴리스를 강제로 갱신한다', async () => {
    await useTodayStore.getState().refresh()
    expect(api.calendar.range).toHaveBeenCalledWith(expect.any(String), expect.any(String), true)
    expect(fakes.jiraSync).toHaveBeenCalledWith('incremental')
    expect(fakes.jiraLoad).not.toHaveBeenCalled()
    expect(fakes.syncChanges).toHaveBeenCalledWith(true)
  })

  it('하나가 실패해도 나머지는 반영한다', async () => {
    fakes.jiraLoad.mockRejectedValue(new Error('jira down'))
    fakes.fetchAllReleaseNotes.mockRejectedValue(new Error('db'))
    await useTodayStore.getState().load()
    const s = useTodayStore.getState()
    expect(s.events).toEqual([EVENT])
    expect(s.loading).toBe(false)
    expect(fakes.fetchActiveTodos).toHaveBeenCalled()
  })

  it('일정 실패는 직전 일정을 두고 오류만 남긴다', async () => {
    await useTodayStore.getState().load()
    api.calendar.range.mockResolvedValueOnce({ success: false, error: 'Google 캘린더가 연결되지 않았어요' })
    await useTodayStore.getState().load()
    expect(useTodayStore.getState().events).toEqual([EVENT])
    expect(useTodayStore.getState().eventsError).toBe('Google 캘린더가 연결되지 않았어요')
    api.calendar.range.mockRejectedValueOnce(new Error('ipc'))
    await useTodayStore.getState().load()
    expect(useTodayStore.getState().eventsError).toBe('ipc')
  })

  it('늦게 온 옛 일정 응답은 새 응답을 덮지 않는다', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const pending = [first.promise, second.promise]
    const base = api.calendar.range.getMockImplementation() as RangeFn
    api.calendar.range.mockImplementation((from: string, to: string, force: boolean) =>
      isTodayRange(from) ? pending.shift() : base(from, to, force)
    )
    const p1 = useTodayStore.getState().load()
    const p2 = useTodayStore.getState().refresh()
    second.resolve({ success: true, events: [{ ...EVENT, id: 'new' }], fetchedAt: 'x' })
    await p2
    first.resolve({ success: true, events: [{ ...EVENT, id: 'old' }], fetchedAt: 'x' })
    await p1
    expect(useTodayStore.getState().events.map((e) => e.id)).toEqual(['new'])
    expect(useTodayStore.getState().loading).toBe(false)
  })

  it('지난 근무일 일정을 오늘 범위와 별개로 받는다', async () => {
    await useTodayStore.getState().load()
    const { from, to } = previousWorkRange(new Date())
    expect(api.calendar.range).toHaveBeenCalledWith(from.toISOString(), to.toISOString(), false)
    expect(api.calendar.range).toHaveBeenCalledWith(calendarRange(new Date()).from, expect.any(String), false)
    const s = useTodayStore.getState()
    expect(s.pastEvents).toEqual([PAST_EVENT])
    expect(s.events).toEqual([EVENT])
    expect(s.meetingNotes).toEqual([NOTE])
    await useTodayStore.getState().refresh()
    expect(api.calendar.range).toHaveBeenCalledWith(from.toISOString(), to.toISOString(), true)
  })

  it('지난 일정·회의록 실패는 직전 값을 두고 오류 문구를 남기지 않는다', async () => {
    await useTodayStore.getState().load()
    const base = api.calendar.range.getMockImplementation() as RangeFn
    api.calendar.range.mockImplementation(async (from: string, to: string, force: boolean) =>
      isTodayRange(from) ? base(from, to, force) : { success: false, error: 'down' }
    )
    api.meetingNotes.list.mockRejectedValueOnce(new Error('db'))
    await useTodayStore.getState().load()
    let s = useTodayStore.getState()
    expect(s.pastEvents).toEqual([PAST_EVENT])
    expect(s.meetingNotes).toEqual([NOTE])
    expect(s.eventsError).toBeNull()
    expect(s.loading).toBe(false)

    api.calendar.range.mockImplementation(async (from: string, to: string, force: boolean) => {
      if (isTodayRange(from)) return base(from, to, force)
      throw new Error('ipc')
    })
    await useTodayStore.getState().load()
    s = useTodayStore.getState()
    expect(s.pastEvents).toEqual([PAST_EVENT])
    expect(s.eventsError).toBeNull()
  })
})
