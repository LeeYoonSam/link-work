import { ElectronAPI } from '@electron-toolkit/preload'
import type { CalendarAPI, TrayAPI, VariableAPI, MemoAPI, MemoCategoryAPI, ReportAPI, TodoAPI, TodoTagAPI, AiAPI, ExportAPI, ReleaseNoteAPI, JiraAPI, JiraBoardAPI, MorningSyncAPI, MeetingNotesAPI, AssistantAPI, AssistantNavigateEvent, AssistantResult } from '../renderer/src/types'

// takePendingNavigate 는 오래된 preload 에 없을 수 있다. 그래서 선택 속성으로 둔다
type AssistantBridge = AssistantAPI & {
  takePendingNavigate?: () => Promise<AssistantResult<{ pending: AssistantNavigateEvent | null }>>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      tray: TrayAPI
      calendar: CalendarAPI
      variable: VariableAPI
      memo: MemoAPI
      memoCategory: MemoCategoryAPI
      report: ReportAPI
      todo: TodoAPI
      todoTag: TodoTagAPI
      ai: AiAPI
      export: ExportAPI
      releaseNote: ReleaseNoteAPI
      jira: JiraAPI
      jiraBoard: JiraBoardAPI
      morningSync: MorningSyncAPI
      meetingNotes: MeetingNotesAPI
      assistant: AssistantBridge
    }
  }
}
