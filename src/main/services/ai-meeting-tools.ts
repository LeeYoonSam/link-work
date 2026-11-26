// AI 채팅용 회의 기록 조회 도구 — search_meetings(여러 회의 검색), get_meeting_excerpt(한 회의의 요약·구간 원문).
//
// [가드레일] 읽기 전용·네트워크 없음 — docs/AI_GUARDRAILS.md
// 1. DB 는 읽기 전용 커넥션(getAiReadOnlyDatabase)만 쓴다. 핸들러는 결과만 만들고 상태를 바꾸지 않는다.
// 2. 오디오·목소리 데이터는 읽지 않는다. meetings.audio_path, meeting_speaker_voices.*,
//    member_voice_samples.* 는 SELECT 하지 않는다. 전사 텍스트와 요약만 돌려준다.
// 3. 입력은 zod 로 검증한다. SQL 은 바인딩 파라미터만 쓰고, LIKE 는 escapeLike + ESCAPE '\' 로 쓴다.
// 4. 결과 크기를 자른다: 검색 8,000자, 원문 12,000자, 원문 창 10분, 한 질의 누적 60,000자(ai-agent.ts).
// 5. 회의 원문·요약은 신뢰할 수 없는 입력이다. 그 안의 지시는 따르지 않도록 ai-agent.ts 시스템 프롬프트가 규칙을 둔다.
import { z } from 'zod'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { getAiReadOnlyDatabase } from '../db/database'
import { addDays, toLocalDateTime } from './assistant-day'
import { escapeLike, parseJsonArray, parseTextItems, parseTopics } from './meeting-notes'

type Db = import('better-sqlite3').Database
type SdkTool = typeof import('@anthropic-ai/claude-agent-sdk').tool

export const SEARCH_MAX_CHARS = 8_000
export const EXCERPT_MAX_CHARS = 12_000
export const EXCERPT_MAX_WINDOW_MS = 600_000
export const QUERY_BUDGET_CHARS = 60_000

const DEFAULT_RANGE_DAYS = 180
const MAX_RANGE_DAYS = 365
const MAX_MEETINGS = 8
const MAX_SPEAKERS = 6
const MAX_SNIPPETS = 4
const SEGMENT_HIT_CAP = 5
const TLDR_MAX = 300
const ITEM_MAX = 300
const SNIPPET_MAX = 240
const TRUNCATION_MARKER = '…'

// 요약 검색 열. src/main/ipc/meeting-notes.ipc.ts 의 SEARCH_COLUMNS 와 같은 목록이다(그 IPC 파일은 import 하지 않는다).
const SUMMARY_SEARCH_COLUMNS = [
  'm.title',
  's.tldr',
  's.key_points',
  's.decisions',
  's.action_items',
  's.next_steps',
  's.topics',
  's.open_questions',
  's.keywords',
  's.qa_pairs'
]

const SEARCHABLE_STATUSES = "m.status IN ('transcribed','summarized')"

export function recordingLink(meetingId: number, ms: number): string {
  return `linkwork://recording/${meetingId}/at/${Math.max(0, Math.round(ms))}`
}

function noteLink(meetingId: number): string {
  return `linkwork://note/${meetingId}`
}

