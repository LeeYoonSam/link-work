/**
 * 회의 메모·북마크(meeting_marks). text=''이면 북마크다.
 * raw_ms는 녹음 경과 시간(일시정지 제외)으로 한 번 정해지면 바뀌지 않고, at_ms는 현재 오디오
 * 시간축의 위치다. 녹음 중 메모('live')는 무음 컷편집 뒤 remapLiveMarks가 at_ms를 다시 계산한다.
 * 재생 중 붙인 메모('post')는 이미 현재 시간축 기준이라 재매핑하지 않는다.
 */
type Db = import('better-sqlite3').Database

export type MarkOrigin = 'live' | 'post'

export interface MeetingMarkRow {
  id: number
  meeting_id: number
  raw_ms: number
  at_ms: number
  text: string
  origin: MarkOrigin
  created_at: string
  updated_at: string
}

export const MARK_TEXT_MAX = 500

function normalizeText(text: unknown): string {
  return (typeof text === 'string' ? text : '').trim().slice(0, MARK_TEXT_MAX)
}

export function listMarks(db: Db, meetingId: number): MeetingMarkRow[] {
  return db
    .prepare('SELECT * FROM meeting_marks WHERE meeting_id = ? ORDER BY at_ms, id')
    .all(meetingId) as MeetingMarkRow[]
}

export function addMark(
  db: Db,
  input: { meetingId: number; raw_ms: number; text?: string; origin?: MarkOrigin }
): { id: number } {
  const meeting = db.prepare('SELECT id FROM meetings WHERE id = ?').get(input?.meetingId)
  if (!meeting) throw new Error('존재하지 않는 회의입니다.')
  const raw = typeof input.raw_ms === 'number' && Number.isFinite(input.raw_ms) ? input.raw_ms : 0
  const rawMs = Math.max(0, Math.round(raw))
  const text = normalizeText(input.text)
  const origin: MarkOrigin = input.origin === 'post' ? 'post' : 'live'
  const result = db
    .prepare('INSERT INTO meeting_marks (meeting_id, raw_ms, at_ms, text, origin) VALUES (?, ?, ?, ?, ?)')
    .run(input.meetingId, rawMs, rawMs, text, origin)
  return { id: Number(result.lastInsertRowid) }
}

export function updateMark(db: Db, input: { id: number; text: string }): { success: boolean } {
  const result = db
    .prepare("UPDATE meeting_marks SET text = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(normalizeText(input?.text), input?.id)
  return { success: result.changes > 0 }
}

export function deleteMark(db: Db, id: number): { success: boolean } {
  const result = db.prepare('DELETE FROM meeting_marks WHERE id = ?').run(id)
  return { success: result.changes > 0 }
}

/**
 * 'live' 메모의 at_ms를 map(raw_ms)로 다시 계산한다. raw_ms 기준이라 여러 번 돌려도 결과가 같다.
 * 'post' 메모는 건드리지 않는다. 값이 실제로 바뀐 메모 수를 돌려준다.
 */
export function remapLiveMarks(db: Db, meetingId: number, map: (ms: number) => number): number {
  const rows = db
    .prepare("SELECT id, raw_ms, at_ms FROM meeting_marks WHERE meeting_id = ? AND origin = 'live'")
    .all(meetingId) as Array<{ id: number; raw_ms: number; at_ms: number }>
  const update = db.prepare('UPDATE meeting_marks SET at_ms = ? WHERE id = ?')
  let changed = 0
  const tx = db.transaction(() => {
    for (const r of rows) {
      const next = Math.max(0, Math.round(map(r.raw_ms)))
      if (!Number.isFinite(next) || next === r.at_ms) continue
      update.run(next, r.id)
      changed++
    }
  })
  tx()
  return changed
}
