import { google } from 'googleapis'
import { getAuthenticatedClient } from './google-auth'
import { getDatabase } from '../db/database'
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
  /** 이 일정을 가져온 캘린더 id. 기본 캘린더는 'primary' */
  calendarId?: string
}

/** 설정 화면의 "가져올 캘린더" 목록 1행. 기본 캘린더의 id 는 항상 'primary' 로 돌려준다 */
interface CalendarListEntry {
  id: string
  summary: string
  primary: boolean
  color: string | null
}

// ── 가져올 캘린더 선택 ─────────────────────────────────────
// app_settings key 'google_calendar_ids' = JSON string[]. 없거나 깨지면 ['primary'].
const SELECTED_KEY = 'google_calendar_ids'
const PRIMARY_ID = 'primary'
const MAX_SELECTED = 50

function normalizeIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string') return null
    const id = v.trim()
    if (!id || id.length > 512) return null
    if (!out.includes(id)) out.push(id)
  }
  if (out.length > MAX_SELECTED) return null
  return out
}

export function getSelectedCalendarIds(): string[] {
  try {
    const row = getDatabase()
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(SELECTED_KEY) as { value: string } | undefined
    if (!row) return [PRIMARY_ID]
    return normalizeIds(JSON.parse(row.value)) ?? [PRIMARY_ID]
  } catch {
    return [PRIMARY_ID]
  }
}

/** 빈 배열·문자열이 아닌 값은 거절(throw)한다. 중복은 지운다. 저장 후 일정 캐시를 비운다 */
export function setSelectedCalendarIds(ids: unknown): string[] {
  const normalized = normalizeIds(ids)
  if (!normalized) throw new Error('캘린더를 1개 이상 골라야 합니다.')
  getDatabase()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(SELECTED_KEY, JSON.stringify(normalized))
  clearCache()
  return normalized
}

/**
 * 내 기본 캘린더의 일정이면 true(calendarId 가 없거나 'primary').
 * 알림성 경로(회의 알림·회의 전 브리핑·회의 수)는 이 일정만 쓴다. 추가로 고른 캘린더는 화면 표시용이다.
 */
export function isOwnCalendarEvent(e: Pick<CalendarEvent, 'calendarId'>): boolean {
  return e.calendarId === undefined || e.calendarId === PRIMARY_ID
}

// 기본 캘린더를 먼저 조회해 dedup 에서 기본 캘린더 쪽이 남게 한다.
function orderedSelectedIds(): string[] {
  const ids = getSelectedCalendarIds()
  return [...ids.filter((id) => id === PRIMARY_ID), ...ids.filter((id) => id !== PRIMARY_ID)]
}

