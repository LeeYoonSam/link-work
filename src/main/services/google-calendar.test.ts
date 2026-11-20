import { beforeEach, describe, expect, it, vi } from 'vitest'

// 실제 Google API 를 호출하지 않는다. googleapis 와 인증 모듈을 경계에서 대체한다.
const state = vi.hoisted(() => ({
  auth: {} as object | null,
  listFail: false,
  items: [] as unknown[],
  listArgs: [] as Record<string, unknown>[],
  // 'primary' 외 캘린더별 응답·실패
  perCalendar: {} as Record<string, unknown[]>,
  failIds: [] as string[],
  calendarList: [] as unknown[],
  calendarListFail: false,
  settings: new Map<string, string>()
}))

vi.mock('./google-auth', () => ({ getAuthenticatedClient: () => state.auth }))
vi.mock('../db/database', () => ({
  getDatabase: () => ({
    prepare: (sql: string) => ({
      get: (key: string) => (state.settings.has(key) ? { value: state.settings.get(key) } : undefined),
      run: (key: string, value: string) => {
        if (!/INSERT INTO app_settings/.test(sql)) throw new Error('unexpected sql')
        state.settings.set(key, value)
      }
    })
  })
}))
vi.mock('googleapis', () => ({
  google: {
    calendar: () => ({
      events: {
        list: async (args: Record<string, unknown>) => {
          state.listArgs.push(args)
          const id = args.calendarId as string
          if (state.listFail || state.failIds.includes(id)) throw new Error('503 Service Unavailable')
          return { data: { items: id === 'primary' ? state.items : (state.perCalendar[id] ?? []) } }
        }
      },
      calendarList: {
        list: async () => {
          if (state.calendarListFail) throw new Error('403 Insufficient Permission')
          return { data: { items: state.calendarList } }
        }
      }
    })
  }
}))

import {
  fetchEventsInRange,
  getEventsInRange,
  getRangeEvents,
  getSelectedCalendarIds,
  getTodayEvents,
  clearCache,
  isOwnCalendarEvent,
  listCalendars,
  setSelectedCalendarIds
} from './google-calendar'

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
  state.perCalendar = {}
  state.failIds = []
  state.calendarList = []
  state.calendarListFail = false
  state.settings = new Map()
  clearCache()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('fetchEventsInRange', () => {
  it('조회 범위를 그대로 넘기고 결과를 매핑·중복 제거·시작 시각 정렬한다', async () => {
    state.items = ITEMS
    const events = await fetchEventsInRange(FROM, TO)
    expect(state.listArgs[0]).toMatchObject({ timeMin: FROM.toISOString(), timeMax: TO.toISOString() })
    // 종일 일정(로컬 0시)이 10:00 회의보다 앞이다
    expect(events.map((e) => e.id)).toEqual(['c', 'a'])
    expect(events[0]).toMatchObject({ summary: '(No title)', allDay: true, start: '2026-11-02', calendarId: 'primary' })
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
    expect(events?.map((e) => e.id)).toEqual(['c', 'a'])
  })
})

const TECH = 'c_tech@group.calendar.google.com'

describe('가져올 캘린더 선택 저장', () => {
  it('저장값이 없거나 깨지면 primary 다', () => {
    expect(getSelectedCalendarIds()).toEqual(['primary'])
    state.settings.set('google_calendar_ids', '{broken')
    expect(getSelectedCalendarIds()).toEqual(['primary'])
    state.settings.set('google_calendar_ids', '[]')
    expect(getSelectedCalendarIds()).toEqual(['primary'])
    state.settings.set('google_calendar_ids', '[1, 2]')
    expect(getSelectedCalendarIds()).toEqual(['primary'])
  })

  it('중복을 지우고 저장한다', () => {
    expect(setSelectedCalendarIds(['primary', TECH, ' primary '])).toEqual(['primary', TECH])
    expect(JSON.parse(state.settings.get('google_calendar_ids')!)).toEqual(['primary', TECH])
    expect(getSelectedCalendarIds()).toEqual(['primary', TECH])
  })

  it('빈 배열·문자열 아님·배열 아님은 거절한다', () => {
    expect(() => setSelectedCalendarIds([])).toThrow()
    expect(() => setSelectedCalendarIds([1])).toThrow()
    expect(() => setSelectedCalendarIds(['  '])).toThrow()
    expect(() => setSelectedCalendarIds('primary')).toThrow()
    expect(state.settings.has('google_calendar_ids')).toBe(false)
  })

  it('저장하면 일정 캐시를 비운다', async () => {
    state.items = [ITEMS[0]]
    await getTodayEvents()
    await getTodayEvents()
    expect(state.listArgs).toHaveLength(1)
    setSelectedCalendarIds(['primary'])
    await getTodayEvents()
    expect(state.listArgs).toHaveLength(2)
  })
})

describe('listCalendars', () => {
  it('기본 캘린더를 primary id 로 맨 앞에 돌려준다', async () => {
    state.calendarList = [
      { id: TECH, summary: 'Tech', backgroundColor: '#ff0000' },
      { id: 'me@example.com', summary: 'me@example.com', primary: true, backgroundColor: '#00ff00' }
    ]
    await expect(listCalendars()).resolves.toEqual([
      { id: 'primary', summary: 'me@example.com', primary: true, color: '#00ff00' },
      { id: TECH, summary: 'Tech', primary: false, color: '#ff0000' }
    ])
  })

  it('실패를 던진다', async () => {
    state.calendarListFail = true
    await expect(listCalendars()).rejects.toThrow('403')
  })
})

