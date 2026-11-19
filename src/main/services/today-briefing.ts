// 오늘 대시보드 브리핑. 렌더러가 규칙으로 만든 신호·사실을 받아 LLM 으로 headline·순서·문구만 다듬는다.
// SSOT: docs/ASSISTANT.md 부록 O
//
// [가드레일]
// - 신호·근거(ref)·숫자는 렌더러 규칙이 만든다. LLM 은 새 신호·새 id·새 사실을 만들 수 없다(validateLlmBriefing).
// - 해시·문구에 상대 시간("40분 뒤")을 넣지 않는다. 입력에는 절대 시각만 있다.
// - LLM 이 꺼졌거나·헤드리스가 없거나·실패하면 같은 구조를 source:'rules' 로 돌려준다.
// - 저장: assistant_events 1행(kind 'today_briefing', event_key `today_briefing:<date>`, status 'logged'). 스키마 변경 없음.
// - LLM 호출은 비서의 llmSerialized 줄(runLlmSerialized)을 공유한다.
import { createHash } from 'crypto'
import { z } from 'zod'
import { getDatabase } from '../db/database'
import { findEventByKey, insertEvent, readAssistantSettings, updateEventPayload } from './assistant-store'
import { runLlmSerialized } from './assistant-service'
import { isHeadlessAvailable, runHeadlessJson } from './ai-headless'
import { resolveAiModelId } from './ai-model'
import { ASSISTANT_SPEECH_JSON_NOTE, ASSISTANT_SPEECH_RULES } from './writing-style'

// ── 계약 타입 (렌더러 types/index.ts 와 같은 모양) ─────────────
export type SignalKind = 'release_risk' | 'release_day' | 'overdue' | 'due_today' | 'meeting_soon' | 'qa_start'
export type SignalSeverity = 'critical' | 'warn' | 'info'

export interface TodayBriefingInput {
  date: string
  ruleHeadline: string
  signals: { id: string; kind: SignalKind; severity: SignalSeverity; text: string; refs: string[] }[]
  facts: {
    meetingCount: number
    overdueCount: number
    dueTodayCount: number
    /** 캘린더 연결 여부. false 면 회의·일정이 없다고 말하지 않는다. 옛 입력에 없으면 true */
    calendarConnected: boolean
    /** Jira 연결 여부. false 면 Jira 작업·마감·배포 작업이 없다고 말하지 않는다. 옛 입력에 없으면 true */
    jiraConnected: boolean
    nextMeeting: { title: string; start: string } | null
    release: {
      version: string | null
      date: string
      dDay: number
      qaStart: string | null
      linked: boolean
      mine: { total: number; done: number; review: number; progress: number; todo: number }
    } | null
  }
}

export interface TodayBriefing {
  date: string
  headline: string
  signals: { id: string; text: string }[]
  source: 'llm' | 'rules'
  model: string | null
  generatedAt: string
  inputHash: string
  error: string | null
}

// ── 상한 ─────────────────────────────────────────────────
export const MAX_SIGNALS = 10
export const HEADLINE_MAX = 80
export const SIGNAL_TEXT_MAX = 60
/** 강제가 아니면 LLM 은 이 간격에 1회만 부른다 */
export const LLM_MIN_INTERVAL_MS = 10 * 60 * 1000

// ── 입력 검증 ─────────────────────────────────────────────
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const COUNT = z.number().int().min(0).max(100_000)

