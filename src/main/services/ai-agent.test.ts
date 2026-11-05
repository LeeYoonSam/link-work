import { beforeEach, describe, expect, it, vi } from 'vitest'

// ai-agent.ts 는 electron·DB·SDK 를 import 한다. Electron 런타임 없이 돌도록 모듈 경계에서 막는다.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false }
}))

// app_settings 흉내 Map. 라벨 캐시 저장(ai_model_labels)이 이 경로를 쓴다.
const settings = new Map<string, string>()
// ai_chats 흉내 Map. runAiQuery 테스트가 채팅 모드를 읽고 쓴다.
const chats = new Map<number, { write_mode: string; session_id: string | null }>()
vi.mock('../db/database', () => ({
  getDatabase: () => ({
    prepare: (sql: string) => ({
      get: (key: string | number) => {
        if (sql.includes('FROM ai_chats')) {
          const chat = chats.get(key as number)
          return chat ? { ...chat } : undefined
        }
        if (sql.includes('FROM ai_messages')) return { id: 1, role: 'assistant' }
        const value = settings.get(key as string)
        return value === undefined ? undefined : { value }
      },
      run: (...args: (string | number)[]) => {
        if (sql.startsWith('UPDATE ai_chats SET write_mode')) {
          const chat = chats.get(args[1] as number)
          if (!chat) return { changes: 0 }
          chat.write_mode = args[0] as string
          return { changes: 1 }
        }
        if (sql.includes('ai_chats') || sql.includes('ai_messages')) {
          return { changes: 1, lastInsertRowid: 1 }
        }
        settings.set(args[0] as string, args[1] as string)
        return { changes: 1 }
      }
    })
  }),
  getAiReadOnlyDatabase: () => {
    throw new Error('테스트에서 DB 를 쓰지 않는다')
  }
}))

// runAiQuery 가 쓰는 도구·연동 모듈은 경계에서 막는다. 도구 이름 규약만 남긴다.
vi.mock('./ai-tools', () => ({
  FETCH_URL_TOOL_NAME: 'mcp__linkwork__fetch_url',
  LINKWORK_TOOL_NAMES: ['mcp__linkwork__list_memos'],
  getLinkworkMcpServer: async () => ({})
}))
vi.mock('./ai-write-tools', () => ({
  LINKWORK_WRITE_TOOL_NAMES: [
    'mcp__linkwork__create_memo',
    'mcp__linkwork__update_memo',
    'mcp__linkwork__create_variable',
    'mcp__linkwork__update_variable'
  ],
  sanitizeWriteInputForAudit: (_name: string, input: unknown) => input,
  getUpdatePreview: () => null
}))
const audit = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('./ai-audit', () => ({ logAiAudit: audit.log }))
vi.mock('./ai-attachments', () => ({ isPathInAttachmentsDir: () => false }))
vi.mock('./bitbucket', () => ({ isBitbucketConnected: () => false }))
vi.mock('./notion', () => ({ isNotionConnected: () => false }))

// script 가 있으면 query 결과를 순회할 때 그 메시지를 낸다. script 는 options.canUseTool 을 직접 부른다.
type ScriptFn = (options: QueryOptions) => AsyncGenerator<unknown>
const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  close: vi.fn(),
  supportedModels: vi.fn(),
  script: null as ScriptFn | null
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => {
    sdk.query(...args)
    const { options } = args[0] as { options: QueryOptions }
    const script = sdk.script
    return {
      supportedModels: sdk.supportedModels,
      close: sdk.close,
      async *[Symbol.asyncIterator]() {
        if (script) yield* script(options)
      }
    }
  }
}))

interface PermissionResultLike {
  behavior: 'allow' | 'deny'
  message?: string
  updatedInput?: Record<string, unknown>
  updatedPermissions?: unknown[]
}

interface QueryOptions {
  permissionMode?: string
  planModeInstructions?: string
  disallowedTools?: string[]
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string }
  ) => Promise<PermissionResultLike>
}

