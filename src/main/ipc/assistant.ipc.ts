import { ipcMain } from 'electron'
import { getSettings, getToday, regenerateMeetingBriefing, saveSettings } from '../services/assistant-service'
import { takePendingNavigate } from '../services/assistant-scheduler'

// release-note.ipc.ts 처럼 throw 하지 않고 { success, error } 로 감싼다.
// 이유: Jira·캘린더 조회가 실패할 수 있고, 실패 사유가 곧 사용자 조치다. getSettings 만 예외다.
// 인자 형식 검증은 서비스가 한다. 렌더러 값은 신뢰하지 않는다.
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type Ok<T> = { success: true } & T
type Fail = { success: false; error: string }

async function wrap<T extends object>(fn: () => Promise<T> | T): Promise<Ok<T> | Fail> {
  try {
    return { success: true, ...(await fn()) }
  } catch (err) {
    return { success: false, error: toMessage(err) }
  }
}

// 채널 계약은 docs/ASSISTANT.md §12 다
export function registerAssistantIpc(): void {
  ipcMain.handle('assistant:getToday', () => wrap(async () => ({ today: await getToday() })))

  // 회의 브리핑 AI 본문 다시 만들기 (docs/ASSISTANT.md §7.7). 버튼은 결과를 기다린다. 인자 검증은 서비스가 한다
  ipcMain.handle('assistant:regenerateMeetingBriefing', (_e, eventId: number) =>
    wrap(async () => ({ today: await regenerateMeetingBriefing(eventId) }))
  )

  ipcMain.handle('assistant:getSettings', () => getSettings())

  ipcMain.handle('assistant:saveSettings', (_e, patch: unknown) => wrap(() => ({ settings: saveSettings(patch) })))

  // 렌더러 마운트 직후 1번 부른다. 구독 전에 도착한 알림 클릭 이동을 가져간다 (docs/ASSISTANT.md §6.3)
  ipcMain.handle('assistant:takePendingNavigate', () => wrap(() => ({ pending: takePendingNavigate() })))
}
