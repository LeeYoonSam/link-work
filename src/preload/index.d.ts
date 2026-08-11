import { ElectronAPI } from '@electron-toolkit/preload'
import type { ProjectAPI, TaskAPI, CalendarAPI, TrayAPI, DocumentAPI, VariableAPI, MemoAPI, MemoCategoryAPI, ReportAPI, TodoAPI, TodoTagAPI, AiAPI, ExportAPI } from '../renderer/src/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      project: ProjectAPI
      task: TaskAPI
      tray: TrayAPI
      calendar: CalendarAPI
      document: DocumentAPI
      variable: VariableAPI
      memo: MemoAPI
      memoCategory: MemoCategoryAPI
      report: ReportAPI
      todo: TodoAPI
      todoTag: TodoTagAPI
      ai: AiAPI
      export: ExportAPI
    }
  }
}
