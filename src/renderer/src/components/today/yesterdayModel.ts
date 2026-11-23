// 지난 근무일 기간과 날짜·시각 도우미. 업무 공유 모델(shareModel)과 오늘 스토어(지난 일정 요청 범위)가 쓴다.
// React·스토어·window 를 쓰지 않는다. 시각(now)은 호출부가 넘긴다.

export interface WorkRange {
  /** 직전 평일 로컬 0시 */
  from: Date
  /** 오늘 로컬 0시 (exclusive) */
  to: Date
  /** 주말이 끼어 2일 이상이면 true */
  multiDay: boolean
  /** 하루: '11월 19일 (목)' / 여러 날: '11월 20일 (금) ~ 22일 (일)' (달이 바뀌면 뒤에도 월 표기) */
  label: string
}

/** getDay() 순 한 글자 요일 */
export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

/** '11월 19일 (목)'. withMonth 가 false 면 '19일 (목)' */
export function formatDayLabel(d: Date, withMonth = true): string {
  const day = `${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`
  return withMonth ? `${d.getMonth() + 1}월 ${day}` : day
}

/** 직전 평일(월~금) 0시 ~ 오늘 0시. 월요일이면 금~일, 일요일이면 금~토, 그 밖은 어제 하루 */
export function previousWorkRange(now: Date): WorkRange {
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  const dow = now.getDay()
  // 월요일은 3일 전(금), 일요일은 2일 전(금), 그 밖(토 포함)은 어제
  const back = dow === 1 ? 3 : dow === 0 ? 2 : 1
  const from = new Date(y, m, d - back)
  const to = new Date(y, m, d)
  const last = new Date(y, m, d - 1)
  const multiDay = back > 1
  const label = multiDay
    ? `${formatDayLabel(from)} ~ ${formatDayLabel(last, last.getMonth() !== from.getMonth() || last.getFullYear() !== from.getFullYear())}`
    : formatDayLabel(from)
  return { from, to, multiDay, label }
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/

/**
 * SQLite datetime('now','localtime') 값('YYYY-MM-DD HH:mm:ss', 로컬)을 Date 로.
 * 시간대가 붙은 ISO 도 받는다. 잘못된 값은 null
 */
export function parseLocalDateTime(s: string | null | undefined): Date | null {
  if (!s) return null
  const m = LOCAL_RE.exec(s.trim())
  if (m) {
    const [, y, mo, d, h, mi, se] = m
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se ?? 0))
  }
  return parseIso(s)
}

/** ISO → Date. 없거나 잘못된 값은 null */
export function parseIso(s: string | null | undefined): Date | null {
  if (!s) return null
  const t = new Date(s)
  return Number.isNaN(t.getTime()) ? null : t
}

/** Date → 로컬 'HH:mm' */
export function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
