import { getDatabase } from '../db/database'

// AI 대화 가드레일 감사 로그.
// 쿼리 라이프사이클(시작/완료/오류/취소), 도구 호출/오류, 화이트리스트 외 도구
// 사용 시도(거부)를 ai_audit_log 테이블에 기록해 사후 추적을 가능하게 한다.
export type AiAuditEvent =
  | 'query_start'
  | 'query_done'
  | 'query_error'
  | 'query_cancelled'
  | 'tool_call'
  | 'tool_error'
  | 'tool_denied'
  | 'approval_request'
  | 'write_approved'
  | 'write_rejected'
  | 'write_executed'
  | 'write_toggle'
  | 'fetch_approved'
  | 'fetch_rejected'

interface AiAuditEntry {
  chatId?: number | null
  event: AiAuditEvent
  toolName?: string
  input?: unknown
  detail?: string
  durationMs?: number
}

const MAX_FIELD_LENGTH = 2000

export function logAiAudit(entry: AiAuditEntry): void {
  try {
    const db = getDatabase()
    const input =
      entry.input === undefined || entry.input === null
        ? null
        : JSON.stringify(entry.input).slice(0, MAX_FIELD_LENGTH)
    db.prepare(
      `INSERT INTO ai_audit_log (chat_id, event, tool_name, input, detail, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      entry.chatId ?? null,
      entry.event,
      entry.toolName ?? null,
      input,
      entry.detail ? entry.detail.slice(0, MAX_FIELD_LENGTH) : null,
      entry.durationMs ?? null
    )
  } catch (err) {
    // 감사 로그 실패가 기능 자체를 막아서는 안 됨 — 콘솔로만 보고
    console.error('AI audit log failed:', err)
  }
}
