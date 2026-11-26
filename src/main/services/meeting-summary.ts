// AI 요약 실행 인프라 — Claude Code 구독 OAuth 패턴 재사용 (ai-agent.ts 인프라)
// SSOT: docs/MEETING_RECORDING.md §6
//
// 녹음 종류(meetings.kind)에 따라 프롬프트/검증/저장만 SummarySpec으로 갈아끼운다.
// 회의=MEETING_SPEC(이 파일), 면접=INTERVIEW_SPEC(interview-summary.ts).
import { app } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { getDatabase } from '../db/database'
import { logActivity } from '../utils/activity-logger'
import { INTERVIEW_SPEC } from './interview-summary'
import { listMarks } from './meeting-marks'
import {
  buildOutputKeys,
  buildTemplateBlock,
  getTemplate,
  resolveTemplate,
  type MeetingTemplate
} from './meeting-templates'
import { parseJsonArray } from './meeting-notes'
import { buildMarksBlock, buildSummaryContextBlock, loadPromptContext } from './recognition-aids'
import type {
  SendStream,
  MeetingSummaryResult,
  SummaryTextItem,
  SummaryTopic
} from './meeting-types'
import { parseTimestamp, type SummarySpec } from './summary-spec'
import { WRITING_STYLE_JSON_NOTE, WRITING_STYLE_RULES } from './writing-style'

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

// 길이 가드. 정제된 전사는 크게 줄어들지만, 장시간 회의는 여전히 한도를 넘을 수 있다.
// 한도 초과 시 앞부분만 자르면 회의 후반이 통째로 누락되므로, 시간순 라인을 균등
// 샘플링해 앞·중간·끝의 흐름을 모두 보존한다.
const MAX_TRANSCRIPT_CHARS = 80000

const SAMPLED_NOTICE = '\n\n(회의가 길어 시간 순서대로 균등 샘플링한 발췌본입니다 — 일부 발언은 생략됨)'

export interface FitTranscriptOptions {
  // lines[i]의 시작 시각(ms). keepRanges와 함께 쓴다.
  lineStartMs?: number[]
  // 이 구간([a, b], ms)에 시작하는 줄은 샘플링에서 빼지 않고 고정으로 넣는다(사용자 메모 주변).
  keepRanges?: Array<[number, number]>
  // 전사록 밖에 함께 보낼 블록(메모 블록 등)의 길이. 그만큼 전사 예산을 줄인다.
  reserveChars?: number
}

// 줄 번호 목록을 일정 간격으로 추출한다. 평균 줄 길이로 목표 줄 수를 추정한다.
function sampleEvenly(indices: number[], textLength: number, budget: number, minLines: number): number[] {
  if (indices.length === 0) return []
  const avgLen = textLength / indices.length
  const targetLines = Math.max(minLines, Math.floor(budget / avgLen))
  if (targetLines <= 0) return []
  const step = indices.length / targetLines
  const out: number[] = []
  for (let i = 0; i < indices.length; i += step) out.push(indices[Math.floor(i)])
  return out
}

export function fitTranscript(lines: string[], opts?: FitTranscriptOptions): string {
  const full = lines.join('\n')
  const budget = MAX_TRANSCRIPT_CHARS - Math.max(0, opts?.reserveChars ?? 0)
  if (full.length <= budget) return full

  const all = lines.map((_, i) => i)
  const ranges = opts?.keepRanges ?? []
  const startMs = opts?.lineStartMs
  if (ranges.length > 0 && startMs) {
    const pinned = new Set<number>()
    for (let i = 0; i < lines.length; i++) {
      const ms = startMs[i]
      if (typeof ms === 'number' && ranges.some(([a, b]) => ms >= a && ms <= b)) pinned.add(i)
    }
    let pinnedChars = 0
    for (const i of pinned) pinnedChars += lines[i].length + 1
    // 고정 줄만으로 예산을 넘으면 고정 없이 균등 샘플링으로 되돌아간다.
    if (pinned.size > 0 && pinnedChars <= budget) {
      const rest = all.filter((i) => !pinned.has(i))
      const restChars = rest.reduce((n, i) => n + lines[i].length + 1, 0)
      const picked = new Set([...pinned, ...sampleEvenly(rest, restChars, budget - pinnedChars, 0)])
      const ordered = all.filter((i) => picked.has(i)).map((i) => lines[i])
      return ordered.join('\n') + SAMPLED_NOTICE
    }
  }

  // 시간순 라인을 균등 샘플링해 앞·중간·끝의 흐름을 모두 보존한다.
  const sampled = sampleEvenly(all, full.length, budget, 1).map((i) => lines[i])
  return sampled.join('\n') + SAMPLED_NOTICE
}

