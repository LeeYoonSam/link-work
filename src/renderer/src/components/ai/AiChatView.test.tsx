import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BitbucketSettingsModal,
  ComposerControls,
  PlanApprovalCard,
  WRITE_MODES,
  isPlanApproval,
  resolveWriteMode
} from './AiChatView'
import { FALLBACK_MODEL_OPTIONS, useAiChatStore } from '../../stores/aiChatStore'
import type { AiChat } from '../../types'

// AI 대화 화면의 모델 선택지 폴백, 입력창 아래 컨트롤, 계획 승인 카드, Bitbucket 연동 모달을 고정한다.

describe('AI 대화 모델 선택지', () => {
  beforeEach(() => {
    useAiChatStore.setState({ model: 'opus', modelOptions: FALLBACK_MODEL_OPTIONS })
  })

  it('옵션을 받기 전에는 Fable·Opus·Haiku 폴백을 쓴다', () => {
    const { model, modelOptions } = useAiChatStore.getState()
    expect(model).toBe('opus')
    expect(modelOptions.map((o) => o.value)).toEqual(['fable', 'opus', 'haiku'])
    expect(modelOptions.map((o) => o.label)).toEqual(['Fable', 'Opus', 'Haiku'])
  })

  it('main 이 준 목록으로 교체한다', async () => {
    const options = [
      { value: 'fable', label: 'Fable 5.1', description: 'd1' },
      { value: 'opus', label: 'Opus 5.5', description: 'd2' },
      { value: 'haiku', label: 'Haiku 5.5', description: 'd3' }
    ]
    vi.stubGlobal('window', { api: { ai: { getModelOptions: vi.fn().mockResolvedValue(options) } } })
    await useAiChatStore.getState().loadModelOptions()
    expect(useAiChatStore.getState().modelOptions).toEqual(options)
    vi.unstubAllGlobals()
  })

  it('조회가 실패하거나 빈 목록이면 폴백을 유지한다', async () => {
    vi.stubGlobal('window', { api: { ai: { getModelOptions: vi.fn().mockRejectedValue(new Error('x')) } } })
    await useAiChatStore.getState().loadModelOptions()
    expect(useAiChatStore.getState().modelOptions).toBe(FALLBACK_MODEL_OPTIONS)
    vi.stubGlobal('window', { api: { ai: { getModelOptions: vi.fn().mockResolvedValue([]) } } })
    await useAiChatStore.getState().loadModelOptions()
    expect(useAiChatStore.getState().modelOptions).toBe(FALLBACK_MODEL_OPTIONS)
    vi.unstubAllGlobals()
  })
})

describe('BitbucketSettingsModal', () => {
  const noop = (): void => {}

  it('연결 전에는 이메일·token 입력과 안내를 그리고 해제 버튼은 없다', () => {
    const html = renderToStaticMarkup(
      <BitbucketSettingsModal status={{ connected: false, email: null }} onClose={noop} onChanged={noop} />
    )
    expect(html).toContain('Bitbucket 저장소의 파일과 폴더를 읽을 수 있습니다. (읽기 전용)')
    expect(html).toContain('type="email"')
    expect(html).toContain('type="password"')
    expect(html).toContain('read:repository')
    expect(html).toContain('https://id.atlassian.com/manage-profile/security/api-tokens')
    expect(html).toContain('데이터 백업에 포함되지 않습니다')
    expect(html).not.toContain('연동 해제')
  })

  it('연결되면 이메일과 해제 버튼을 그린다', () => {
    const html = renderToStaticMarkup(
      <BitbucketSettingsModal
        status={{ connected: true, email: 'me@example.com' }}
        onClose={noop}
        onChanged={noop}
      />
    )
    expect(html).toContain('me@example.com')
    expect(html).toContain('연동 해제')
  })
})

