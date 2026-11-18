import { ipcMain } from 'electron'
import { fetchJiraBoard, summarizeJiraEpic } from '../services/jira-board'

// Jira가 얽힌 채널이라 throw하지 않고 { success, error }로 감싼다(서비스가 감싼다).
// renderer 값은 신뢰하지 않는다. force는 true일 때만 켜고, 이슈 키는 서비스가 정규식으로 검증한다.
export function registerJiraBoardIpc(): void {
  ipcMain.handle('jiraBoard:fetch', (_event, force: unknown) => fetchJiraBoard(force === true))

  // 사용자가 버튼을 눌렀을 때만 부른다. 자동 생성하지 않는다
  ipcMain.handle('jiraBoard:summarizeEpic', (_event, epicKey: unknown) => summarizeJiraEpic(epicKey))
}
