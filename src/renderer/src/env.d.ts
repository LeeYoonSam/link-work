/// <reference types="vite/client" />
/// <reference types="react" />

import type { ProjectAPI, TaskAPI, CalendarAPI, TrayAPI } from './types'

declare global {
  interface Window {
    api: {
      project: ProjectAPI
      task: TaskAPI
      tray: TrayAPI
      calendar: CalendarAPI
    }
  }
}
