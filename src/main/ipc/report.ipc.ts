import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'

interface ActivityLogRow {
  id: number
  entity_type: string
  entity_id: number | null
  entity_name: string | null
  action: string
  details: string | null
  created_at: string
}

interface WeeklySummary {
  entity_type: string
  action: string
  count: number
}

export function registerReportIpc(): void {
  const db = getDatabase()

  // 특정 주의 활동 로그 조회
  ipcMain.handle('report:weeklyActivities', (_event, weekStart: string, weekEnd: string) => {
    return db
      .prepare(
        'SELECT * FROM activity_log WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC'
      )
      .all(weekStart, weekEnd + 'T23:59:59') as ActivityLogRow[]
  })

  // 특정 주의 요약 통계
  ipcMain.handle('report:weeklySummary', (_event, weekStart: string, weekEnd: string) => {
    return db
      .prepare(
        `SELECT entity_type, action, COUNT(*) as count
         FROM activity_log
         WHERE created_at >= ? AND created_at < ?
         GROUP BY entity_type, action
         ORDER BY count DESC`
      )
      .all(weekStart, weekEnd + 'T23:59:59') as WeeklySummary[]
  })

  // 일별 활동 수 (차트용)
  ipcMain.handle('report:dailyStats', (_event, weekStart: string, weekEnd: string) => {
    return db
      .prepare(
        `SELECT DATE(created_at) as date, entity_type, COUNT(*) as count
         FROM activity_log
         WHERE created_at >= ? AND created_at < ?
         GROUP BY DATE(created_at), entity_type
         ORDER BY date ASC`
      )
      .all(weekStart, weekEnd + 'T23:59:59') as { date: string; entity_type: string; count: number }[]
  })

  // 최근 N주 트렌드 (주간 비교 차트용)
  ipcMain.handle('report:weeklyTrend', (_event, weeks: number) => {
    return db
      .prepare(
        `SELECT
           strftime('%Y-W%W', created_at) as week,
           entity_type,
           COUNT(*) as count
         FROM activity_log
         WHERE created_at >= date('now', ? || ' days')
         GROUP BY week, entity_type
         ORDER BY week ASC`
      )
      .all(-weeks * 7) as { week: string; entity_type: string; count: number }[]
  })
}