describe('여러 캘린더 병합', () => {
  const release = { id: 'r', summary: ' App Release(v4.177.0)', start: { date: '2026-11-02' }, end: { date: '2026-11-03' } }
  const techDup = { id: 't1', summary: '회의 ', start: { dateTime: '2026-11-02T10:00:00+09:00' }, end: { dateTime: '2026-11-02T11:00:00+09:00' } }
  const techEarly = { id: 't2', summary: '스크럼', start: { dateTime: '2026-11-02T09:00:00+09:00' }, end: { dateTime: '2026-11-02T09:30:00+09:00' } }

  it('선택한 캘린더 전부에서 받아 calendarId 를 채우고 dedup·정렬한다', async () => {
    setSelectedCalendarIds([TECH, 'primary'])
    state.items = [ITEMS[0]]
    state.perCalendar[TECH] = [techDup, techEarly, release]
    const events = await fetchEventsInRange(FROM, TO)
    // primary 를 먼저 조회한다
    expect(state.listArgs.map((a) => a.calendarId)).toEqual(['primary', TECH])
    // 제목 앞뒤 공백만 다른 중복은 primary 쪽(a)이 남는다
    expect(events.map((e) => [e.id, e.calendarId])).toEqual([
      ['r', TECH],
      ['t2', TECH],
      ['a', 'primary']
    ])
  })

  it('일부 캘린더가 실패하면 성공분만 쓰고 console.error 로 남긴다', async () => {
    setSelectedCalendarIds(['primary', TECH])
    state.items = [ITEMS[0]]
    state.failIds = [TECH]
    const events = await fetchEventsInRange(FROM, TO)
    expect(events.map((e) => e.id)).toEqual(['a'])
    expect(console.error).toHaveBeenCalled()
  })

  it('전부 실패하면 던지고, getTodayEvents 는 캐시를 돌려준다', async () => {
    setSelectedCalendarIds(['primary', TECH])
    state.items = [ITEMS[0]]
    const first = await getTodayEvents()
    expect(first.map((e) => e.id)).toEqual(['a'])
    state.listFail = true
    await expect(fetchEventsInRange(FROM, TO)).rejects.toThrow('503')
    await expect(getTodayEvents(true)).resolves.toEqual(first)
  })
})

describe('isOwnCalendarEvent', () => {
  it('calendarId 가 없거나 primary 면 내 일정이다', () => {
    expect(isOwnCalendarEvent({})).toBe(true)
    expect(isOwnCalendarEvent({ calendarId: 'primary' })).toBe(true)
    expect(isOwnCalendarEvent({ calendarId: TECH })).toBe(false)
  })

  it('병합 결과에서 기본 캘린더 일정은 calendarId primary 이고, 양쪽에 있는 회의는 primary 쪽이 남는다', async () => {
    // 선택 순서가 Tech 먼저여도 primary 를 먼저 조회한다
    setSelectedCalendarIds([TECH, 'primary'])
    const weekly = { summary: 'Tech weekly', start: { dateTime: '2026-11-02T14:00:00+09:00' }, end: { dateTime: '2026-11-02T15:00:00+09:00' } }
    state.items = [{ id: 'mine', ...weekly }]
    state.perCalendar[TECH] = [
      { id: 'tech-copy', ...weekly },
      { id: 'tech-only', summary: '스크럼', start: { dateTime: '2026-11-02T09:00:00+09:00' }, end: { dateTime: '2026-11-02T09:30:00+09:00' } }
    ]
    const events = await fetchEventsInRange(FROM, TO)
    expect(events.map((e) => [e.id, e.calendarId, isOwnCalendarEvent(e)])).toEqual([
      ['tech-only', TECH, false],
      ['mine', 'primary', true]
    ])
  })
})

describe('getRangeEvents (calendar:range)', () => {
  const from = '2026-11-19T00:00:00.000+09:00'
  const to = '2026-12-10T00:00:00.000+09:00'

  it('형식 오류·역순·45일 초과를 거절한다', async () => {
    await expect(getRangeEvents('nope', to)).rejects.toThrow()
    await expect(getRangeEvents(from, 123)).rejects.toThrow()
    await expect(getRangeEvents(to, from)).rejects.toThrow()
    await expect(getRangeEvents('2026-11-01T00:00:00Z', '2026-12-17T00:00:00Z')).rejects.toThrow('45')
    expect(state.listArgs).toHaveLength(0)
  })

  it('미연결이면 던진다', async () => {
    state.auth = null
    await expect(getRangeEvents(from, to)).rejects.toThrow()
  })

  it('5분 캐시를 쓰고 force 면 다시 조회한다', async () => {
    state.items = ITEMS
    const r1 = await getRangeEvents(from, to)
    expect(r1.events.map((e) => e.id)).toEqual(['c', 'a'])
    expect(typeof r1.fetchedAt).toBe('string')
    await getRangeEvents(from, to)
    expect(state.listArgs).toHaveLength(1)
    await getRangeEvents(from, to, true)
    expect(state.listArgs).toHaveLength(2)
  })
})