describe('입력창 아래 모드·모델 컨트롤', () => {
  const noop = (): void => {}

  const render = (chat?: Pick<AiChat, 'write_mode'>): string =>
    renderToStaticMarkup(
      <ComposerControls
        writeMode={resolveWriteMode(chat)}
        onWriteModeChange={noop}
        model="opus"
        modelOptions={FALLBACK_MODEL_OPTIONS}
        onModelChange={noop}
      />
    )

  it('select 2개를 모드·모델 순서로 그린다', () => {
    const html = render()
    const labels = [...html.matchAll(/<select[^>]*aria-label="([^"]+)"/g)].map((m) => m[1])
    expect(labels).toEqual(['모드', '모델'])
  })

  it('모드 옵션 4개를 자동·승인·계획·읽기 전용 순서로 그린다', () => {
    expect(WRITE_MODES.map((m) => m.value)).toEqual(['auto', 'ask', 'plan', 'readonly'])
    const html = render()
    const modeSelect = html.slice(html.indexOf('aria-label="모드"'), html.indexOf('aria-label="모델"'))
    const values = [...modeSelect.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])
    expect(values).toEqual(['auto', 'ask', 'plan', 'readonly'])
    expect(modeSelect).toContain('자동 모드 (Auto)')
    expect(modeSelect).toContain('승인 후 쓰기 (Ask)')
    expect(modeSelect).toContain('계획 모드 (Plan)')
    expect(modeSelect).toContain('읽기 전용')
  })

  it('chat 이나 write_mode 가 없으면 자동 모드를 선택한다', () => {
    expect(resolveWriteMode(undefined)).toBe('auto')
    expect(resolveWriteMode(null)).toBe('auto')
    expect(resolveWriteMode({} as Pick<AiChat, 'write_mode'>)).toBe('auto')
    const html = render()
    expect(html).toMatch(/<option value="auto"[^>]*selected=""/)
    expect(html).not.toMatch(/<option value="ask"[^>]*selected=""/)
    expect(html).toContain('title="자동 모드 (Auto): 쓰기를 자동 승인합니다.')
  })

  it('저장된 모드와 모델을 선택 상태로 그린다', () => {
    const html = render({ write_mode: 'plan' })
    expect(html).toMatch(/<option value="plan"[^>]*selected=""/)
    expect(html).toMatch(/<option value="opus"[^>]*selected=""/)
    expect(html).toContain('bg-indigo-50')
  })
})

describe('PlanApprovalCard', () => {
  it('kind plan 이나 ExitPlanMode 도구를 계획 승인으로 판정한다', () => {
    expect(isPlanApproval({ kind: 'plan', name: 'ExitPlanMode' })).toBe(true)
    expect(isPlanApproval({ name: 'ExitPlanMode' })).toBe(true)
    expect(isPlanApproval({ kind: 'write', name: 'create_task' })).toBe(false)
    expect(isPlanApproval({ name: 'fetch_url' })).toBe(false)
  })

  it('계획 마크다운 본문과 버튼 3개를 그린다', () => {
    const html = renderToStaticMarkup(
      <PlanApprovalCard
        request={{
          requestId: 'r1',
          name: 'ExitPlanMode',
          label: '계획 승인',
          kind: 'plan',
          input: { plan: '## 할 일\n\n- **작업 A** 만들기\n- 작업 B 수정' }
        }}
        onRespond={() => {}}
      />
    )
    expect(html).toContain('계획 승인')
    expect(html).toMatch(/<h2[^>]*>할 일<\/h2>/)
    expect(html).toMatch(/<strong[^>]*>작업 A<\/strong>/)
    expect(html).toContain('작업 B 수정')
    expect(html).toContain('max-h-80 overflow-y-auto')
    const buttons = [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1])
    expect(buttons).toEqual(['승인 후 자동 실행', '승인 후 하나씩 확인', '거절'])
    expect(html).toContain('거절한 뒤 입력창에 수정 요청을 쓰면')
  })
})

