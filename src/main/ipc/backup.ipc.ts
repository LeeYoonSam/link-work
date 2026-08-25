// 앱 데이터 백업 · 복원 IPC (docs/DATA_BACKUP.md)
//
// 실제 로직은 services/backup-service.ts에 있고 여기서는 다이얼로그·진행 이벤트·재시작만 맡는다.
// 백업 한 벌은 단일 .zip 파일이라 내보내기는 저장 다이얼로그, 가져오기는 파일 선택 다이얼로그다.
// 복원은 DB 핸들을 닫고 파일을 덮어쓰므로 **되돌릴 수 없다** — 진입 조건(처리 중인 회의)을
// 먼저 확인하고, 사용자 확인은 렌더러의 체크박스가 담당한다.
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { closeDatabase, getDatabase } from '../db/database'
import {
  DB_FILE,
  defaultBackupFileName,
  exportBackup,
  importBackup,
  inspectBackup,
  type BackupPaths,
  type BackupProgress
} from '../services/backup-service'

const ZIP_FILTER = [{ name: 'LinkWork 백업', extensions: ['zip'] }]

function currentPaths(): BackupPaths {
  const userDataDir = app.getPath('userData')
  return { userDataDir, dbPath: join(userDataDir, DB_FILE) }
}

function progressSender(event: Electron.IpcMainInvokeEvent): (p: BackupProgress) => void {
  return (p) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) win.webContents.send('backup:progress', p)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 파이프라인이 돌고 있으면 복원을 막는다 — 복원 중 DB를 닫으면 처리 중인 회의가 깨진다. */
function blockingReason(): string | null {
  try {
    const row = getDatabase()
      .prepare("SELECT COUNT(*) AS c FROM meetings WHERE status = 'processing'")
      .get() as { c: number } | undefined
    if ((row?.c ?? 0) > 0) {
      return '회의 처리가 진행 중입니다. 끝난 뒤에 다시 시도하세요.'
    }
  } catch {
    // 테이블이 없는 초기 상태 등 — 막을 이유가 없다
  }
  return null
}

export function registerBackupIpc(): void {
  // 저장 위치를 고르면 그 경로에 LinkWork-backup-<시각>.zip을 쓴다.
  ipcMain.handle('backup:export', async (event) => {
    const report = progressSender(event)
    try {
      const parent = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.SaveDialogOptions = {
        title: '백업 파일 저장',
        buttonLabel: '내보내기',
        defaultPath: join(app.getPath('documents'), defaultBackupFileName()),
        filters: ZIP_FILTER
      }
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)

      if (result.canceled || !result.filePath) return { success: false, canceled: true }

      const { path, manifest } = await exportBackup(result.filePath, {
        paths: currentPaths(),
        sourceDb: getDatabase(),
        appVersion: app.getVersion(),
        onProgress: report
      })
      return { success: true, path, manifest }
    } catch (error) {
      report({ phase: 'error', progress: 0, message: errorMessage(error) })
      return { success: false, error: errorMessage(error) }
    }
  })

  // 백업 파일을 골라 내용을 확인만 한다 (복원은 별도 확인 후 backup:import).
  ipcMain.handle('backup:pick', async (event) => {
    try {
      const parent = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: '복원할 백업 파일 선택',
        buttonLabel: '이 백업 확인',
        properties: ['openFile'],
        filters: ZIP_FILTER
      }
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)

      const picked = result.filePaths[0]
      if (result.canceled || !picked) return { success: false, canceled: true }

      const summary = await inspectBackup(picked, { paths: currentPaths() })
      return { success: true, summary }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('backup:import', async (event, backupPath: unknown) => {
    const report = progressSender(event)
    if (typeof backupPath !== 'string' || !backupPath) {
      return { success: false, error: '복원할 백업 파일이 지정되지 않았습니다.' }
    }
    const blocked = blockingReason()
    if (blocked) return { success: false, error: blocked }

    // DB 핸들을 닫은 뒤의 실패는 앱을 닫힌 DB와 함께 남긴다 — 그 상태로 계속 쓰면 이후
    // 모든 DB 접근이 터지므로, 실패해도 재시작해 안전한 상태로 되돌린다.
    let mustRestart = false
    let rollbackPath = ''
    try {
      await importBackup(backupPath, {
        paths: currentPaths(),
        closeDb: closeDatabase,
        onProgress: report,
        onDbClosed: () => {
          mustRestart = true
        },
        onRollbackPointCreated: (p) => {
          rollbackPath = p
        }
      })
      report({ phase: 'done', progress: 1, message: '복원 완료 — 앱을 다시 시작합니다' })
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 1000)
      return { success: true }
    } catch (error) {
      let message = errorMessage(error)
      if (rollbackPath) {
        message += `\n복원 전 데이터베이스는 ${rollbackPath}에 보관돼 있습니다.`
      }
      if (mustRestart) message += '\n앱을 다시 시작합니다.'
      report({ phase: 'error', progress: 0, message })
      if (mustRestart) {
        setTimeout(() => {
          app.relaunch()
          app.exit(0)
        }, 1500)
      }
      return { success: false, error: message }
    }
  })
}
