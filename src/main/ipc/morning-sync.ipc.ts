import { ipcMain } from 'electron'
import { getMorningSyncStatus } from '../services/morning-sync'

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerMorningSyncIpc(): void {
  // 아침 자동 동기화 상태. 사이드바 배지와 상태 줄이 읽는다. 읽기 전용이다.
  ipcMain.handle('morningSync:status', async () => {
    try {
      return { success: true, status: await getMorningSyncStatus() }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })
}