// 시간 포맷 mm:ss
function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// zod 스키마 — MeetingSummaryResult 검증.
// 시각(at, start)은 전사 줄의 "mm:ss" 문자열로 받아 parseTimestamp로 ms 환산한다.
// decisions·open_questions는 구버전 응답(문자열 배열)도 받는다. 개수 하한은 프롬프트로만 요구하고
// 스키마로 강제하지 않는다(짧은 회의에서 요약 전체가 파싱 실패로 버려지지 않게).
const At = z.string().nullish()
const TextAtSchema = z.union([z.string(), z.object({ text: z.string(), at: At })])
const TopicSchema = z.object({
  title: z.string(),
  start: At,
  points: z.array(z.string()).default([])
})
const ActionItemSchema = z.object({
  text: z.string(),
  assignee: z.string().nullish(),
  due: z.string().nullish(),
  at: At
})

const SummarySchema = z.object({
  tldr: z.string().default(''),
  keywords: z.array(z.string()).default([]),
  topics: z.array(TopicSchema).default([]),
  decisions: z.array(TextAtSchema).default([]),
  action_items: z.array(ActionItemSchema).default([]),
  open_questions: z.array(TextAtSchema).default([]),
  key_points: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).default([])
})

const MAX_KEYWORDS = 10
const MAX_TOPICS = 12
const MAX_TOPIC_POINTS = 8

function cleanStrings(items: string[]): string[] {
  return items.map((s) => s.trim()).filter(Boolean)
}

function toTextItems(items: z.infer<typeof TextAtSchema>[]): SummaryTextItem[] {
  return items
    .map((it) =>
      typeof it === 'string'
        ? { text: it.trim(), at_ms: null }
        : { text: it.text.trim(), at_ms: parseTimestamp(it.at) }
    )
    .filter((it) => it.text)
}

function toKeywords(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const k = raw.trim().replace(/^#+/, '').trim()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(k)
    if (out.length >= MAX_KEYWORDS) break
  }
  return out
}

function toTopics(items: z.infer<typeof TopicSchema>[]): SummaryTopic[] {
  const topics = items
    .map((t) => ({
      title: t.title.trim(),
      start_ms: parseTimestamp(t.start),
      points: cleanStrings(t.points).slice(0, MAX_TOPIC_POINTS)
    }))
    .filter((t) => t.title)
  // 시각이 모두 있을 때만 시간순으로 맞춘다. 일부가 null이면 모델이 준 순서를 믿는다.
  if (topics.every((t) => t.start_ms != null)) {
    topics.sort((a, b) => (a.start_ms as number) - (b.start_ms as number))
  }
  return topics.slice(0, MAX_TOPICS)
}

// 프롬프트의 "출력 키" 블록. 회의 형식(템플릿)별 힌트는 meeting-templates.ts의 buildOutputKeys가 끼운다.
export { MEETING_OUTPUT_KEYS } from './meeting-templates'