const SUPPORTED_MODELS = [
  { value: 'default', displayName: 'Default (recommended)', description: 'x' },
  { value: 'fable', displayName: 'Fable 5.1', description: 'For your toughest challenges' },
  { value: 'opus', displayName: 'Opus 5.5', description: 'Most capable' },
  { value: 'haiku', displayName: 'Haiku 5.5', description: 'Fastest' }
]

// 탐침 상태와 라벨 캐시는 모듈 상태다. 테스트마다 새 모듈을 읽는다.
async function loadAgent(): Promise<typeof import('./ai-agent')> {
  vi.resetModules()
  return import('./ai-agent')
}

beforeEach(() => {
  settings.clear()
  chats.clear()
  audit.log.mockReset()
  sdk.query.mockReset()
  sdk.close.mockReset()
  sdk.supportedModels.mockReset()
  sdk.script = null
})

describe('buildSystemPrompt — 앱 내 링크', () => {
  it('항목 링크 형식을 안내하고 메뉴 링크는 목록 안내에만 쓰게 한다', async () => {
    const { buildSystemPrompt } = await loadAgent()
    for (const mode of ['readonly', 'ask', 'auto', 'plan'] as const) {
      const prompt = buildSystemPrompt(mode, false, false)
      expect(prompt).toContain('linkwork://memo/{id}')
      expect(prompt).toContain('linkwork://todo/{id}')
      expect(prompt).toContain('linkwork://release/{id}')
      expect(prompt).toContain('linkwork://project/{projectId}/task/{taskId}')
      expect(prompt).toContain('linkwork://note/{id}')
      expect(prompt).toContain('메뉴 링크는 목록 전체를 안내할 때만 쓰세요')
    }
  })

  it('쓰기 모드는 생성/수정 후 도구 결과의 link 를 그대로 쓰게 한다', async () => {
    const { buildSystemPrompt } = await loadAgent()
    expect(buildSystemPrompt('ask', false, false)).toContain('생성/수정 후에는 도구 결과의 link 를 그대로')
    expect(buildSystemPrompt('readonly', false, false)).not.toContain('생성/수정 후에는')
  })
})

describe('buildSystemPrompt — Bitbucket', () => {
  it('연동되면 read_bitbucket 사용과 fetch_url 금지를 지시한다', async () => {
    const { buildSystemPrompt } = await loadAgent()
    const prompt = buildSystemPrompt('ask', false, true)
    expect(prompt).toContain('read_bitbucket')
    expect(prompt).toContain('Bitbucket 링크(bitbucket.org)는 read_bitbucket을 사용하세요 (fetch_url 금지')
    expect(prompt).toContain('추측해서 지어내지 마세요')
    expect(prompt).not.toContain('"Bitbucket 연동"에서 이메일과 API token을 등록')
  })

  it('미연동이면 하단 Bitbucket 연동 등록을 안내한다', async () => {
    const { buildSystemPrompt } = await loadAgent()
    const prompt = buildSystemPrompt('readonly', true, false)
    expect(prompt).toContain('AI 대화 화면 하단 "Bitbucket 연동"에서 이메일과 API token을 등록')
    expect(prompt).toContain('fetch_url 금지')
    expect(prompt).toContain('추측해서 지어내지 마세요')
  })
})

