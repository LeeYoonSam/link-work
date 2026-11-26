/**
 * 발언 화자 교정. 한 발언만(one), 이 발언부터 같은 화자의 뒤 발언(forward), 같은 화자의 모든
 * 발언(all) 세 범위로 화자를 바꾼다. all이면서 두 화자가 모두 있으면 화자 병합으로 처리한다.
 */
import { mergeSpeakerVoices, speakersBelongToMeeting } from './voiceprint'

type Db = import('better-sqlite3').Database

export type ReassignScope = 'one' | 'forward' | 'all'

export function isReassignScope(v: unknown): v is ReassignScope {
  return v === 'one' || v === 'forward' || v === 'all'
}

export interface ScopeSegment {
  id: number
  start_ms: number
  sort_order: number
  speaker_id: number | null
}

function compareSegments(a: ScopeSegment, b: ScopeSegment): number {
  return a.start_ms - b.start_ms || a.sort_order - b.sort_order || a.id - b.id
}

/** 범위에 들어가는 세그먼트 id를 (start_ms, sort_order, id) 순으로 돌려준다. 기준이 없으면 []. */
export function planReassign(segments: ScopeSegment[], segmentId: number, scope: ReassignScope): number[] {
  const sorted = [...segments].sort(compareSegments)
  const index = sorted.findIndex((s) => s.id === segmentId)
  if (index < 0) return []
  if (scope === 'one') return [segmentId]
  const speaker = sorted[index].speaker_id
  const from = scope === 'forward' ? index : 0
  return sorted
    .slice(from)
    .filter((s) => s.speaker_id === speaker)
    .map((s) => s.id)
}

/** 같은 회의의 두 화자를 합친다(목소리 가중 평균 → 발언 이동 → from 화자 삭제). */
export function mergeSpeakersInMeeting(
  db: Db,
  meetingId: number,
  fromSpeakerId: number,
  intoSpeakerId: number
): { success: boolean; error?: string } {
  if (!speakersBelongToMeeting(db, meetingId, [fromSpeakerId, intoSpeakerId])) {
    return { success: false, error: '같은 회의의 서로 다른 화자만 합칠 수 있습니다.' }
  }
  const tx = db.transaction(() => {
    // 두 centroid를 speech_ms 가중 평균해 into에 둔다(from의 표본은 지운다).
    mergeSpeakerVoices(db, meetingId, fromSpeakerId, intoSpeakerId)
    db.prepare(
      'UPDATE meeting_segments SET speaker_id = ?, speaker_corrected = 1 WHERE meeting_id = ? AND speaker_id = ?'
    ).run(intoSpeakerId, meetingId, fromSpeakerId)
    db.prepare('DELETE FROM meeting_speakers WHERE id = ? AND meeting_id = ?').run(fromSpeakerId, meetingId)
  })
  tx()
  return { success: true }
}

export function reassignSegments(
  db: Db,
  input: { segmentId: number; speakerId: number | null; scope?: ReassignScope }
): { success: boolean; changed: number; merged: boolean; error?: string } {
  const scope: ReassignScope = isReassignScope(input?.scope) ? input.scope : 'one'
  const target = input?.speakerId ?? null
  const base = db
    .prepare('SELECT id, meeting_id, speaker_id FROM meeting_segments WHERE id = ?')
    .get(input?.segmentId) as { id: number; meeting_id: number; speaker_id: number | null } | undefined
  if (!base) return { success: false, changed: 0, merged: false, error: '존재하지 않는 발언입니다.' }
  const meetingId = base.meeting_id

  if (target !== null && !speakersBelongToMeeting(db, meetingId, [target])) {
    return { success: false, changed: 0, merged: false, error: '같은 회의의 화자만 지정할 수 있습니다.' }
  }
  const current = base.speaker_id ?? null
  if (current === target) return { success: true, changed: 0, merged: false }

  if (scope === 'all' && current !== null && target !== null) {
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM meeting_segments WHERE meeting_id = ? AND speaker_id = ?')
      .get(meetingId, current) as { n: number }
    const merged = mergeSpeakersInMeeting(db, meetingId, current, target)
    if (!merged.success) return { success: false, changed: 0, merged: false, error: merged.error }
    return { success: true, changed: n, merged: true }
  }

  const segments = db
    .prepare('SELECT id, start_ms, sort_order, speaker_id FROM meeting_segments WHERE meeting_id = ?')
    .all(meetingId) as ScopeSegment[]
  const ids = planReassign(segments, base.id, scope)
  const update = db.prepare('UPDATE meeting_segments SET speaker_id = ?, speaker_corrected = 1 WHERE id = ?')
  db.transaction(() => {
    for (const id of ids) update.run(target, id)
  })()
  return { success: true, changed: ids.length, merged: false }
}