const InputSchema = z
  .object({
    date: DATE,
    ruleHeadline: z.string().max(200),
    signals: z
      .array(
        z.object({
          id: z.string().min(1).max(80),
          kind: z.enum(['release_risk', 'release_day', 'overdue', 'due_today', 'meeting_soon', 'qa_start']),
          severity: z.enum(['critical', 'warn', 'info']),
          text: z.string().max(200),
          refs: z.array(z.string().max(120)).max(20)
        })
      )
      .max(MAX_SIGNALS),
    facts: z.object({
      meetingCount: COUNT,
      overdueCount: COUNT,
      dueTodayCount: COUNT,
      calendarConnected: z.boolean().default(true),
      jiraConnected: z.boolean().default(true),
      nextMeeting: z
        .object({ title: z.string().max(200), start: z.string().regex(/^\d{2}:\d{2}$/) })
        .nullable(),
      release: z
        .object({
          version: z.string().max(40).nullable(),
          date: DATE,
          dDay: z.number().int().min(-1000).max(1000),
          qaStart: DATE.nullable(),
          linked: z.boolean(),
          mine: z.object({ total: COUNT, done: COUNT, review: COUNT, progress: COUNT, todo: COUNT })
        })
        .nullable()
    })
  })
  .superRefine((v, ctx) => {
    const ids = new Set<string>()
    for (const s of v.signals) {
      if (ids.has(s.id)) ctx.addIssue({ code: 'custom', message: `중복 신호 id: ${s.id}` })
      ids.add(s.id)
    }
  })

