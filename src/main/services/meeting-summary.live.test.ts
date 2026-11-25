// 회의 요약 프롬프트 실측 — 실제 회의 전사로 claude CLI 를 불러 출력 형식을 단언한다.
// 평소에는 건너뛴다. 실행: LINKWORK_LIVE_SUMMARY_ID=<회의 id> npx vitest run src/main/services/meeting-summary.live.test.ts
// DB 는 sqlite3 -readonly 로만 읽는다. 응답 본문은 어디에도 쓰지 않고 개수·비율만 출력한다.
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, writeSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

// meeting-summary.ts 의 import 체인(electron·better-sqlite3)을 끊는다. 이 테스트는 순수 함수만 쓴다.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/linkwork-live-test' } }))
vi.mock('../db/database', () => ({ getDatabase: () => undefined }))
vi.mock('../utils/activity-logger', () => ({ logActivity: () => undefined }))
vi.mock('./recognition-aids', () => ({
  loadPromptContext: () => ({}),
  buildSummaryContextBlock: () => ''
}))

import { MEETING_SPEC, SUMMARY_MODEL, extractJson, fitTranscript, formatTranscriptLines } from './meeting-summary'

const MEETING_ID = process.env.LINKWORK_LIVE_SUMMARY_ID
const DB_PATH =
  process.env.LINKWORK_DB ?? join(homedir(), 'Library', 'Application Support', 'linkwork', 'linkwork.db')
const TIMEOUT_MS = 300_000
const DEFAULT_LABEL = /^화자 ?\d+$/

function findClaude(): string | undefined {
  return [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(
    (p) => existsSync(p)
  )
}

function sqliteJson<T>(sql: string): T[] {
  const out = execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', DB_PATH, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  return out.trim() ? (JSON.parse(out) as T[]) : []
}

function clockToMs(clock: string): number {
  const [m, s] = clock.split(':').map(Number)
  return (m * 60 + s) * 1000
}

describe.skipIf(!MEETING_ID)('회의 요약 실측 (LINKWORK_LIVE_SUMMARY_ID)', () => {
  it(
    '실제 전사로 요약하면 새 형식의 개수·시각·담당자 규칙을 지킨다',
    () => {
      const id = Number(MEETING_ID)
      expect(Number.isInteger(id)).toBe(true)

      const meeting = sqliteJson<{ duration_ms: number }>(`SELECT duration_ms FROM meetings WHERE id = ${id}`)[0]
      expect(meeting, `meeting ${id} 가 DB 에 없다`).toBeDefined()
      const durationMs = meeting.duration_ms

      const segments = sqliteJson<{
        start_ms: number
        end_ms: number
        text: string
        label: string | null
        display_name: string | null
      }>(
        `SELECT s.start_ms, s.end_ms, s.text, sp.label, sp.display_name
         FROM meeting_segments s LEFT JOIN meeting_speakers sp ON s.speaker_id = sp.id
         WHERE s.meeting_id = ${id} ORDER BY s.start_ms, s.sort_order`
      )
      expect(segments.length).toBeGreaterThan(0)

      const transcript = fitTranscript(formatTranscriptLines(segments))
      // 모델이 실제로 본 줄의 시각 집합
      const lineTimes = new Set(Array.from(transcript.matchAll(/^\[(\d+:\d{2})\]/gm), (m) => clockToMs(m[1])))

      const claude = findClaude()
      expect(claude, 'claude CLI 를 찾지 못했다').toBeDefined()
      const env = { ...process.env }
      for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
        delete env[k]
      }
      const started = Date.now()
      const proc = spawnSync(
        claude as string,
        [
          '-p',
          '--system-prompt',
          MEETING_SPEC.systemPrompt,
          '--model',
          SUMMARY_MODEL,
          '--tools',
          '',
          '--setting-sources',
          ''
        ],
        { input: MEETING_SPEC.buildPrompt(transcript, ''), encoding: 'utf8', timeout: TIMEOUT_MS, env, maxBuffer: 16 * 1024 * 1024 }
      )
      const elapsedSec = Math.round((Date.now() - started) / 1000)
      expect(proc.error, `claude 실행 실패: ${proc.error?.message}`).toBeUndefined()
      expect(proc.status, `claude 종료 코드 ${proc.status}: ${(proc.stderr ?? '').slice(0, 300)}`).toBe(0)

      const parsed = MEETING_SPEC.validate(JSON.parse(extractJson(proc.stdout)))

      const times: number[] = [
        ...parsed.topics.map((t) => t.start_ms),
        ...parsed.decisions.map((d) => d.at_ms),
        ...parsed.action_items.map((a) => a.at_ms ?? null),
        ...parsed.open_questions.map((q) => q.at_ms)
      ].filter((t): t is number => t !== null)
      const matched = times.filter((t) => lineTimes.has(t)).length
      const matchRatio = times.length === 0 ? 1 : matched / times.length
      const topicStarts = parsed.topics.map((t) => t.start_ms).filter((t): t is number => t !== null)
      const defaultAssignees = parsed.action_items.filter((a) => a.assignee && DEFAULT_LABEL.test(a.assignee.trim()))
      const minPoints = Math.min(...parsed.topics.map((t) => t.points.length))

      // 개수·비율만 출력한다(응답 본문 금지). vitest 의 console 가로채기를 피해 stderr 에 직접 쓴다.
      writeSync(
        2,
        `[live-summary] ${JSON.stringify({
          meetingId: id,
          model: SUMMARY_MODEL,
          elapsedSec,
          segments: segments.length,
          transcriptChars: transcript.length,
          keywords: parsed.keywords.length,
          topics: parsed.topics.length,
          minPoints,
          decisions: parsed.decisions.length,
          actionItems: parsed.action_items.length,
          openQuestions: parsed.open_questions.length,
          keyPoints: parsed.key_points.length,
          nextSteps: parsed.next_steps.length,
          nonNullTimes: times.length,
          nullTimes:
            parsed.topics.length +
            parsed.decisions.length +
            parsed.action_items.length +
            parsed.open_questions.length -
            times.length,
          timesOnTranscriptLine: matched,
          matchRatio: Number(matchRatio.toFixed(3)),
          topicStartsSorted: topicStarts.every((t, i) => i === 0 || topicStarts[i - 1] <= t),
          defaultLabelAssignees: defaultAssignees.length
        })}\n`
      )

      expect(parsed.topics.length).toBeGreaterThanOrEqual(3)
      expect(parsed.topics.length).toBeLessThanOrEqual(8)
      expect(minPoints).toBeGreaterThanOrEqual(2)
      expect(parsed.keywords.length).toBeGreaterThanOrEqual(5)
      expect(parsed.keywords.length).toBeLessThanOrEqual(10)
      for (const t of times) {
        expect(t).toBeGreaterThanOrEqual(0)
        expect(t).toBeLessThanOrEqual(durationMs)
      }
      expect(matchRatio).toBeGreaterThanOrEqual(0.9)
      expect(topicStarts.every((t, i) => i === 0 || topicStarts[i - 1] <= t)).toBe(true)
      expect(defaultAssignees.length).toBe(0)
    },
    TIMEOUT_MS + 60_000
  )
})
