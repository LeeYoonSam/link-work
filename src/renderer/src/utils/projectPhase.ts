import { differenceInCalendarDays, format } from 'date-fns'
import { isWeekend, isKoreanHoliday } from './timeline'

// getPhaseHint가 필요로 하는 최소 필드(본 앱 Project / 트레이 위젯 데이터 모두 충족).
export interface PhaseFields {
  status: string
  dev_start_date: string
  dev_end_date: string
  qa_start_date: string
  qa_end_date: string
  deploy_date: string
}

// 'YYYY-MM-DD'를 로컬 자정 기준 Date로 파싱(요일 계산이 타임존에 흔들리지 않게).
function parseLocal(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function isBusinessDay(d: Date): boolean {
  return !isWeekend(d) && !isKoreanHoliday(d)
}

// start~end(포함) 사이의 영업일 수. 주말/공휴일은 제외(타임라인 밴드 표시와 동일 기준).
function businessDaysBetween(startStr: string, endStr: string): number {
  const start = parseLocal(startStr)
  const end = parseLocal(endStr)
  if (end < start) return 0
  let count = 0
  const cur = new Date(start)
  while (cur <= end) {
    if (isBusinessDay(cur)) count++
    cur.setDate(cur.getDate() + 1)
  }
  return count
}

// 오늘 날짜 'YYYY-MM-DD'. 로컬 시각 기준이다.
// UTC 날짜를 쓰면 한국 시간 오전 9시 전에는 어제 날짜가 된다.
export function localToday(now: Date = new Date()): string {
  return format(now, 'yyyy-MM-dd')
}

// start~end 기간에서 오늘이 몇 번째 영업일인지 센다. 오늘이 기간 밖이면 경계로 보정한다.
// current 는 1 이상 total 이하다. 기간 중 주말·공휴일이면 직전 영업일 차수다.
function businessDayOrdinal(start: string, end: string, today: string): { current: number; total: number } {
  const total = Math.max(businessDaysBetween(start, end), 1)
  const clamped = today < start ? start : today > end ? end : today
  const current = Math.min(Math.max(businessDaysBetween(start, clamped), 1), total)
  return { current, total }
}

// 개발 기간 일정 진행률. 영업일 기준이고 PhaseHint 의 'N/M일차' 와 정의가 같다.
// percent = round(N / M × 100). 오늘이 개발 기간 밖(시작 전·종료 후)이면 null 이다.
export function devScheduleProgress(
  project: Pick<PhaseFields, 'dev_start_date' | 'dev_end_date'>,
  today: string
): { current: number; total: number; percent: number } | null {
  const start = project.dev_start_date
  const end = project.dev_end_date
  if (!start || !end || today < start || today > end) return null
  const { current, total } = businessDayOrdinal(start, end, today)
  return { current, total, percent: Math.round((current / total) * 100) }
}

export type PhaseHint =
  // 진행 단계의 N/M일차(영업일 기준)
  | { kind: 'day'; text: string }
  // 다음 단계 라벨 + 그 단계까지 D-day(달력일). 렌더러가 라벨/디데이를 다른 색으로 분리해 표시.
  | { kind: 'countdown'; label: string; dday: string; daysLeft: number }

// 현재 상태 기준 보조 정보.
// - development / qa: 지정 기간 중 며칠째인지 'N/M일차' (주말/공휴일 제외한 영업일 기준)
// - qa_pending / deploy_pending / scheduled: 다음 단계까지 'D-N'
// 그 외(completed/cancelled/deploy/on_hold)는 null — 끝났거나 멈춰 있어 남은 일수가 뜻이 없다.
export function getPhaseHint(project: PhaseFields, todayStr?: string): PhaseHint | null {
  const today = todayStr ?? localToday()

  const dayHint = (start: string, end: string): PhaseHint => {
    const { current, total } = businessDayOrdinal(start, end, today)
    return { kind: 'day', text: `${current}/${total}일차` }
  }

  const ddayHint = (target: string, label: string): PhaseHint => {
    const daysLeft = differenceInCalendarDays(parseLocal(target), parseLocal(today))
    const d = Math.max(daysLeft, 0)
    return { kind: 'countdown', label, dday: d === 0 ? 'D-Day' : `D-${d}`, daysLeft }
  }

  switch (project.status) {
    case 'development':
      return dayHint(project.dev_start_date, project.dev_end_date)
    case 'qa':
      return dayHint(project.qa_start_date, project.qa_end_date)
    case 'qa_pending':
      return ddayHint(project.qa_start_date, 'QA')
    case 'deploy_pending':
      return ddayHint(project.deploy_date, '배포')
    case 'scheduled':
      return ddayHint(project.dev_start_date, '시작')
    default:
      return null
  }
}
