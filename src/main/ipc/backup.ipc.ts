// 앱 데이터 백업 · 복원 IPC (docs/DATA_BACKUP.md)
//
// 실제 로직은 services/backup-service.ts에 있고 여기서는 다이얼로그·진행 이벤트·재시작만 맡는다.
// 백업 한 벌은 단일 .zip 파일이라 내보내기는 저장 다이얼로그, 가져오기는 파일 선택 다이얼로그다.
// 복원은 고른 그룹의 테이블·파일을 백업 내용으로 **교체**한다(.bak 보관본 외에는 되돌릴 수 없다) —
// 진입 조건(처리 중인 회의)을 먼저 확인하고, 사용자 확인은 렌더러의 체크박스가 담당한다.
// 렌더러가 보낸 그룹 목록은 믿지 않고 parseGroupsArg로 다시 검증한다.
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { closeDatabase, getDatabase } from '../db/database'
import {
  DB_FILE,
  collectGroupStats,
  defaultBackupFileName,
  exportBackup,
  importBackup,
  inspectBackup,
  parseGroupsArg,
  type BackupPaths,
  type BackupProgress,
  type DatabaseLike
} from '../services/backup-service'
import type { BackupGroupId } from '../services/backup-groups'

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

/**
 * 복원으로 DB 핸들을 닫은 뒤 재시작을 기다리는 중인지.
 * 경고가 있는 복원은 사용자가 경고를 읽고 backup:restart를 부를 때까지 재시작하지 않는다.
 * 그동안 getDatabase()는 throw하므로 일반 IPC·타이머는 실패할 뿐 데이터를 바꾸지 않는다
 * (assistant-scheduler·tray-widget은 이 창을 이미 try/catch로 견딘다).
 * 다만 blockingReason()은 getDatabase()의 throw를 "막을 이유 없음"으로 삼키므로,
 * 이 플래그가 없으면 두 번째 복원이 닫힌 앱 위에서 그대로 돈다 — 그래서 내보내기·복원을 명시적으로 막는다.
 */
let restartPending = false

const RESTART_PENDING_ERROR = '복원이 끝나 앱 재시작을 기다리는 중입니다. 먼저 앱을 다시 시작하세요.'

const BUSY_ERROR = '다른 백업·복원 작업이 진행 중입니다. 끝난 뒤에 다시 시도하세요.'

/**
 * 내보내기·복원이 도는 동안 다른 작업을 받지 않는다. 복원은 DB 를 닫았다 다시 열고 파일을 바꾸므로
 * 두 작업이 겹치면 안 된다. 확인과 설정은 같은 동기 구간에서 해야 두 번째 호출이 끼어들지 못한다.
 * 복원 뒤 재시작 대기(restartPending)와는 별개다 — 그쪽은 재시작 전까지 계속 막힌다.
 */
let operationBusy = false

function beginOperation(): boolean {
  if (operationBusy) return false
  operationBusy = true
  return true
}

function endOperation(): void {
  operationBusy = false
}

/** 재시작을 이미 예약했는지 — 창 닫힘·restart·실패 경로가 겹쳐도 한 번만 띄운다. */
let relaunchScheduled = false

function relaunchAfter(ms: number): void {
  if (relaunchScheduled) return
  relaunchScheduled = true
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, ms)
}

