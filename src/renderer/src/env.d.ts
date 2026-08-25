/// <reference types="vite/client" />
/// <reference types="react" />

import type { ProjectAPI, TaskAPI, CalendarAPI, TrayAPI, DocumentAPI, VariableAPI, MemoAPI, MemoCategoryAPI, ReportAPI, TodoAPI, TodoTagAPI, AiAPI, RecordingAPI, RecognitionAidsAPI, ExportAPI, ReleaseNoteAPI, JiraAPI } from './types'

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
      memoCategory: MemoCategoryAPI
      report: ReportAPI
      todo: TodoAPI
      todoTag: TodoTagAPI
      ai: AiAPI
      recording: RecordingAPI
      recognitionAids: RecognitionAidsAPI
      export: ExportAPI
      releaseNote: ReleaseNoteAPI
      jira: JiraAPI
    }
  }
}
