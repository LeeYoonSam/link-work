import { ipcMain, shell } from 'electron'
import {
  disconnectJira,
  getJiraIssueUrl,
  getJiraStatus,
  listJiraProjects,
  listJiraVersions,
  saveJiraCredentials,
  setDefaultJiraProjectKey
} from '../services/jira'
import type { JiraCredentialsInput, JiraVersionSummary } from '../services/jira'
import {
  getReleaseNote,
  linkReleaseNote,
  listReleaseNotes,
  syncAllByDeployVersion,
  syncReleaseNote,
  unlinkReleaseNote
} from '../services/release-note-sync'

// Jira가 얽힌 채널은 throw하지 않고 { success, error }로 감싼다.
// 실패 사유(토큰 만료·권한 없음·버전 삭제됨)가 곧 사용자가 해야 할 조치라서
// renderer가 메시지를 그대로 보여줄 수 있어야 하기 때문이다.
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerReleaseNoteIpc(): void {
  ipcMain.handle('releaseNote:list', (_event, projectId?: number) => listReleaseNotes(projectId))

  ipcMain.handle('releaseNote:get', (_event, id: number) => getReleaseNote(id))

  ipcMain.handle(
    'releaseNote:link',
    (_event, projectId: number, jiraProjectKey: string, version: JiraVersionSummary) => {
      try {
        const { id } = linkReleaseNote(projectId, jiraProjectKey, version)
        return { success: true, id }
      } catch (err) {
        return { success: false, error: toMessage(err) }
      }
    }
  )

  ipcMain.handle('releaseNote:unlink', (_event, id: number) => {
    unlinkReleaseNote(id)
    return { success: true }
  })

  ipcMain.handle('releaseNote:sync', async (_event, id: number) => {
    try {
      const { itemCount, truncated } = await syncReleaseNote(id)
      // itemCount 0은 성공이다 — renderer가 실패와 구분해 표시한다.
      return { success: true, itemCount, truncated }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })

  ipcMain.handle('releaseNote:syncAll', async () => {
    try {
      return { success: true, result: await syncAllByDeployVersion() }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })

  ipcMain.handle('jira:status', () => getJiraStatus())

  ipcMain.handle('jira:saveCredentials', async (_event, input: JiraCredentialsInput) => {
    try {
      const { accountName } = await saveJiraCredentials(input)
      return { success: true, accountName }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })

  ipcMain.handle('jira:disconnect', () => {
    disconnectJira()
    return { success: true }
  })

  ipcMain.handle('jira:listProjects', async () => {
    try {
      return { success: true, projects: await listJiraProjects() }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })

  ipcMain.handle('jira:listVersions', async (_event, projectKey: string) => {
    try {
      return { success: true, versions: await listJiraVersions(projectKey) }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })

  // 키 형식 검증은 setDefaultJiraProjectKey가 하고, 여기서는 그 오류를 문구로 넘긴다.
  ipcMain.handle('jira:setDefaultProject', (_event, projectKey: string | null) => {
    try {
      setDefaultJiraProjectKey(projectKey)
      return { success: true }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })

  ipcMain.handle('jira:openIssue', async (_event, issueKey: string) => {
    // 미연결이면 사이트 URL을 모르므로 열 수 없다.
    const url = getJiraIssueUrl(issueKey)
    if (!url) return { success: false }
    try {
      await shell.openExternal(url)
      return { success: true }
    } catch (err) {
      console.error('[release-note.ipc] openIssue', err)
      return { success: false }
    }
  })
}