/** 테스트 전용: 모듈 상태를 처음으로 되돌린다. */
export function resetBackupIpcStateForTest(): void {
  restartPending = false
  relaunchScheduled = false
  operationBusy = false
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

/**
 * 복원 본체. 호출측(backup:import)이 operationBusy 를 잡고 있다.
 * 복원으로 DB 핸들을 닫은 뒤에는 실패해도 재시작 경로로 보낸다.
 */
async function runImport(
  event: Electron.IpcMainInvokeEvent,
  backupPath: string,
  groups: BackupGroupId[],
  report: (p: BackupProgress) => void
): Promise<Record<string, unknown>> {
  const blocked = blockingReason()
  if (blocked) return { success: false, error: blocked }

  // DB 핸들을 닫은 뒤의 실패는 앱을 닫힌 DB와 함께 남긴다 — 그 상태로 계속 쓰면 이후
  // 모든 DB 접근이 터지므로, 실패해도 재시작해 안전한 상태로 되돌린다.
  let mustRestart = false
  let rollbackPath = ''
  try {
    const result = await importBackup(backupPath, {
      groups,
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
    // 경고가 없으면 지금처럼 1초 뒤 자동 재시작한다. 경고가 있으면 사용자가 읽을 수 있게
    // 재시작을 미루고(restartPending), 렌더러가 확인 뒤 backup:restart를 부른다.
    restartPending = true
    if (result.warnings.length === 0) {
      report({ phase: 'done', progress: 1, message: '복원 완료 — 앱을 다시 시작합니다' })
      relaunchAfter(1000)
      return { success: true, groups: result.groups, warnings: result.warnings }
    }
    // 사용자가 restart를 누르지 않고 창만 닫으면(macOS는 앱이 남는다) 닫힌 DB로 창이 다시
    // 열린다. 요청한 창이 닫히는 순간 재시작해 그 상태를 남기지 않는다. 창을 못 찾으면 그대로 둔다.
    const requester = BrowserWindow.fromWebContents(event.sender)
    if (requester && !requester.isDestroyed()) {
      requester.once('closed', () => relaunchAfter(0))
    }
    report({ phase: 'done', progress: 1, message: '복원 완료 — 확인할 내용을 읽은 뒤 앱을 다시 시작하세요' })
    return {
      success: true,
      groups: result.groups,
      warnings: result.warnings,
      restartPending: true
    }
  } catch (error) {
    let message = errorMessage(error)
    if (rollbackPath) {
      message += `\n복원 전 데이터베이스는 ${rollbackPath}에 보관돼 있습니다.`
    }
    if (mustRestart) message += '\n앱을 다시 시작합니다.'
    report({ phase: 'error', progress: 0, message })
    if (mustRestart) {
      restartPending = true
      relaunchAfter(1500)
    }
    return { success: false, error: message }
  }
}

export function registerBackupIpc(): void {
  // 그룹별 현재 건수·파일 용량 (백업 화면 표시용, 읽기 전용)
  ipcMain.handle('backup:stats', async () => {
    try {
      const groups = await collectGroupStats(
        getDatabase() as unknown as DatabaseLike,
        app.getPath('userData')
      )
      return { success: true, groups }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  })

  // 고른 그룹만 담는다. 저장 위치를 고르면 그 경로에 LinkWork-backup-<시각>.zip을 쓴다.
  ipcMain.handle('backup:export', async (event, groupsArg: unknown) => {
    // 다이얼로그를 띄우기 전에 그룹부터 검증한다 — 빈 선택으로 저장 위치를 묻지 않는다.
    if (restartPending) return { success: false, error: RESTART_PENDING_ERROR }
    const parsed = parseGroupsArg(groupsArg)
    if (!parsed.ok) return { success: false, error: parsed.error }
    if (!beginOperation()) return { success: false, error: BUSY_ERROR }
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
        groups: parsed.groups,
        onProgress: report
      })
      return { success: true, path, manifest }
    } catch (error) {
      report({ phase: 'error', progress: 0, message: errorMessage(error) })
      return { success: false, error: errorMessage(error) }
    } finally {
      endOperation()
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

  ipcMain.handle('backup:import', async (event, backupPath: unknown, groupsArg: unknown) => {
    const report = progressSender(event)
    if (typeof backupPath !== 'string' || !backupPath) {
      return { success: false, error: '복원할 백업 파일이 지정되지 않았습니다.' }
    }
    const parsed = parseGroupsArg(groupsArg)
    if (!parsed.ok) return { success: false, error: parsed.error }
    if (restartPending) return { success: false, error: RESTART_PENDING_ERROR }
    if (!beginOperation()) return { success: false, error: BUSY_ERROR }
    try {
      return await runImport(event, backupPath, parsed.groups, report)
    } finally {
      endOperation()
    }
  })

  // 경고가 있는 복원 뒤 렌더러가 부른다. 자동 재시작과 같은 방식으로 앱을 다시 띄운다.
  ipcMain.handle('backup:restart', () => {
    relaunchAfter(0)
    return { success: true }
  })
}
