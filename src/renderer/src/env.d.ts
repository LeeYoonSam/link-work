/// <reference types="vite/client" />
/// <reference types="react" />

import type { ProjectAPI, TaskAPI, CalendarAPI } from './types'

declare global {
  interface Window {
    api: {
      project: ProjectAPI
      task: TaskAPI
      calendar: CalendarAPI
    }
  }
}