const MEETING_PRINCIPLES = `원칙
- 전사록에 없는 내용을 만들지 마세요. 불확실하면 해당 배열을 비우거나 값을 null로 두세요.
- 시각(start, at)은 근거가 되는 전사 줄의 대괄호 안 "mm:ss"를 그대로 복사하세요. 시각을 계산하거나 추정하지 마세요. 근거 줄을 찾지 못하면 null로 두세요.
- 화자명이 "화자 1", "화자 2" 같은 기본 라벨이면, 그 화자의 실제 이름을 추측하지 마세요. 기본 라벨을 문장의 주어나 assignee로 쓰지 마세요. 화자 라벨이 1개여도 여러 사람이 말했을 수 있습니다.
- assignee는 전사록에서 담당자가 이름으로 드러날 때만 채우세요. [참고 정보]의 참석자 이름은 표기를 맞추는 데만 쓰세요. 담당자가 드러나지 않으면 null로 두세요.
- 같은 내용을 여러 키에 반복하지 마세요. 확정된 것은 decisions, 누군가 할 일은 action_items, 결론이 나지 않은 것은 open_questions에만 넣으세요.
- [사용자 메모]는 사용자가 회의 중 중요하다고 표시한 지점입니다. 메모는 보통 발언보다 늦게 적히므로 각 메모 시각 앞 90초~뒤 10초의 전사를 먼저 보세요. 그 논의를 topics·decisions·action_items·open_questions 중 알맞은 곳에 반영하세요. 메모 문구를 사실로 단정하지 말고 전사록에서 근거를 찾으세요. 시각은 메모 시각이 아니라 근거 전사 줄에서 복사하세요.`

// ── 액션아이템 할 일 연결 승계 ──
// 재요약하면 action_items가 새로 만들어져, 이미 할 일로 옮긴 항목의 todo_id가 사라진다.
// 공백·문장부호·기호를 뺀 문장이 같은 항목끼리 todo_id를 옮겨 준다.
function normalizeActionText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

export function carryTodoIds<T extends { text: string; todo_id?: number | null }>(prev: T[], next: T[]): T[] {
  const used = new Set<number>()
  const candidates = prev
    .map((p, index) => ({
      index,
      key: typeof p?.text === 'string' ? normalizeActionText(p.text) : '',
      todoId: p?.todo_id
    }))
    .filter((c): c is { index: number; key: string; todoId: number } => typeof c.todoId === 'number' && c.key !== '')
  return next.map((item) => {
    if (typeof item.todo_id === 'number') return item
    const key = normalizeActionText(item.text ?? '')
    if (!key) return item
    const hit = candidates.find((c) => !used.has(c.index) && c.key === key)
    if (!hit) return item
    used.add(hit.index)
    return { ...item, todo_id: hit.todoId }
  })
}

// ── 회의 요약 스펙 (kind='meeting') ──
// 면접 전용 4분류는 빈 배열로 덮어써, 종류를 바꿔 재요약했을 때 이전 종류의
// 잔여 데이터가 남지 않게 한다 (INTERVIEW_SPEC.persist와 대칭).
// key_points·next_steps는 주제별 요약·액션아이템·미결 질문으로 흡수했으므로 새 요약은 [].
// 회의 형식(템플릿)마다 프롬프트의 [회의 형식] 블록과 출력 키 힌트만 다르다. persist는 template_id에
// 그 형식 id를 남긴다.
export function buildMeetingSpec(t: MeetingTemplate): SummarySpec<MeetingSummaryResult> {
  const templateBlock = buildTemplateBlock(t)
  return {
    systemPrompt: `회의 전사록을 분석해 한국어로 JSON만 출력하세요.

전사록의 각 줄은 "[mm:ss] 화자명: 발언" 형식입니다. mm은 60을 넘을 수 있습니다.

${MEETING_PRINCIPLES}

${templateBlock ? `${templateBlock}\n\n` : ''}${buildOutputKeys(t)}

${WRITING_STYLE_RULES}
${WRITING_STYLE_JSON_NOTE}
keywords 와 title 은 문장이 아닌 명사구다. 이 2개 필드에는 글쓰기 규칙의 문장 규칙을 적용하지 않는다.

코드펜스 없이 순수 JSON만 출력하세요.`,

    buildPrompt: (transcript, contextBlock) =>
      `${contextBlock ? `${contextBlock}\n\n` : ''}다음 회의 전사록을 분석해 JSON으로 요약하세요:\n\n${transcript}`,

    progressMessage: 'AI 요약 생성 중…',

    validate: (raw) => {
      const v = SummarySchema.parse(raw)
      return {
        tldr: v.tldr.trim(),
        keywords: toKeywords(v.keywords),
        topics: toTopics(v.topics),
        decisions: toTextItems(v.decisions),
        action_items: v.action_items
          .map((item) => ({
            text: item.text.trim(),
            assignee: item.assignee?.trim() || null,
            due: item.due?.trim() || null,
            at_ms: parseTimestamp(item.at)
          }))
          .filter((item) => item.text),
        open_questions: toTextItems(v.open_questions),
        key_points: cleanStrings(v.key_points),
        next_steps: cleanStrings(v.next_steps)
      }
    },

    persist: (db, meetingId, parsed, model) => {
      // 재요약이면 기존 action_items의 todo_id(할 일 연결)를 같은 문장의 새 항목으로 옮긴다.
      const prevRow = db
        .prepare('SELECT action_items FROM meeting_summaries WHERE meeting_id = ?')
        .get(meetingId) as { action_items: string | null } | undefined
      const prevItems = parseJsonArray<{ text: string; todo_id?: number | null }>(prevRow?.action_items)
      const actionItems = carryTodoIds<{ text: string; todo_id?: number | null }>(prevItems, parsed.action_items)
      db.prepare(
        `INSERT INTO meeting_summaries
           (meeting_id, tldr, key_points, decisions, action_items, next_steps,
            topics, open_questions, keywords,
            qa_pairs, competencies, follow_ups, fact_checks, model, template_id, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', ?, ?, datetime('now','localtime'))
         ON CONFLICT(meeting_id) DO UPDATE SET
           tldr = excluded.tldr,
           key_points = excluded.key_points,
           decisions = excluded.decisions,
           action_items = excluded.action_items,
           next_steps = excluded.next_steps,
           topics = excluded.topics,
           open_questions = excluded.open_questions,
           keywords = excluded.keywords,
           qa_pairs = excluded.qa_pairs,
           competencies = excluded.competencies,
           follow_ups = excluded.follow_ups,
           fact_checks = excluded.fact_checks,
           model = excluded.model,
           template_id = excluded.template_id,
           generated_at = excluded.generated_at`
      ).run(
        meetingId,
        parsed.tldr,
        JSON.stringify(parsed.key_points),
        JSON.stringify(parsed.decisions),
        JSON.stringify(actionItems),
        JSON.stringify(parsed.next_steps),
        JSON.stringify(parsed.topics),
        JSON.stringify(parsed.open_questions),
        JSON.stringify(parsed.keywords),
        model,
        t.id
      )
    }
  }
}

