import { format } from 'date-fns'

// 파싱 불가능한 날짜 문자열(예: AI가 생성한 "다음 주")이 저장돼 있어도
// format()의 RangeError로 화면 전체가 죽지 않도록 원문을 그대로 표시한다.
// 로컬 시각으로 저장한 값(할 일 마감 등)에 쓴다. UTC로 저장한 DB 시각은 formatUtcDbTime 을 쓴다
export function formatDateSafe(value: string, fmt: string): string {
  const d = new Date(value)
  if (isNaN(d.getTime())) return value
  return format(d, fmt)
}

// 오프셋 없는 'YYYY-MM-DD HH:MM[:SS[.fff]]' (SQLite datetime('now') 기본값). 'T' 구분도 받는다
const UTC_DB_TIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/

// datetime('now') 로 저장한 DB 시각을 읽는다. 그 값은 오프셋 없는 UTC 다.
// new Date('2026-11-02 09:15:00') 은 로컬 시각으로 읽혀 한국에서 9시간 이르게 보인다.
// Z·오프셋이 붙은 값은 그대로 읽는다. 날짜만 있는 값('YYYY-MM-DD')은 바꾸지 않는다(기존 해석 유지).
// 규칙은 components/memo/memoText.ts 의 parseDbTime 과 같다
export function parseUtcDbTime(value: string | null | undefined): Date {
  if (!value) return new Date(NaN)
  const s = value.trim()
  const m = UTC_DB_TIME_RE.exec(s)
  if (m) return new Date(`${m[1]}T${m[2]}Z`)
  return new Date(s)
}

// UTC 로 저장한 DB 시각을 로컬 시각으로 포맷한다. 해석할 수 없으면 원문을 돌려준다
export function formatUtcDbTime(value: string, fmt: string): string {
  const d = parseUtcDbTime(value)
  if (isNaN(d.getTime())) return value
  return format(d, fmt)
}
