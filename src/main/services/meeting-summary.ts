// AI 회의 요약 — Claude Code 구독 OAuth 패턴 재사용 (ai-agent.ts 인프라)
// SSOT: docs/MEETING_RECORDING.md §6
import { app } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { getDatabase } from '../db/database'
import type { SendStream, MeetingSummaryResult } from './meeting-types'

// ── ai-agent.ts와 동일한 인증/환경 패턴 복제 (ai-agent.ts 수정 금지) ──

const BILLING_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX'
]

function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !BILLING_ENV_VARS.includes(key)) {
      env[key] = value
    }
  }
  return env
}

function findClaudeExecutable(): string | undefined {
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(homedir(), '.local/bin/claude'),
    join(homedir(), '.claude/local/claude')
  ]
  return candidates.find((p) => existsSync(p))
}

// SDK lazy load (ESM-only)
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')
let sdkPromise: Promise<SdkModule> | null = null
function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk')
  return sdkPromise
}

// ai-agent.ts의 toFriendlyError 패턴 복제
function toFriendlyError(raw: string): string {
  if (/not logged in/i.test(raw)) {
    return 'Claude Code에 로그인되어 있지 않습니다. 터미널에서 `claude`를 실행해 로그인(/login)한 뒤 다시 시도해 주세요.'
  }
  if (/(native binary|executable) not found|ENOENT/i.test(raw)) {
    return 'Claude Code가 설치되어 있지 않습니다. AI 요약 기능을 사용하려면 Claude Code 설치 및 로그인이 필요합니다. (https://claude.com/claude-code)'
  }
  if (/credit balance|billing|payment/i.test(raw)) {
    return 'Claude 계정의 사용 한도/결제 상태를 확인해 주세요.'
  }
  if (/rate limit|overloaded|429/i.test(raw)) {
    return '사용량 한도에 도달했거나 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.'
  }
  return raw
}

// 길이 가드: 24000자 초과 시 앞부분 우선 절단
const MAX_TRANSCRIPT_CHARS = 24000
const TRUNCATION_SUFFIX = '\n\n(이하 생략 — 원본이 너무 길어 앞부분만 분석합니다)'

function truncateTranscript(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text
  return text.slice(0, MAX_TRANSCRIPT_CHARS) + TRUNCATION_SUFFIX
}

// 시간 포맷 mm:ss
function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// zod 스키마 — MeetingSummaryResult 검증
const ActionItemSchema = z.object({
  text: z.string(),
  assignee: z.string().nullish(),
  due: z.string().nullish()
})

const SummarySchema = z.object({
  tldr: z.string().default(''),
  key_points: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  action_items: z.array(ActionItemSchema).default([]),
  next_steps: z.array(z.string()).default([])
})

// 응답에서 JSON 블록 추출 (코드펜스 ```json … ``` 허용)
function extractJson(text: string): string {
  // ```json ... ``` 또는 ``` ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  // 중괄호로 시작하는 JSON 블록 직접 탐색
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1)
  }
  return text.trim()
}

interface SegmentRow {
  start_ms: number
  end_ms: number
  text: string
  label: string | null
  display_name: string | null
}

