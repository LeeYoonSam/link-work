import { ipcMain } from 'electron'
import {
  getMobileStatus,
  publishMobileToday,
  regenerateMobileToken,
  setMobileServerEnabled
} from '../services/mobile/controller'

// 휴대폰 열람 서버 — 설정 화면(켜기·QR·토큰 재발급)과 오늘 스냅샷 발행.
// 이벤트 main→renderer: 'mobile:publishRequested' (payload 없음) — 휴대폰이 오늘 화면을 열면 재발행을 요청한다.
export function registerMobileIpc(): void {
  ipcMain.handle('mobile:getStatus', () => getMobileStatus())

  ipcMain.handle('mobile:setEnabled', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return getMobileStatus()
    return setMobileServerEnabled(enabled)
  })

  ipcMain.handle('mobile:regenerateToken', () => regenerateMobileToken())

  ipcMain.handle('mobile:publishToday', (_event, snapshot: unknown) => publishMobileToday(snapshot))
}
