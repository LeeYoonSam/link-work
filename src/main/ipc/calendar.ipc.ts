import { ipcMain } from 'electron'
import {
  authenticate,
  disconnect,
  isConnected,
  hasCredentials,
  saveSettings
} from '../services/google-auth'
import {
  getWeekEvents,
  clearCache,
  listCalendars,
  getSelectedCalendarIds,
  setSelectedCalendarIds,
  getRangeEvents
} from '../services/google-calendar'

function fail(error: unknown): { success: false; error: string } {
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

export function registerCalendarIpc(): void {
  ipcMain.handle('calendar:auth', async () => {
    try {
      const result = await authenticate()
      return { success: result }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // weekStartISO: 조회할 주(월요일 기준)의 임의 시각. 없으면 이번 주.
  ipcMain.handle('calendar:events', async (_event, weekStartISO?: string) => {
    try {
      const events = await getWeekEvents(weekStartISO)
      return events
    } catch (error) {
      console.error('Failed to get events:', error)
      return []
    }
  })

  ipcMain.handle('calendar:refresh', async (_event, weekStartISO?: string) => {
    try {
      const events = await getWeekEvents(weekStartISO, true)
      return events
    } catch (error) {
      return []
    }
  })

  // 설정 화면 "가져올 캘린더". 목록 조회가 실패해도 저장된 선택은 그대로 쓴다.
  ipcMain.handle('calendar:listCalendars', async () => {
    try {
      const calendars = await listCalendars()
      return { success: true, calendars, selectedIds: getSelectedCalendarIds() }
    } catch (error) {
      console.error('Failed to list calendars:', error)
      return fail(error)
    }
  })

  ipcMain.handle('calendar:setSelectedCalendars', (_event, ids: unknown) => {
    try {
      return { success: true, selectedIds: setSelectedCalendarIds(ids) }
    } catch (error) {
      return fail(error)
    }
  })

  // 오늘 대시보드: 임의 기간(최대 45일) 일정. 미연결·형식 오류·조회 실패는 Fail 이다.
  ipcMain.handle('calendar:range', async (_event, fromISO: unknown, toISO: unknown, force?: unknown) => {
    try {
      const r = await getRangeEvents(fromISO, toISO, force === true)
      return { success: true, events: r.events, fetchedAt: r.fetchedAt }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('calendar:disconnect', () => {
    disconnect()
    clearCache()
    return { success: true }
  })

  ipcMain.handle('calendar:status', () => {
    return {
      connected: isConnected(),
      hasCredentials: hasCredentials()
    }
  })

  ipcMain.handle(
    'calendar:saveSettings',
    (_event, clientId: string, clientSecret: string) => {
      saveSettings(clientId, clientSecret)
      return { success: true }
    }
  )
}
