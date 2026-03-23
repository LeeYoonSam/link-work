import { ElectronAPI } from '@electron-toolkit/preload'
import type { ProjectAPI, TaskAPI, CalendarAPI, TrayAPI } from '../renderer/src/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      project: ProjectAPI
      task: TaskAPI
      tray: TrayAPI
      calendar: CalendarAPI
    }
  }
}