describe('계획 승인 응답과 mode_changed 이벤트', () => {
  beforeEach(() => {
    useAiChatStore.setState({
      currentChatId: 1,
      pendingApproval: null,
      pendingApprovalChatId: null,
      chats: [
        { id: 1, title: 'a', session_id: null, write_mode: 'plan', created_at: '', updated_at: '' },
        { id: 2, title: 'b', session_id: null, write_mode: 'auto', created_at: '', updated_at: '' }
      ]
    })
  })

  it('승인하면 mode 를 넘기고 채팅 모드를 바꾼다', async () => {
    const approve = vi.fn().mockResolvedValue({ success: true })
    vi.stubGlobal('window', { api: { ai: { approve } } })
    await useAiChatStore.getState().respondPlan('r1', true, 'ask')
    expect(approve).toHaveBeenCalledWith('r1', true, { mode: 'ask' })
    expect(useAiChatStore.getState().chats[0].write_mode).toBe('ask')
    vi.unstubAllGlobals()
  })

  it('거절하면 mode 없이 보내고 모드를 유지한다', async () => {
    const approve = vi.fn().mockResolvedValue({ success: true })
    vi.stubGlobal('window', { api: { ai: { approve } } })
    await useAiChatStore.getState().respondPlan('r1', false)
    expect(approve).toHaveBeenCalledWith('r1', false, undefined)
    expect(useAiChatStore.getState().chats[0].write_mode).toBe('plan')
    vi.unstubAllGlobals()
  })

  const planRequest = {
    requestId: 'r2',
    name: 'ExitPlanMode',
    label: '계획 승인',
    kind: 'plan' as const,
    input: { plan: 'x' }
  }

  it('승인 요청을 받은 채팅의 모드를 바꾼다', async () => {
    const approve = vi.fn().mockResolvedValue({ success: true })
    vi.stubGlobal('window', { api: { ai: { approve } } })
    useAiChatStore.setState((s) => ({
      chats: s.chats.map((c) => (c.id === 2 ? { ...c, write_mode: 'plan' as const } : c))
    }))
    useAiChatStore.getState().handleStreamEvent({ chatId: 1, event: 'approval', request: planRequest })
    // 응답 전에 현재 채팅이 바뀐 상황
    useAiChatStore.setState({ currentChatId: 2 })
    await useAiChatStore.getState().respondPlan('r2', true, 'auto')
    const { chats, pendingApproval, pendingApprovalChatId } = useAiChatStore.getState()
    expect(chats.map((c) => c.write_mode)).toEqual(['auto', 'plan'])
    expect(pendingApproval).toBeNull()
    expect(pendingApprovalChatId).toBeNull()
    vi.unstubAllGlobals()
  })

  it('approve 가 success:false 면 이전 모드로 되돌린다', async () => {
    const approve = vi.fn().mockResolvedValue({ success: false })
    vi.stubGlobal('window', { api: { ai: { approve } } })
    useAiChatStore.getState().handleStreamEvent({ chatId: 1, event: 'approval', request: planRequest })
    await useAiChatStore.getState().respondPlan('r2', true, 'auto')
    expect(approve).toHaveBeenCalledWith('r2', true, { mode: 'auto' })
    expect(useAiChatStore.getState().chats[0].write_mode).toBe('plan')
    vi.unstubAllGlobals()
  })

  it('approve 가 예외를 던져도 이전 모드로 되돌린다', async () => {
    const approve = vi.fn().mockRejectedValue(new Error('ipc'))
    vi.stubGlobal('window', { api: { ai: { approve } } })
    await useAiChatStore.getState().respondPlan('r3', true, 'ask')
    expect(useAiChatStore.getState().chats[0].write_mode).toBe('plan')
    vi.unstubAllGlobals()
  })

  it('mode_changed 는 보고 있지 않은 채팅에도 적용한다', () => {
    useAiChatStore.getState().handleStreamEvent({ chatId: 2, event: 'mode_changed', mode: 'readonly' })
    useAiChatStore.getState().handleStreamEvent({ chatId: 1, event: 'mode_changed', mode: 'auto' })
    const chats = useAiChatStore.getState().chats
    expect(chats.map((c) => c.write_mode)).toEqual(['auto', 'readonly'])
  })
})
