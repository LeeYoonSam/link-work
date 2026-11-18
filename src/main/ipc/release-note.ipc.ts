import { ipcMain, shell } from 'electron'
import {
  disconnectJira,
  getJiraIssueUrl,
  getJiraStatus,
  listJiraProjects,
  saveJiraCredentials,
  setDefaultJiraProjectKey
} from '../services/jira'
import type { JiraCredentialsInput } from '../services/jira'
import {
  getReleaseNote,
  listReleaseNotes,
  syncAllReleases,
  syncReleaseNote
} from '../services/release-note-sync'
import { clearJiraBoardCache } from '../services/jira-board'

// Jira가 얽힌 채널은 throw하지 않고 { success, error }로 감싼다.
// 실패 사유(토큰 만료·권한 없음·버전 삭제됨)가 곧 사용자가 해야 할 조치라서
// renderer가 메시지를 그대로 보여줄 수 있어야 하기 때문이다.
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerReleaseNoteIpc(): void {
  // deployVersion을 주면 그 배포 버전과 이름이 같은 릴리스만 — 프로젝트 상세 화면이 쓴다.
  // 릴리스 노트는 프로젝트와 저장된 연결이 없어 이름 대조가 유일한 통로다.
  ipcMain.handle('releaseNote:list', (_event, deployVersion?: string) =>
    listReleaseNotes(deployVersion)
  )

  ipcMain.handle('releaseNote:get', (_event, id: number) => getReleaseNote(id))

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
      return { success: true, result: await syncAllReleases() }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })

  ipcMain.handle('jira:status', () => getJiraStatus())

  ipcMain.handle('jira:saveCredentials', async (_event, input: JiraCredentialsInput) => {
    // 계정·사이트가 바뀌면 이전 연결로 받은 프로젝트 보드 스냅샷은 더 이상 유효하지 않다.
    clearJiraBoardCache()
    try {
      const { accountName } = await saveJiraCredentials(input)
      // 저장을 기다리는 사이 옛 자격 증명으로 시작한 조회가 캐시를 채웠을 수 있다. 한 번 더 비운다
      clearJiraBoardCache()
      return { success: true, accountName }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })

  ipcMain.handle('jira:disconnect', () => {
    disconnectJira()
    clearJiraBoardCache()
    return { success: true }
  })

  ipcMain.handle('jira:listProjects', async () => {
    try {
      return { success: true, projects: await listJiraProjects() }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })

  ipcMain.handle('jira:setDefaultProject', (_event, projectKey: string | null) => {
    try {
      setDefaultJiraProjectKey(projectKey)
      // 프로젝트 보드는 기본 프로젝트 기준으로 받은 것이라 키가 바뀌면 버린다.
      clearJiraBoardCache()
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