describe('getAiChatModelOptions', () => {
  it('캐시가 비면 탐침 1회로 라벨을 채우고 프로세스를 닫는다', async () => {
    sdk.supportedModels.mockResolvedValue(SUPPORTED_MODELS)
    const { getAiChatModelOptions } = await loadAgent()

    const [a, b] = await Promise.all([getAiChatModelOptions(), getAiChatModelOptions()])
    expect(sdk.query).toHaveBeenCalledTimes(1)
    expect(sdk.close).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(a).toEqual([
      { value: 'fable', label: 'Fable 5.1', description: '가장 강력, 느림' },
      { value: 'opus', label: 'Opus 5.5', description: '정확, 균형' },
      { value: 'haiku', label: 'Haiku 5.5', description: '가장 빠름' }
    ])
    expect(settings.has('ai_model_labels')).toBe(true)

    // 캐시가 차면 다시 탐침하지 않는다.
    await getAiChatModelOptions()
    expect(sdk.query).toHaveBeenCalledTimes(1)
  })

  it('탐침은 과금 경로 env 를 제거하고 사용자 설정을 격리한다', async () => {
    const saved = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    try {
      sdk.supportedModels.mockResolvedValue(SUPPORTED_MODELS)
      const { getAiChatModelOptions } = await loadAgent()
      await getAiChatModelOptions()
      const { options } = sdk.query.mock.calls[0][0] as {
        options: { env: Record<string, string>; settingSources: unknown[]; model?: string }
      }
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(options.settingSources).toEqual([])
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = saved
    }
  })

  it('탐침이 실패하면 패밀리 이름·힌트로 폴백하고 곧바로 재시도하지 않는다', async () => {
    sdk.supportedModels.mockRejectedValue(new Error('spawn failed'))
    const { getAiChatModelOptions } = await loadAgent()

    const options = await getAiChatModelOptions()
    expect(options).toEqual([
      { value: 'fable', label: 'Fable', description: '가장 강력, 느림' },
      { value: 'opus', label: 'Opus', description: '정확, 균형' },
      { value: 'haiku', label: 'Haiku', description: '가장 빠름' }
    ])
    expect(sdk.close).toHaveBeenCalledTimes(1)

    await getAiChatModelOptions()
    expect(sdk.query).toHaveBeenCalledTimes(1)
  })

  it('저장된 라벨이 있으면 탐침 없이 바로 쓴다', async () => {
    settings.set(
      'ai_model_labels',
      JSON.stringify({ fable: { displayName: 'Fable 6', description: 'new' } })
    )
    const { getAiChatModelOptions } = await loadAgent()
    const options = await getAiChatModelOptions()
    expect(sdk.query).not.toHaveBeenCalled()
    expect(options[0]).toEqual({ value: 'fable', label: 'Fable 6', description: '가장 강력, 느림' })
    expect(options[1]).toEqual({ value: 'opus', label: 'Opus', description: '정확, 균형' })
  })
})

// ── plan mode (docs/AI_GUARDRAILS.md 7절) ──

const CHAT_ID = 1
const RESULT_MESSAGE = { type: 'result', subtype: 'success', result: '완료', session_id: 's1' }

interface ApprovalReply {
  approved: boolean
  options?: { mode?: 'auto' | 'ask' }
}

interface StreamEvent {
  chatId: number
  event: string
  [key: string]: unknown
}

// 채팅 1개를 만들고 runAiQuery 를 끝까지 돌린다.
// reply 가 있으면 승인 카드 요청(approval 이벤트)에 그 값으로 응답한다.
async function runChat(
  writeMode: string,
  script: ScriptFn,
  reply?: ApprovalReply
): Promise<{ sent: StreamEvent[]; options: QueryOptions }> {
  chats.set(CHAT_ID, { write_mode: writeMode, session_id: null })
  sdk.supportedModels.mockResolvedValue([])
  sdk.script = script
  const agent = await loadAgent()
  const sent: StreamEvent[] = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, payload: StreamEvent) => {
        sent.push(payload)
        if (payload.event === 'approval' && reply) {
          const request = payload.request as { requestId: string }
          queueMicrotask(() => agent.resolveAiApproval(request.requestId, reply.approved, reply.options))
        }
      }
    }
  }
  await agent.runAiQuery(CHAT_ID, '메모 x 를 만들어줘', win as never)
  const { options } = sdk.query.mock.calls[0][0] as { options: QueryOptions }
  return { sent, options }
}

const toolCtx = (toolUseID: string): { signal: AbortSignal; toolUseID: string } => ({
  signal: new AbortController().signal,
  toolUseID
})

