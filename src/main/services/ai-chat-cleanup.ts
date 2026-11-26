// 빈 대화 정리
// [새 채팅]으로 만든 뒤 메시지 없이 떠난 대화는 목록에 남기지 않는다.
// - discardChatIfEmpty: 화면을 떠날 때 렌더러가 부른다(ai:chatDiscardIfEmpty). 메시지가 0개이고
//   응답 생성·전송이 진행 중이 아닐 때만 지운다. 메시지 유무 확인과 삭제는 한 문장으로 처리해
//   그 사이에 메시지가 들어와도 지우지 않는다.
// - purgeEmptyChats: 앱 시작 시 한 번 부른다. 시작 시점에는 진행 중인 응답이 없다.
// ai_messages 는 ON DELETE CASCADE, ai_audit_log.chat_id 는 외래 키가 없어 ai:chatDelete 와 같이 행만 지운다.
import type Database from 'better-sqlite3'

export function isValidChatId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0
}

/** 메시지가 없는 대화면 지운다. 지웠으면 true. isBusy(id) 가 true 면 지우지 않는다. */
export function discardChatIfEmpty(
  db: Database.Database,
  id: unknown,
  isBusy: (id: number) => boolean
): boolean {
  if (!isValidChatId(id)) return false
  if (isBusy(id)) return false
  const result = db
    .prepare(
      'DELETE FROM ai_chats WHERE id = ? AND NOT EXISTS (SELECT 1 FROM ai_messages WHERE chat_id = ?)'
    )
    .run(id, id)
  return Number(result.changes) > 0
}

/** 메시지가 없는 대화를 모두 지우고 지운 id 목록을 돌려준다. 진행 중인 응답이 없는 앱 시작 시에만 부른다. */
export function purgeEmptyChats(db: Database.Database): number[] {
  const rows = db
    .prepare(
      'DELETE FROM ai_chats WHERE NOT EXISTS (SELECT 1 FROM ai_messages m WHERE m.chat_id = ai_chats.id) RETURNING id'
    )
    .all() as { id: number }[]
  return rows.map((r) => Number(r.id))
}
