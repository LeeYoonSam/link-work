import { google } from 'googleapis'
import { getAuthenticatedClient } from './google-auth'
import { startOfDay, endOfDay, startOfWeek, endOfWeek, format } from 'date-fns'

export interface CalendarEvent {
  id: string
  summary: string
  description?: string
  start: string
  end: string
  allDay: boolean
  location?: string
  htmlLink?: string
}

let cachedTodayEvents: CalendarEvent[] = []
let lastTodayFetchTime = 0
// 주 단위 이동(이전/다음 주)을 지원하므로 주차별로 캐시한다. 키는 해당 주 월요일의 yyyy-MM-dd.
const weekCache = new Map<string, { events: CalendarEvent[]; fetchedAt: number }>()
const WEEK_CACHE_LIMIT = 12
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

function mapEvent(event: {
  id?: string | null
  summary?: string | null
  description?: string | null
  start?: { dateTime?: string | null; date?: string | null } | null
  end?: { dateTime?: string | null; date?: string | null } | null
  location?: string | null
  htmlLink?: string | null
}): CalendarEvent {
  return {
    id: event.id || '',
    summary: event.summary || '(No title)',
    description: event.description || undefined,
    start: event.start?.dateTime || event.start?.date || '',
    end: event.end?.dateTime || event.end?.date || '',
    allDay: !event.start?.dateTime,
    location: event.location || undefined,
    htmlLink: event.htmlLink || undefined
  }
}

/**
 * 동일한 내용의 이벤트(제목/시작/종료/종일 여부 일치)를 1개로 합쳐 대시보드/캘린더의 중복 표시를 방지한다.
 * 원인: Google Calendar 상에서 동일 제목의 All-day 이벤트가 여러 개 존재하거나,
 *       순환 이벤트의 인스턴스 확장으로 같은 컨텐츠가 중복될 수 있음.
 */
function dedupEvents(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>()
  const result: CalendarEvent[] = []
  for (const e of events) {
    const key = `${e.summary}|${e.start}|${e.end}|${e.allDay ? '1' : '0'}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(e)
  }
  return result
}

export async function getTodayEvents(forceRefresh = false): Promise<CalendarEvent[]> {
  const now = Date.now()
  if (!forceRefresh && cachedTodayEvents.length > 0 && now - lastTodayFetchTime < CACHE_DURATION) {
    return cachedTodayEvents
  }

  const auth = getAuthenticatedClient()
  if (!auth) return []

  const calendar = google.calendar({ version: 'v3', auth })
  const today = new Date()

  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay(today).toISOString(),
      timeMax: endOfDay(today).toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    })

    cachedTodayEvents = dedupEvents((response.data.items || []).map(mapEvent))
    lastTodayFetchTime = now
    return cachedTodayEvents
  } catch (error) {
    console.error('Failed to fetch calendar events:', error)
    return cachedTodayEvents
  }
}

/**
 * 주간 일정 조회. weekStartISO를 주면 그 날짜가 속한 주를, 없으면 이번 주를 반환한다.
 * (렌더러가 이전/다음 주로 이동할 때 사용)
 */
export async function getWeekEvents(
  weekStartISO?: string,
  forceRefresh = false
): Promise<CalendarEvent[]> {
  const base = weekStartISO ? new Date(weekStartISO) : new Date()
  const target = Number.isNaN(base.getTime()) ? new Date() : base
  const weekStart = startOfWeek(target, { weekStartsOn: 1 })
  const weekEnd = endOfWeek(target, { weekStartsOn: 1 })
  const key = format(weekStart, 'yyyy-MM-dd')

  const now = Date.now()
  const cached = weekCache.get(key)
  if (!forceRefresh && cached && now - cached.fetchedAt < CACHE_DURATION) {
    return cached.events
  }

  const auth = getAuthenticatedClient()
  if (!auth) return []

  const calendar = google.calendar({ version: 'v3', auth })

  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: weekStart.toISOString(),
      timeMax: weekEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    })

    const events = dedupEvents((response.data.items || []).map(mapEvent))
    weekCache.delete(key) // 재삽입해 최근 사용 순서를 유지
    weekCache.set(key, { events, fetchedAt: now })
    // 오래된 주차부터 정리해 무한정 쌓이지 않게 한다.
    while (weekCache.size > WEEK_CACHE_LIMIT) {
      const oldest = weekCache.keys().next().value
      if (oldest === undefined) break
      weekCache.delete(oldest)
    }
    return events
  } catch (error) {
    console.error('Failed to fetch calendar events:', error)
    return cached?.events ?? []
  }
}

/**
 * 임의 기간의 일정 조회 (AI 어시스턴트용).
 * 캘린더 미연동 시 null을 반환해 호출자가 미연동/빈 일정을 구분할 수 있게 한다.
 */
export async function getEventsInRange(
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[] | null> {
  const auth = getAuthenticatedClient()
  if (!auth) return null

  const calendar = google.calendar({ version: 'v3', auth })
  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    })
    return dedupEvents((response.data.items || []).map(mapEvent))
  } catch (error) {
    console.error('Failed to fetch calendar events:', error)
    return []
  }
}

export function clearCache(): void {
  cachedTodayEvents = []
  lastTodayFetchTime = 0
  weekCache.clear()
}
