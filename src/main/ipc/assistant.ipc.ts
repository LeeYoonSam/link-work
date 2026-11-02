import { ipcMain } from 'electron'
import {
  acceptSuggestion,
  addItem,
  applyCommand,
  closeDay,
  dismissSuggestion,
  focusItem,
  generateRecovery,
  getSettings,
  getToday,
  interpretCommand,
  listCandidates,
  refreshBriefing,
  regenerateMeetingBriefing,
  reopenDay,
  respondCheckin,
  runRefresh,
  saveSettings,
  saveWrapup,
  setItemStatus,
  startDay
} from '../services/assistant-service'
import { takePendingNavigate } from '../services/assistant-scheduler'
import type { CheckinStatus, PlanItemStatus } from '../services/assistant-types'

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

  // 수동 맥락 복구. 진행 중인 job 이 있으면 그것을 기다린다 (F.2)
  ipcMain.handle('assistant:generateRecovery', () => wrap(async () => ({ today: await generateRecovery() })))

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

  // 명령 입력 (부록 G.9). 해석은 DB 를 쓰지 않는다. 적용은 사용자가 미리보기에서 확인한 조작만 받는다 (A34)
  ipcMain.handle('assistant:interpretCommand', (_e, text: unknown, scopeItemId?: unknown) =>
    wrap(async () => ({ interpretation: await interpretCommand(text, scopeItemId) }))
  )

  // { today, results, applied, failed }
  ipcMain.handle('assistant:applyCommand', (_e, ops: unknown, text: unknown) =>
    wrap(async () => await applyCommand(ops, text))
  )

  // 체크인 패널 버튼 (부록 H.9.7). 넘기기는 status null 이다. 인자 검증은 서비스가 한다
  ipcMain.handle('assistant:respondCheckin', (_e, eventId: number, status: CheckinStatus | null, note?: string) =>
    wrap(async () => ({ today: await respondCheckin(eventId, { status, note: note ?? null, raw: null }) }))
  )

  // 회의 브리핑 AI 본문 다시 만들기 (부록 I.11.10). 버튼은 결과를 기다린다. 인자 검증은 서비스가 한다
  ipcMain.handle('assistant:regenerateMeetingBriefing', (_e, eventId: number) =>
    wrap(async () => ({ today: await regenerateMeetingBriefing(eventId) }))
  )

  ipcMain.handle('assistant:getSettings', () => getSettings())

  ipcMain.handle('assistant:saveSettings', (_e, patch: unknown) => wrap(() => ({ settings: saveSettings(patch) })))

  // 렌더러 마운트 직후 1번 부른다. 구독 전에 도착한 알림 클릭 이동을 가져간다 (§12.1)
  ipcMain.handle('assistant:takePendingNavigate', () => wrap(() => ({ pending: takePendingNavigate() })))
}
