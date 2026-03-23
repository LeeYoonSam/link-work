import { Notification } from 'electron'
import { getTodayEvents, CalendarEvent } from './google-calendar'
import { differenceInMinutes } from 'date-fns'

const sentNotifications = new Set<string>()
let intervalId: ReturnType<typeof setInterval> | null = null

function makeKey(eventId: string, minutesBefore: number): string {
  return `${eventId}:${minutesBefore}`
}

function sendNotification(event: CalendarEvent, minutesBefore: number): void {
  const key = makeKey(event.id, minutesBefore)
  if (sentNotifications.has(key)) return

  const notification = new Notification({
    title: `${minutesBefore}분 후 일정`,
    body: event.summary,
    silent: false
  })

  notification.show()
  sentNotifications.add(key)
}

async function checkUpcomingEvents(): Promise<void> {
  const events = await getTodayEvents()
  const now = new Date()

  for (const event of events) {
    if (event.allDay) continue

    const eventStart = new Date(event.start)
    const minutesUntil = differenceInMinutes(eventStart, now)

    if (minutesUntil <= 10 && minutesUntil >= 5) {
      sendNotification(event, 10)
    } else if (minutesUntil < 5 && minutesUntil >= 1) {
      sendNotification(event, 5)
    } else if (minutesUntil < 1 && minutesUntil >= -1) {
      sendNotification(event, 1)
    }
  }
}

export function startNotificationService(): void {
  if (intervalId) return
  checkUpcomingEvents()
  intervalId = setInterval(checkUpcomingEvents, 60 * 1000)
}

export function stopNotificationService(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}

export function clearNotificationHistory(): void {
  sentNotifications.clear()
}