// ExitPlanMode tool_use 블록을 내고, CLI 처럼 plan 이 빠진 input {} 으로 canUseTool 을 부른다.
function exitPlanScript(results: PermissionResultLike[], afterExit?: string): ScriptFn {
  return async function* (options) {
    yield {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '계획입니다.' },
          { type: 'tool_use', id: 'tu-plan', name: 'ExitPlanMode', input: { plan: '# 계획\n1. 메모 x 생성' } }
        ]
      }
    }
    results.push(await options.canUseTool('ExitPlanMode', {}, toolCtx('tu-plan')))
    if (afterExit) {
      results.push(await options.canUseTool(afterExit, { title: 'x' }, toolCtx('tu-write')))
    }
    yield RESULT_MESSAGE
  }
}

describe('runAiQuery — plan mode', () => {
  it('plan 채팅은 permissionMode plan 과 planModeInstructions 를 넘기고 EnterPlanMode 를 막는다', async () => {
    const { options } = await runChat('plan', async function* () {
      yield RESULT_MESSAGE
    })
    expect(options.permissionMode).toBe('plan')
    expect(options.planModeInstructions).toContain('ExitPlanMode')
    expect(options.planModeInstructions).toContain('mcp__linkwork__')
    expect(options.disallowedTools).toContain('EnterPlanMode')
    expect(options.disallowedTools).toContain('Write')
  })

  it.each(['auto', 'ask', 'readonly'])('%s 채팅은 permissionMode default 이고 계획 지시가 없다', async (mode) => {
    const { options } = await runChat(mode, async function* () {
      yield RESULT_MESSAGE
    })
    expect(options.permissionMode).toBe('default')
    expect(options.planModeInstructions).toBeUndefined()
  })

  it('plan 모드에서 쓰기 도구는 거부하고 조회 도구는 허용한다', async () => {
    const results: PermissionResultLike[] = []
    await runChat('plan', async function* (options) {
      results.push(await options.canUseTool('mcp__linkwork__create_memo', { title: 'x' }, toolCtx('t1')))
      results.push(await options.canUseTool('mcp__linkwork__list_memos', {}, toolCtx('t2')))
      yield RESULT_MESSAGE
    })
    expect(results[0]).toEqual({
      behavior: 'deny',
      message: '계획 모드입니다. 쓰기 전에 ExitPlanMode 로 계획을 제출하세요.'
    })
    expect(results[1].behavior).toBe('allow')
    expect(chats.get(CHAT_ID)?.write_mode).toBe('plan')
  })

  it('계획 승인(mode auto)이면 채팅 모드를 auto 로 바꾸고 setMode 로 plan mode 를 빠져나간다', async () => {
    const results: PermissionResultLike[] = []
    const { sent } = await runChat(
      'plan',
      exitPlanScript(results, 'mcp__linkwork__create_memo'),
      { approved: true, options: { mode: 'auto' } }
    )

    const approval = sent.find((e) => e.event === 'approval')
    expect(approval?.request).toMatchObject({
      kind: 'plan',
      name: 'ExitPlanMode',
      label: '계획 승인',
      input: { plan: '# 계획\n1. 메모 x 생성' },
      current: null
    })
    expect(results[0]).toEqual({
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }]
    })
    expect(chats.get(CHAT_ID)?.write_mode).toBe('auto')
    expect(sent).toContainEqual({ chatId: CHAT_ID, event: 'mode_changed', mode: 'auto' })
    // 승인 뒤 쓰기 도구는 새 모드(auto) 규칙으로 자동 승인된다.
    expect(results[1].behavior).toBe('allow')
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'plan_approved',
        toolName: 'ExitPlanMode',
        detail: '실행 모드=auto'
      })
    )
  })

  it.each(['mcp__linkwork__create_variable', 'mcp__linkwork__update_variable'])(
    '계획을 auto 로 승인한 뒤에도 %s 는 승인 카드를 거친다',
    async (toolName) => {
      const results: PermissionResultLike[] = []
      const { sent } = await runChat('plan', exitPlanScript(results, toolName), {
        approved: true,
        options: { mode: 'auto' }
      })
      expect(chats.get(CHAT_ID)?.write_mode).toBe('auto')
      const approvals = sent.filter((e) => e.event === 'approval')
      expect(approvals).toHaveLength(2)
      expect(approvals[0].request).toMatchObject({ kind: 'plan', name: 'ExitPlanMode' })
      expect(approvals[1].request).toMatchObject({
        kind: 'write',
        name: toolName.replace('mcp__linkwork__', '')
      })
      expect(results[1].behavior).toBe('allow')
    }
  )

  it('계획 본문을 기다리는 중 쿼리가 취소되면 카드 없이 즉시 거절한다', async () => {
    chats.set(CHAT_ID, { write_mode: 'plan', session_id: null })
    sdk.supportedModels.mockResolvedValue([])
    const agent = await loadAgent()
    const sent: StreamEvent[] = []
    const results: PermissionResultLike[] = []
    sdk.script = async function* (options) {
      // plan 이 없는 toolUseID 라 waitForPlan 이 기다리는 동안 취소한다.
      const pending = options.canUseTool('ExitPlanMode', {}, toolCtx('tu-cancel'))
      setTimeout(() => agent.cancelAiQuery(CHAT_ID), 50)
      results.push(await pending)
      yield RESULT_MESSAGE
    }
    const win = {
      isDestroyed: () => false,
      webContents: { send: (_channel: string, payload: StreamEvent) => sent.push(payload) }
    }
    await agent.runAiQuery(CHAT_ID, '계획 세워줘', win as never)

    expect(results[0]).toEqual({
      behavior: 'deny',
      message: '사용자가 계획을 승인하지 않았습니다. 실행하지 말고, 사용자의 수정 요청을 기다리세요.'
    })
    expect(sent.some((e) => e.event === 'approval')).toBe(false)
    // 대기 항목을 남기지 않는다. 첫 요청 id 로 응답해도 받을 곳이 없다.
    expect(agent.resolveAiApproval(`${CHAT_ID}-1`, true)).toBe(false)
    expect(agent.getAiProgress(CHAT_ID).pendingApproval).toBeNull()
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'plan_rejected', toolName: 'ExitPlanMode', detail: '쿼리 중단' })
    )
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'approval_request' }))
    expect(chats.get(CHAT_ID)?.write_mode).toBe('plan')
  })

  it('계획 승인에서 mode 를 생략하면 auto, ask 를 고르면 ask 로 바뀐다', async () => {
    await runChat('plan', exitPlanScript([]), { approved: true })
    expect(chats.get(CHAT_ID)?.write_mode).toBe('auto')

    const results: PermissionResultLike[] = []
    const { sent } = await runChat('plan', exitPlanScript(results), {
      approved: true,
      options: { mode: 'ask' }
    })
    expect(chats.get(CHAT_ID)?.write_mode).toBe('ask')
    expect(sent).toContainEqual({ chatId: CHAT_ID, event: 'mode_changed', mode: 'ask' })
    expect(results[0].behavior).toBe('allow')
  })

  it('계획 거절이면 deny 를 돌려주고 모드는 plan 그대로다', async () => {
    const results: PermissionResultLike[] = []
    const { sent } = await runChat('plan', exitPlanScript(results, 'mcp__linkwork__create_memo'), {
      approved: false
    })
    expect(results[0]).toEqual({
      behavior: 'deny',
      message: '사용자가 계획을 승인하지 않았습니다. 실행하지 말고, 사용자의 수정 요청을 기다리세요.'
    })
    expect(chats.get(CHAT_ID)?.write_mode).toBe('plan')
    expect(sent.some((e) => e.event === 'mode_changed')).toBe(false)
    // 거절 뒤에도 쓰기 도구는 계속 막힌다.
    expect(results[1].behavior).toBe('deny')
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'plan_rejected', toolName: 'ExitPlanMode' })
    )
  })

  it('plan 모드가 아닌 채팅의 ExitPlanMode 는 승인 카드 없이 거부한다', async () => {
    const results: PermissionResultLike[] = []
    const { sent } = await runChat('auto', async function* (options) {
      results.push(await options.canUseTool('ExitPlanMode', {}, toolCtx('t1')))
      yield RESULT_MESSAGE
    })
    expect(results[0].behavior).toBe('deny')
    expect(sent.some((e) => e.event === 'approval')).toBe(false)
  })

  it('tool_use 에 plan 이 없으면 마지막 결정 뒤의 스트림 텍스트를 계획으로 쓴다', async () => {
    const { sent } = await runChat(
      'plan',
      async function* (options) {
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '## 본문 계획' } }
        }
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'tu-empty', name: 'ExitPlanMode', input: {} }] }
        }
        await options.canUseTool('ExitPlanMode', {}, toolCtx('tu-empty'))
        yield RESULT_MESSAGE
      },
      { approved: false }
    )
    const approval = sent.find((e) => e.event === 'approval')
    expect(approval?.request).toMatchObject({ input: { plan: '## 본문 계획' } })
  })

  it('toolUseID 가 다른 tool_use 의 plan 은 쓰지 않는다', async () => {
    const { sent } = await runChat(
      'plan',
      async function* (options) {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'tu-a', name: 'ExitPlanMode', input: { plan: '다른 계획' } }]
          }
        }
        await options.canUseTool('ExitPlanMode', {}, toolCtx('tu-b'))
        yield RESULT_MESSAGE
      },
      { approved: false }
    )
    const approval = sent.find((e) => e.event === 'approval')
    expect((approval?.request as { input: { plan: string } }).input.plan).not.toBe('다른 계획')
  })

  it('plan 인자도 응답 텍스트도 없으면 안내 문구를 계획으로 쓴다', async () => {
    const { sent } = await runChat(
      'plan',
      async function* (options) {
        await options.canUseTool('ExitPlanMode', {}, toolCtx('tu-none'))
        yield RESULT_MESSAGE
      },
      { approved: false }
    )
    const approval = sent.find((e) => e.event === 'approval')
    expect(approval?.request).toMatchObject({
      input: { plan: '계획 본문을 받지 못했습니다. 대화 본문의 계획을 확인하세요.' }
    })
  })
})