// 기본 형식의 회의 요약 스펙. 테스트가 공통 글쓰기 규칙 포함 여부를 확인할 수 있도록 export 한다.
export const MEETING_SPEC: SummarySpec<MeetingSummaryResult> = buildMeetingSpec(getTemplate('default'))

// 응답에서 JSON 블록 추출 (코드펜스 ```json … ``` 허용)
export function extractJson(text: string): string {
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

// 전사 직렬화에 필요한 최소 필드 (실측 테스트가 DB 행을 그대로 넘길 수 있게 좁게 둔다)
export type TranscriptSegment = Pick<SegmentRow, 'start_ms' | 'text' | 'label' | 'display_name'>

// 전사 텍스트 직렬화: [mm:ss] 화자명: 텍스트 (빈 발언 제외). startMs[i]는 lines[i]의 시작 시각이다.
export function formatTranscriptLinesWithMs(segments: TranscriptSegment[]): {
  lines: string[]
  startMs: number[]
} {
  const lines: string[] = []
  const startMs: number[] = []
  for (const s of segments) {
    if (!s.text.trim()) continue
    const speakerName = s.display_name || s.label || '화자'
    lines.push(`[${formatTime(s.start_ms)}] ${speakerName}: ${s.text.trim()}`)
    startMs.push(s.start_ms)
  }
  return { lines, startMs }
}

export function formatTranscriptLines(segments: TranscriptSegment[]): string[] {
  return formatTranscriptLinesWithMs(segments).lines
}

export const SUMMARY_MODEL = 'claude-opus-5-5'

export async function runMeetingSummary(
  meetingId: number,
  send: SendStream
): Promise<{ success: boolean; error?: string }> {
  const db = getDatabase()

  // 녹음 종류에 따라 요약 스펙 선택 (기본=회의). 회의는 지정한 형식, 없으면 제목으로 형식을 고른다.
  // 제목은 활동 기록에도 쓴다.
  const kindRow = db
    .prepare('SELECT kind, title, summary_template FROM meetings WHERE id = ?')
    .get(meetingId) as { kind: string; title: string | null; summary_template: string | null } | undefined
  const spec: SummarySpec<unknown> =
    kindRow?.kind === 'interview'
      ? (INTERVIEW_SPEC as SummarySpec<unknown>)
      : (buildMeetingSpec(resolveTemplate(kindRow?.summary_template, kindRow?.title)) as SummarySpec<unknown>)

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

  const { lines, startMs } = formatTranscriptLinesWithMs(segments)
  const transcriptRaw = lines.join('\n')

  if (!transcriptRaw.trim()) {
    const err = '전사 텍스트가 비어 있습니다. 전사 내용을 확인해 주세요.'
    send({ meetingId, phase: 'error', error: err })
    return { success: false, error: err }
  }

  // 회의 중 남긴 메모·북마크. 메모 블록 길이만큼 전사 예산을 비우고, 메모 주변(앞 90초~뒤 10초)
  // 전사 줄은 샘플링에서 빼지 않는다.
  const marks = listMarks(db, meetingId)
  const marksBlock = buildMarksBlock(marks)
  const transcript = fitTranscript(lines, {
    lineStartMs: startMs,
    keepRanges: marks.map((m) => [m.at_ms - 90_000, m.at_ms + 10_000] as [number, number]),
    reserveChars: marksBlock.length
  })

  // ── 2. Claude query ──
  send({ meetingId, phase: 'summarize', progress: 0, message: spec.progressMessage })

  const systemPrompt = spec.systemPrompt
  // 사용자가 등록한 참석자·용어를 전사록 앞에 [참고 정보]로 붙인다. 표기 통일과 담당자
  // 매칭에만 쓰이며, 없으면 ''이라 프롬프트가 그대로다.
  // (프라이버시: 이 단계에서 참석자 이름과 용어, 사용자 메모가 전사록과 함께 Claude로 전송된다.)
  const contextBlock = [buildSummaryContextBlock(loadPromptContext(db, meetingId)), marksBlock]
    .filter(Boolean)
    .join('\n\n')
  const prompt = spec.buildPrompt(transcript, contextBlock)

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
        model: SUMMARY_MODEL,
        maxTurns: 3,
        mcpServers: {},
        // tools: [] 가 내장 도구 전부를 끈다. allowedTools: [] 만으로는 기본 도구가 남는다.
        tools: [],
        allowedTools: [],
        disallowedTools: ['Bash', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Task'],
        settingSources: [],
        env: sanitizedEnv(),
        cwd: app.getPath('userData'),
        pathToClaudeCodeExecutable: claudePath
      }
    })

    type SdkMsg = import('@anthropic-ai/claude-agent-sdk').SDKMessage
    // Claude 응답은 토큰 단위 진행률을 알 수 없어, 메시지 수신마다 진행률을 점진적으로 올린다.
    let streamProgress = 0.1
    for await (const msg of q as AsyncIterable<SdkMsg>) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            responseText += block.text
          }
        }
        streamProgress = Math.min(0.7, streamProgress + 0.15)
        send({ meetingId, phase: 'summarize', progress: streamProgress, message: spec.progressMessage })
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

  // ── 3. JSON 파싱 + zod 검증 (스펙별) ──
  let parsed: unknown
  try {
    const jsonStr = extractJson(responseText)
    parsed = spec.validate(JSON.parse(jsonStr))
  } catch (err) {
    const parseErr = err instanceof Error ? err.message : String(err)
    const friendly = `AI 응답 파싱에 실패했습니다: ${parseErr}\n\n원본 응답:\n${responseText.slice(0, 500)}`
    send({ meetingId, phase: 'error', error: friendly })
    return { success: false, error: friendly }
  }

  // ── 4. meeting_summaries UPSERT (스펙별) ──
  spec.persist(db, meetingId, parsed, SUMMARY_MODEL)

  db.prepare(
    "UPDATE meetings SET status = 'summarized', updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(meetingId)

  // 비서가 새 액션아이템을 반영하도록 활동을 기록한다 (assistant-scheduler 가 구독).
  logActivity('meeting', 'update', meetingId, kindRow?.title ?? undefined, '요약 생성')

  send({ meetingId, phase: 'done', progress: 1, message: '요약 완료' })
  return { success: true }
}
