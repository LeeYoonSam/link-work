// 녹음 처리 파이프라인(회의·면접 공통): STT → VAD → Diarization → merge → DB 저장
// SSOT: docs/MEETING_RECORDING.md §5
import { app } from 'electron'
import { join } from 'path'
import { getDatabase } from '../db/database'
import type { SendStream, SttSegment, DiarTurn } from './meeting-types'
import { getSttAdapter } from './stt/index'
import { buildInitialPrompt } from './stt/initial-prompt'
import { GapAdapter } from './vad/gap-adapter'
import { getVadAdapter } from './vad/index'
import { diarizeWithFallback } from './diarization/index'
import { ensureDiarizationModels } from './diarization/model-manager'
import { cleanSegments } from './transcript-cleaner'
import { wavDurationMs } from './wav-util'
import { postprocessTurns } from './diarization/postprocess'
import { beginPipeline, endPipeline, PipelineCancelledError } from './pipeline-abort'

// 화자 색상 팔레트 (순환) — 수동 화자 추가(recording.ipc)에서도 사용
export const SPEAKER_COLORS = [
  '#4F8EF7',
  '#F7844F',
  '#4FBF7A',
  '#C84FF7',
  '#F7C84F',
  '#4FF7F0',
  '#F74F6F',
  '#A0A0A0'
]

interface MeetingRow {
  id: number
  title: string
  kind: string
  audio_path: string | null
  audio_mime: string
  duration_ms: number
  language: string
  source: string
  status: string
  expected_speakers: number | null
  project_id: number | null
  calendar_event_title: string | null
}

/**
 * segment와 turn의 겹침 ms를 계산
 */
function overlapMs(
  segStart: number,
  segEnd: number,
  turnStart: number,
  turnEnd: number
): number {
  return Math.max(0, Math.min(segEnd, turnEnd) - Math.max(segStart, turnStart))
}

/**
 * STT segment를 가장 많이 겹치는 diar turn의 speaker_key에 귀속.
 * turns가 비어 있으면 기본 키('spk_0') 반환.
 */
function assignSpeaker(seg: SttSegment, turns: DiarTurn[]): string {
  if (turns.length === 0) return 'spk_0'

  let bestKey = 'spk_0'
  let bestOverlap = -1

  for (const turn of turns) {
    const ov = overlapMs(seg.start_ms, seg.end_ms, turn.start_ms, turn.end_ms)
    if (ov > bestOverlap) {
      bestOverlap = ov
      bestKey = turn.speaker_key
    }
  }
  return bestKey
}

/**
 * speaker_key → 라벨/색상/sort_order 결정.
 * mic → '나', system → '상대', sys_N → '상대 N+1'(2-스테이지 분리), spk_N → '화자 N+1'
 */
function resolveSpeakerMeta(
  speakerKey: string,
  index: number
): { label: string; color: string } {
  if (speakerKey === 'mic') {
    return { label: '나', color: SPEAKER_COLORS[0] }
  }
  if (speakerKey === 'system') {
    return { label: '상대', color: SPEAKER_COLORS[1] }
  }
  // 2-스테이지 재정합: 'sys_N' → '상대 1', '상대 2' … (system 안에서 분리된 상대편들).
  // 색상은 mic('나')=팔레트[0] 다음부터 순환시켜 상대 1이 기존 '상대'(팔레트[1])와 일치.
  const sysMatch = /^sys_(\d+)$/.exec(speakerKey)
  if (sysMatch) {
    const n = Number(sysMatch[1])
    return {
      label: `상대 ${n + 1}`,
      color: SPEAKER_COLORS[(n + 1) % SPEAKER_COLORS.length]
    }
  }
  return {
    label: `화자 ${index + 1}`,
    color: SPEAKER_COLORS[index % SPEAKER_COLORS.length]
  }
}

/**
 * project_id로 프로젝트명을 조회한다. 없거나 조회 실패 시 null(프롬프트에서 무해하게 생략).
 */
function loadProjectName(
  db: ReturnType<typeof getDatabase>,
  projectId: number | null
): string | null {
  if (!projectId) return null
  try {
    const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as
      | { name: string }
      | undefined
    return row?.name ?? null
  } catch {
    return null
  }
}

/**
 * 사용자가 지정한 화자 실명(display_name)을 수집한다.
 * 최초 처리 땐 빈 배열이 정상이며, 재처리 시 이전 처리에서 지정한 실명이 프롬프트 힌트로 재사용된다.
 */
