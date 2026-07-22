// 요약 스펙 인터페이스 — 녹음 종류(meetings.kind)별로 프롬프트/검증/저장만 갈아끼운다.
// 실행 인프라(Claude SDK 호출, 전사 직렬화, JSON 추출, 진행률 스트림)는 공통이며
// meeting-summary.ts가 담당한다.
import type Database from 'better-sqlite3'

export interface SummarySpec<T> {
  systemPrompt: string
  buildPrompt: (transcript: string) => string
  // 요약 진행 중 UI에 표시할 문구
  progressMessage: string
  // JSON.parse 결과를 검증·정규화 (실패 시 throw → 호출측이 파싱 오류로 처리)
  validate: (raw: unknown) => T
  persist: (db: Database.Database, meetingId: number, parsed: T, model: string) => void
}
