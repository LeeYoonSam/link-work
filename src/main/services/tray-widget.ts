import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron'
import { join } from 'path'
import { getDatabase } from '../db/database'
import { getTodayEvents } from './google-calendar'
import { differenceInCalendarDays, format } from 'date-fns'

let tray: Tray | null = null
let updateInterval: ReturnType<typeof setInterval> | null = null

interface ActiveProject {
  name: string
  deploy_date: string
  daysLeft: number
}

function getActiveProjects(): ActiveProject[] {
  const db = getDatabase()
  const projects = db
    .prepare("SELECT name, deploy_date FROM projects WHERE status = 'active' ORDER BY deploy_date ASC")
    .all() as { name: string; deploy_date: string }[]

  const today = new Date()
  return projects.map((p) => ({
    name: p.name,
    deploy_date: p.deploy_date,
    daysLeft: differenceInCalendarDays(new Date(p.deploy_date), today)
  }))
}

async function buildMenu(): Promise<Menu> {
  const projects = getActiveProjects()
  const events = await getTodayEvents()

  const menuItems: Electron.MenuItemConstructorOptions[] = []

  // Header
  menuItems.push({ label: 'LinkWork', enabled: false })
  menuItems.push({ type: 'separator' })

  // Active Projects
  if (projects.length > 0) {
    menuItems.push({ label: 'Active Projects', enabled: false })
    for (const p of projects) {
      const daysText =
        p.daysLeft < 0
          ? `${Math.abs(p.daysLeft)}d overdue`
          : p.daysLeft === 0
            ? 'Deploy today!'
            : `${p.daysLeft}d left`
      const urgency = p.daysLeft <= 3 ? ' ⚠️' : ''
      menuItems.push({
        label: `  ${p.name} — ${daysText}${urgency}`,
        enabled: false
      })
    }
  } else {
    menuItems.push({ label: 'No active projects', enabled: false })
  }

  menuItems.push({ type: 'separator' })

  // Today's Schedule
  if (events.length > 0) {
    menuItems.push({ label: `Today's Schedule (${events.length})`, enabled: false })
    for (const event of events) {
      const time = event.allDay ? 'All Day' : format(new Date(event.start), 'HH:mm')
      menuItems.push({
        label: `  ${time}  ${event.summary}`,
        enabled: false
      })
    }
  } else {
    menuItems.push({ label: 'No events today', enabled: false })
  }

  menuItems.push({ type: 'separator' })

  // Actions
  menuItems.push({
    label: 'Open LinkWork',
    click: () => {
      const windows = BrowserWindow.getAllWindows()
      if (windows.length > 0) {
        windows[0].show()
        windows[0].focus()
      }
    }
  })

  menuItems.push({
    label: 'Refresh',
    click: () => updateTrayMenu()
  })

  menuItems.push({ type: 'separator' })
  menuItems.push({ label: 'Quit', click: () => app.quit() })

  return Menu.buildFromTemplate(menuItems)
}

async function updateTrayMenu(): Promise<void> {
  if (!tray) return
  const menu = await buildMenu()
  tray.setContextMenu(menu)

  // Update tooltip with summary
  const projects = getActiveProjects()
  const urgent = projects.filter((p) => p.daysLeft <= 3)
  const tooltip = urgent.length > 0
    ? `LinkWork — ${urgent.length} urgent project(s)`
    : `LinkWork — ${projects.length} active project(s)`
  tray.setToolTip(tooltip)
}

export function createTrayWidget(): void {
  // Create a small template icon (16x16 for macOS menu bar)
  const iconPath = join(__dirname, '../../resources/icon.png')
  let icon: Electron.NativeImage

  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    icon.setTemplateImage(true)
  } catch {
    // Fallback: create a simple icon
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('LinkWork')

  // Initial menu build
  updateTrayMenu()

  // Auto-refresh every 2 minutes
  updateInterval = setInterval(updateTrayMenu, 2 * 60 * 1000)

  // Click to show menu (macOS default behavior)
  tray.on('click', () => {
    updateTrayMenu()
  })
}

export function destroyTrayWidget(): void {
  if (updateInterval) {
    clearInterval(updateInterval)
    updateInterval = null
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
}
