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

// ── 목록 조회·작성 (memo:list / memoCategory:list / memo:create 와 같은 SQL). 모바일 열람 서버가 쓴다 ──
// memo.ipc.ts·memo-category.ipc.ts 와 같은 SQL 이다 — 한쪽을 바꾸면 다른 쪽도 바꾼다.

export function listMemosByArchived(db: Database.Database, archived: boolean): unknown[] {
  return db
    .prepare('SELECT * FROM memos WHERE is_archived = ? ORDER BY created_at ASC')
    .all(archived ? 1 : 0)
}

export function listMemoCategories(db: Database.Database): unknown[] {
  return db.prepare('SELECT * FROM memo_categories ORDER BY sort_order ASC, name ASC').all()
}

export function memoCategoryExists(db: Database.Database, id: number): boolean {
  return db.prepare('SELECT 1 FROM memo_categories WHERE id = ?').get(id) !== undefined
}

/** memos 에 한 줄 넣는다(활동 로그는 호출자가 기록). 새 id 를 돌려준다 */
export function insertMemo(
  db: Database.Database,
  input: { content: string; color?: string; is_important?: number; category_id?: number | null }
): number {
  const result = db
    .prepare('INSERT INTO memos (content, color, is_important, category_id) VALUES (?, ?, ?, ?)')
    .run(input.content, input.color || 'default', input.is_important ?? 0, input.category_id ?? null)
  return Number(result.lastInsertRowid)
}
