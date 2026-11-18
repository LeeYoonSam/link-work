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
  clearReleaseSyncCheckpoint,
  getReleaseNote,
  listReleaseNotes,
  syncAllReleases,
  syncReleaseChanges,
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

  // 변경분 동기화. 화면 진입(force=false, 10분 이내면 생략)과 새로고침 버튼(force=true)이 부른다.
  // renderer 값은 신뢰하지 않는다 — true 일 때만 강제한다.
  ipcMain.handle('releaseNote:syncChanges', async (_event, force: unknown) => {
    try {
      return { success: true, result: await syncReleaseChanges({ force: force === true }) }
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
    try {
      const { accountName } = await saveJiraCredentials(input)
      // 계정·사이트가 바뀌면 볼 수 있는 이슈가 다르다. 프로젝트 보드 저장본을 모두 지운다.
      // 저장 성공 뒤에만 지운다 — 실패하면 기존 자격 증명이 그대로라 저장본도 유효하다.
      // 저장을 기다리는 사이 시작된 동기화는 비우기의 세대 가드로 저장하지 못한다.
      clearJiraBoardCache()
      // 릴리스 변경분 기준도 다른 계정 기준이 된다. 다음 번은 전체 동기화로 넘어간다
      clearReleaseSyncCheckpoint()
      return { success: true, accountName }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })

  ipcMain.handle('jira:disconnect', () => {
    disconnectJira()
    // 다른 계정으로 다시 연결할 수 있다. 이전 계정의 보드 저장본·릴리스 변경분 기준을 남기지 않는다
    clearJiraBoardCache()
    clearReleaseSyncCheckpoint()
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
      // 프로젝트 보드 저장본은 프로젝트 키로 나뉘어 있어 지우지 않는다(같은 계정의 데이터다)
      setDefaultJiraProjectKey(projectKey)
      // 릴리스 변경분 기준은 프로젝트 하나에 대한 값이다. 다음 번은 전체 동기화로 넘어간다
      clearReleaseSyncCheckpoint()
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
