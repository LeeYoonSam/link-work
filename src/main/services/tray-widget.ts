import { Tray, BrowserWindow, nativeImage, screen, ipcMain, app } from 'electron'
import { join } from 'path'
import { getDatabase } from '../db/database'
import { getTodayEvents, CalendarEvent } from './google-calendar'
import { differenceInCalendarDays, format } from 'date-fns'
import { is } from '@electron-toolkit/utils'

let tray: Tray | null = null
let panelWindow: BrowserWindow | null = null
let panelReady = false
let updateInterval: ReturnType<typeof setInterval> | null = null

interface TrayProject {
  name: string
  status: string
  dev_start_date: string
  dev_end_date: string
  qa_start_date: string
  qa_end_date: string
  deploy_date: string
  daysLeft: number // 상태별 마감 D-day(툴팁 긴급도 판정용)
}

interface TrayEvent {
  summary: string
  time: string
  allDay: boolean
  kind: 'event' | 'todo'
  isCompleted: boolean
}

interface TrayData {
  projects: TrayProject[]
  events: TrayEvent[]
}

/**
 * 위젯 필터 정책: 대시보드와 동일하게 적용
 * - scheduled, development, qa_pending, qa, deploy_pending, deploy 상태만 표시
 * - completed, cancelled 상태는 제외
 * - 상태는 날짜 기반 자동 계산 (status_manual=0) 또는 수동 설정값 사용
 *
 * 정책 변경 시 Dashboard.tsx의 필터도 함께 수정할 것
 */
const VISIBLE_STATUSES = new Set([
  'scheduled',
  'development',
  'qa_pending',
  'qa',
  'deploy_pending',
  'deploy'
])

const STATUS_PRIORITY: Record<string, number> = {
  development: 0,
  qa: 1,
  qa_pending: 2,
  deploy_pending: 3,
  deploy: 4,
  scheduled: 5
}

function calculateAutoStatus(project: { dev_start_date: string; dev_end_date: string; qa_start_date: string; qa_end_date: string; deploy_date: string }): string {
  const today = new Date().toISOString().split('T')[0]
  if (today < project.dev_start_date) return 'scheduled'
  if (today > project.deploy_date) return 'completed'
  if (today === project.deploy_date) return 'deploy'
  if (today >= project.qa_start_date && today <= project.qa_end_date) return 'qa'
  // QA 종료 ~ 배포일 사이의 공백 구간은 배포대기 상태.
  if (today > project.qa_end_date) return 'deploy_pending'
  // 개발 종료 ~ QA 시작 사이의 공백 구간은 QA대기 상태.
  if (today > project.dev_end_date) return 'qa_pending'
  return 'development'
}

function getActiveProjects(): TrayProject[] {
  const db = getDatabase()
  const projects = db
    .prepare(
      'SELECT id, name, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date, status, status_manual FROM projects ORDER BY deploy_date ASC'
    )
    .all() as { id: number; name: string; dev_start_date: string; dev_end_date: string; qa_start_date: string; qa_end_date: string; deploy_date: string; status: string; status_manual: number }[]

  const today = new Date()
  return projects
    .map((p) => {
      const status = p.status_manual === 0 ? calculateAutoStatus(p) : p.status
      return { ...p, status }
    })
    .filter((p) => VISIBLE_STATUSES.has(p.status))
    .map((p) => {
      // 상태별 마감일 기준 D-day. 위젯 표시는 renderer의 getPhaseHint가 담당하고,
      // 이 값은 툴팁 긴급도(daysLeft <= 3) 판정에 쓰인다.
      let daysLeft: number
      switch (p.status) {
        case 'scheduled':
          daysLeft = differenceInCalendarDays(new Date(p.dev_start_date), today)
          break
        case 'development':
          daysLeft = differenceInCalendarDays(new Date(p.dev_end_date), today)
          break
        case 'qa_pending':
          daysLeft = differenceInCalendarDays(new Date(p.qa_start_date), today)
          break
        case 'qa':
          daysLeft = differenceInCalendarDays(new Date(p.qa_end_date), today)
          break
        default: // deploy_pending, deploy
          daysLeft = differenceInCalendarDays(new Date(p.deploy_date), today)
          break
      }

      return {
        name: p.name,
        status: p.status,
        dev_start_date: p.dev_start_date,
        dev_end_date: p.dev_end_date,
        qa_start_date: p.qa_start_date,
        qa_end_date: p.qa_end_date,
        deploy_date: p.deploy_date,
        daysLeft
      }
    })
    .sort((a, b) => (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99))
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

async function getTrayData(): Promise<TrayData> {
  const projects = getActiveProjects()
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

  // Auto-refresh tooltip
  updateInterval = setInterval(async () => {
    const projects = getActiveProjects()
    const urgent = projects.filter((p) => p.daysLeft <= 3)
    const tooltip = urgent.length > 0
      ? `LinkWork - ${urgent.length} urgent`
      : `LinkWork - ${projects.length} active`
    tray?.setToolTip(tooltip)
  }, 5 * 60 * 1000)
}

export function destroyTrayWidget(): void {
  if (updateInterval) {
    clearInterval(updateInterval)
    updateInterval = null
  }
  // 앱 종료/재생성 시 이중 등록 방지
  ipcMain.removeHandler('tray:getData')
  ipcMain.removeHandler('tray:openApp')
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
