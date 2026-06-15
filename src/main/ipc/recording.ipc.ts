import { ipcMain, BrowserWindow, app } from 'electron'
import { writeFile, mkdir, unlink } from 'fs/promises'
import { join } from 'path'
import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'
import { runMeetingPipeline } from '../services/meeting-pipeline'
import { runMeetingSummary } from '../services/meeting-summary'
import { getWeekEvents } from '../services/google-calendar'
import type { RecordingStreamEvent, SendStream, SummaryActionItem } from '../services/meeting-types'

// 녹음 오디오 저장 위치 (userData 밖이 아니라 안 — 백업/유지 일관성)
function recordingsDir(): string {
  return join(app.getPath('userData'), 'recordings')
}

interface SummaryRow {
  id: number
  meeting_id: number
  tldr: string | null
  key_points: string | null
  decisions: string | null
  action_items: string | null
  next_steps: string | null
  model: string | null
  generated_at: string
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

function mapSummary(row: SummaryRow | undefined): unknown {
  if (!row) return null
  return {
    id: row.id,
    meeting_id: row.meeting_id,
    tldr: row.tldr,
    key_points: parseJsonArray<string>(row.key_points),
    decisions: parseJsonArray<string>(row.decisions),
    action_items: parseJsonArray<SummaryActionItem>(row.action_items),
    next_steps: parseJsonArray<string>(row.next_steps),
    model: row.model,
    generated_at: row.generated_at
  }
}

// 'YYYY-MM-DD HH:MM:SS' (localtime) → epoch ms
function localStringToMs(s: string): number {
  const t = Date.parse(s.replace(' ', 'T'))
  return Number.isNaN(t) ? Date.now() : t
}

export function registerRecordingIpc(): void {
  const db = getDatabase()

  const streamTo = (event: Electron.IpcMainInvokeEvent): SendStream => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return (e: RecordingStreamEvent) => {
      if (win && !win.isDestroyed()) win.webContents.send('recording:stream', e)
    }
  }

  ipcMain.handle('recording:list', () => {
    return db.prepare('SELECT * FROM meetings ORDER BY started_at DESC').all()
  })

