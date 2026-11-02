import { ipcMain } from 'electron'
import {
  acceptSuggestion,
  addItem,
  closeDay,
  dismissSuggestion,
  focusItem,
  getSettings,
  getToday,
  listCandidates,
  refreshBriefing,
  reopenDay,
  runRefresh,
  saveSettings,
  saveWrapup,
  setItemStatus,
  startDay
} from '../services/assistant-service'
import type { PlanItemStatus } from '../services/assistant-types'

// project-sync.ipc.ts 처럼 throw 하지 않고 { success, error } 로 감싼다.
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

export function registerAssistantIpc(): void {
  ipcMain.handle('assistant:getToday', () => wrap(async () => ({ today: await getToday() })))

  ipcMain.handle('assistant:startDay', () => wrap(async () => ({ today: await startDay() })))

  ipcMain.handle('assistant:closeDay', (_e, note?: unknown) =>
    wrap(async () => ({ today: await closeDay(typeof note === 'string' ? note : null) }))
  )

  ipcMain.handle('assistant:reopenDay', () => wrap(async () => ({ today: await reopenDay() })))

  ipcMain.handle('assistant:saveWrapup', (_e, note: string, date: string) =>
    wrap(async () => ({ plan: await saveWrapup(note, date) }))
  )

  // 근무 중이 아니면 최신화할 계획이 없다. 이때는 현재 상태를 돌려준다
  ipcMain.handle('assistant:refresh', () =>
    wrap(async () => ({ today: (await runRefresh('full')) ?? (await getToday()) }))
  )

  ipcMain.handle('assistant:refreshBriefing', () => wrap(async () => ({ today: await refreshBriefing() })))

  ipcMain.handle('assistant:listCandidates', () => wrap(async () => ({ candidates: await listCandidates() })))

  ipcMain.handle('assistant:addItem', (_e, candidateId: string) =>
    wrap(async () => ({ today: await addItem(candidateId) }))
  )

  ipcMain.handle('assistant:acceptSuggestion', (_e, itemId: number) =>
    wrap(async () => ({ today: await acceptSuggestion(itemId) }))
  )

  ipcMain.handle('assistant:dismissSuggestion', (_e, itemId: number) =>
    wrap(async () => ({ today: await dismissSuggestion(itemId) }))
  )

  ipcMain.handle('assistant:setItemStatus', (_e, itemId: number, status: PlanItemStatus, note?: string) =>
    wrap(async () => ({ today: await setItemStatus(itemId, status, note ?? null) }))
  )

  ipcMain.handle('assistant:focusItem', (_e, itemId: number) =>
    wrap(async () => ({ today: await focusItem(itemId) }))
  )

  ipcMain.handle('assistant:getSettings', () => getSettings())

  ipcMain.handle('assistant:saveSettings', (_e, patch: unknown) => wrap(() => ({ settings: saveSettings(patch) })))
}
