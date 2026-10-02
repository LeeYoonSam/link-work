import { ipcMain } from 'electron'
import { applyProjectSync, previewProjectSync } from '../services/project-sync'

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
}
