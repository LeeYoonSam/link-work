import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ApprovalCard,
  batchTodoItems,
  ComposerControls,
  createSuggestionController,
  FALLBACK_SUGGESTIONS,
  normalizeSuggestions,
  PlanApprovalCard,
  SuggestionGrid,
  WRITE_MODES,
  isPlanApproval,
  resolveWriteMode
} from './AiChatView'
import { FALLBACK_MODEL_OPTIONS, useAiChatStore } from '../../stores/aiChatStore'
import type { AiChat, AiSuggestion } from '../../types'
import type { ReactElement, ReactNode } from 'react'

// AI 대화 화면의 모델 선택지 폴백, 입력창 아래 컨트롤, 계획 승인 카드를 고정한다.
// Bitbucket 연동 팝업 검증은 settings/ConnectDialogs.test.tsx 로 옮겼다.

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

describe('ApprovalCard — create_todos', () => {
  const render = (input: Record<string, unknown>, name = 'create_todos'): string =>
    renderToStaticMarkup(
      <ApprovalCard
        request={{ requestId: 'r9', name, label: '할 일 여러 건 생성', kind: 'write', input }}
        allowAlways
        onRespond={() => {}}
      />
    )

  it('items 를 건수와 번호 목록(제목·우선순위·마감·태그)으로 보여 준다', () => {
    const html = render({
      items: [
        { title: '자료 정리', priority: 'high', due_date: '2026-11-21', tags: ['회의'] },
        { title: '메일 회신', due_date: '2026-11-22 10:00' },
        { title: '리뷰 요청', priority: 'low' }
      ],
      source_link: 'linkwork://note/5'
    })
    expect(html).toContain('할 일 3건 생성')
    expect(html).toContain('<ol')
    expect(html.match(/<li/g)).toHaveLength(3)
    expect(html).toContain('자료 정리')
    expect(html).toContain('높음')
    expect(html).toContain('마감 2026-11-21')
    expect(html).toContain('#회의')
    expect(html).toContain('메일 회신')
    expect(html).toContain('보통')
    expect(html).toContain('마감 2026-11-22 10:00')
    expect(html).toContain('낮음')
    expect(html).toContain('출처: linkwork://note/5')
    // 원본 JSON 대신 목록을 보여 준다
    expect(html).not.toContain('&quot;items&quot;')
  })

  it('다른 쓰기 도구는 입력 JSON 을 그대로 보여 준다', () => {
    const html = render({ title: '하나' }, 'create_todo')
    expect(html).toContain('&quot;title&quot;')
    expect(html).not.toContain('건 생성</p>')
  })

  it('형식이 다른 items 는 빈 목록으로 다룬다', () => {
    expect(batchTodoItems({ items: 'x' })).toEqual([])
    expect(batchTodoItems({ items: [null, { title: 3 }] })).toEqual([
      { title: '(제목 없음)', priority: undefined, due_date: undefined, tags: undefined }
    ])
  })
})

