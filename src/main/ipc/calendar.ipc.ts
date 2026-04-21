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

  ipcMain.handle('calendar:events', async () => {
    try {
      const events = await getWeekEvents()
      return events
    } catch (error) {
      console.error('Failed to get events:', error)
      return []
    }
  })

  ipcMain.handle('calendar:refresh', async () => {
    try {
      const events = await getWeekEvents(true)
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
