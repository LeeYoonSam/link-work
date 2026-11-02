import { beforeEach, describe, expect, it, vi } from 'vitest'

// 실제 Google API 를 호출하지 않는다. googleapis 와 인증 모듈을 경계에서 대체한다.
const state = vi.hoisted(() => ({
  auth: {} as object | null,
  listFail: false,
  items: [] as unknown[],
  listArgs: [] as Record<string, unknown>[]
}))

vi.mock('./google-auth', () => ({ getAuthenticatedClient: () => state.auth }))
vi.mock('googleapis', () => ({
  google: {
    calendar: () => ({
      events: {
        list: async (args: Record<string, unknown>) => {
          state.listArgs.push(args)
          if (state.listFail) throw new Error('503 Service Unavailable')
          return { data: { items: state.items } }
        }
      }
    })
  }
}))

import { fetchEventsInRange, getEventsInRange } from './google-calendar'

const FROM = new Date(2026, 10, 2, 0, 0, 0)
const TO = new Date(2026, 10, 2, 23, 59, 59)

const ITEMS = [
  { id: 'a', summary: '회의', start: { dateTime: '2026-11-02T10:00:00+09:00' }, end: { dateTime: '2026-11-02T11:00:00+09:00' } },
  { id: 'b', summary: '회의', start: { dateTime: '2026-11-02T10:00:00+09:00' }, end: { dateTime: '2026-11-02T11:00:00+09:00' } },
  { id: 'c', start: { date: '2026-11-02' }, end: { date: '2026-11-03' } }
]

beforeEach(() => {
  state.auth = {}
  state.listFail = false
  state.items = []
  state.listArgs = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('fetchEventsInRange', () => {
  it('조회 범위를 그대로 넘기고 결과를 매핑·중복 제거한다', async () => {
    state.items = ITEMS
    const events = await fetchEventsInRange(FROM, TO)
    expect(state.listArgs[0]).toMatchObject({ timeMin: FROM.toISOString(), timeMax: TO.toISOString() })
    expect(events.map((e) => e.id)).toEqual(['a', 'c'])
    expect(events[1]).toMatchObject({ summary: '(No title)', allDay: true, start: '2026-11-02' })
  })

  it('API 오류를 삼키지 않고 던진다', async () => {
    state.listFail = true
    await expect(fetchEventsInRange(FROM, TO)).rejects.toThrow('503')
  })

  it('인증 클라이언트가 없으면 Error 를 던진다', async () => {
    state.auth = null
    await expect(fetchEventsInRange(FROM, TO)).rejects.toThrow(Error)
    expect(state.listArgs).toHaveLength(0)
  })

  it('조회에 성공한 일정 0건은 빈 배열이다', async () => {
    await expect(fetchEventsInRange(FROM, TO)).resolves.toEqual([])
  })
})

describe('getEventsInRange (기존 동작 유지)', () => {
  it('미연결이면 null 이다', async () => {
    state.auth = null
    await expect(getEventsInRange(FROM, TO)).resolves.toBeNull()
  })

  it('API 오류면 [] 를 돌려주고 console.error 로 남긴다', async () => {
    state.listFail = true
    await expect(getEventsInRange(FROM, TO)).resolves.toEqual([])
    expect(console.error).toHaveBeenCalled()
  })

  it('성공하면 fetchEventsInRange 와 같은 결과다', async () => {
    state.items = ITEMS
    const events = await getEventsInRange(FROM, TO)
    expect(events?.map((e) => e.id)).toEqual(['a', 'c'])
  })
})