// 전사 줄과 같은 mm:ss 표기(mm은 60을 넘을 수 있다)
function formatTime(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function cut(text: string | null | undefined, max: number): string {
  const t = (text ?? '').trim()
  return t.length > max ? t.slice(0, max) + TRUNCATION_MARKER : t
}

// 도구 결과 텍스트. 크기 판정도 이 직렬화로 한다.
function toText(data: unknown): string {
  return JSON.stringify(data, null, 1)
}

// ── search_meetings ──

export interface SearchMeetingsArgs {
  terms: string[]
  from?: string
  to?: string
  project_id?: number
  person?: string
  meeting_ids?: number[]
  include_interviews?: boolean
}

export interface MeetingSnippet {
  start_ms: number
  time: string
  speaker: string
  text: string
  link: string
}

export interface MeetingSearchHit {
  meeting_id: number
  title: string
  started_at: string | null
  kind: string
  project: string | null
  speakers: string[]
  tldr: string
  note_link: string
  snippets: MeetingSnippet[]
}

export interface SearchMeetingsResult {
  scope_applied: {
    from: string
    to: string
    project_id: number | null
    person: string | null
    include_interviews: boolean
  }
  meetings: MeetingSearchHit[]
  notice?: string
  hint?: string
}

function isDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

function resolveRange(
  args: SearchMeetingsArgs,
  now: Date
): { from: string; to: string; narrowed: boolean } {
  let to = isDate(args.to) ? args.to : toLocalDateTime(now).slice(0, 10)
  let from = isDate(args.from) ? args.from : addDays(to, -DEFAULT_RANGE_DAYS)
  if (from > to) [from, to] = [to, from]
  if (daysBetween(from, to) > MAX_RANGE_DAYS) {
    return { from: addDays(to, -MAX_RANGE_DAYS), to, narrowed: true }
  }
  return { from, to, narrowed: false }
}

function cleanTerms(terms: unknown): string[] {
  if (!Array.isArray(terms)) return []
  const out: string[] = []
  for (const raw of terms) {
    if (typeof raw !== 'string') continue
    const t = raw.trim().slice(0, 40)
    if (t && !out.includes(t)) out.push(t)
    if (out.length >= 6) break
  }
  return out
}

interface CandidateRow {
  id: number
  title: string | null
  started_at: string | null
  kind: string
  project: string | null
  tldr: string | null
  seg_hits: number
  [key: string]: unknown
}

// 매칭 세그먼트와 앞뒤 1개를 이어 240자로 만든다. 매칭 세그먼트를 먼저 살리고 남는 자리를 앞뒤에 나눈다.
function joinContext(prev: string, cur: string, next: string): string {
  if (cur.length >= SNIPPET_MAX) return cur.slice(0, SNIPPET_MAX) + TRUNCATION_MARKER
  const room = SNIPPET_MAX - cur.length
  const prevWant = prev ? prev.length + 1 : 0
  const nextWant = next ? next.length + 1 : 0
  // 앞뒤에 반씩 나누고, 한쪽이 짧으면 남는 자리를 다른 쪽에 준다(구분 공백 1자 포함).
  const prevRoom = Math.min(prevWant, Math.max(Math.floor(room / 2), room - nextWant))
  const nextRoom = Math.min(nextWant, room - prevRoom)
  const prevPart = prevRoom >= prevWant ? prev : prevRoom > 1 ? prev.slice(prev.length - (prevRoom - 1)) : ''
  const nextPart = nextRoom >= nextWant ? next : nextRoom > 1 ? next.slice(0, nextRoom - 1) : ''
  return [prevPart, cur, nextPart].filter(Boolean).join(' ')
}

export function searchMeetings(db: Db, args: SearchMeetingsArgs, now: Date = new Date()): SearchMeetingsResult {
  const terms = cleanTerms(args?.terms)
  const { from, to, narrowed } = resolveRange(args ?? { terms: [] }, now)
  const includeInterviews = args?.include_interviews === true
  const projectId = typeof args?.project_id === 'number' ? args.project_id : null
  const person = typeof args?.person === 'string' && args.person.trim() ? args.person.trim().slice(0, 50) : null
  const scope_applied = { from, to, project_id: projectId, person, include_interviews: includeInterviews }
  const notices: string[] = []
  if (narrowed) notices.push('기간이 길어 최근 365일로 좁혔습니다.')

  const empty = (): SearchMeetingsResult => ({
    scope_applied,
    meetings: [],
    ...(notices.length > 0 ? { notice: notices.join(' ') } : {}),
    hint: '다른 표현·더 넓은 기간으로 다시 검색'
  })
  if (terms.length === 0) return empty()

  const where: string[] = [SEARCHABLE_STATUSES, 'm.started_at >= ?', 'm.started_at < ?']
  const whereParams: unknown[] = [`${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`]
  if (!includeInterviews) where.push("m.kind = 'meeting'")
  if (projectId !== null) {
    where.push('m.project_id = ?')
    whereParams.push(projectId)
  }
  if (person) {
    const p = `%${escapeLike(person)}%`
    where.push(
      `(EXISTS (SELECT 1 FROM meeting_speakers sp WHERE sp.meeting_id = m.id AND sp.display_name LIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM meeting_attendees a JOIN meeting_members mm ON mm.id = a.member_id
                   WHERE a.meeting_id = m.id AND mm.name LIKE ? ESCAPE '\\'))`
    )
    whereParams.push(p, p)
  }
  const ids = Array.isArray(args?.meeting_ids)
    ? args.meeting_ids.filter((n) => Number.isInteger(n)).slice(0, 50)
    : []
  if (ids.length > 0) {
    where.push(`m.id IN (${ids.map(() => '?').join(', ')})`)
    whereParams.push(...ids)
  }

  const patterns = terms.map((t) => `%${escapeLike(t)}%`)
  const selectParams: unknown[] = []
  const termCols: string[] = []
  patterns.forEach((p, i) => {
    const ors = SUMMARY_SEARCH_COLUMNS.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')
    termCols.push(`COALESCE((${ors}), 0) AS s${i}`)
    for (let k = 0; k < SUMMARY_SEARCH_COLUMNS.length; k++) selectParams.push(p)
    termCols.push(
      `EXISTS (SELECT 1 FROM meeting_segments g WHERE g.meeting_id = m.id AND g.text LIKE ? ESCAPE '\\') AS g${i}`
    )
    selectParams.push(p)
  })
  const anySeg = patterns.map(() => `g.text LIKE ? ESCAPE '\\'`).join(' OR ')
  selectParams.push(...patterns)

  const rows = db
    .prepare(
      `SELECT m.id, m.title, m.started_at, m.kind, p.name AS project, s.tldr,
              ${termCols.join(',\n              ')},
              (SELECT COUNT(*) FROM meeting_segments g WHERE g.meeting_id = m.id AND (${anySeg})) AS seg_hits
         FROM meetings m
         LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
         LEFT JOIN projects p ON p.id = m.project_id
        WHERE ${where.join(' AND ')}`
    )
    .all(...selectParams, ...whereParams) as CandidateRow[]

  const scored = rows
    .map((r) => {
      let matched = 0
      let summaryHit = false
      for (let i = 0; i < terms.length; i++) {
        const s = Number(r[`s${i}`]) === 1
        const g = Number(r[`g${i}`]) === 1
        if (s) summaryHit = true
        if (s || g) matched++
      }
      const segHits = Number(r.seg_hits) || 0
      return { row: r, matched, score: matched * 3 + (summaryHit ? 2 : 0) + Math.min(segHits, SEGMENT_HIT_CAP) }
    })
    .filter((x) => x.matched > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const sa = a.row.started_at ?? ''
      const sb = b.row.started_at ?? ''
      if (sa !== sb) return sa < sb ? 1 : -1
      return b.row.id - a.row.id
    })
    .slice(0, MAX_MEETINGS)

  if (scored.length === 0) return empty()

  const speakerStmt = db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(display_name), ''), label) AS name
       FROM meeting_speakers WHERE meeting_id = ? ORDER BY sort_order, id`
  )
  const hitStmt = db.prepare(
    `SELECT g.id, g.start_ms, g.sort_order, g.text,
            COALESCE(NULLIF(TRIM(sp.display_name), ''), sp.label, '화자') AS speaker
       FROM meeting_segments g
       LEFT JOIN meeting_speakers sp ON sp.id = g.speaker_id
      WHERE g.meeting_id = ? AND (${anySeg})
      ORDER BY g.start_ms, g.sort_order, g.id
      LIMIT ${MAX_SNIPPETS}`
  )
  const prevStmt = db.prepare(
    `SELECT text FROM meeting_segments
      WHERE meeting_id = ? AND TRIM(text) != '' AND (start_ms < ? OR (start_ms = ? AND (sort_order < ? OR (sort_order = ? AND id < ?))))
      ORDER BY start_ms DESC, sort_order DESC, id DESC LIMIT 1`
  )
  const nextStmt = db.prepare(
    `SELECT text FROM meeting_segments
      WHERE meeting_id = ? AND TRIM(text) != '' AND (start_ms > ? OR (start_ms = ? AND (sort_order > ? OR (sort_order = ? AND id > ?))))
      ORDER BY start_ms, sort_order, id LIMIT 1`
  )

  const meetings: MeetingSearchHit[] = scored.map(({ row }) => {
    const speakers: string[] = []
    for (const sp of speakerStmt.all(row.id) as Array<{ name: string | null }>) {
      const name = (sp.name ?? '').trim()
      if (name && !speakers.includes(name)) speakers.push(name)
      if (speakers.length >= MAX_SPEAKERS) break
    }
    const hits = hitStmt.all(row.id, ...patterns) as Array<{
      id: number
      start_ms: number
      sort_order: number
      text: string
      speaker: string
    }>
    const snippets = hits.map((h) => {
      const key = [row.id, h.start_ms, h.start_ms, h.sort_order, h.sort_order, h.id]
      const prev = (prevStmt.get(...key) as { text: string } | undefined)?.text?.trim() ?? ''
      const next = (nextStmt.get(...key) as { text: string } | undefined)?.text?.trim() ?? ''
      return {
        start_ms: h.start_ms,
        time: formatTime(h.start_ms),
        speaker: h.speaker,
        text: joinContext(prev, h.text.trim(), next),
        link: recordingLink(row.id, h.start_ms)
      }
    })
    return {
      meeting_id: row.id,
      title: cut(row.title, ITEM_MAX),
      started_at: row.started_at,
      kind: row.kind,
      project: row.project ?? null,
      speakers,
      tldr: cut(row.tldr, TLDR_MAX),
      note_link: noteLink(row.id),
      snippets
    }
  })

  const result: SearchMeetingsResult = { scope_applied, meetings }
  const withNotice = (extra: string[]): SearchMeetingsResult => {
    const all = [...notices, ...extra]
    return all.length > 0 ? { ...result, notice: all.join(' ') } : { ...result }
  }
  // 결과가 길면 점수가 낮은 뒤 회의부터 뺀다.
  let out = withNotice([])
  while (toText(out).length > SEARCH_MAX_CHARS && result.meetings.length > 1) {
    result.meetings = result.meetings.slice(0, -1)
    out = withNotice(['결과가 길어 일부 회의를 뺐습니다.'])
  }
  return out
}

// ── get_meeting_excerpt ──

export interface ExcerptArgs {
  meeting_id: number
  from_ms?: number
  to_ms?: number
  include_interviews?: boolean
}

export interface ExcerptItem {
  text: string
  at_ms: number | null
  time: string | null
  link: string | null
}

export type ExcerptResult =
  | { error: 'not_found' | 'interview_excluded' }
  | {
      meeting_id: number
      title: string
      started_at: string | null
      kind: string
      note_link: string
      mode: 'summary'
      summary: {
        tldr: string
        topics: Array<ExcerptItem & { points: string[] }>
        decisions: ExcerptItem[]
        action_items: Array<ExcerptItem & { assignee: string | null; due: string | null }>
        open_questions: ExcerptItem[]
        qa_pairs?: ExcerptItem[]
      }
      hint: string
    }
  | {
      meeting_id: number
      title: string
      started_at: string | null
      kind: string
      note_link: string
      mode: 'transcript'
      from_ms: number
      to_ms: number
      link: string
      text: string
      notice?: string
    }

function item(meetingId: number, text: string, atMs: number | null): ExcerptItem {
  return {
    text: cut(text, ITEM_MAX),
    at_ms: atMs,
    time: atMs == null ? null : formatTime(atMs),
    link: atMs == null ? null : recordingLink(meetingId, atMs)
  }
}

function msOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function getMeetingExcerpt(db: Db, args: ExcerptArgs): ExcerptResult {
  const meeting = db
    .prepare(`SELECT m.id, m.title, m.kind, m.started_at FROM meetings m WHERE m.id = ? AND ${SEARCHABLE_STATUSES}`)
    .get(args?.meeting_id) as { id: number; title: string | null; kind: string; started_at: string | null } | undefined
  if (!meeting) return { error: 'not_found' }
  if (meeting.kind === 'interview' && args?.include_interviews !== true) return { error: 'interview_excluded' }

  const base = {
    meeting_id: meeting.id,
    title: cut(meeting.title, ITEM_MAX),
    started_at: meeting.started_at,
    kind: meeting.kind,
    note_link: noteLink(meeting.id)
  }
  const fromArg = msOrNull(args?.from_ms)
  const toArg = msOrNull(args?.to_ms)

  if (fromArg == null && toArg == null) {
    const s = db
      .prepare(
        `SELECT tldr, topics, decisions, action_items, open_questions, qa_pairs
           FROM meeting_summaries WHERE meeting_id = ?`
      )
      .get(meeting.id) as
      | {
          tldr: string | null
          topics: string | null
          decisions: string | null
          action_items: string | null
          open_questions: string | null
          qa_pairs: string | null
        }
      | undefined
    if (s) {
      const id = meeting.id
      const actions = parseJsonArray<Record<string, unknown>>(s.action_items).filter(
        (a) => a && typeof a.text === 'string' && a.text.trim()
      )
      const qa = parseJsonArray<Record<string, unknown>>(s.qa_pairs).filter(
        (q) => q && typeof q.question === 'string' && q.question.trim()
      )
      return {
        ...base,
        mode: 'summary',
        summary: {
          tldr: cut(s.tldr, TLDR_MAX),
          topics: parseTopics(s.topics).map((t) => ({
            ...item(id, t.title, t.start_ms),
            points: t.points.map((p) => cut(p, ITEM_MAX))
          })),
          decisions: parseTextItems(s.decisions).map((d) => item(id, d.text, d.at_ms)),
          action_items: actions.map((a) => ({
            ...item(id, String(a.text), msOrNull(a.at_ms)),
            assignee: typeof a.assignee === 'string' ? cut(a.assignee, 50) : null,
            due: typeof a.due === 'string' ? cut(a.due, 50) : null
          })),
          open_questions: parseTextItems(s.open_questions).map((q) => item(id, q.text, q.at_ms)),
          ...(meeting.kind === 'interview'
            ? {
                qa_pairs: qa.map((q) =>
                  item(
                    id,
                    `${String(q.question).trim()} — ${typeof q.answer_summary === 'string' ? q.answer_summary : ''}`,
                    msOrNull(q.start_ms)
                  )
                )
              }
            : {})
        },
        hint: '원문이 필요하면 from_ms·to_ms(최대 10분)로 다시 요청'
      }
    }
  }

  // 원문 구간. 구간이 없고 요약도 없으면 처음 10분이다.
  let fromMs = Math.max(0, Math.round(fromArg ?? (toArg != null ? toArg - EXCERPT_MAX_WINDOW_MS : 0)))
  let toMs = Math.round(toArg ?? fromMs + EXCERPT_MAX_WINDOW_MS)
  if (toMs < fromMs) [fromMs, toMs] = [toMs, fromMs]
  const notices: string[] = []
  if (toMs - fromMs > EXCERPT_MAX_WINDOW_MS) {
    toMs = fromMs + EXCERPT_MAX_WINDOW_MS
    notices.push(`구간이 길어 10분(${formatTime(fromMs)}~${formatTime(toMs)})으로 줄였습니다.`)
  }

  const segs = db
    .prepare(
      `SELECT g.start_ms, g.text, COALESCE(NULLIF(TRIM(sp.display_name), ''), sp.label, '화자') AS speaker
         FROM meeting_segments g
         LEFT JOIN meeting_speakers sp ON sp.id = g.speaker_id
        WHERE g.meeting_id = ? AND g.start_ms >= ? AND g.start_ms < ? AND TRIM(g.text) != ''
        ORDER BY g.start_ms, g.sort_order, g.id`
    )
    .all(meeting.id, fromMs, toMs) as Array<{ start_ms: number; text: string; speaker: string }>

  const out: string[] = []
  let length = 0
  let cutAt: number | null = null
  for (const s of segs) {
    const line = `[${formatTime(s.start_ms)} ${s.speaker}] ${s.text.trim()}`
    const add = (out.length > 0 ? 1 : 0) + line.length
    if (length + add > EXCERPT_MAX_CHARS) {
      if (out.length === 0) out.push(line.slice(0, EXCERPT_MAX_CHARS))
      cutAt = s.start_ms
      break
    }
    out.push(line)
    length += add
  }
  if (cutAt != null) {
    notices.push(`내용이 길어 ${formatTime(cutAt)} 앞까지만 보냈습니다. 이어서 보려면 from_ms=${cutAt}로 다시 요청하세요.`)
  }
  return {
    ...base,
    mode: 'transcript',
    from_ms: fromMs,
    to_ms: toMs,
    link: recordingLink(meeting.id, fromMs),
    text: out.join('\n'),
    ...(notices.length > 0 ? { notice: notices.join(' ') } : {})
  }
}

// ── 질의 단위 누적 예산 ──
// ai-agent.ts 가 한 질의에서 회의 도구 결과 길이를 누적한다. 누적이 예산을 넘으면 그 뒤 호출은 이 응답으로 막는다.
export const BUDGET_EXCEEDED_RESULT = {
  error: 'budget_exceeded',
  hint: '지금까지 찾은 근거로 답하라'
} as const

// 허용 시점에 미리 잡아 두는 결과 길이 상한. 한 턴에 여러 호출이 병렬로 와도 결과가 오기 전에 예산을 센다.
export function meetingToolReserveChars(toolName: string): number {
  return toolName.endsWith('search_meetings') ? SEARCH_MAX_CHARS : EXCERPT_MAX_CHARS
}

// usedChars: 도착한 결과 길이 + 아직 결과가 오지 않은 호출의 예약분. reserveChars: 이번 호출의 예약분.
export function checkMeetingBudget(usedChars: number, reserveChars = 0): typeof BUDGET_EXCEEDED_RESULT | null {
  return usedChars + reserveChars > QUERY_BUDGET_CHARS ? BUDGET_EXCEEDED_RESULT : null
}

// ── MCP 도구 정의 ──

type ToolResult = { content: { type: 'text'; text: string }[] }

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: toText(data) }] }
}

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식')

// 반환 타입은 ai-assistant-tools.ts 와 같다. 스키마별 handler 타입이 달라 하나로 묶이지 않는다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildMeetingTools(tool: SdkTool): SdkMcpToolDefinition<any>[] {
  const searchTool = tool(
    'search_meetings',
    '녹음·전사한 회의의 요약과 원문을 키워드로 검색한다. "지난 회의에서 ~ 얘기한 것" 같은 질문에 쓴다. 검색어끼리는 OR 이고, 회의마다 매칭 발언 발췌(snippets)와 그 시각의 link 를 준다. 기간을 주지 않으면 최근 180일, 최대 365일이다. 면접은 사용자가 명시적으로 요청할 때만 include_interviews=true.',
    {
      terms: z
        .array(z.string().trim().min(1).max(40))
        .min(1)
        .max(6)
        .describe('검색어 1~6개(각 1~40자). 동의어·다른 표현을 함께 넣으면 잘 찾는다'),
      from: dateArg.optional().describe('회의 시작일 하한 YYYY-MM-DD'),
      to: dateArg.optional().describe('회의 시작일 상한 YYYY-MM-DD(그날 포함)'),
      project_id: z.number().int().positive().optional().describe('프로젝트 id'),
      person: z.string().trim().min(1).max(50).optional().describe('화자 이름 또는 참석자 이름'),
      meeting_ids: z.array(z.number().int().positive()).max(50).optional().describe('이 회의들 안에서만 검색'),
      include_interviews: z.boolean().default(false).describe('면접 기록도 포함할지(기본 false)')
    },
    async (args) => {
      try {
        return jsonResult(searchMeetings(getAiReadOnlyDatabase(), args as SearchMeetingsArgs))
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) })
      }
    }
  )

  const excerptTool = tool(
    'get_meeting_excerpt',
    '회의 하나의 요약 또는 구간 원문을 읽는다. 구간(from_ms·to_ms)이 없으면 요약(주제·결정·액션아이템·미결 질문, 항목마다 시각 link)을, 요약이 없으면 처음 10분 원문을 준다. 구간은 최대 10분이며 원문은 "[mm:ss 화자] 발언" 줄이다. 인용 출처는 결과의 link 나 search_meetings 의 snippet link 를 그대로 쓴다.',
    {
      meeting_id: z.number().int().positive().describe('회의 id(search_meetings 결과의 meeting_id)'),
      from_ms: z.number().int().min(0).optional().describe('구간 시작(ms)'),
      to_ms: z.number().int().min(0).optional().describe('구간 끝(ms). from_ms 에서 최대 10분'),
      include_interviews: z.boolean().default(false).describe('면접 기록이면 true 여야 읽는다')
    },
    async (args) => {
      try {
        return jsonResult(getMeetingExcerpt(getAiReadOnlyDatabase(), args as ExcerptArgs))
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) })
      }
    }
  )

  return [searchTool, excerptTool]
}
