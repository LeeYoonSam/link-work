// 요약 스펙 인터페이스 — 녹음 종류(meetings.kind)별로 프롬프트/검증/저장만 갈아끼운다.
// 실행 인프라(Claude SDK 호출, 전사 직렬화, JSON 추출, 진행률 스트림)는 공통이며
// meeting-summary.ts가 담당한다.
import type Database from 'better-sqlite3'

export interface SummarySpec<T> {
  systemPrompt: string
  // contextBlock은 recognition-aids의 buildSummaryContextBlock() 결과([참고 정보] 블록).
  // 넣을 참석자·용어가 없으면 ''이므로, 각 스펙은 비어 있을 때 아무것도 붙이지 않아야 한다.
  buildPrompt: (transcript: string, contextBlock: string) => string
  // 요약 진행 중 UI에 표시할 문구
  progressMessage: string
  // JSON.parse 결과를 검증·정규화 (실패 시 throw → 호출측이 파싱 오류로 처리)
  validate: (raw: unknown) => T
  persist: (db: Database.Database, meetingId: number, parsed: T, model: string) => void
}

// AI에게 ms 정수를 직접 만들게 하면 신뢰도가 낮다. 전사록에 이미 [mm:ss]가 붙어 있으므로
// 그 표기를 그대로 돌려받아 여기서 ms로 환산한다. 회의·면접 스펙이 함께 쓴다.
// 허용: "mm:ss"(분 1~3자리, 1시간을 넘으면 분이 60을 넘는다), "h:mm:ss", 앞뒤 대괄호("[12:34]").
// 그 밖의 표기("00:75", "3분 12초")와 빈 값은 null → 재생 점프 버튼을 숨긴다.
export function parseTimestamp(at: string | null | undefined): number | null {
  if (!at) return null
  let s = at.trim()
  const bracketed = s.match(/^\[\s*(.*?)\s*\]$/)
  if (bracketed) s = bracketed[1]
  const hms = s.match(/^(\d{1,2}):([0-5]\d):([0-5]\d)$/)
  if (hms) return (Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])) * 1000
  const ms = s.match(/^(\d{1,3}):([0-5]\d)$/)
  if (ms) return (Number(ms[1]) * 60 + Number(ms[2])) * 1000
  return null
}