function loadSpeakerNames(db: ReturnType<typeof getDatabase>, meetingId: number): string[] {
  try {
    const rows = db
      .prepare(
        "SELECT display_name FROM meeting_speakers WHERE meeting_id = ? AND display_name IS NOT NULL AND display_name != ''"
      )
      .all(meetingId) as { display_name: string }[]
    return rows.map((r) => r.display_name)
  } catch {
    return []
  }
}

/**
 * 취소 시 status 복원. merge DB 트랜잭션은 파이프라인 마지막에 단 한 번만 실행되므로,
 * 그 전에 취소되면 기존에 저장돼 있던 데이터(segments/summaries)는 무손상이다.
 * 따라서 현재 DB에 이미 존재하는 이전 처리 결과로 되돌릴 status를 결정한다.
 *  - 요약본이 있으면 'summarized', 세그먼트만 있으면 'transcribed'로 복원.
 *  - 둘 다 없으면(첫 처리 도중 취소) 'failed' + 취소 사유.
 * 스트림에는 phase 'cancelled'를 보내고 호출측이 취소를 식별하도록 error:'cancelled'를 반환한다.
 */
function restoreAfterCancel(
  db: ReturnType<typeof getDatabase>,
  meetingId: number,
  send: SendStream
): { success: false; error: string } {
  const hasSummary = db
    .prepare('SELECT 1 FROM meeting_summaries WHERE meeting_id = ? LIMIT 1')
    .get(meetingId)
  const hasSegments = db
    .prepare('SELECT 1 FROM meeting_segments WHERE meeting_id = ? LIMIT 1')
    .get(meetingId)

  if (hasSummary) {
    db.prepare(
      "UPDATE meetings SET status = 'summarized', error = NULL, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(meetingId)
  } else if (hasSegments) {
    db.prepare(
      "UPDATE meetings SET status = 'transcribed', error = NULL, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(meetingId)
  } else {
    db.prepare(
      "UPDATE meetings SET status = 'failed', error = '사용자가 취소했습니다.', updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(meetingId)
  }

  send({ meetingId, phase: 'cancelled', message: '처리를 취소했습니다.' })
  return { success: false, error: 'cancelled' }
}

export async function runMeetingPipeline(
  meetingId: number,
  send: SendStream,
  opts?: { skipTranscribe?: boolean }
): Promise<{ success: boolean; error?: string; transcribed?: boolean }> {
  const db = getDatabase()

  // 취소 레지스트리 등록. 이미 처리 중이면(중복 실행) 진행 중 작업을 망치지 않도록
  // DB를 전혀 건드리지 않고 즉시 반환한다. status를 'failed'로 덮어쓰면 살아 있는
  // 파이프라인의 결과를 잃게 되므로 send(error)만 하고 빠져나온다.
  let signal: AbortSignal
  try {
    signal = beginPipeline(meetingId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    send({ meetingId, phase: 'error', error: message })
    return { success: false, error: message }
  }

  // ── 1. meetings 행 로드 ──
  const meeting = db
    .prepare('SELECT * FROM meetings WHERE id = ?')
    .get(meetingId) as MeetingRow | undefined

  if (!meeting) {
    endPipeline(meetingId)
    const err = '회의를 찾을 수 없습니다.'
    send({ meetingId, phase: 'error', error: err })
    return { success: false, error: err }
  }

  if (!meeting.audio_path) {
    endPipeline(meetingId)
    const err = '오디오 파일이 없습니다. 먼저 녹음을 완료해 주세요.'
    db.prepare(
      "UPDATE meetings SET status = 'failed', error = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(err, meetingId)
    send({ meetingId, phase: 'error', error: err })
    return { success: false, error: err }
  }

  const audioPath = join(app.getPath('userData'), 'recordings', meeting.audio_path)

  try {
    // ── 2. STT 전사 (또는 기존 전사 재사용) ──
    send({
      meetingId,
      phase: 'transcribe',
      progress: 0,
      message: opts?.skipTranscribe ? '기존 전사 재사용 중…' : '음성 인식 중…'
    })

    let rawSegments: SttSegment[] = []
    let sttName = 'whisper'

    // 빠른 재적용: 재전사 없이 기존 meeting_segments를 재사용 (정제/화자분리만 다시 수행)
    if (opts?.skipTranscribe) {
      const existing = db
        .prepare(
          'SELECT start_ms, end_ms, text FROM meeting_segments WHERE meeting_id = ? ORDER BY start_ms, sort_order'
        )
        .all(meetingId) as { start_ms: number; end_ms: number; text: string }[]
      rawSegments = existing
        .map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, text: s.text }))
        .filter((s) => s.text && s.text.trim())

      // 박제 차단: 기존 세그먼트의 끝시각이 실제 WAV 길이를 크게 초과하면(과거 ×10 오염 등)
      // 재사용을 포기하고 아래에서 전체 재전사로 폴백한다. 빠른 재적용이 오염 데이터를
      // 그대로 영속화하던 문제를 방지한다.
      const wavMs0 = wavDurationMs(audioPath)
      if (wavMs0 && rawSegments.length > 0) {
        const maxEnd = Math.max(...rawSegments.map((s) => s.end_ms))
        if (maxEnd > wavMs0 * 1.5) {
          send({
            meetingId,
            phase: 'transcribe',
            message: '기존 전사가 오디오 길이와 어긋나 전체 재전사로 전환합니다.'
          })
          rawSegments = []
        }
      }
    }

    // 일반 모드이거나, 빠른 재적용인데 기존 전사가 없으면 STT 실행
    if (rawSegments.length === 0) {
      const sttAdapter = await getSttAdapter()
      sttName = sttAdapter.name

      // whisper initial_prompt: 회의 도메인 컨텍스트(주제·프로젝트·참석자 실명)를 주입해
      // 고유명사 오인식을 줄인다. 재전사가 실제로 실행되는 이 경로에서만 조립하므로
      // 빠른 재적용(skipTranscribe) 경로에는 영향이 없다. 조회 실패는 무해하게 생략된다.
      const prompt = buildInitialPrompt({
        kind: meeting.kind,
        language: meeting.language || 'ko',
        title: meeting.title,
        projectName: loadProjectName(db, meeting.project_id),
        calendarEventTitle: meeting.calendar_event_title,
        speakerNames: loadSpeakerNames(db, meetingId)
      })

      rawSegments = await sttAdapter.transcribe(audioPath, {
        language: meeting.language || 'ko',
        prompt,
        signal,
        onProgress: (p) => {
          send({ meetingId, phase: 'transcribe', progress: p })
        },
        onMessage: (m) => {
          send({ meetingId, phase: 'transcribe', message: m })
        }
      })
    }

    // STT 후 취소 체크. 어댑터가 취소를 일반 에러로 삼켜 부분/빈 결과를 그대로 반환하더라도
    // (예: diarize try/catch가 취소 에러를 turns=[]로 삼킴) 여기서 끊어 merge에 부분 결과가
    // 들어가지 않게 한다. 단계 사이 이 체크들이 취소 시 DB 무손상을 보장하는 핵심 방어선이다.
    if (signal.aborted) throw new PipelineCancelledError()

    // 환각/반복/filler 후처리 정제 (manual 폴백/빈 결과는 변화 없음)
    const beforeClean = rawSegments.length
    rawSegments = cleanSegments(rawSegments)
    if (beforeClean !== rawSegments.length) {
      send({
        meetingId,
        phase: 'transcribe',
        message: `정제 완료 (${beforeClean} → ${rawSegments.length} segment)`
      })
    }

    // 타임스탬프 방어: 실제 WAV 길이(ground truth)를 넘는 비정상 타임스탬프를 클램프한다.
    // (과거 회귀로 STT 타임스탬프가 ×10로 부풀려져 타임라인이 실제 오디오보다 길게
    //  표시되고 재생 시킹이 깨지던 사례 방지.) 정상 데이터에는 영향 없음(no-op).
    const audioMs = wavDurationMs(audioPath)
    if (audioMs && audioMs > 0) {
      rawSegments = rawSegments
        .map((s) => {
          const start = Math.min(Math.max(0, s.start_ms), audioMs)
          const end = Math.min(Math.max(start, s.end_ms), audioMs)
          return { ...s, start_ms: start, end_ms: end }
        })
        .filter((s) => s.end_ms > s.start_ms)
    }

    // manual 어댑터(엔진 미설치) 또는 결과 없음 → 안내 segment 삽입
    const isManualFallback = sttName === 'manual' || rawSegments.length === 0

    if (isManualFallback && sttName === 'manual') {
      rawSegments = [
        {
          start_ms: 0,
          end_ms: Math.max(meeting.duration_ms, 1000),
          text: '전사 엔진(Whisper)이 설치되지 않았습니다. 설치 후 재처리하거나 텍스트를 직접 입력해 주세요.',
          confidence: undefined
        }
      ]
    }

    send({ meetingId, phase: 'transcribe', progress: 1, message: `${rawSegments.length}개 segment 완료` })

    // 정제 후 취소 체크 (VAD 진입 전).
    if (signal.aborted) throw new PipelineCancelledError()

    // ── 3. VAD 침묵 검출 ──
    send({ meetingId, phase: 'vad', progress: 0, message: '침묵 구간 감지 중…' })

    const vadAdapter = await getVadAdapter()

    // gap 어댑터라면 STT 세그먼트를 주입
    if (vadAdapter instanceof GapAdapter) {
      vadAdapter.setSegments(rawSegments)
    }

    let silenceRegions: Awaited<ReturnType<typeof vadAdapter.detectSilence>> = []
    try {
      silenceRegions = await vadAdapter.detectSilence(audioPath, { minSilenceMs: 500 })
    } catch {
      // VAD 실패 시 cuts 없이 계속
      silenceRegions = []
    }

    send({ meetingId, phase: 'vad', progress: 1, message: `${silenceRegions.length}개 침묵 구간` })

    // VAD 후 취소 체크 (화자분리 진입 전).
    if (signal.aborted) throw new PipelineCancelledError()

    // ── 4. 화자 분리 (폴백 체인: channel → sherpa → none) ──
    send({ meetingId, phase: 'diarize', progress: 0, message: '화자 분리 중…' })

    // 참석 인원(expected_speakers)을 지정하면 sherpa가 정확히 그 수로 클러스터링(numClusters).
    // 미지정 시 threshold(0.85) 자동 추정 + postprocessTurns 후처리(smoothing + 소수화자 흡수)로 보정.
    // mic+system은 채널 분리를 우선하되, 채널 에너지가 없거나 단일 화자로만 나오면 sherpa로 폴백한다.
    // sherpa 모델은 폴백 직전(ensureModels 콜백)에만 다운로드한다.
    let turns: DiarTurn[] = []
    let diarAdapter = 'none'
    try {
      const result = await diarizeWithFallback(audioPath, {
        source: meeting.source,
        segments: rawSegments,
        numSpeakers:
          meeting.expected_speakers && meeting.expected_speakers > 0
            ? meeting.expected_speakers
            : undefined,
        signal,
        ensureModels: () =>
          ensureDiarizationModels(({ ratio, label }) =>
            send({ meetingId, phase: 'diarize', progress: ratio, message: label })
          )
      })
      turns = result.turns
      diarAdapter = result.adapter
    } catch {
      turns = []
    }

    // 후처리: smoothing + 소수 화자 흡수로 과분할 감소.
    // 단, 2-스테이지 재정합('two-stage') 결과는 상대편을 이미 정밀 분리했으므로
    // 소수화자 흡수(absorbMinority)를 끈다. 흡수를 켜면 짧게 말한 상대 화자가
    // 통째로 흡수돼 분리가 무의미해진다.
    if (turns.length > 0) {
      const beforeCount = new Set(turns.map((t) => t.speaker_key)).size
      turns = postprocessTurns(turns, {
        smooth: { minTurnMs: 200, sandwichMs: 600, gapFillMs: 500 },
        absorb: diarAdapter === 'two-stage' ? false : { minRatio: 0.02, minDurationMs: 60_000 }
      })
      const afterCount = new Set(turns.map((t) => t.speaker_key)).size
      if (beforeCount !== afterCount) {
        send({
          meetingId,
          phase: 'diarize',
          message: `화자 후처리: ${beforeCount}명 → ${afterCount}명`
        })
      }
    }

    // turns가 비어 있으면 merge 단계에서 전체가 spk_0(단일 화자)으로 귀속된다.
    send({ meetingId, phase: 'diarize', progress: 1, message: `${new Set(turns.map((t) => t.speaker_key)).size}명 화자 감지` })

    // 화자분리 후 취소 체크. diarize의 try/catch가 취소 에러를 turns=[]로 삼켜도
    // 여기서 끊기므로 부분 화자분리 결과로 merge에 진입하지 않는다.
    if (signal.aborted) throw new PipelineCancelledError()

    // ── 5. merge: speaker_key별 speakers 생성 + segments 귀속 ──
    send({ meetingId, phase: 'merge', progress: 0, message: '세그먼트 병합 중…' })

    // speaker_key 순서 결정 (등장 순)
    const speakerKeyOrder: string[] = []
    const speakerKeySet = new Set<string>()

    // turns에서 등장 순 수집
    for (const turn of turns) {
      if (!speakerKeySet.has(turn.speaker_key)) {
        speakerKeyOrder.push(turn.speaker_key)
        speakerKeySet.add(turn.speaker_key)
      }
    }

    // segment 귀속 결과에서 추가 key 수집 (turns 없는 경우 spk_0)
    const segmentAssignments = rawSegments.map((seg) => assignSpeaker(seg, turns))
    for (const key of segmentAssignments) {
      if (!speakerKeySet.has(key)) {
        speakerKeyOrder.push(key)
        speakerKeySet.add(key)
      }
    }

    // DB 트랜잭션으로 저장
    const tx = db.transaction(() => {
      // 기존 데이터 정리 (재처리 시)
      db.prepare('DELETE FROM meeting_speakers WHERE meeting_id = ?').run(meetingId)
      db.prepare('DELETE FROM meeting_segments WHERE meeting_id = ?').run(meetingId)
      db.prepare('DELETE FROM meeting_cuts WHERE meeting_id = ?').run(meetingId)

      // meeting_speakers INSERT
      const speakerIdMap = new Map<string, number>()
      speakerKeyOrder.forEach((key, index) => {
        const { label, color } = resolveSpeakerMeta(key, index)
        const result = db
          .prepare(
            `INSERT INTO meeting_speakers
               (meeting_id, speaker_key, label, color, sort_order)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(meetingId, key, label, color, index)
        speakerIdMap.set(key, Number(result.lastInsertRowid))
      })

      // meeting_segments INSERT
      rawSegments.forEach((seg, i) => {
        const key = segmentAssignments[i]
        const speakerId = speakerIdMap.get(key) ?? null
        db.prepare(
          `INSERT INTO meeting_segments
             (meeting_id, start_ms, end_ms, speaker_id, text, confidence, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          meetingId,
          seg.start_ms,
          seg.end_ms,
          speakerId,
          seg.text,
          seg.confidence ?? null,
          i
        )
      })

      // meeting_cuts INSERT (침묵 구간)
      for (const region of silenceRegions) {
        db.prepare(
          `INSERT INTO meeting_cuts
             (meeting_id, type, start_ms, end_ms, enabled, auto)
           VALUES (?, 'silence', ?, ?, 1, 1)`
        ).run(meetingId, region.start_ms, region.end_ms)
      }

      // duration 결정: WAV 파일 헤더(ground truth) > STT 마지막 발화 끝 > 기존 duration_ms.
      // 과거 회귀로 duration_ms가 부풀려진(예: 10배) 데이터를 재처리 시 자동 교정한다.
      // (기존엔 Math.max로 잘못된 큰 값을 그대로 영속화하는 버그가 있었다.)
      const wavMs = wavDurationMs(audioPath)
      const lastSegEnd =
        rawSegments.length > 0 ? Math.max(...rawSegments.map((s) => s.end_ms)) : 0
      const duration = wavMs ?? (lastSegEnd > 0 ? lastSegEnd : meeting.duration_ms)

      db.prepare(
        `UPDATE meetings
         SET status = 'transcribed', duration_ms = ?, error = NULL,
             updated_at = datetime('now','localtime')
         WHERE id = ?`
      ).run(duration, meetingId)
    })

    // merge 트랜잭션 직전 마지막 취소 체크. 이 트랜잭션이 기존 데이터를 DELETE 후 재삽입하는
    // 유일한 쓰기 지점이므로, 여기서 취소를 잡으면 기존 데이터가 무손상으로 남는다.
    if (signal.aborted) throw new PipelineCancelledError()

    tx()

    send({ meetingId, phase: 'merge', progress: 1 })
    send({ meetingId, phase: 'done', progress: 1, message: '처리 완료' })

    // transcribed=false면 폴백(엔진 미설치/빈 전사) → 호출측이 자동 요약을 건너뛴다
    return { success: true, transcribed: !isManualFallback }
  } catch (err) {
    // 취소는 일반 실패와 구분해 이전 상태로 복원한다. 어댑터가 취소를 일반 에러로 삼켜도
    // signal.aborted로 함께 판별하므로 취소가 'failed'로 오분류되지 않는다.
    if (signal.aborted || err instanceof PipelineCancelledError) {
      return restoreAfterCancel(db, meetingId, send)
    }
    const message = err instanceof Error ? err.message : String(err)
    db.prepare(
      "UPDATE meetings SET status = 'failed', error = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(message, meetingId)
    send({ meetingId, phase: 'error', error: message })
    return { success: false, error: message }
  } finally {
    // 완료/실패/취소 어느 경로든 레지스트리에서 해제해 재처리가 가능하게 한다.
    endPipeline(meetingId)
  }
}
