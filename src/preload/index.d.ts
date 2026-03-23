import { ElectronAPI } from '@electron-toolkit/preload'
import type { ProjectAPI, TaskAPI, CalendarAPI } from '../renderer/src/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      project: ProjectAPI
      task: TaskAPI
      calendar: CalendarAPI
    }
  }
}
