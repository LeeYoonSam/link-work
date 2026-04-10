import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase } from './db/database'
import { registerProjectIpc } from './ipc/project.ipc'
import { registerTaskIpc } from './ipc/task.ipc'
import { registerCalendarIpc } from './ipc/calendar.ipc'
import { registerDocumentIpc } from './ipc/document.ipc'
import { registerVariableIpc } from './ipc/variable.ipc'
import { registerMemoIpc } from './ipc/memo.ipc'
import { registerReportIpc } from './ipc/report.ipc'
import { registerTodoIpc } from './ipc/todo.ipc'
import { registerTodoTagIpc } from './ipc/todo-tag.ipc'
import { startNotificationService } from './services/notification'
import { createTrayWidget } from './services/tray-widget'

let mainWindow: BrowserWindow | null = null

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
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.linkwork.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initDatabase()
  registerProjectIpc()
  registerTaskIpc()
  registerCalendarIpc()
  registerDocumentIpc()
  registerVariableIpc()
  registerMemoIpc()
  registerReportIpc()
  registerTodoIpc()
  registerTodoTagIpc()
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
