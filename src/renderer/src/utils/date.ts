import { format } from 'date-fns'

// 파싱 불가능한 날짜 문자열(예: AI가 생성한 "다음 주")이 저장돼 있어도
// format()의 RangeError로 화면 전체가 죽지 않도록 원문을 그대로 표시한다.
export function formatDateSafe(value: string, fmt: string): string {
  const d = new Date(value)
  if (isNaN(d.getTime())) return value
  return format(d, fmt)
}
