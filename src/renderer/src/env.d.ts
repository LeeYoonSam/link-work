/// <reference types="vite/client" />
/// <reference types="react" />

import type { ProjectAPI, TaskAPI, CalendarAPI, TrayAPI, DocumentAPI, VariableAPI, MemoAPI, MemoCategoryAPI, ReportAPI, TodoAPI, TodoTagAPI, AiAPI, RecordingAPI, RecorderBridgeAPI, RecognitionAidsAPI, ExportAPI, ReleaseNoteAPI, JiraAPI, BackupAPI, ProjectSyncAPI, MeetingNotesAPI, AssistantAPI, AssistantNavigateEvent, AssistantResult } from './types'

// takePendingNavigate 는 오래된 preload 에 없을 수 있다. 그래서 선택 속성으로 둔다
type AssistantBridge = AssistantAPI & {
  takePendingNavigate?: () => Promise<AssistantResult<{ pending: AssistantNavigateEvent | null }>>
}

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
      recorder: RecorderBridgeAPI
      recognitionAids: RecognitionAidsAPI
      export: ExportAPI
      releaseNote: ReleaseNoteAPI
      jira: JiraAPI
      backup: BackupAPI
      projectSync: ProjectSyncAPI
      meetingNotes: MeetingNotesAPI
      assistant: AssistantBridge
    }
  }
}
