// 녹음 중 박제 복구 — 렌더러가 녹음 도중 사라졌을 때(창 닫기·렌더러 크래시·앱 비정상 종료)
// DB에 status='recording'으로 남은 회의를 정리한다.
// SSOT: docs/MEETING_RECORDING.md "녹음 수명주기와 비정상 종료 복구"
//
// 녹음은 렌더러의 MediaRecorder 메모리에만 있으므로 렌더러가 죽으면 오디오도 사라진다.
// 그런데 createDraft가 기록한 'recording' 행은 그대로 남아, 목록에 영원히 '녹음 중'으로
// 보이고 녹음기는 idle이라 중지할 방법이 없다. 이 행들을 'failed'로 돌려 사용자가 지우거나
// (오디오가 있으면) 다시 처리할 수 있게 한다.
//
// 이 모듈은 DB 핸들을 인자로 받는다(getDatabase()를 부르지 않는다) — 테스트에서 실제 스키마로
// 검증할 수 있게.
import type Database from 'better-sqlite3'
import type { RecordingGuard } from './recording-guard'

type Db = Database.Database

export const ORPHAN_NO_AUDIO_ERROR =
  '녹음이 비정상 종료되어 오디오가 저장되지 않았습니다. 이 항목은 삭제해도 됩니다.'
export const ORPHAN_UNPROCESSED_ERROR =
  '녹음은 저장됐지만 처리가 완료되지 않았습니다. 다시 처리해 주세요.'

// status='recording'인 행 중 keepId(지금 실제로 녹음 중인 draft)를 뺀 나머지를 'failed'로
// 돌린다. 오디오가 저장된 행은 재처리 안내, 없는 행은 삭제 안내 메시지를 남긴다.
// 다른 status는 건드리지 않는다. 복구한 id 목록을 반환한다.
export function recoverOrphanRecordings(db: Db, keepId: number | null): number[] {
  const rows = db
    .prepare("SELECT id, audio_path FROM meetings WHERE status = 'recording'")
    .all() as { id: number; audio_path: string | null }[]
  const update = db.prepare(
    "UPDATE meetings SET status = 'failed', error = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'recording'"
  )
  const recovered: number[] = []
  for (const row of rows) {
    if (keepId !== null && row.id === keepId) continue
    const message = row.audio_path ? ORPHAN_UNPROCESSED_ERROR : ORPHAN_NO_AUDIO_ERROR
    update.run(message, row.id)
    recovered.push(row.id)
  }
  return recovered
}

// 녹음 시작 실패·취소 시 draft 행을 지운다. 오디오가 아직 없는 'recording' 행만 대상이다 —
// 저장이 끝난 녹음이나 처리된 회의가 실수로 지워지지 않게. 하위 테이블은 CASCADE로 정리된다.
export function discardDraft(db: Db, id: number): boolean {
  const result = db
    .prepare("DELETE FROM meetings WHERE id = ? AND status = 'recording' AND audio_path IS NULL")
    .run(id)
  return result.changes > 0
}

// 렌더러가 새로 로드될 때(첫 로드·새로고침) 호출한다. 새로고침은 창 'closed'나
// 'render-process-gone' 없이 이전 렌더러의 녹음기를 없애므로, 가드 상태를 비우고(대기 중인
// 저장 요청은 'renderer-gone'으로 끝난다) 남은 'recording' 행을 정리한다.
// 새 렌더러가 녹음을 시작하기 전이므로 정상 녹음을 건드리지 않는다. 복구한 id 목록을 반환한다.
export function onRendererReload(db: Db, guard: Pick<RecordingGuard, 'reset'>): number[] {
  guard.reset()
  return recoverOrphanRecordings(db, null)
}
