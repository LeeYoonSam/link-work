// 회의 녹음 파이프라인: STT → VAD → Diarization → merge → DB 저장
// SSOT: docs/MEETING_RECORDING.md §5
import { app } from 'electron'
import { join } from 'path'
import { getDatabase } from '../db/database'
import type { SendStream, SttSegment, DiarTurn } from './meeting-types'
import { getSttAdapter } from './stt/index'
import { GapAdapter } from './vad/gap-adapter'
import { getVadAdapter } from './vad/index'
import { getDiarizationAdapter } from './diarization/index'
import { ChannelAdapter } from './diarization/channel-adapter'

// 화자 색상 팔레트 (순환)
const SPEAKER_COLORS = [
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
  audio_path: string | null
  audio_mime: string
  duration_ms: number
  language: string
  source: string
  status: string
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
 * mic → '나', system → '상대', spk_N → '화자 N+1'
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
  return {
    label: `화자 ${index + 1}`,
    color: SPEAKER_COLORS[index % SPEAKER_COLORS.length]
  }
}

export async function runMeetingPipeline(
  meetingId: number,
  send: SendStream
): Promise<{ success: boolean; error?: string; transcribed?: boolean }> {
  const db = getDatabase()

  // ── 1. meetings 행 로드 ──
  const meeting = db
    .prepare('SELECT * FROM meetings WHERE id = ?')
    .get(meetingId) as MeetingRow | undefined

  if (!meeting) {
    const err = '회의를 찾을 수 없습니다.'
    send({ meetingId, phase: 'error', error: err })
    return { success: false, error: err }
  }

  if (!meeting.audio_path) {
    const err = '오디오 파일이 없습니다. 먼저 녹음을 완료해 주세요.'
    db.prepare(
      "UPDATE meetings SET status = 'failed', error = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(err, meetingId)
    send({ meetingId, phase: 'error', error: err })
    return { success: false, error: err }
  }

  const audioPath = join(app.getPath('userData'), 'recordings', meeting.audio_path)

  try {
    // ── 2. STT 전사 ──
    send({ meetingId, phase: 'transcribe', progress: 0, message: '음성 인식 중…' })

    const sttAdapter = await getSttAdapter()
    let rawSegments: SttSegment[] = []

    rawSegments = await sttAdapter.transcribe(audioPath, {
      language: meeting.language || 'ko',
      onProgress: (p) => {
        send({ meetingId, phase: 'transcribe', progress: p })
      },
      onMessage: (m) => {
        send({ meetingId, phase: 'transcribe', message: m })
      }
    })

    // manual 어댑터(엔진 미설치) 또는 결과 없음 → 안내 segment 삽입
    const isManualFallback = sttAdapter.name === 'manual' || rawSegments.length === 0

    if (isManualFallback && sttAdapter.name === 'manual') {
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

    // ── 4. 화자 분리 ──
    send({ meetingId, phase: 'diarize', progress: 0, message: '화자 분리 중…' })

    const diarAdapter = await getDiarizationAdapter(meeting.source)
    let turns: DiarTurn[] = []

    try {
      turns = await diarAdapter.diarize(audioPath, { minSpeakers: 1, maxSpeakers: 4 })
    } catch {
      turns = []
    }

    // channel 어댑터가 빈 결과를 반환하면 STT segments 기반으로 보완
    if (turns.length === 0 && diarAdapter instanceof ChannelAdapter) {
      turns = ChannelAdapter.buildFromSegments(rawSegments, meeting.source)
    }

    // turns도 비어 있으면 전체를 spk_0으로 단일화자 처리
    send({ meetingId, phase: 'diarize', progress: 1, message: `${new Set(turns.map((t) => t.speaker_key)).size}명 화자 감지` })

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

      // duration 보정: 마지막 segment end_ms 또는 기존 duration 중 큰 값
      const lastSegEnd =
        rawSegments.length > 0
          ? Math.max(...rawSegments.map((s) => s.end_ms))
          : 0
      const duration = Math.max(meeting.duration_ms, lastSegEnd)

      db.prepare(
        `UPDATE meetings
         SET status = 'transcribed', duration_ms = ?, error = NULL,
             updated_at = datetime('now','localtime')
         WHERE id = ?`
      ).run(duration, meetingId)
    })

    tx()

    send({ meetingId, phase: 'merge', progress: 1 })
    send({ meetingId, phase: 'done', progress: 1, message: '처리 완료' })

    // transcribed=false면 폴백(엔진 미설치/빈 전사) → 호출측이 자동 요약을 건너뛴다
    return { success: true, transcribed: !isManualFallback }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    db.prepare(
      "UPDATE meetings SET status = 'failed', error = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(message, meetingId)
    send({ meetingId, phase: 'error', error: message })
    return { success: false, error: message }
  }
}