describe('getAiProgress — 계획 승인 대기', () => {
  it('pendingApproval 에 kind 가 들어 있다', async () => {
    chats.set(CHAT_ID, { write_mode: 'plan', session_id: null })
    sdk.supportedModels.mockResolvedValue([])
    const agent = await loadAgent()
    let progressKind: unknown
    sdk.script = async function* (options) {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-p', name: 'ExitPlanMode', input: { plan: '계획' } }]
        }
      }
      await options.canUseTool('ExitPlanMode', {}, toolCtx('tu-p'))
      yield RESULT_MESSAGE
    }
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, payload: StreamEvent) => {
          if (payload.event !== 'approval') return
          progressKind = agent.getAiProgress(CHAT_ID).pendingApproval?.kind
          const request = payload.request as { requestId: string }
          queueMicrotask(() => agent.resolveAiApproval(request.requestId, false))
        }
      }
    }
    await agent.runAiQuery(CHAT_ID, '계획 세워줘', win as never)
    expect(progressKind).toBe('plan')
  })
})

describe('getChatWriteMode', () => {
  it('plan 을 인식하고, 허용 밖 값은 ask 로 폴백한다', async () => {
    const { getChatWriteMode } = await loadAgent()
    chats.set(CHAT_ID, { write_mode: 'plan', session_id: null })
    expect(getChatWriteMode(CHAT_ID)).toBe('plan')
    chats.set(CHAT_ID, { write_mode: 'weird', session_id: null })
    expect(getChatWriteMode(CHAT_ID)).toBe('ask')
  })
})

describe('buildSystemPrompt — plan 모드', () => {
  it('계획 승인 전 쓰기 금지와 승인 후 계획대로 실행을 지시한다', async () => {
    const { buildSystemPrompt } = await loadAgent()
    const prompt = buildSystemPrompt('plan', false, false)
    expect(prompt).toContain('계획 모드')
    expect(prompt).toContain('계획이 승인되기 전에는 쓰기 도구를 호출하지 마세요')
    expect(prompt).toContain('ExitPlanMode')
    expect(prompt).toContain('계획대로 실행하세요')
  })
})
