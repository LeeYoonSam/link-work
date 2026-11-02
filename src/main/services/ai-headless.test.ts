import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// 실제 Claude 를 호출하지 않는다. SDK·electron·ai-agent 를 모듈 경계에서 대체한다.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/linkwork-test' } }))

const claudePath = { value: '/usr/local/bin/claude' as string | undefined }
vi.mock('./ai-agent', () => ({ findClaudeExecutable: () => claudePath.value }))

type QueryArgs = { prompt: string; options: Record<string, unknown> }
const queryMock = vi.fn<(args: QueryArgs) => AsyncIterable<unknown>>()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (args: QueryArgs) => queryMock(args) }))

import {
  cancelAllHeadless,
  HEADLESS_BUSY_MESSAGE,
  isHeadlessAvailable,
  runHeadlessJson,
  toFriendlyAiError
} from './ai-headless'

const Schema = z.object({ headline: z.string().max(10), n: z.number() })

function textMessages(text: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text }] } }
    yield { type: 'result', subtype: 'success', result: text }
  })()
}

function spec(timeoutMs?: number): Parameters<typeof runHeadlessJson<z.infer<typeof Schema>>>[0] {
  return { systemPrompt: '시스템', prompt: '입력', model: 'claude-sonnet-5-5', schema: Schema, timeoutMs }
}

beforeEach(() => {
  claudePath.value = '/usr/local/bin/claude'
  queryMock.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runHeadlessJson 출력 검증', () => {
  it('A9: 스키마에 맞는 JSON 은 ok:true 로 값을 돌려준다', async () => {
    queryMock.mockReturnValue(textMessages('{"headline":"좋음","n":3}'))
    expect(await runHeadlessJson(spec())).toEqual({ ok: true, value: { headline: '좋음', n: 3 } })
  })

  it('A9: 코드펜스로 감싼 JSON 도 읽는다', async () => {
    queryMock.mockReturnValue(textMessages('설명\n```json\n{"headline":"a","n":1}\n```'))
    expect(await runHeadlessJson(spec())).toEqual({ ok: true, value: { headline: 'a', n: 1 } })
  })

  it('A9: 스키마 위반 출력은 ok:false 다 (길이 초과)', async () => {
    queryMock.mockReturnValue(textMessages('{"headline":"아주아주아주아주긴제목입니다","n":1}'))
    const result = await runHeadlessJson(spec())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('AI 응답 형식이 올바르지 않습니다')
  })

  it('A9: 스키마 위반 출력은 ok:false 다 (필드 누락)', async () => {
    queryMock.mockReturnValue(textMessages('{"headline":"a"}'))
    expect((await runHeadlessJson(spec())).ok).toBe(false)
  })

  it('A9: JSON 이 아닌 출력은 ok:false 다', async () => {
    queryMock.mockReturnValue(textMessages('JSON 을 만들 수 없습니다'))
    const result = await runHeadlessJson(spec())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('JSON')
  })

  it('빈 응답은 ok:false 다', async () => {
    queryMock.mockReturnValue(textMessages(''))
    expect(await runHeadlessJson(spec())).toEqual({ ok: false, error: 'AI 응답이 비어 있습니다.' })
  })
})

describe('runHeadlessJson 옵션', () => {
  it('A9·A10: 도구 0개(tools [], allowedTools []), settingSources [], mcpServers {}, maxTurns 1 로 실행한다', async () => {
    queryMock.mockReturnValue(textMessages('{"headline":"a","n":1}'))
    await runHeadlessJson(spec())

    const { prompt, options } = queryMock.mock.calls[0][0]
    expect(prompt).toBe('입력')
    expect(options.systemPrompt).toBe('시스템')
    expect(options.model).toBe('claude-sonnet-5-5')
    // A9: tools [] 가 내장 도구 전부를 끈다
    expect(options.tools).toEqual([])
    expect(options.allowedTools).toEqual([])
    expect(options.settingSources).toEqual([])
    expect(options.mcpServers).toEqual({})
    expect(options.maxTurns).toBe(1)
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(['Bash', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Task'])
    )
    expect(options.cwd).toBe('/tmp/linkwork-test')
    expect(options.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
    expect(options.abortController).toBeInstanceOf(AbortController)
  })

  it('A10: 과금 환경 변수를 SDK 에 넘기지 않는다', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'tok')
    vi.stubEnv('LINKWORK_KEEP', 'yes')
    queryMock.mockReturnValue(textMessages('{"headline":"a","n":1}'))
    await runHeadlessJson(spec())

    const env = queryMock.mock.calls[0][0].options.env as Record<string, string>
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.LINKWORK_KEEP).toBe('yes')
  })
})

