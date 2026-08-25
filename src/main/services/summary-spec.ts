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
