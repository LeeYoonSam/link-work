import { google } from 'googleapis'
import { getAuthenticatedClient } from './google-auth'
import { startOfDay, endOfDay } from 'date-fns'

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

let cachedEvents: CalendarEvent[] = []
let lastFetchTime = 0
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes

export async function getTodayEvents(forceRefresh = false): Promise<CalendarEvent[]> {
  const now = Date.now()
  if (!forceRefresh && cachedEvents.length > 0 && now - lastFetchTime < CACHE_DURATION) {
    return cachedEvents
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

    cachedEvents = (response.data.items || []).map((event) => ({
      id: event.id || '',
      summary: event.summary || '(No title)',
      description: event.description || undefined,
      start: event.start?.dateTime || event.start?.date || '',
      end: event.end?.dateTime || event.end?.date || '',
      allDay: !event.start?.dateTime,
      location: event.location || undefined,
      htmlLink: event.htmlLink || undefined
    }))

    lastFetchTime = now
    return cachedEvents
  } catch (error) {
    console.error('Failed to fetch calendar events:', error)
    return cachedEvents
  }
}

export function clearCache(): void {
  cachedEvents = []
  lastFetchTime = 0
}
