import { Notification } from 'electron'
import { getTodayEvents, CalendarEvent } from './google-calendar'
import { getDatabase } from '../db/database'
import { differenceInMinutes } from 'date-fns'

const sentNotifications = new Set<string>()
let intervalId: ReturnType<typeof setInterval> | null = null

function makeEventKey(eventId: string, minutesBefore: number): string {
  return `event:${eventId}:${minutesBefore}`
}

function makeTodoKey(todoId: number, dueDate: string, minutesBefore: number): string {
  return `todo:${todoId}:${dueDate}:${minutesBefore}`
}

function sendEventNotification(event: CalendarEvent, minutesBefore: number): void {
  const key = makeEventKey(event.id, minutesBefore)
  if (sentNotifications.has(key)) return

  const notification = new Notification({
    title: `${minutesBefore}분 후 일정`,
    body: event.summary,
    silent: false
  })

  notification.show()
  sentNotifications.add(key)
}

function sendTodoNotification(
  todoId: number,
  title: string,
  dueDate: string,
  minutesBefore: number
): void {
  const key = makeTodoKey(todoId, dueDate, minutesBefore)
  if (sentNotifications.has(key)) return

  const isNow = minutesBefore === 0
  const notification = new Notification({
    title: isNow ? '☑ TODO 시간' : `☑ TODO ${minutesBefore}분 전`,
    body: title,
    silent: false
  })

  notification.show()
  sentNotifications.add(key)
}

async function checkUpcomingEvents(): Promise<void> {
  try {
    const events = await getTodayEvents()
    const now = new Date()

    for (const event of events) {
      if (event.allDay) continue

      const eventStart = new Date(event.start)
      const minutesUntil = differenceInMinutes(eventStart, now)

      if (minutesUntil <= 10 && minutesUntil >= 5) {
        sendEventNotification(event, 10)
      } else if (minutesUntil < 5 && minutesUntil >= 1) {
        sendEventNotification(event, 5)
      } else if (minutesUntil < 1 && minutesUntil >= -1) {
        sendEventNotification(event, 1)
      }
    }
  } catch (e) {
    console.error('[notification] event check failed', e)
  }
}

interface TodoRow {
  id: number
  title: string
  due_date: string
}

function hasTime(dueDate: string): boolean {
  return /\s\d{2}:\d{2}/.test(dueDate)
}

async function checkUpcomingTodos(): Promise<void> {
  try {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT id, title, due_date FROM todos
         WHERE is_completed = 0
           AND due_reminder = 1
           AND due_date IS NOT NULL`
      )
      .all() as TodoRow[]

    const now = new Date()

    for (const row of rows) {
      if (!row.due_date || !hasTime(row.due_date)) continue

      // due_date is stored in local time: "YYYY-MM-DD HH:mm:ss"
      const dueAt = new Date(row.due_date.replace(' ', 'T'))
      if (isNaN(dueAt.getTime())) continue

      const minutesUntil = differenceInMinutes(dueAt, now)

      // 10 minutes before: window of 10..6 minutes
      if (minutesUntil <= 10 && minutesUntil >= 6) {
        sendTodoNotification(row.id, row.title, row.due_date, 10)
      }

      // At due time: window of 1..-1 minutes
      if (minutesUntil < 1 && minutesUntil >= -1) {
        sendTodoNotification(row.id, row.title, row.due_date, 0)
      }
    }
  } catch (e) {
    console.error('[notification] todo check failed', e)
  }
}

async function runChecks(): Promise<void> {
  await Promise.all([checkUpcomingEvents(), checkUpcomingTodos()])
}

export function startNotificationService(): void {
  if (intervalId) return
  runChecks()
  intervalId = setInterval(runChecks, 60 * 1000)
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
