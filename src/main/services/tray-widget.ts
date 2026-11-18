import { Tray, BrowserWindow, nativeImage, screen, ipcMain, app } from 'electron'
import { join } from 'path'
import { getDatabase } from '../db/database'
import { getTodayEvents, CalendarEvent } from './google-calendar'
import { format } from 'date-fns'
import { is } from '@electron-toolkit/utils'
import { getToday } from './assistant-service'
import { navigateToToday } from './assistant-scheduler'
import { toTraySummary } from './assistant-tray'
import type { TrayAssistant } from './assistant-types'

let tray: Tray | null = null
let panelWindow: BrowserWindow | null = null
let panelReady = false

interface TrayEvent {
  summary: string
  time: string
  allDay: boolean
  kind: 'event' | 'todo'
  isCompleted: boolean
}

interface TrayData {
  events: TrayEvent[]
  assistant: TrayAssistant | null
}

function hasTime(dueDate: string): boolean {
  return /\s\d{2}:\d{2}/.test(dueDate)
}

function getTodayTodoScheduleItems(): TrayEvent[] {
  const db = getDatabase()
  const today = format(new Date(), 'yyyy-MM-dd')

  // TODOs with due_date today (with time) OR completed today
  const rows = db
    .prepare(`
      SELECT id, title, due_date, is_completed, completed_at FROM todos
      WHERE (due_date IS NOT NULL AND due_date LIKE ? || '%')
         OR (is_completed = 1 AND completed_at IS NOT NULL AND completed_at LIKE ? || '%')
    `)
    .all(today, today) as {
      id: number
      title: string
      due_date: string | null
      is_completed: number
      completed_at: string | null
    }[]

  const items: TrayEvent[] = []
  const seen = new Set<number>()

  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)

    const isCompleted = row.is_completed === 1

    // Determine time: prefer completed_at for completed todos, else due_date
    let time: string | null = null
    if (isCompleted && row.completed_at && row.completed_at.startsWith(today)) {
      time = format(new Date(row.completed_at.replace(' ', 'T')), 'HH:mm')
    } else if (row.due_date && hasTime(row.due_date) && row.due_date.startsWith(today)) {
      time = format(new Date(row.due_date.replace(' ', 'T')), 'HH:mm')
    }

    if (!time) continue

    items.push({
      summary: row.title,
      time,
      allDay: false,
      kind: 'todo',
      isCompleted
    })
  }

  return items
}

/**
 * 트레이 '오늘 계획' 요약 (부록 E.4.1). 비서 테이블을 직접 읽지 않고 getToday 를 투영한다 (A28).
 * 백업 복원 중 DB 가 닫혀 있으면 throw 하므로 null 로 넘긴다 (A13).
 */
async function getTrayAssistant(): Promise<TrayAssistant | null> {
  try {
    const today = await getToday()
    if (!today.settings.enabled) return null
    return toTraySummary(today)
  } catch {
    return null
  }
}

async function getTrayData(): Promise<TrayData> {
  const assistant = await getTrayAssistant()
  const calEvents = await getTodayEvents()
  const calItems: TrayEvent[] = calEvents.map((e: CalendarEvent) => ({
    summary: e.summary,
    time: e.allDay ? 'All Day' : format(new Date(e.start), 'HH:mm'),
    allDay: e.allDay,
    kind: 'event' as const,
    isCompleted: false
  }))
  const todoItems = getTodayTodoScheduleItems()

  // Merge and sort: all-day first, then by time
  const events = [...calItems, ...todoItems].sort((a, b) => {
    if (a.allDay && !b.allDay) return -1
    if (!a.allDay && b.allDay) return 1
    if (a.allDay && b.allDay) return 0
    return a.time.localeCompare(b.time)
  })

  return { events, assistant }
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
    // 비활성화(non-activating) NSPanel. 트레이 위젯을 열어도 앱이 활성화되지 않아
    // Stage Manager 스테이지 전환을 일으키지 않고, 전체화면 앱 위에도 뜬다.
    // 생성 시 "NSWindow does not support nonactivating panel styleMask" 경고가
    // 한 번 찍히지만 무해함(electron#35815) — 비활성화 동작은 정상 작동 확인됨.
    type: 'panel',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 트레이 드롭다운은 시스템 컨텍스트 메뉴와 같은 층(pop-up-menu)에서 표시.
  panel.setAlwaysOnTop(true, 'pop-up-menu')

  // skipTransformProcessType 필수: 이 옵션 없이 visibleOnFullScreen을 켜면 Electron이
  // 앱 전체를 UIElement(액세서리) 프로세스로 변환해서(DockHide) Stage Manager가
  // 메인 창을 관리 대상에서 제외한다 — 앱 실행 시 스테이지 전환이 안 되고,
  // 다른 창 클릭 시 스트립으로 안 들어가고 뒤로 가라앉으며, Dock 아이콘이
  // 간헐적으로 사라지던 증상의 원인. (type:'panel'이 전체화면 위 표시를 담당하고,
  // 이 호출은 모든 스페이스에서 보이는 속성만 추가한다.)
  panel.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  })

  panel.once('ready-to-show', () => {
    panelReady = true
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
  if (!tray || !panelWindow || !panelReady) return

  const trayBounds = tray.getBounds()
  const panelWidth = 340
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })

  const x = Math.round(trayBounds.x + trayBounds.width / 2 - panelWidth / 2)
  const y = display.workArea.y

  panelWindow.setPosition(x, y)

  // Send fresh data
  getTrayData().then((data) => {
    panelWindow?.webContents.send('tray:data', data)
  })

  panelWindow.show()
  panelWindow.focus()
}

export function createTrayWidget(onOpenApp: () => void): void {
  const iconPath = join(__dirname, '../../resources/tray-icon.png')
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
    } else {
      onOpenApp()
    }
    panelWindow?.hide()
  })

  // 트레이 '오늘 보기' (부록 E.4.3)
  ipcMain.handle('tray:openToday', () => {
    navigateToToday()
    panelWindow?.hide()
  })
}

export function destroyTrayWidget(): void {
  // 앱 종료/재생성 시 이중 등록 방지
  ipcMain.removeHandler('tray:getData')
  ipcMain.removeHandler('tray:openApp')
  ipcMain.removeHandler('tray:openToday')
  if (panelWindow) {
    panelWindow.destroy()
    panelWindow = null
    panelReady = false
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
}
