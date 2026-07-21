import { ipcMain } from 'electron'
import {
  authenticate,
  disconnect,
  isConnected,
  hasCredentials,
  saveSettings
} from '../services/google-auth'
import { getWeekEvents, clearCache } from '../services/google-calendar'

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