/** 형식이 맞지 않으면 throw 한다. 반환값은 키 순서가 고정된 사본이다 */
export function parseBriefingInput(raw: unknown): TodayBriefingInput {
  const r = InputSchema.safeParse(raw)
  if (!r.success) {
    const first = r.error.issues[0]
    throw new Error(`브리핑 입력 형식이 올바르지 않습니다: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim())
  }
  return r.data as TodayBriefingInput
}

/** 입력의 해시. 검증을 거친 사본(키 순서 고정)을 직렬화한다. 현재 시각은 넣지 않는다 */
export function hashBriefingInput(input: TodayBriefingInput): string {
  return createHash('sha256').update(JSON.stringify(parseBriefingInput(input))).digest('hex').slice(0, 32)
}

/** LLM 없이 규칙 문구 그대로 만든 브리핑 */
export function ruleBriefing(
  input: TodayBriefingInput,
  opts: { now?: Date; inputHash?: string; error?: string | null } = {}
): TodayBriefing {
  return {
    date: input.date,
    headline: input.ruleHeadline,
    signals: input.signals.map((s) => ({ id: s.id, text: s.text })),
    source: 'rules',
    model: null,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    inputHash: opts.inputHash ?? hashBriefingInput(input),
    error: opts.error ?? null
  }
}

// ── LLM 출력 ─────────────────────────────────────────────
export const LlmBriefingSchema = z.object({
  headline: z.string(),
  signals: z.array(z.object({ id: z.string(), text: z.string() })).max(MAX_SIGNALS * 2).default([])
})
export type LlmBriefingRaw = z.infer<typeof LlmBriefingSchema>

/**
 * LLM 출력을 입력 기준으로 바로잡는다.
 * 1) 모르는 id·중복 id 는 버린다. 2) 빠진 id 는 규칙 문구로 뒤에 붙인다.
 * 3) headline 이 비었거나 80자를 넘으면 ruleHeadline. 4) 신호 문구가 비었거나 60자를 넘으면 규칙 문구.
 * 5) 결과 신호 id 는 입력 id 의 순열이다.
 */
export function validateLlmBriefing(
  input: TodayBriefingInput,
  raw: LlmBriefingRaw
): { headline: string; signals: { id: string; text: string }[] } {
  const ruleText = new Map(input.signals.map((s) => [s.id, s.text]))
  const headline = typeof raw.headline === 'string' ? raw.headline.trim() : ''
  const out: { id: string; text: string }[] = []
  const used = new Set<string>()
  for (const s of raw.signals ?? []) {
    if (!ruleText.has(s.id) || used.has(s.id)) continue
    used.add(s.id)
    const text = typeof s.text === 'string' ? s.text.trim() : ''
    out.push({ id: s.id, text: text && text.length <= SIGNAL_TEXT_MAX ? text : (ruleText.get(s.id) as string) })
  }
  for (const s of input.signals) {
    if (!used.has(s.id)) out.push({ id: s.id, text: s.text })
  }
  return {
    headline: headline && headline.length <= HEADLINE_MAX ? headline : input.ruleHeadline,
    signals: out
  }
}

// ── 프롬프트 ─────────────────────────────────────────────
export const TODAY_BRIEFING_SYSTEM_PROMPT = `너는 업무 대시보드의 한 줄 브리핑을 다듬는 비서다.
[데이터] 의 신호와 사실만 쓴다. 출력은 JSON 하나다.

## 할 일
- headline: 오늘 가장 중요한 것을 1문장으로 쓴다. ${HEADLINE_MAX}자 이하.
- signals: 입력 신호를 중요한 순서로 다시 놓고 각 문구를 ${SIGNAL_TEXT_MAX}자 이하로 다듬는다.
- 입력 신호가 0건이면 signals 는 빈 배열이고 headline 만 쓴다.

## 금지
- 상대 시간("40분 뒤", "곧", "잠시 후")을 쓰지 않는다. 시각은 [데이터] 의 절대 시각("14:00")만 쓴다.
- [데이터] 에 없는 사실·숫자·이름·이슈 키를 만들지 않는다.
- 새 신호 id 를 만들지 않는다. 입력 id 만 쓴다.
- '집중 가능 시간'·빈 시간·집중 블록은 언급 금지다.
- facts.calendarConnected 가 false 면 회의·일정이 없다고 말하지 않는다. 캘린더가 연결되지 않아 모를 뿐이다.
- facts.jiraConnected 가 false 면 Jira 작업·마감·배포 작업이 없다고 말하지 않는다. Jira 가 연결되지 않아 모를 뿐이다.

${ASSISTANT_SPEECH_RULES}

## 출력 형식
{"headline": "...", "signals": [{"id": "입력 id", "text": "다듬은 문구"}]}
${ASSISTANT_SPEECH_JSON_NOTE}`

export function buildTodayBriefingPrompt(input: TodayBriefingInput): string {
  const data = {
    date: input.date,
    ruleHeadline: input.ruleHeadline,
    signals: input.signals.map((s) => ({ id: s.id, kind: s.kind, severity: s.severity, text: s.text })),
    facts: input.facts
  }
  return `[데이터]\n${JSON.stringify(data, null, 2)}\n[/데이터]\n\n위 [데이터] 로 JSON 을 만들어 주세요.`
}

// ── 실행부 ───────────────────────────────────────────────
const inflight = new Map<string, Promise<TodayBriefing>>()
let lastLlmAttemptMs = 0

/** 테스트 전용: 모듈 상태를 비운다 */
export function resetTodayBriefingStateForTest(): void {
  inflight.clear()
  lastLlmAttemptMs = 0
}

function eventKeyOf(date: string): string {
  return `today_briefing:${date}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function localDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function parseStored(payload: string | null): TodayBriefing | null {
  if (!payload) return null
  try {
    const v = JSON.parse(payload) as TodayBriefing
    if (!v || typeof v !== 'object' || typeof v.inputHash !== 'string' || !Array.isArray(v.signals)) return null
    return v
  } catch {
    return null
  }
}

function readStored(date: string): TodayBriefing | null {
  const row = findEventByKey(getDatabase(), eventKeyOf(date))
  return row ? parseStored(row.payload) : null
}

function save(briefing: TodayBriefing, now: Date): void {
  try {
    const db = getDatabase()
    const key = eventKeyOf(briefing.date)
    const payload = JSON.stringify(briefing)
    const existing = findEventByKey(db, key)
    if (existing) {
      updateEventPayload(db, existing.id, payload)
      return
    }
    const inserted = insertEvent(db, {
      event_key: key,
      kind: 'today_briefing',
      plan_date: briefing.date,
      scheduled_at: localDateTime(now),
      fired_at: null,
      status: 'logged',
      ref_id: null,
      payload
    })
    if (!inserted) {
      const again = findEventByKey(db, key)
      if (again) updateEventPayload(db, again.id, payload)
    }
  } catch (err) {
    // 저장 실패는 화면 표시를 막지 않는다
    console.error('Failed to save today briefing:', err)
  }
}

function safeHeadlessAvailable(): boolean {
  try {
    return isHeadlessAvailable()
  } catch {
    return false
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function requestLlm(
  input: TodayBriefingInput,
  modelId: string
): Promise<{ ok: true; value: LlmBriefingRaw } | { ok: false; error: string }> {
  try {
    const r = await runHeadlessJson({
      systemPrompt: TODAY_BRIEFING_SYSTEM_PROMPT,
      prompt: buildTodayBriefingPrompt(input),
      model: modelId,
      schema: LlmBriefingSchema,
      timeoutMs: 60_000
    })
    return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

/**
 * 오늘 브리핑을 돌려준다. 입력 형식이 틀리면 throw 한다(IPC 가 Fail 로 바꾼다).
 * - LLM 꺼짐·헤드리스 없음 → rules(error null).
 * - 저장본의 inputHash 가 같고 llm 이면 그대로 돌려준다(force 제외).
 * - 강제가 아니면 LLM 은 10분에 1회. 제한에 걸리면 같은 해시의 저장본, 없으면 rules 를 돌려주고
 *   retryAfterMs(남은 제한 시간)를 함께 준다. 이때 rules 는 저장하지 않는다(저장된 llm 결과를 덮지 않는다).
 * - 같은 입력의 LLM 호출이 진행 중이면 그 promise 를 공유한다.
 * - LLM 실패 → rules + error.
 */
export interface TodayBriefingResult {
  briefing: TodayBriefing
  /** 10분 제한에 걸려 LLM 을 부르지 않았을 때만 있다. 이 시간(ms) 뒤 같은 입력으로 다시 요청하면 된다 */
  retryAfterMs?: number
}

export async function getTodayBriefing(
  rawInput: unknown,
  force = false,
  now = new Date()
): Promise<TodayBriefingResult> {
  const input = parseBriefingInput(rawInput)
  const inputHash = hashBriefingInput(input)
  const settings = readAssistantSettings(getDatabase())

  if (!settings.enabled || !settings.llmEnabled || !safeHeadlessAvailable()) {
    const rules = ruleBriefing(input, { now, inputHash })
    save(rules, now)
    return { briefing: rules }
  }

  // 캘린더·Jira 가 모두 미연결이고 신호도 없으면 LLM 이 다듬을 사실이 없다. 규칙 문구로 충분하다
  if (!input.facts.calendarConnected && !input.facts.jiraConnected && input.signals.length === 0) {
    const rules = ruleBriefing(input, { now, inputHash })
    save(rules, now)
    return { briefing: rules }
  }

  const stored = readStored(input.date)
  if (!force && stored && stored.inputHash === inputHash && stored.source === 'llm') return { briefing: stored }

  const flightKey = `${input.date}|${inputHash}`
  const pending = inflight.get(flightKey)
  if (pending) return { briefing: await pending }

  const elapsed = now.getTime() - lastLlmAttemptMs
  if (!force && elapsed < LLM_MIN_INTERVAL_MS) {
    const retryAfterMs = Math.max(1, LLM_MIN_INTERVAL_MS - elapsed)
    if (stored && stored.inputHash === inputHash) return { briefing: stored, retryAfterMs }
    // 저장하지 않는다: 저장된 llm 결과(다른 해시)를 rules 로 덮지 않는다
    return { briefing: ruleBriefing(input, { now, inputHash }), retryAfterMs }
  }

  lastLlmAttemptMs = now.getTime()
  const modelId = resolveAiModelId(settings.llmModel)
  const task = runLlmSerialized(async (): Promise<TodayBriefing> => {
    const r = await requestLlm(input, modelId)
    const at = new Date()
    if (!r.ok) return ruleBriefing(input, { now: at, inputHash, error: r.error })
    const v = validateLlmBriefing(input, r.value)
    return {
      date: input.date,
      headline: v.headline,
      signals: v.signals,
      source: 'llm',
      model: modelId,
      generatedAt: at.toISOString(),
      inputHash,
      error: null
    }
  })
    .catch((err: unknown) => ruleBriefing(input, { now: new Date(), inputHash, error: toMessage(err) }))
    .then((b) => {
      save(b, now)
      return b
    })
    .finally(() => {
      inflight.delete(flightKey)
    })
  inflight.set(flightKey, task)
  return { briefing: await task }
}
