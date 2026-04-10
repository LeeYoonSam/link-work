/// <reference types="vite/client" />
/// <reference types="react" />

import type { ProjectAPI, TaskAPI, CalendarAPI, TrayAPI, DocumentAPI, VariableAPI, MemoAPI, ReportAPI, TodoAPI, TodoTagAPI } from './types'

declare global {
  interface Window {
    api: {
      project: ProjectAPI
      task: TaskAPI
      tray: TrayAPI
      calendar: CalendarAPI
      document: DocumentAPI
      variable: VariableAPI
      memo: MemoAPI
      report: ReportAPI
      todo: TodoAPI
      todoTag: TodoTagAPI
    }
  }
}
