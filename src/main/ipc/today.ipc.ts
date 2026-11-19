import { ipcMain } from 'electron'
import { getTodayBriefing } from '../services/today-briefing'

export function registerTodayIpc(): void {
  // 오늘 대시보드 브리핑. 입력 형식 오류·예기치 못한 실패는 Fail 로 돌려준다.
  ipcMain.handle('today:getBriefing', async (_event, input: unknown, force?: unknown) => {
    try {
      const r = await getTodayBriefing(input, force === true)
      // retryAfterMs: 10분 제한에 걸렸을 때만 있다. 렌더러는 그 시간 뒤 같은 입력으로 다시 요청한다
      return r.retryAfterMs !== undefined
        ? { success: true, briefing: r.briefing, retryAfterMs: r.retryAfterMs }
        : { success: true, briefing: r.briefing }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
