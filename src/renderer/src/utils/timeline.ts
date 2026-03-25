const KOREAN_HOLIDAYS: [number, number][] = [
  [1, 1],   // 신정
  [3, 1],   // 삼일절
  [5, 5],   // 어린이날
  [6, 6],   // 현충일
  [8, 15],  // 광복절
  [10, 3],  // 개천절
  [10, 9],  // 한글날
  [12, 25]  // 크리스마스
]

export function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 6
}

export function isKoreanHoliday(date: Date): boolean {
  const month = date.getMonth() + 1
  const day = date.getDate()
  return KOREAN_HOLIDAYS.some(([m, d]) => m === month && d === day)
}

export function filterBusinessDays(days: Date[]): Date[] {
  return days.filter((day) => !isWeekend(day) && !isKoreanHoliday(day))
}

export type DateMarkerType = 'dev_end' | 'deploy' | 'qa_start' | 'qa_end' | 'qa' | null

export function getDateMarkerType(
  date: Date,
  project: { dev_end_date: string; deploy_date: string; qa_start_date?: string; qa_end_date?: string }
): DateMarkerType {
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  if (dateStr === project.deploy_date) return 'deploy'
  if (dateStr === project.dev_end_date) return 'dev_end'
  if (project.qa_start_date && project.qa_end_date) {
    if (dateStr === project.qa_start_date) return 'qa_start'
    if (dateStr === project.qa_end_date) return 'qa_end'
    if (dateStr > project.qa_start_date && dateStr < project.qa_end_date) return 'qa'
  }
  return null
}

export function isNewWeekStart(date: Date, index: number): boolean {
  return index > 0 && date.getDay() === 1
}
