import type Database from 'better-sqlite3'

// 메모 조회/상태 전이 공용 헬퍼.
// memo IPC와 AI 도구(search_memos/get_memo/update_memo/getUpdatePreview)가 공용으로 사용한다.

// memos + 카테고리명 조인 SELECT 프리픽스. memos 별칭 `m`, 카테고리 별칭 `c`를 가정한다.
// 호출부에서 WHERE/ORDER/LIMIT을 이어 붙인다 — 조인 토폴로지 한 곳 관리로 드리프트 방지.
export const MEMO_WITH_CATEGORY_SELECT = `SELECT m.id, m.content, m.is_important, m.is_archived,
                m.created_at, m.updated_at, c.name AS category
         FROM memos m LEFT JOIN memo_categories c ON c.id = m.category_id`

// 보관/보관 해제 상태 전이 SQL만 수행한다(활동 로그는 호출자가 기록).
// 메뉴(memo:archive/restore)와 AI 수정 도구가 이 한 곳을 공용으로 사용한다.
export function setMemoArchived(
  db: Database.Database,
  memoId: number | bigint,
  archived: boolean
): void {
  db.prepare("UPDATE memos SET is_archived = ?, updated_at = datetime('now') WHERE id = ?").run(
    archived ? 1 : 0,
    memoId
  )
}
