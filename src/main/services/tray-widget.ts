import { Tray, BrowserWindow, nativeImage, screen, ipcMain, app } from 'electron'
import { join } from 'path'
import { getDatabase } from '../db/database'
import { getTodayEvents, CalendarEvent } from './google-calendar'
import { differenceInCalendarDays, format } from 'date-fns'
import { is } from '@electron-toolkit/utils'

let tray: Tray | null = null
let panelWindow: BrowserWindow | null = null
let updateInterval: ReturnType<typeof setInterval> | null = null

interface TrayData {
  projects: { name: string; deployDate: string; daysLeft: number; progress: number }[]
  events: { summary: string; time: string; allDay: boolean }[]
}

function getActiveProjects(): TrayData['projects'] {
  const db = getDatabase()
  const projects = db
    .prepare(
      "SELECT name, dev_start_date, deploy_date FROM projects WHERE status = 'active' ORDER BY deploy_date ASC"
    )
    .all() as { name: string; dev_start_date: string; deploy_date: string }[]

  const today = new Date()
  return projects.map((p) => {
    const total = differenceInCalendarDays(new Date(p.deploy_date), new Date(p.dev_start_date))
    const elapsed = differenceInCalendarDays(today, new Date(p.dev_start_date))
    const progress = total > 0 ? Math.min(100, Math.max(0, Math.round((elapsed / total) * 100))) : 100
    return {
      name: p.name,
      deployDate: p.deploy_date,
      daysLeft: differenceInCalendarDays(new Date(p.deploy_date), today),
      progress
    }
  })
}

async function getTrayData(): Promise<TrayData> {
  const projects = getActiveProjects()
  const calEvents = await getTodayEvents()
  const events = calEvents.map((e: CalendarEvent) => ({
    summary: e.summary,
    time: e.allDay ? 'All Day' : format(new Date(e.start), 'HH:mm'),
    allDay: e.allDay
  }))
  return { projects, events }
}

function createPanelWindow(): BrowserWindow {
  const panel = new BrowserWindow({
    width: 340,
    height: 480,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    panel.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#tray-panel`)
  } else {
    panel.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'tray-panel' })
  }

  panel.on('blur', () => {
    panel.hide()
  })

  return panel
}

function showPanel(): void {
  if (!tray || !panelWindow) return

  const trayBounds = tray.getBounds()
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
  const panelBounds = panelWindow.getBounds()

  const x = Math.round(trayBounds.x + trayBounds.width / 2 - panelBounds.width / 2)
  const y = display.workArea.y

  panelWindow.setPosition(x, y)

  // Send fresh data
  getTrayData().then((data) => {
    panelWindow?.webContents.send('tray:data', data)
  })

  panelWindow.show()
  panelWindow.focus()
}

export function createTrayWidget(): void {
  const iconPath = join(__dirname, '../../resources/icon.png')
  let icon: Electron.NativeImage

  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    icon.setTemplateImage(true)
  } catch {
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('LinkWork')

  panelWindow = createPanelWindow()

  tray.on('click', () => {
    if (panelWindow?.isVisible()) {
      panelWindow.hide()
    } else {
      showPanel()
    }
  })

  // IPC for panel requesting data
  ipcMain.handle('tray:getData', async () => {
    return getTrayData()
  })

  ipcMain.handle('tray:openApp', () => {
    const windows = BrowserWindow.getAllWindows().filter((w) => w !== panelWindow)
    if (windows.length > 0) {
      windows[0].show()
      windows[0].focus()
    }
    panelWindow?.hide()
  })

  // Auto-refresh tooltip
  updateInterval = setInterval(async () => {
    const projects = getActiveProjects()
    const urgent = projects.filter((p) => p.daysLeft <= 3)
    const tooltip = urgent.length > 0
      ? `LinkWork - ${urgent.length} urgent`
      : `LinkWork - ${projects.length} active`
    tray?.setToolTip(tooltip)
  }, 2 * 60 * 1000)
}

export function destroyTrayWidget(): void {
  if (updateInterval) {
    clearInterval(updateInterval)
    updateInterval = null
  }
  if (panelWindow) {
    panelWindow.destroy()
    panelWindow = null
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
}
