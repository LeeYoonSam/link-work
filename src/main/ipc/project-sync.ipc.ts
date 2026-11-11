import { ipcMain } from 'electron'
import { applyProjectSync, previewProjectSync, refreshProjectJiraTasks } from '../services/project-sync'
import { getMorningSyncStatus } from '../services/morning-sync'

// Jira가 얽힌 채널이라 release-note.ipc.ts와 같이 throw하지 않고 { success, error }로 감싼다.
// 실패 사유(미연결·기본 프로젝트 미설정·토큰 만료)가 곧 사용자가 해야 할 조치다.
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerProjectSyncIpc(): void {
  ipcMain.handle('projectSync:preview', async () => {
    try {
      return { success: true, plan: await previewProjectSync() }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })

  // selection: ProjectSyncSelection[] — 사용자가 고른 항목만 적용한다(R9). 형식 검증은
  // applyProjectSync 안의 parseProjectSyncSelection이 한다(renderer 값은 신뢰하지 않는다).
  ipcMain.handle('projectSync:apply', async (_event, selection: unknown) => {
    try {
      return { success: true, result: await applyProjectSync(selection) }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })

  // R12: 프로젝트 하나의 Jira 연결 작업 새로고침. renderer 값은 신뢰하지 않고 여기서 검증한다.
  ipcMain.handle('projectSync:refreshTasks', async (_event, projectId: unknown, reason: unknown) => {
    if (typeof projectId !== 'number' || !Number.isInteger(projectId) || projectId <= 0) {
      return { success: false, error: '잘못된 프로젝트 id 입니다.' }
    }
    if (reason !== undefined && reason !== 'manual' && reason !== 'enter') {
      return { success: false, error: '잘못된 새로고침 사유입니다.' }
    }
    try {
      const result = await refreshProjectJiraTasks(projectId, { reason: reason ?? 'manual' })
      return { success: true, result }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })

  // 아침 자동 동기화(R11) 상태. 사이드바 배지와 상태 줄이 읽는다. 읽기 전용이다.
  ipcMain.handle('projectSync:morningStatus', async () => {
    try {
      return { success: true, status: await getMorningSyncStatus() }
    } catch (err) {
      return { success: false, error: toMessage(err) }
    }
  })
}