describe('빈 화면 추천 질문', () => {
  const ipcItems: AiSuggestion[] = [
    { id: 't1', category: 'todo', label: '마감 지난 할 일 3건 정리해줘', prompt: '마감 지난 할 일 정리해줘', feature: '할 일 일괄 수정' },
    { id: 'm1', category: 'meeting', label: '주간 회의 액션아이템', prompt: '주간 회의 액션아이템 정리해줘', feature: '회의 간 검색' },
    { id: 'p1', category: 'project', label: 'ABC-12 진행 상황', prompt: 'ABC-12 티켓 진행 상황 알려줘', feature: 'Jira 커넥터' },
    { id: 'r1', category: 'release', label: '1.2.0 릴리스 요약', prompt: '1.2.0 릴리스 노트 요약해줘' },
    { id: 'n1', category: 'memo', label: '최근 메모 요약', prompt: '최근 메모 요약해줘' },
    { id: 's1', category: 'schedule', label: '오후 일정', prompt: '오늘 오후 일정 알려줘' },
    { id: 't2', category: 'todo', label: '이번 주 할 일', prompt: '이번 주 할 일 보여줘' },
    { id: 'm2', category: 'meeting', label: '결론 안 난 논의', prompt: '결론 안 난 논의 정리해줘' }
  ]

  // 함수 컴포넌트 결과 트리에서 button 요소를 모은다 (DOM 없이 onClick 을 호출하기 위함)
  const collectButtons = (node: ReactNode, out: ReactElement<{ onClick?: () => void; title?: string }>[] = []) => {
    if (Array.isArray(node)) node.forEach((n) => collectButtons(n, out))
    else if (node && typeof node === 'object' && 'props' in node) {
      const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void; title?: string }>
      if (el.type === 'button') out.push(el)
      collectButtons(el.props.children, out)
    }
    return out
  }

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('폴백은 8개이고 링크·대상이 필요 없는 일반 질문이다', () => {
    expect(FALLBACK_SUGGESTIONS).toHaveLength(8)
    expect(new Set(FALLBACK_SUGGESTIONS.map((s) => s.id)).size).toBe(8)
    for (const s of FALLBACK_SUGGESTIONS) expect(s.prompt).not.toMatch(/https?:|linkwork:/)
    // 새 채팅은 자동 쓰기 모드다. 폴백은 조회만 요청한다
    for (const s of FALLBACK_SUGGESTIONS) expect(s.prompt).not.toMatch(/만들어|생성|수정|삭제|바꿔|덮어|옮겨|완료 처리/)
  })

  it('IPC 데이터 8개를 칩·질문·소개 기능과 함께 그린다', async () => {
    const onChange = vi.fn()
    const controller = createSuggestionController(vi.fn().mockResolvedValue(ipcItems), onChange)
    controller.load()
    await flush()
    const { items } = onChange.mock.calls.at(-1)![0]
    expect(items).toEqual(ipcItems)

    const html = renderToStaticMarkup(
      <SuggestionGrid suggestions={items} loading={false} onSelect={() => {}} onRefresh={() => {}} />
    )
    expect(html).toContain('추천 질문')
    expect(html).toContain('↻ 다른 추천')
    expect(html.match(/title="[^"]*"[^>]*>(?:<span)/g) ?? []).toHaveLength(8)
    for (const chip of ['할 일', '회의록', '프로젝트', '릴리스', '메모', '일정']) expect(html).toContain(chip)
    expect(html).toContain('마감 지난 할 일 3건 정리해줘')
    expect(html).toContain('title="ABC-12 티켓 진행 상황 알려줘"')
    expect(html).toMatch(/✦ (<!-- -->)?Jira 커넥터/)
    expect(html).toContain('line-clamp-2')
  })

  it('IPC 가 실패하면 폴백 8개를 유지한다', async () => {
    const onChange = vi.fn()
    const controller = createSuggestionController(vi.fn().mockRejectedValue(new Error('ipc')), onChange)
    controller.load()
    await flush()
    const last = onChange.mock.calls.at(-1)![0]
    expect(last.loading).toBe(false)
    expect(last.items).toBe(FALLBACK_SUGGESTIONS)
    const html = renderToStaticMarkup(
      <SuggestionGrid suggestions={last.items} loading={false} onSelect={() => {}} onRefresh={() => {}} />
    )
    for (const s of FALLBACK_SUGGESTIONS) expect(html).toContain(s.label)
  })

  it('카드를 누르면 그 prompt 를 보낸다', () => {
    const onSelect = vi.fn()
    const tree = SuggestionGrid({ suggestions: ipcItems, loading: false, onSelect, onRefresh: () => {} })
    const cards = collectButtons(tree).filter((b) => b.props.title !== '다른 추천 질문 보기')
    expect(cards).toHaveLength(8)
    cards[2].props.onClick!()
    expect(onSelect).toHaveBeenCalledWith('ABC-12 티켓 진행 상황 알려줘')
  })

  it('다른 추천은 variant 를 올려 다시 조회하고 이전 응답은 버린다', async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(ipcItems)
      .mockReturnValueOnce(new Promise(() => {}))
    const onChange = vi.fn()
    const controller = createSuggestionController(fetcher, onChange)
    controller.load()
    controller.refresh()
    expect(fetcher).toHaveBeenNthCalledWith(1, 0)
    expect(fetcher).toHaveBeenNthCalledWith(2, 1)
    await flush()
    expect(onChange.mock.calls.at(-1)![0].items).toEqual(ipcItems)
    // 늦게 온 첫 응답은 반영하지 않는다
    resolveFirst([{ ...ipcItems[0], id: 'stale', label: '오래된 추천' }])
    await flush()
    expect(onChange.mock.calls.at(-1)![0].items).toEqual(ipcItems)
    // 조회 중에도 지금 카드를 유지한다 (폴백으로 깜빡이지 않음)
    controller.refresh()
    expect(onChange.mock.calls.at(-1)![0]).toEqual({ items: ipcItems, loading: true })
  })

  it('다른 추천 버튼은 onRefresh 를 부른다', () => {
    const onRefresh = vi.fn()
    const tree = SuggestionGrid({ suggestions: ipcItems, loading: false, onSelect: () => {}, onRefresh })
    const refresh = collectButtons(tree).find((b) => b.props.title === '다른 추천 질문 보기')
    refresh!.props.onClick!()
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('형식이 틀린 항목은 버리고 모자라면 폴백으로 8개를 채운다', () => {
    const items = normalizeSuggestions([ipcItems[0], { id: 'x', category: 'nope', label: 'a', prompt: 'b' }, null])
    expect(items).toHaveLength(8)
    expect(items[0]).toEqual(ipcItems[0])
    expect(normalizeSuggestions('bad')).toEqual(FALLBACK_SUGGESTIONS)
  })
})