  ipcMain.handle('recording:get', (_e, id: number) => {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id)
    if (!meeting) return null
    const speakers = db
      .prepare('SELECT * FROM meeting_speakers WHERE meeting_id = ? ORDER BY sort_order, id')
      .all(id)
    const segments = db
      .prepare('SELECT * FROM meeting_segments WHERE meeting_id = ? ORDER BY start_ms, sort_order, id')
      .all(id)
    const cuts = db
      .prepare('SELECT * FROM meeting_cuts WHERE meeting_id = ? ORDER BY start_ms')
      .all(id)
    const summary = mapSummary(
      db.prepare('SELECT * FROM meeting_summaries WHERE meeting_id = ?').get(id) as
        | SummaryRow
        | undefined
    )
    return { meeting, speakers, segments, cuts, summary }
  })

  ipcMain.handle(
    'recording:createDraft',
    (_e, input: { title?: string; source?: string }) => {
      const title = (input?.title ?? '').trim() || '제목 없는 회의'
      const source = input?.source === 'mic+system' ? 'mic+system' : 'mic'
      const result = db
        .prepare("INSERT INTO meetings (title, status, source) VALUES (?, 'recording', ?)")
        .run(title, source)
      const id = Number(result.lastInsertRowid)
      logActivity('meeting', 'create', id, title)
      return { id }
    }
  )

  ipcMain.handle(
    'recording:saveAudio',
    async (_e, id: number, bytes: ArrayBuffer, meta: { mime: string; durationMs: number }) => {
      const row = db.prepare('SELECT id FROM meetings WHERE id = ?').get(id)
      if (!row) throw new Error('존재하지 않는 회의입니다.')
      await mkdir(recordingsDir(), { recursive: true })
      const ext = meta.mime.includes('wav') ? 'wav' : meta.mime.includes('ogg') ? 'ogg' : 'webm'
      const fileName = `${id}.${ext}`
      const filePath = join(recordingsDir(), fileName)
      await writeFile(filePath, Buffer.from(bytes))
      db.prepare(
        "UPDATE meetings SET audio_path = ?, audio_mime = ?, duration_ms = ?, updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(fileName, meta.mime, Math.round(meta.durationMs), id)
      return { path: fileName }
    }
  )

  // 전사+화자분리+VAD 파이프라인 (서비스에 위임, 진행률은 recording:stream)
  ipcMain.handle('recording:process', async (event, id: number) => {
    const row = db.prepare('SELECT id FROM meetings WHERE id = ?').get(id)
    if (!row) return { success: false, error: '존재하지 않는 회의입니다.' }
    db.prepare(
      "UPDATE meetings SET status = 'processing', error = NULL, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(id)
    try {
      return await runMeetingPipeline(id, streamTo(event))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      db.prepare(
        "UPDATE meetings SET status = 'failed', error = ? WHERE id = ?"
      ).run(message, id)
      return { success: false, error: message }
    }
  })

  // AI 요약 5분류 (서비스에 위임)
  ipcMain.handle('recording:summarize', async (event, id: number) => {
    const row = db.prepare('SELECT id FROM meetings WHERE id = ?').get(id)
    if (!row) return { success: false, error: '존재하지 않는 회의입니다.' }
    try {
      return await runMeetingSummary(id, streamTo(event))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('recording:rename', (_e, id: number, title: string) => {
    const trimmed = (title ?? '').trim()
    if (!trimmed) return { success: false }
    db.prepare(
      "UPDATE meetings SET title = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(trimmed, id)
    return { success: true }
  })

  ipcMain.handle('recording:remove', async (_e, id: number) => {
    const meeting = db.prepare('SELECT audio_path FROM meetings WHERE id = ?').get(id) as
      | { audio_path: string | null }
      | undefined
    if (meeting?.audio_path) {
      try {
        await unlink(join(recordingsDir(), meeting.audio_path))
      } catch {
        // 파일이 이미 없으면 무시
      }
    }
    db.prepare('DELETE FROM meetings WHERE id = ?').run(id) // CASCADE로 하위 정리
    logActivity('meeting', 'delete', id)
    return { success: true }
  })

  // ── 화자 보정 ──
  ipcMain.handle(
    'recording:updateSpeaker',
    (_e, speakerId: number, input: { display_name?: string | null; color?: string; label?: string }) => {
      const fields: string[] = []
      const values: unknown[] = []
      if (input.display_name !== undefined) {
        fields.push('display_name = ?')
        values.push(input.display_name)
      }
      if (input.color !== undefined) {
        fields.push('color = ?')
        values.push(input.color)
      }
      if (input.label !== undefined) {
        fields.push('label = ?')
        values.push(input.label)
      }
      if (fields.length === 0) return { success: false }
      values.push(speakerId)
      db.prepare(`UPDATE meeting_speakers SET ${fields.join(', ')} WHERE id = ?`).run(...values)
      return { success: true }
    }
  )

  ipcMain.handle('recording:reassignSegment', (_e, segmentId: number, speakerId: number | null) => {
    db.prepare(
      'UPDATE meeting_segments SET speaker_id = ?, speaker_corrected = 1 WHERE id = ?'
    ).run(speakerId, segmentId)
    return { success: true }
  })

  ipcMain.handle(
    'recording:mergeSpeakers',
    (_e, meetingId: number, fromSpeakerId: number, intoSpeakerId: number) => {
      const tx = db.transaction(() => {
        db.prepare(
          'UPDATE meeting_segments SET speaker_id = ?, speaker_corrected = 1 WHERE meeting_id = ? AND speaker_id = ?'
        ).run(intoSpeakerId, meetingId, fromSpeakerId)
        db.prepare('DELETE FROM meeting_speakers WHERE id = ? AND meeting_id = ?').run(
          fromSpeakerId,
          meetingId
        )
      })
      tx()
      return { success: true }
    }
  )

  // ── 컷 토글 (비파괴) ──
  ipcMain.handle('recording:toggleCut', (_e, cutId: number, enabled: boolean) => {
    db.prepare('UPDATE meeting_cuts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, cutId)
    return { success: true }
  })

  // ── 액션아이템 → TODO 등록 ──
  ipcMain.handle('recording:actionItemToTodo', (_e, meetingId: number, index: number) => {
    const meeting = db.prepare('SELECT title FROM meetings WHERE id = ?').get(meetingId) as
      | { title: string }
      | undefined
    const summaryRow = db
      .prepare('SELECT * FROM meeting_summaries WHERE meeting_id = ?')
      .get(meetingId) as SummaryRow | undefined
    if (!summaryRow) throw new Error('요약이 없습니다.')
    const items = parseJsonArray<SummaryActionItem & { todo_id?: number }>(summaryRow.action_items)
    const item = items[index]
    if (!item) throw new Error('해당 액션아이템이 없습니다.')

    const notes = `회의에서 추출: ${meeting?.title ?? ''}${item.assignee ? `\n담당: ${item.assignee}` : ''}`
    const result = db
      .prepare('INSERT INTO todos (title, priority, due_date, notes) VALUES (?, ?, ?, ?)')
      .run(item.text, 'medium', item.due ?? null, notes)
    const todoId = Number(result.lastInsertRowid)
    logActivity('todo', 'create', todoId, item.text)

    // summary의 해당 항목에 todo_id 기록 (재등록 방지/표시)
    items[index] = { ...item, todo_id: todoId }
    db.prepare('UPDATE meeting_summaries SET action_items = ? WHERE meeting_id = ?').run(
      JSON.stringify(items),
      meetingId
    )
    return { todo_id: todoId }
  })

  // ── 캘린더 매칭 (녹음 시각 ±90분 후보) ──
  ipcMain.handle('recording:calendarMatches', async (_e, id: number) => {
    const meeting = db.prepare('SELECT started_at FROM meetings WHERE id = ?').get(id) as
      | { started_at: string }
      | undefined
    if (!meeting) return []
    const center = localStringToMs(meeting.started_at)
    const windowMs = 90 * 60 * 1000
    try {
      const events = await getWeekEvents()
      return (events as { id: string; summary: string; start: string }[])
        .filter((ev) => Math.abs(Date.parse(ev.start) - center) <= windowMs)
        .map((ev) => ({ id: ev.id, title: ev.summary, start: ev.start }))
    } catch {
      return []
    }
  })

  ipcMain.handle(
    'recording:linkCalendar',
    (_e, id: number, eventId: string | null, eventTitle: string | null) => {
      db.prepare(
        "UPDATE meetings SET calendar_event_id = ?, calendar_event_title = ?, updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(eventId, eventTitle, id)
      return { success: true }
    }
  )
}