describe('runHeadlessJson 잠금과 실패', () => {
  it("A11: 동시 2번째 호출은 '다른 AI 작업이 진행 중입니다.' 를 돌려준다", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    queryMock.mockImplementationOnce(() =>
      (async function* () {
        await gate
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '{"headline":"a","n":1}' }] } }
      })()
    )

    const first = runHeadlessJson(spec())
    const second = await runHeadlessJson(spec())
    expect(second).toEqual({ ok: false, error: HEADLESS_BUSY_MESSAGE })
    expect(HEADLESS_BUSY_MESSAGE).toBe('다른 AI 작업이 진행 중입니다.')

    release()
    expect(await first).toEqual({ ok: true, value: { headline: 'a', n: 1 } })
    expect(queryMock).toHaveBeenCalledTimes(1)
  })

  it('A11: 앞 실행이 끝나면 잠금이 풀린다 (실패로 끝나도 풀린다)', async () => {
    queryMock.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect((await runHeadlessJson(spec())).ok).toBe(false)

    queryMock.mockReturnValue(textMessages('{"headline":"b","n":2}'))
    expect(await runHeadlessJson(spec())).toEqual({ ok: true, value: { headline: 'b', n: 2 } })
  })

  it('시간이 초과되면 abort 하고 ok:false 를 돌려준다', async () => {
    let captured: AbortController | null = null
    queryMock.mockImplementationOnce(({ options }) => {
      captured = options.abortController as AbortController
      return (async function* () {
        await new Promise<void>((resolve) => captured!.signal.addEventListener('abort', () => resolve()))
        throw new Error('aborted by user')
      })()
    })

    const result = await runHeadlessJson(spec(20))
    expect(captured!.signal.aborted).toBe(true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('시간이 초과')
  })

  it('cancelAllHeadless 는 진행 중인 실행을 abort 하고 잠금을 푼다', async () => {
    let captured: AbortController | null = null
    queryMock.mockImplementationOnce(({ options }) => {
      captured = options.abortController as AbortController
      return (async function* () {
        await new Promise<void>((resolve) => captured!.signal.addEventListener('abort', () => resolve()))
        throw new Error('aborted')
      })()
    })

    const pending = runHeadlessJson(spec())
    await vi.waitFor(() => expect(captured).not.toBeNull())
    cancelAllHeadless()
    expect(await pending).toEqual({ ok: false, error: 'AI 작업을 취소했습니다.' })
    expect(captured!.signal.aborted).toBe(true)

    queryMock.mockReturnValue(textMessages('{"headline":"c","n":3}'))
    expect(await runHeadlessJson(spec())).toEqual({ ok: true, value: { headline: 'c', n: 3 } })
  })

  it('실행 중이 아니면 cancelAllHeadless 는 아무것도 하지 않는다', () => {
    expect(() => cancelAllHeadless()).not.toThrow()
  })

  it('Claude CLI 가 없으면 SDK 를 부르지 않고 설치 안내를 돌려준다', async () => {
    claudePath.value = undefined
    expect(isHeadlessAvailable()).toBe(false)
    const result = await runHeadlessJson(spec())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Claude Code가 설치되어 있지 않습니다')
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('SDK 예외는 throw 하지 않고 사용자용 문구로 바꾼다', async () => {
    queryMock.mockImplementationOnce(() => {
      throw new Error('Claude Code: Not logged in')
    })
    const result = await runHeadlessJson(spec())
    expect(result).toEqual({ ok: false, error: toFriendlyAiError('not logged in') })
  })

  it('result 오류 메시지만 오고 본문이 없으면 그 오류를 돌려준다', async () => {
    queryMock.mockReturnValue(
      (async function* () {
        yield { type: 'result', subtype: 'error_during_execution', errors: ['rate limit exceeded'] }
      })()
    )
    const result = await runHeadlessJson(spec())
    expect(result).toEqual({ ok: false, error: toFriendlyAiError('429') })
  })
})

describe('toFriendlyAiError', () => {
  it('대표 오류를 안내 문구로 바꾸고 나머지는 그대로 둔다', () => {
    expect(toFriendlyAiError('Not logged in')).toContain('로그인')
    expect(toFriendlyAiError('spawn ENOENT')).toContain('설치')
    expect(toFriendlyAiError('credit balance is too low')).toContain('결제')
    expect(toFriendlyAiError('overloaded_error')).toContain('잠시 후')
    expect(toFriendlyAiError('기타 오류')).toBe('기타 오류')
  })
})
