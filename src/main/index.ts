import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { join, basename } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase, closeDatabase } from './db/database'
import { registerProjectIpc } from './ipc/project.ipc'
import { registerTaskIpc } from './ipc/task.ipc'
import { registerCalendarIpc } from './ipc/calendar.ipc'
import { registerDocumentIpc } from './ipc/document.ipc'
import { registerVariableIpc } from './ipc/variable.ipc'
import { registerMemoIpc } from './ipc/memo.ipc'
import { registerMemoCategoryIpc } from './ipc/memo-category.ipc'
import { registerReportIpc } from './ipc/report.ipc'
import { registerTodoIpc } from './ipc/todo.ipc'
import { registerTodoTagIpc } from './ipc/todo-tag.ipc'
import { registerAiIpc } from './ipc/ai.ipc'
import { registerRecordingIpc } from './ipc/recording.ipc'
import { cancelAllAiQueries } from './services/ai-agent'
import { startNotificationService, stopNotificationService } from './services/notification'
import { createTrayWidget, destroyTrayWidget } from './services/tray-widget'

let mainWindow: BrowserWindow | null = null

// 녹음 오디오 재생용 커스텀 프로토콜 (renderer는 userData 경로를 모르고 file://는 막힘).
// 반드시 app ready 전에 등록해야 한다.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'linkwork-media',
    privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
  }
])

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const parsed = new URL(details.url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(details.url)
      }
    } catch {
      // Invalid URL — ignore
    }
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.linkwork.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 녹음 오디오 스트리밍 (linkwork-media://audio/<파일명>). basename으로 경로 탈출 차단.
  protocol.handle('linkwork-media', (request) => {
    const fileName = basename(decodeURIComponent(new URL(request.url).pathname))
    const filePath = join(app.getPath('userData'), 'recordings', fileName)
    return net.fetch(pathToFileURL(filePath).toString())
  })

  initDatabase()
  registerProjectIpc()
  registerTaskIpc()
  registerCalendarIpc()
  registerDocumentIpc()
  registerVariableIpc()
  registerMemoIpc()
  registerMemoCategoryIpc()
  registerReportIpc()
  registerTodoIpc()
  registerTodoTagIpc()
  registerAiIpc()
  registerRecordingIpc()
  startNotificationService()
  createTrayWidget(() => createWindow())

  createWindow()

  app.on('activate', function () {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      createWindow()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  })
})

app.on('before-quit', () => {
  // 타이머/트레이 먼저 정지 (in-flight async 콜백이 DB에 접근하는 race 회피)
  stopNotificationService()
  destroyTrayWidget()
  cancelAllAiQueries()
})

app.on('will-quit', () => {
  // 모든 window/timer가 정리된 뒤 DB 닫기 (WAL 잔존 방지)
  closeDatabase()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