export async function runMeetingSummary(
  meetingId: number,
  send: SendStream
): Promise<{ success: boolean; error?: string }> {
  const db = getDatabase()

  // ── 1. 전사 로드 ──
  const segments = db
    .prepare(
      `SELECT s.start_ms, s.end_ms, s.text,
              sp.label, sp.display_name
       FROM meeting_segments s
       LEFT JOIN meeting_speakers sp ON s.speaker_id = sp.id
       WHERE s.meeting_id = ?
       ORDER BY s.start_ms, s.sort_order`
    )
    .all(meetingId) as SegmentRow[]

  if (segments.length === 0) {
    const err = '전사 내용이 없습니다. 먼저 녹음을 처리(전사)해 주세요.'
    send({ meetingId, phase: 'error', error: err })
    return { success: false, error: err }
  }

  // 전사 텍스트 직렬화: [mm:ss] 화자명: 텍스트
  const lines = segments
    .filter((s) => s.text.trim())
    .map((s) => {
      const speakerName = s.display_name || s.label || '화자'
      return `[${formatTime(s.start_ms)}] ${speakerName}: ${s.text.trim()}`
    })
  const transcriptRaw = lines.join('\n')

  if (!transcriptRaw.trim()) {
    const err = '전사 텍스트가 비어 있습니다. 전사 내용을 확인해 주세요.'
    send({ meetingId, phase: 'error', error: err })
    return { success: false, error: err }
  }

  const transcript = truncateTranscript(transcriptRaw)

  // ── 2. Claude query ──
  send({ meetingId, phase: 'summarize', progress: 0, message: 'AI 요약 생성 중…' })

  const systemPrompt = `회의록을 분석해 한국어로 JSON만 출력하세요.
키: tldr(string), key_points(string[]), decisions(string[]), action_items({text, assignee?, due?}[]), next_steps(string[]).
회의에 없는 내용 생성 금지, 불확실하면 해당 배열을 비워두세요.
코드펜스 없이 순수 JSON만 출력하세요.`

  const prompt = `다음 회의 전사록을 분석해 JSON으로 요약하세요:\n\n${transcript}`

  const claudePath = findClaudeExecutable()

  if (!claudePath) {
    const err = toFriendlyError('native binary not found')
    send({ meetingId, phase: 'error', error: err })
    return { success: false, error: err }
  }

  let responseText = ''

  try {
    const { query } = await loadSdk()

    const q = query({
      prompt,
      options: {
        systemPrompt,
        model: 'claude-sonnet-4-6',
        maxTurns: 3,
        mcpServers: {},
        allowedTools: [],
        disallowedTools: ['Bash', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Task'],
        settingSources: [],
        env: sanitizedEnv(),
        cwd: app.getPath('userData'),
        pathToClaudeCodeExecutable: claudePath
      }
    })

    type SdkMsg = import('@anthropic-ai/claude-agent-sdk').SDKMessage
    for await (const msg of q as AsyncIterable<SdkMsg>) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            responseText += block.text
          }
        }
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success' && msg.result && !responseText) {
          responseText = msg.result
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const friendly = toFriendlyError(message)
    send({ meetingId, phase: 'error', error: friendly })
    return { success: false, error: friendly }
  }

  send({ meetingId, phase: 'summarize', progress: 0.8, message: 'JSON 파싱 중…' })

  // ── 3. JSON 파싱 + zod 검증 ──
  let parsed: MeetingSummaryResult
  try {
    const jsonStr = extractJson(responseText)
    const raw = JSON.parse(jsonStr)
    const validated = SummarySchema.parse(raw)
    parsed = {
      tldr: validated.tldr,
      key_points: validated.key_points,
      decisions: validated.decisions,
      action_items: validated.action_items.map((item) => ({
        text: item.text,
        assignee: item.assignee ?? null,
        due: item.due ?? null
      })),
      next_steps: validated.next_steps
    }
  } catch (err) {
    const parseErr = err instanceof Error ? err.message : String(err)
    const friendly = `AI 응답 파싱에 실패했습니다: ${parseErr}\n\n원본 응답:\n${responseText.slice(0, 500)}`
    send({ meetingId, phase: 'error', error: friendly })
    return { success: false, error: friendly }
  }

  // ── 4. meeting_summaries UPSERT ──
  db.prepare(
    `INSERT INTO meeting_summaries
       (meeting_id, tldr, key_points, decisions, action_items, next_steps, model, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(meeting_id) DO UPDATE SET
       tldr = excluded.tldr,
       key_points = excluded.key_points,
       decisions = excluded.decisions,
       action_items = excluded.action_items,
       next_steps = excluded.next_steps,
       model = excluded.model,
       generated_at = excluded.generated_at`
  ).run(
    meetingId,
    parsed.tldr,
    JSON.stringify(parsed.key_points),
    JSON.stringify(parsed.decisions),
    JSON.stringify(parsed.action_items),
    JSON.stringify(parsed.next_steps),
    'claude-sonnet-4-6'
  )

  db.prepare(
    "UPDATE meetings SET status = 'summarized', updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(meetingId)

  send({ meetingId, phase: 'done', progress: 1, message: '요약 완료' })
  return { success: true }
}
