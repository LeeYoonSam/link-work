// 비서의 수집 지점. 회의 전 브리핑 맥락을 DB 에서 모은다.
// SSOT: docs/ASSISTANT.md §7.1, §7.3
//
// [가드레일]
// - 이 파일은 DB 를 읽기만 한다. 원본 테이블에 쓰지 않는다.
// - 조회 실패는 throw 하지 않는다. 해당 출처를 비우고 errors 에 문구를 넣는다.
import type Database from 'better-sqlite3'
import { addDays, isoToLocalDateTime } from './assistant-day'
import { MEETING_LINE_MAX, sameTitle } from './assistant-meeting'
import type { MeetingContext, MeetingPastRef, MeetingRef } from './assistant-types'
import type { CalendarEvent } from './google-calendar'
import { parseJsonArray, type NoteActionItem } from './meeting-notes'

function nonBlank(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

// ── 회의 전 브리핑 수집 ──
// DB 읽기만 한다. Jira·캘린더를 부르지 않는다. 일정은 호출자가 캐시에서 읽어 넘긴다.
// meetings·meeting_summaries 는 SELECT 만 한다.

export const MEETING_LIMITS = {
  pastDays: 90,
  pastCandidates: 200,
  pastMeetings: 3,
  actionItems: 10
} as const

const MEETING_PAST_FAILED = '지난 회의 조회에 실패했습니다.'

/** 캘린더 일정을 회의 참조로 바꾼다. 종일 일정과 시각 변환 실패는 null 이다 */
export function toMeetingRef(e: CalendarEvent): MeetingRef | null {
  if (e.allDay) return null
  const startAt = isoToLocalDateTime(e.start)
  const endAt = isoToLocalDateTime(e.end)
  if (!startAt || !endAt) return null
  return { id: e.id, title: typeof e.summary === 'string' ? e.summary : '', startAt, endAt }
}

interface PastMeetingRow {
  meeting_id: number
  title: string | null
  calendar_event_title: string | null
  started_at: string | null
  tldr: string | null
  action_items: string | null
}

function openActionTexts(raw: string | null): string[] {
  return parseJsonArray<NoteActionItem>(raw)
    .filter((a) => a && a.todo_id == null && nonBlank(a.text) !== null)
    .map((a) => a.text.trim())
}

// started_at 은 로컬 기본값이다. 회의 시작 시각 기준 90일 안, 시작 전 회의만 본다.
function readPastMeetings(db: Database.Database, meeting: MeetingRef): MeetingPastRef[] {
  const cutoff = `${addDays(meeting.startAt.slice(0, 10), -MEETING_LIMITS.pastDays)}${meeting.startAt.slice(10)}`
  const rows = db
    .prepare(
      `SELECT m.id AS meeting_id, m.title, m.calendar_event_title, m.started_at, ms.tldr, ms.action_items
       FROM meetings m
       JOIN meeting_summaries ms ON ms.meeting_id = m.id
       WHERE m.started_at >= ? AND m.started_at < ?
       ORDER BY m.started_at DESC, m.id DESC
       LIMIT ?`
    )
    .all(cutoff, meeting.startAt, MEETING_LIMITS.pastCandidates) as unknown as PastMeetingRow[]

  const out: MeetingPastRef[] = []
  for (const r of rows) {
    if (out.length >= MEETING_LIMITS.pastMeetings) break
    const matched =
      (r.title !== null && sameTitle(meeting.title, r.title)) ||
      (r.calendar_event_title !== null && sameTitle(meeting.title, r.calendar_event_title))
    if (!matched) continue
    const tldr = nonBlank(r.tldr)
    out.push({
      meetingId: r.meeting_id,
      title: r.title ?? '',
      startedAt: r.started_at ?? '',
      tldr: tldr === null ? null : tldr.trim().slice(0, MEETING_LINE_MAX),
      openActionItems: openActionTexts(r.action_items).slice(0, MEETING_LIMITS.actionItems)
    })
  }
  return out
}

/** 회의 브리핑 맥락. throw 하지 않는다. 실패한 출처는 비우고 errors 에 문구를 넣는다 */
export function collectMeetingContext(db: Database.Database, meeting: MeetingRef): MeetingContext {
  const errors: string[] = []
  function guard<T>(message: string, empty: T, read: () => T): T {
    try {
      return read()
    } catch (err) {
      console.error('[assistant-sources] collectMeetingContext', message, err)
      errors.push(message)
      return empty
    }
  }

  const pastMeetings = guard<MeetingPastRef[]>(MEETING_PAST_FAILED, [], () => readPastMeetings(db, meeting))
  const openActionItems = pastMeetings.flatMap((m) => m.openActionItems).slice(0, MEETING_LIMITS.actionItems)

  return { meeting, pastMeetings, openActionItems, errors }
}
