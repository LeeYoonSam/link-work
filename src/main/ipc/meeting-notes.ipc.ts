import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'
import { listAttendees } from '../services/recognition-aids'
import {
  buildMeetingNoteMarkdown,
  countActionItems,
  escapeLike,
  parseJsonArray,
  type NoteDetail,
  type NoteSummary
} from '../services/meeting-notes'

// 회의록 — 요약 완료(status='summarized')된 회의를 목록·검색·Markdown으로 제공한다.
// 새 테이블 없이 meetings + meeting_summaries 조인만 쓴다. (docs/MEETING_NOTES.md)

interface MeetingNoteFilter {
  q?: string
  kind?: 'all' | 'meeting' | 'interview'
  projectId?: number | null
}

interface ListRow {
  id: number
  title: string
  kind: 'meeting' | 'interview'
  started_at: string
  duration_ms: number
  project_id: number | null
  project_name: string | null
  tldr: string | null
  key_points: string | null
  decisions: string | null
  action_items: string | null
  generated_at: string
}

const SEARCH_COLUMNS = [
  'm.title',
  's.tldr',
  's.key_points',
  's.decisions',
  's.action_items',
  's.next_steps',
  's.qa_pairs'
]

type Db = ReturnType<typeof getDatabase>

export function listMeetingNotes(db: Db, filter?: MeetingNoteFilter) {
  const where = ["m.status = 'summarized'"]
  const params: unknown[] = []

  const q = (filter?.q ?? '').trim()
  if (q) {
    const pattern = `%${escapeLike(q)}%`
    const ors = SEARCH_COLUMNS.map((c) => `${c} LIKE ? ESCAPE '\\'`)
    ors.push(
      `EXISTS (SELECT 1 FROM meeting_segments g WHERE g.meeting_id = m.id AND g.text LIKE ? ESCAPE '\\')`
    )
    where.push(`(${ors.join(' OR ')})`)
    for (let i = 0; i < ors.length; i++) params.push(pattern)
  }
  if (filter?.kind === 'meeting' || filter?.kind === 'interview') {
    where.push('m.kind = ?')
    params.push(filter.kind)
  }
  if (filter?.projectId === null) {
    where.push('m.project_id IS NULL')
  } else if (typeof filter?.projectId === 'number') {
    where.push('m.project_id = ?')
    params.push(filter.projectId)
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.title, m.kind, m.started_at, m.duration_ms, m.project_id,
              p.name AS project_name, s.tldr, s.key_points, s.decisions, s.action_items,
              s.generated_at
         FROM meetings m
         JOIN meeting_summaries s ON s.meeting_id = m.id
         LEFT JOIN projects p ON p.id = m.project_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.started_at DESC, m.id DESC`
    )
    .all(...params) as ListRow[]

  return rows.map((r) => {
    const actions = countActionItems(r.action_items)
    return {
      id: r.id,
      title: r.title,
      kind: r.kind,
      started_at: r.started_at,
      duration_ms: r.duration_ms,
      project_id: r.project_id,
      project_name: r.project_name,
      tldr: r.tldr,
      key_point_count: parseJsonArray(r.key_points).length,
      decision_count: parseJsonArray(r.decisions).length,
      action_item_count: actions.total,
      open_action_count: actions.open,
      attendee_names: listAttendees(db, r.id).map((a) => a.name),
      generated_at: r.generated_at
    }
  })
}

export function meetingNoteMarkdown(db: Db, id: number): string {
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as
    | (NoteDetail['meeting'] & { project_id: number | null })
    | undefined
  if (!meeting) return ''
  const speakers = db
    .prepare('SELECT * FROM meeting_speakers WHERE meeting_id = ? ORDER BY sort_order, id')
    .all(id) as NoteDetail['speakers']
  const segments = db
    .prepare('SELECT * FROM meeting_segments WHERE meeting_id = ? ORDER BY start_ms, sort_order, id')
    .all(id) as NoteDetail['segments']
  const s = db.prepare('SELECT * FROM meeting_summaries WHERE meeting_id = ?').get(id) as
    | Record<string, string | null>
    | undefined
  const summary: NoteSummary | null = s
    ? {
        tldr: s.tldr,
        key_points: parseJsonArray(s.key_points),
        decisions: parseJsonArray(s.decisions),
        action_items: parseJsonArray(s.action_items),
        next_steps: parseJsonArray(s.next_steps),
        qa_pairs: parseJsonArray(s.qa_pairs),
        competencies: parseJsonArray(s.competencies),
        follow_ups: parseJsonArray(s.follow_ups),
        fact_checks: parseJsonArray(s.fact_checks)
      }
    : null
  const project =
    meeting.project_id != null
      ? (db.prepare('SELECT name FROM projects WHERE id = ?').get(meeting.project_id) as
          | { name: string }
          | undefined)
      : undefined
  return buildMeetingNoteMarkdown({
    meeting,
    speakers,
    segments,
    summary,
    attendees: listAttendees(db, id),
    projectName: project?.name ?? null
  })
}

export function registerMeetingNotesIpc(): void {
  const db = getDatabase()
  ipcMain.handle('meetingNotes:list', (_e, filter?: MeetingNoteFilter) =>
    listMeetingNotes(db, filter)
  )
  ipcMain.handle('meetingNotes:markdown', (_e, id: number) => meetingNoteMarkdown(db, id))
}
