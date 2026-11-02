// 창 없이 Claude 를 1회 실행하고 JSON 출력을 zod 로 검증하는 공용 파일.
// SSOT: docs/ASSISTANT.md §9.2
//
// [가드레일]
// - A9: 도구는 0개다. 출력은 zod 스키마로 검증한다. 검증에 실패하면 ok:false 다.
// - A10: sanitizedEnv() 와 settingSources: [] 로 토큰당 과금 경로를 막는다 (AI_GUARDRAILS §9).
// - A11: 모듈 수준 잠금으로 동시에 1개만 실행한다.
// meeting-summary.ts 의 인증·환경 패턴을 옮겨 왔다. meeting-summary.ts 는 이번에 전환하지 않는다.
import { app } from 'electron'
import type { z } from 'zod'
import { findClaudeExecutable } from './ai-agent'

const DEFAULT_TIMEOUT_MS = 90_000

export const HEADLESS_BUSY_MESSAGE = '다른 AI 작업이 진행 중입니다.'
const TIMEOUT_MESSAGE = 'AI 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
const EMPTY_MESSAGE = 'AI 응답이 비어 있습니다.'
const CANCELLED_MESSAGE = 'AI 작업을 취소했습니다.'

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

// SDK 는 ESM 전용이다. 동적 import 로 늦게 읽는다.
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')
let sdkPromise: Promise<SdkModule> | null = null
function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk')
  return sdkPromise
}

/** SDK·CLI 오류 문자열을 사용자용 문구로 바꾼다 */
export function toFriendlyAiError(raw: string): string {
  if (/not logged in/i.test(raw)) {
    return 'Claude Code에 로그인되어 있지 않습니다. 터미널에서 `claude`를 실행해 로그인(/login)한 뒤 다시 시도해 주세요.'
  }
  if (/(native binary|executable) not found|ENOENT/i.test(raw)) {
    return 'Claude Code가 설치되어 있지 않습니다. AI 브리핑을 사용하려면 Claude Code 설치 및 로그인이 필요합니다. (https://claude.com/claude-code)'
  }
  if (/credit balance|billing|payment/i.test(raw)) {
    return 'Claude 계정의 사용 한도/결제 상태를 확인해 주세요.'
  }
  if (/rate limit|overloaded|429/i.test(raw)) {
    return '사용량 한도에 도달했거나 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.'
  }
  return raw
}

/** Claude CLI 가 설치되어 있으면 true */
export function isHeadlessAvailable(): boolean {
  return findClaudeExecutable() !== undefined
}

// 응답에서 JSON 블록을 꺼낸다. 코드펜스를 허용한다.
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1)
  return text.trim()
}

export interface HeadlessJsonSpec<T> {
  systemPrompt: string
  prompt: string
  model: string
  schema: z.ZodType<T>
  timeoutMs?: number
}

export type HeadlessJsonResult<T> = { ok: true; value: T } | { ok: false; error: string }

// A11: 단일 실행 잠금. await 전에 동기로 잡는다.
let running = false
// 진행 중인 실행의 abort 핸들. cancelAllHeadless 가 쓴다.
let active: { controller: AbortController; cancelled: boolean } | null = null

/** 진행 중인 헤드리스 실행을 중단한다. 앱 종료(before-quit) 때 부른다 */
export function cancelAllHeadless(): void {
  if (!active) return
  active.cancelled = true
  active.controller.abort()
}

export async function runHeadlessJson<T>(spec: HeadlessJsonSpec<T>): Promise<HeadlessJsonResult<T>> {
  if (running) return { ok: false, error: HEADLESS_BUSY_MESSAGE }
  running = true
  try {
    return await runOnce(spec)
  } catch (err) {
    // 예상하지 못한 예외도 throw 하지 않고 ok:false 로 돌려준다.
    return { ok: false, error: toFriendlyAiError(err instanceof Error ? err.message : String(err)) }
  } finally {
    running = false
  }
}

async function runOnce<T>(spec: HeadlessJsonSpec<T>): Promise<HeadlessJsonResult<T>> {
  const claudePath = findClaudeExecutable()
  if (!claudePath) return { ok: false, error: toFriendlyAiError('native binary not found') }

  const controller = new AbortController()
  const run = { controller, cancelled: false }
  active = run
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const abortedMessage = (): string => (run.cancelled ? CANCELLED_MESSAGE : TIMEOUT_MESSAGE)

  let responseText = ''
  let resultError: string | null = null
  try {
    const { query } = await loadSdk()
    const q = query({
      prompt: spec.prompt,
      options: {
        systemPrompt: spec.systemPrompt,
        model: spec.model,
        maxTurns: 1,
        mcpServers: {},
        // tools: [] 가 내장 도구 전부를 끈다. allowedTools: [] 만으로는 기본 도구가 남는다.
        tools: [],
        allowedTools: [],
        disallowedTools: ['Bash', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Task'],
        settingSources: [],
        env: sanitizedEnv(),
        cwd: app.getPath('userData'),
        pathToClaudeCodeExecutable: claudePath,
        abortController: controller
      }
    })

    type SdkMsg = import('@anthropic-ai/claude-agent-sdk').SDKMessage
    for await (const msg of q as AsyncIterable<SdkMsg>) {
      if (controller.signal.aborted) break
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) responseText += block.text
        }
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          if (msg.result && !responseText) responseText = msg.result
        } else {
          resultError = msg.errors?.join('\n') || msg.subtype
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, error: abortedMessage() }
    return { ok: false, error: toFriendlyAiError(err instanceof Error ? err.message : String(err)) }
  } finally {
    clearTimeout(timer)
    if (active === run) active = null
  }

  if (controller.signal.aborted) return { ok: false, error: abortedMessage() }
  if (!responseText.trim()) {
    return { ok: false, error: resultError ? toFriendlyAiError(resultError) : EMPTY_MESSAGE }
  }

  // A9: JSON 파싱과 zod 검증. 실패하면 원문 앞부분만 오류에 붙인다.
  let raw: unknown
  try {
    raw = JSON.parse(extractJson(responseText))
  } catch {
    return { ok: false, error: `AI 응답을 JSON 으로 읽지 못했습니다: ${responseText.slice(0, 200)}` }
  }
  const parsed = spec.schema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    return { ok: false, error: `AI 응답 형식이 올바르지 않습니다: ${issues}` }
  }
  return { ok: true, value: parsed.data }
}
