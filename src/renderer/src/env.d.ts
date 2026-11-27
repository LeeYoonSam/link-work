/// <reference types="vite/client" />
/// <reference types="react" />

import type { CalendarAPI, TrayAPI, VariableAPI, MemoAPI, MemoCategoryAPI, TodoAPI, TodoTagAPI, AiAPI, RecordingAPI, RecorderBridgeAPI, RecognitionAidsAPI, ExportAPI, ReleaseNoteAPI, JiraAPI, BackupAPI, JiraBoardAPI, MorningSyncAPI, MeetingNotesAPI, AssistantAPI, AssistantNavigateEvent, AssistantResult, SettingsAPI, MobileAPI, InboxAPI } from './types'

// takePendingNavigate 는 오래된 preload 에 없을 수 있다. 그래서 선택 속성으로 둔다
type AssistantBridge = AssistantAPI & {
  takePendingNavigate?: () => Promise<AssistantResult<{ pending: AssistantNavigateEvent | null }>>
}

declare global {
  interface Window {
    api: {
      tray: TrayAPI
      calendar: CalendarAPI
      variable: VariableAPI
      memo: MemoAPI
      memoCategory: MemoCategoryAPI
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
      jiraBoard: JiraBoardAPI
      morningSync: MorningSyncAPI
      meetingNotes: MeetingNotesAPI
      assistant: AssistantBridge
      settings: SettingsAPI
      mobile: MobileAPI
      inbox: InboxAPI
    }
  }
}
