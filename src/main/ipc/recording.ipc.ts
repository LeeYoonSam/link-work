import { ipcMain, BrowserWindow, app } from 'electron'
import { writeFile, mkdir, unlink } from 'fs/promises'
import { join } from 'path'
import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'
import { runMeetingPipeline, SPEAKER_COLORS } from '../services/meeting-pipeline'
import { runMeetingSummary } from '../services/meeting-summary'
import { wavDurationMs } from '../services/wav-util'
import { cancelPipeline } from '../services/pipeline-abort'
import type {
  RecordingStreamEvent,
  SendStream,
  SummaryActionItem,
  InterviewQaPair,
  InterviewCompetency
} from '../services/meeting-types'

// 녹음 오디오 저장 위치 (userData 밖이 아니라 안 — 백업/유지 일관성)
function recordingsDir(): string {
  return join(app.getPath('userData'), 'recordings')
}

// 화자분리용 채널 에너지 envelope 파일 경로 ({id}.channels.json)
function channelEnergyPath(id: number): string {
  return join(recordingsDir(), `${id}.channels.json`)
}

interface SummaryRow {
  id: number
  meeting_id: number
  tldr: string | null
  key_points: string | null
  decisions: string | null
  action_items: string | null
  next_steps: string | null
  qa_pairs: string | null
  competencies: string | null
  follow_ups: string | null
  fact_checks: string | null
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
    // 면접 전용 4분류 (회의 요약에서는 빈 배열)
    qa_pairs: parseJsonArray<InterviewQaPair>(row.qa_pairs),
    competencies: parseJsonArray<InterviewCompetency>(row.competencies),
    follow_ups: parseJsonArray<string>(row.follow_ups),
    fact_checks: parseJsonArray<string>(row.fact_checks),
    model: row.model,
    generated_at: row.generated_at
  }
}