/** 계정이 읽을 수 있는 캘린더 목록. 실패하면 googleapis 에러를 그대로 던진다 */
export async function listCalendars(): Promise<CalendarListEntry[]> {
  const auth = getAuthenticatedClient()
  if (!auth) throw new Error('Google 캘린더가 연결되어 있지 않습니다.')
  const calendar = google.calendar({ version: 'v3', auth })
  const out: CalendarListEntry[] = []
  let pageToken: string | undefined
  for (let page = 0; page < 10; page++) {
    const res = await calendar.calendarList.list(
      { minAccessRole: 'reader', maxResults: 250, pageToken },
      { timeout: 15_000, retry: false }
    )
    for (const item of res.data.items ?? []) {
      if (!item.id) continue
      const primary = item.primary === true
      out.push({
        id: primary ? PRIMARY_ID : item.id,
        summary: item.summaryOverride || item.summary || item.id,
        primary,
        color: item.backgroundColor ?? null
      })
    }
    pageToken = res.data.nextPageToken ?? undefined
    if (!pageToken) break
  }
  // 기본 캘린더를 맨 앞에
  return [...out.filter((c) => c.primary), ...out.filter((c) => !c.primary)]
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
    const key = `${e.summary.trim()}|${e.start}|${e.end}|${e.allDay ? '1' : '0'}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(e)
  }
  return result
}

// 종일 일정('YYYY-MM-DD')은 로컬 0시로 본다.
function startMs(e: CalendarEvent): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.start)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  const t = new Date(e.start).getTime()
  return Number.isNaN(t) ? 0 : t
}

/**
 * 선택한 캘린더 전부에서 기간 일정을 받아 병합한다.
 * 각 일정에 calendarId 를 채우고 dedup(먼저 온 것 = 기본 캘린더 우선) 후 시작 시각으로 정렬한다.
 * 전부 실패하면 첫 오류를 던진다. 일부만 실패하면 성공분만 쓰고 console.error 로 남긴다.
 */
async function listSelectedEvents(
  auth: NonNullable<ReturnType<typeof getAuthenticatedClient>>,
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[]> {
  const calendar = google.calendar({ version: 'v3', auth })
  const ids = orderedSelectedIds()
  const settled = await Promise.allSettled(
    ids.map(async (calendarId) => {
      const response = await calendar.events.list({
        calendarId,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      })
      return (response.data.items || []).map((item) => ({ ...mapEvent(item), calendarId }))
    })
  )
  const merged: CalendarEvent[] = []
  const errors: unknown[] = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') merged.push(...r.value)
    else {
      errors.push(r.reason)
      console.error(`Failed to fetch calendar events (${ids[i]}):`, r.reason)
    }
  })
  if (errors.length === ids.length) throw errors[0]
  return dedupEvents(merged)
    .map((e, i) => ({ e, i, t: startMs(e) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.e)
}

export async function getTodayEvents(forceRefresh = false): Promise<CalendarEvent[]> {
  const now = Date.now()
  if (!forceRefresh && cachedTodayEvents.length > 0 && now - lastTodayFetchTime < CACHE_DURATION) {
    return cachedTodayEvents
  }

  const auth = getAuthenticatedClient()
  if (!auth) return []

  const today = new Date()

  try {
    cachedTodayEvents = await listSelectedEvents(auth, startOfDay(today), endOfDay(today))
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

  try {
    const events = await listSelectedEvents(auth, weekStart, weekEnd)
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
 * 임의 기간의 일정 조회. 실패를 숨기지 않는다.
 * 미연결이면 Error 를 던지고, API 오류도 그대로 던진다.
 * 비서는 '조회 실패'와 '일정 0건'을 구분해야 하므로 이 함수를 쓴다.
 */
export async function fetchEventsInRange(timeMin: Date, timeMax: Date): Promise<CalendarEvent[]> {
  const auth = getAuthenticatedClient()
  if (!auth) throw new Error('Google 캘린더가 연결되어 있지 않습니다.')

  return listSelectedEvents(auth, timeMin, timeMax)
}

// ── 오늘 대시보드용 기간 조회 (calendar:range) ──────────────
const RANGE_MAX_DAYS = 45
const rangeCache = new Map<string, { events: CalendarEvent[]; fetchedAt: number }>()
const RANGE_CACHE_LIMIT = 8

function parseIso(value: unknown, name: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new Error(`${name} 형식이 올바르지 않습니다.`)
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error(`${name} 형식이 올바르지 않습니다.`)
  return d
}

/**
 * 오늘 대시보드가 쓰는 기간 조회. 5분 캐시(키 from|to), force 면 캐시를 무시한다.
 * 형식 오류·역순·45일 초과·미연결·전부 실패는 throw 한다(IPC 가 Fail 로 바꾼다).
 */
export async function getRangeEvents(
  fromISO: unknown,
  toISO: unknown,
  force = false
): Promise<{ events: CalendarEvent[]; fetchedAt: string }> {
  const from = parseIso(fromISO, 'fromISO')
  const to = parseIso(toISO, 'toISO')
  if (to.getTime() <= from.getTime()) throw new Error('조회 기간이 올바르지 않습니다.')
  if (to.getTime() - from.getTime() > RANGE_MAX_DAYS * 24 * 60 * 60 * 1000) {
    throw new Error(`조회 기간은 ${RANGE_MAX_DAYS}일을 넘을 수 없습니다.`)
  }
  const key = `${fromISO as string}|${toISO as string}`
  const now = Date.now()
  const cached = rangeCache.get(key)
  if (!force && cached && now - cached.fetchedAt < CACHE_DURATION) {
    return { events: cached.events, fetchedAt: new Date(cached.fetchedAt).toISOString() }
  }
  const events = await fetchEventsInRange(from, to)
  rangeCache.delete(key)
  rangeCache.set(key, { events, fetchedAt: now })
  while (rangeCache.size > RANGE_CACHE_LIMIT) {
    const oldest = rangeCache.keys().next().value
    if (oldest === undefined) break
    rangeCache.delete(oldest)
  }
  return { events, fetchedAt: new Date(now).toISOString() }
}

/**
 * 임의 기간의 일정 조회 (AI 어시스턴트용).
 * 캘린더 미연동 시 null을 반환해 호출자가 미연동/빈 일정을 구분할 수 있게 한다.
 * API 오류는 [] 로 바꾼다.
 */
export async function getEventsInRange(
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[] | null> {
  if (!getAuthenticatedClient()) return null
  try {
    return await fetchEventsInRange(timeMin, timeMax)
  } catch (error) {
    console.error('Failed to fetch calendar events:', error)
    return []
  }
}

export function clearCache(): void {
  cachedTodayEvents = []
  lastTodayFetchTime = 0
  weekCache.clear()
  rangeCache.clear()
}

/**
 * 설정 화면 [연결 테스트]. 저장된 OAuth 토큰으로 primary 캘린더를 GET 한 번 조회해 id 를 계정으로 쓴다.
 * 실패하면 googleapis 에러를 그대로 던진다(분류는 integration-verify.ts). 토큰은 돌려주지 않는다.
 */
export async function verifyGoogleCalendar(): Promise<{ account: string | null }> {
  const auth = getAuthenticatedClient()
  if (!auth) throw new Error('Google 캘린더가 연결되어 있지 않습니다.')
  const calendar = google.calendar({ version: 'v3', auth })
  // 연결 테스트가 멈추지 않도록 타임아웃을 걸고 재시도를 끈다(기본 재시도는 지연을 키운다)
  const res = await calendar.calendarList.get({ calendarId: PRIMARY_ID }, { timeout: 15_000, retry: false })
  return { account: res.data.id ?? null }
}