// 처리 중 박제 복구 — 앱 시작 시 1회 실행.
// 처리 파이프라인 실행 중 앱이 네이티브 abort로 크래시하면 recording:process가 기록한
// status='processing'이 DB에 그대로 남아, 재시작 후 실제로는 아무것도 돌지 않는데 UI는
// 계속 "처리 중"으로 표시되고 사용자가 손댈 수 없게 된다. 이를 정리한다.
//
// 이 함수는 IPC 핸들러 등록 시점(앱 시작 직후)에만 호출되며, recording:process는 이 등록
// 이후에만 invoke될 수 있으므로 이 순간 파이프라인이 실행 중일 가능성은 없다. 따라서
// 'processing' 행은 전부 죽은 잔재로 간주하고 안전하게 되돌릴 수 있다.
//
// meeting-pipeline.ts의 restoreAfterCancel과 복원 규칙(요약 있으면 summarized, 세그먼트만
// 있으면 transcribed, 둘 다 없으면 failed)은 같지만 목적이 다르다: restoreAfterCancel은
// '살아 있는 프로세스 내'에서의 사용자 취소 복구이고, 이 함수는 '죽었다 살아난 뒤'의 잔재
// 정리다. 그 파일은 타 팀원 영역이므로 import하지 않고 여기에 로컬로 둔다.
function restoreStuckProcessing(db: ReturnType<typeof getDatabase>): void {
  const stuck = db
    .prepare("SELECT id FROM meetings WHERE status = 'processing'")
    .all() as { id: number }[]
  for (const { id } of stuck) {
    const hasSummary = db
      .prepare('SELECT 1 FROM meeting_summaries WHERE meeting_id = ? LIMIT 1')
      .get(id)
    const hasSegments = db
      .prepare('SELECT 1 FROM meeting_segments WHERE meeting_id = ? LIMIT 1')
      .get(id)

    if (hasSummary) {
      db.prepare(
        "UPDATE meetings SET status = 'summarized', error = NULL, updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(id)
    } else if (hasSegments) {
      db.prepare(
        "UPDATE meetings SET status = 'transcribed', error = NULL, updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(id)
    } else {
      db.prepare(
        "UPDATE meetings SET status = 'failed', error = '이전 처리가 비정상 종료되었습니다. 다시 시도해 주세요.', updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(id)
    }
  }
}

export function registerRecordingIpc(): void {
  const db = getDatabase()

  // 앱 시작 시 1회: 지난 세션에서 크래시로 'processing'에 박제된 회의를 복구한다.
  restoreStuckProcessing(db)

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
    (
      _e,
      input: { title?: string; source?: string; kind?: string; expected_speakers?: number | null }
    ) => {
      const kind = input?.kind === 'interview' ? 'interview' : 'meeting'
      const title =
        (input?.title ?? '').trim() || (kind === 'interview' ? '제목 없는 면접' : '제목 없는 회의')
      const source = input?.source === 'mic+system' ? 'mic+system' : 'mic'
      // 참석 인원(화자분리 클러스터 수). 입력값이 유효한 정수(1~20)면 그 값을 쓰고,
      // 없으면 면접은 면접관+지원자 2인 기본형(자동추정 과분할 방지), 회의는 자동 추정(null).
      // 상세 화면에서 언제든 바꿔 재분리 가능.
      const raw = input?.expected_speakers
      const requested =
        typeof raw === 'number' && Number.isFinite(raw) && raw >= 1
          ? Math.min(20, Math.round(raw))
          : null
      const expectedSpeakers = requested ?? (kind === 'interview' ? 2 : null)
      const result = db
        .prepare(
          "INSERT INTO meetings (title, kind, status, source, expected_speakers) VALUES (?, ?, 'recording', ?, ?)"
        )
        .run(title, kind, source, expectedSpeakers)
      const id = Number(result.lastInsertRowid)
      logActivity('meeting', 'create', id, title)
      return { id }
    }
  )

  ipcMain.handle(
    'recording:saveAudio',
    async (
      _e,
      id: number,
      bytes: ArrayBuffer,
      meta: { mime: string; durationMs: number },
      channelEnergy?: { hopMs: number; left: number[]; right: number[] } | null
    ) => {
      const row = db.prepare('SELECT id, source FROM meetings WHERE id = ?').get(id) as
        | { id: number; source: string }
        | undefined
      if (!row) throw new Error('존재하지 않는 회의입니다.')
      await mkdir(recordingsDir(), { recursive: true })
      const ext = meta.mime.includes('wav') ? 'wav' : meta.mime.includes('ogg') ? 'ogg' : 'webm'
      const fileName = `${id}.${ext}`
      const filePath = join(recordingsDir(), fileName)
      await writeFile(filePath, Buffer.from(bytes))

      // 화자분리용 채널 에너지 envelope 저장 (재처리 시 재사용). 없으면 이전 파일 정리.
      const hasStereo = !!(channelEnergy && channelEnergy.left.length > 0)
      const energyPath = channelEnergyPath(id)
      if (hasStereo) {
        await writeFile(energyPath, JSON.stringify(channelEnergy))
      } else {
        try {
          await unlink(energyPath)
        } catch {
          // 파일이 없으면 무시
        }
      }

      // mic+system으로 요청했지만 실제 스테레오 채널 분리가 불가능하면(시스템 오디오 미캡처 →
      // mono 녹음 → 채널 에너지 없음) source를 'mic'으로 강등한다. 그래야 화자분리가
      // 채널 어댑터(2화자 고정)가 아니라 sherpa 임베딩 기반 다화자 분리로 라우팅된다.
      const effectiveSource = !hasStereo && row.source === 'mic+system' ? 'mic' : row.source

      // 길이는 WAV 파일 헤더(ground truth)로 정확히 계산한다. renderer가 보낸 타이머/
      // 디코더 기반 durationMs는 환경에 따라 부정확할 수 있어, WAV면 파일을 신뢰한다.
      const accurateMs = wavDurationMs(filePath)
      const durationMs = accurateMs ?? Math.round(meta.durationMs)

      db.prepare(
        "UPDATE meetings SET audio_path = ?, audio_mime = ?, duration_ms = ?, source = ?, updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(fileName, meta.mime, durationMs, effectiveSource, id)
      return { path: fileName }
    }
  )

  // 전사+화자분리+VAD 파이프라인 (서비스에 위임, 진행률은 recording:stream)
  // opts.skipTranscribe=true면 재전사 없이 기존 전사로 정제/화자분리만 다시 수행(빠른 재적용)
  ipcMain.handle(
    'recording:process',
    async (event, id: number, opts?: { skipTranscribe?: boolean }) => {
      const row = db.prepare('SELECT id FROM meetings WHERE id = ?').get(id)
      if (!row) return { success: false, error: '존재하지 않는 회의입니다.' }
      db.prepare(
        "UPDATE meetings SET status = 'processing', error = NULL, updated_at = datetime('now','localtime') WHERE id = ?"
      ).run(id)
      try {
        return await runMeetingPipeline(id, streamTo(event), opts)
      } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      db.prepare(
        "UPDATE meetings SET status = 'failed', error = ? WHERE id = ?"
      ).run(message, id)
      return { success: false, error: message }
    }
  })

  // 처리 취소 — 활성 파이프라인을 abort. 취소된 파이프라인이 있었으면 success:true.
  // 실제 취소 정리와 phase:'cancelled' 스트림 방출은 meeting-pipeline이 담당한다.
  ipcMain.handle('recording:cancel', (_e, meetingId: number) => {
    return { success: cancelPipeline(meetingId) }
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
    try {
      await unlink(channelEnergyPath(id))
    } catch {
      // 채널 에너지 파일이 없으면 무시
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

  // ── 발언 텍스트 보정 (전사 오류 수동 수정) ──
  ipcMain.handle('recording:updateSegmentText', (_e, segmentId: number, text: string) => {
    db.prepare(
      'UPDATE meeting_segments SET text = ?, text_corrected = 1 WHERE id = ?'
    ).run((text ?? '').trim(), segmentId)
    return { success: true }
  })

  // ── 화자 수동 추가 (타임라인에서 즉석 추가). 같은 이름이 이미 있으면 그 화자를 재사용 ──
  ipcMain.handle('recording:addSpeaker', (_e, meetingId: number, name: string) => {
    const trimmed = (name ?? '').trim()
    if (!trimmed) return { success: false, error: '화자 이름이 비어 있습니다.' }
    const existing = db
      .prepare(
        'SELECT id FROM meeting_speakers WHERE meeting_id = ? AND (display_name = ? OR label = ?)'
      )
      .get(meetingId, trimmed, trimmed) as { id: number } | undefined
    if (existing) return { success: true, id: existing.id, existed: true }

    const stats = db
      .prepare(
        'SELECT COUNT(*) AS cnt, COALESCE(MAX(sort_order), -1) AS maxOrder FROM meeting_speakers WHERE meeting_id = ?'
      )
      .get(meetingId) as { cnt: number; maxOrder: number }
    const color = SPEAKER_COLORS[stats.cnt % SPEAKER_COLORS.length]
    const result = db
      .prepare(
        'INSERT INTO meeting_speakers (meeting_id, speaker_key, label, display_name, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(meetingId, `manual_${Date.now()}`, trimmed, trimmed, color, stats.maxOrder + 1)
    return { success: true, id: Number(result.lastInsertRowid), existed: false }
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

    // AI 요약의 due는 "다음 주" 같은 자유 텍스트일 수 있다. todos.due_date는 날짜 포맷을
    // 전제로 렌더링되므로(ai-write-tools.ts의 todoDueField와 동일 규약) 형식이 맞을 때만
    // due_date로 쓰고, 아니면 notes에 원문을 남긴다.
    const dueIsDate = !!item.due && /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(item.due)
    const notes = [
      `회의에서 추출: ${meeting?.title ?? ''}`,
      item.assignee ? `담당: ${item.assignee}` : null,
      !dueIsDate && item.due ? `기한: ${item.due}` : null
    ]
      .filter(Boolean)
      .join('\n')
    const result = db
      .prepare('INSERT INTO todos (title, priority, due_date, notes) VALUES (?, ?, ?, ?)')
      .run(item.text, 'medium', dueIsDate ? item.due : null, notes)
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

  // ── 프로젝트 연결 (projectId=null이면 해제) ──
  ipcMain.handle('recording:linkProject', (_e, id: number, projectId: number | null) => {
    db.prepare(
      "UPDATE meetings SET project_id = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(projectId, id)
    return { success: true }
  })

  // ── 참석 인원 설정 (화자분리 시 numClusters로 사용, null이면 자동 추정) ──
  ipcMain.handle('recording:setExpectedSpeakers', (_e, id: number, n: number | null) => {
    const v = n && n > 0 ? Math.round(n) : null
    db.prepare(
      "UPDATE meetings SET expected_speakers = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(v, id)
    return { success: true }
  })
}
