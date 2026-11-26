import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installAiStreamSync, useAiChatStore } from './aiChatStore'
import { useNavigationStore } from './navigationStore'
import type { AiChat, AiMessage } from '../types'

// 다른 화면에서 AI 대화를 여는 startChatWith 와 앱 수준 스트림 구독을 고정한다.
// node 환경이라 window.api.ai 를 목으로 바꾼다.

type Calls = string[]

function mockAi(over: Record<string, unknown> = {}, calls: Calls = []): Record<string, ReturnType<typeof vi.fn>> {
  const ai = {
    status: vi.fn(async () => {
      calls.push('status')
      return { available: true }
    }),
    chatCreate: vi.fn(async () => {
      calls.push('chatCreate')
      return { id: 7 }
    }),
    chatList: vi.fn(async () => []),
    messages: vi.fn(async () => []),
    progress: vi.fn(async () => ({ running: false, text: '', toolLabel: null })),
    send: vi.fn(async (chatId: number, text: string) => {
      calls.push(`send:${chatId}:${text}`)
      return { started: true }
    }),
    chatDiscardIfEmpty: vi.fn(async (id: number) => {
      calls.push(`discard:${id}`)
      return { deleted: true }
    }),
    ...over
  }
  vi.stubGlobal('window', { api: { ai } })
  return ai as unknown as Record<string, ReturnType<typeof vi.fn>>
}

function resetStores(): void {
  useAiChatStore.setState({
    chats: [],
    currentChatId: null,
    messages: [],
    streamingText: '',
    toolStatus: null,
    isStreaming: false,
    error: null,
    pendingApproval: null,
    pendingApprovalChatId: null
  })
  useNavigationStore.setState({ view: 'today' })
}

describe('startChatWith', () => {
  beforeEach(resetStores)
  afterEach(() => vi.unstubAllGlobals())

  it('새 채팅을 만들고 프롬프트를 보낸 뒤 AI 화면으로 간다', async () => {
    const calls: Calls = []
    const ai = mockAi({}, calls)
    const setView = vi.spyOn(useNavigationStore.getState(), 'setView')
    useNavigationStore.setState({ setView })
    setView.mockImplementation((view) => {
      calls.push(`setView:${view}`)
      useNavigationStore.setState({ view })
    })

    await useAiChatStore.getState().startChatWith('Jira 티켓 PROJ-1 의 내용과 최근 진행 상황을 읽고 정리해줘.')

    expect(calls).toEqual([
      'status',
      'chatCreate',
      'send:7:Jira 티켓 PROJ-1 의 내용과 최근 진행 상황을 읽고 정리해줘.',
      'setView:ai'
    ])
    expect(ai.send).toHaveBeenCalledTimes(1)
    const s = useAiChatStore.getState()
    expect(s.currentChatId).toBe(7)
    expect(s.isStreaming).toBe(true)
    expect(s.messages.at(-1)?.content).toBe('Jira 티켓 PROJ-1 의 내용과 최근 진행 상황을 읽고 정리해줘.')
    expect(useNavigationStore.getState().view).toBe('ai')
  })

  it('AI 를 쓸 수 없으면 보내지 않고 AI 화면만 연다 (열린 채팅은 닫아 안내 카드를 보인다)', async () => {
    const ai = mockAi({ status: vi.fn(async () => ({ available: false, error: 'Claude Code 없음' })) })
    useAiChatStore.setState({ currentChatId: 3 })

    await useAiChatStore.getState().startChatWith('오늘 마감인 할 일 알려줘')

    expect(ai.chatCreate).not.toHaveBeenCalled()
    expect(ai.send).not.toHaveBeenCalled()
    expect(useAiChatStore.getState().currentChatId).toBeNull()
    expect(useNavigationStore.getState().view).toBe('ai')
  })

  it('상태 조회가 실패하면 사용 불가로 보고 보내지 않는다', async () => {
    const ai = mockAi({ status: vi.fn(async () => Promise.reject(new Error('ipc'))) })
    await useAiChatStore.getState().startChatWith('오늘 마감인 할 일 알려줘')
    expect(ai.send).not.toHaveBeenCalled()
    expect(useNavigationStore.getState().view).toBe('ai')
  })

  it('빈 프롬프트는 채팅을 만들지 않고 AI 화면만 연다', async () => {
    const ai = mockAi()
    await useAiChatStore.getState().startChatWith('   ')
    expect(ai.chatCreate).not.toHaveBeenCalled()
    expect(useNavigationStore.getState().view).toBe('ai')
  })

  it('전송이 거절되면 오류를 남기고 AI 화면을 연다', async () => {
    mockAi({ send: vi.fn(async () => ({ started: false, error: '이미 응답 중' })) })
    await useAiChatStore.getState().startChatWith('이번 주 일정 알려줘')
    expect(useAiChatStore.getState().error).toBe('이미 응답 중')
    expect(useAiChatStore.getState().isStreaming).toBe(false)
    expect(useNavigationStore.getState().view).toBe('ai')
  })
})

describe('startChatWith 실패·연타·쓰기 모드', () => {
  beforeEach(resetStores)
  afterEach(() => vi.unstubAllGlobals())

  it('채팅 생성이 실패하면 throw 하지 않고 error 를 남기고 AI 화면을 연다', async () => {
    const ai = mockAi({ chatCreate: vi.fn(async () => Promise.reject(new Error('db locked'))) })
    await expect(useAiChatStore.getState().startChatWith('이번 주 일정 알려줘')).resolves.toBeUndefined()
    expect(ai.send).not.toHaveBeenCalled()
    expect(useAiChatStore.getState().currentChatId).toBeNull()
    expect(useAiChatStore.getState().error).toContain('db locked')
    expect(useNavigationStore.getState().view).toBe('ai')
  })

  it('전송 IPC 가 reject 해도 throw 하지 않고 스트리밍 표시를 끄고 error 를 남긴다', async () => {
    mockAi({ send: vi.fn(async () => Promise.reject(new Error('ipc down'))) })
    await expect(useAiChatStore.getState().startChatWith('이번 주 일정 알려줘')).resolves.toBeUndefined()
    expect(useAiChatStore.getState().isStreaming).toBe(false)
    expect(useAiChatStore.getState().error).toContain('ipc down')
  })

  it('진행 중에 다시 부르면 두 번째는 화면 이동만 한다 (채팅 1개, 전송 1번)', async () => {
    const ai = mockAi()
    const first = useAiChatStore.getState().startChatWith('오늘 마감인 할 일 알려줘')
    const second = useAiChatStore.getState().startChatWith('오늘 마감인 할 일 알려줘')
    await Promise.all([first, second])
    expect(ai.chatCreate).toHaveBeenCalledTimes(1)
    expect(ai.send).toHaveBeenCalledTimes(1)
    expect(useNavigationStore.getState().view).toBe('ai')
    // 끝난 뒤에는 다시 시작할 수 있다
    await useAiChatStore.getState().startChatWith('이번 주 일정 알려줘')
    expect(ai.chatCreate).toHaveBeenCalledTimes(2)
  })

  it('실패로 끝나도 잠금이 풀린다', async () => {
    const ai = mockAi({
      chatCreate: vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue({ id: 8 })
    })
    await useAiChatStore.getState().startChatWith('a')
    await useAiChatStore.getState().startChatWith('b')
    expect(ai.chatCreate).toHaveBeenCalledTimes(2)
    expect(ai.send).toHaveBeenCalledTimes(1)
  })

  it('writeMode 를 주면 생성 직후·전송 전에 모드를 바꾼다', async () => {
    const calls: Calls = []
    // main 처럼 저장된 모드를 목록 조회에 돌려준다 (전송 뒤 목록 재조회가 있다)
    let saved = 'auto'
    const ai = mockAi(
      {
        chatList: vi.fn(async () => [{ id: 7, title: '새 대화', write_mode: saved }]),
        setChatWriteMode: vi.fn(async (id: number, mode: string) => {
          calls.push(`mode:${id}:${mode}`)
          saved = mode
          return { success: true }
        })
      },
      calls
    )
    await useAiChatStore.getState().startChatWith('Jira 에픽 PROJ-1 ...', { writeMode: 'ask' })
    expect(calls).toEqual(['status', 'chatCreate', 'mode:7:ask', 'send:7:Jira 에픽 PROJ-1 ...'])
    expect(ai.setChatWriteMode).toHaveBeenCalledTimes(1)
    expect(useAiChatStore.getState().chats.find((c) => c.id === 7)?.write_mode).toBe('ask')
  })

  it('writeMode 가 없으면 모드를 바꾸지 않는다', async () => {
    const ai = mockAi({ setChatWriteMode: vi.fn(async () => ({ success: true })) })
    await useAiChatStore.getState().startChatWith('이번 주 일정 알려줘')
    expect(ai.setChatWriteMode).not.toHaveBeenCalled()
    expect(ai.send).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['success=false', vi.fn(async () => ({ success: false }))],
    ['reject', vi.fn(async () => Promise.reject(new Error('x')))]
  ])('모드 변경이 실패(%s)하면 전송하지 않고 error 를 남긴다', async (_label, setChatWriteMode) => {
    const ai = mockAi({ setChatWriteMode })
    await expect(
      useAiChatStore.getState().startChatWith('Jira 티켓 PROJ-1 ...', { writeMode: 'ask' })
    ).resolves.toBeUndefined()
    expect(ai.send).not.toHaveBeenCalled()
    expect(useAiChatStore.getState().isStreaming).toBe(false)
    expect(useAiChatStore.getState().error).toContain('쓰기 모드')
    expect(useNavigationStore.getState().view).toBe('ai')
  })
})

describe('빈 새 채팅 정리 (discardIfEmpty)', () => {
  beforeEach(resetStores)
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const msg = (chatId: number): AiMessage => ({
    id: 1,
    chat_id: chatId,
    role: 'user',
    content: '안녕',
    meta: null,
    created_at: '2026-11-26T00:00:00.000Z'
  })

  it('빈 채팅에서 다른 채팅을 열면 떠나는 채팅을 지우고 목록을 다시 읽는다', async () => {
    const calls: Calls = []
    const ai = mockAi(
      {
        chatList: vi.fn(async () => {
          calls.push('chatList')
          return [{ id: 2, title: '기존 대화' }]
        }),
        messages: vi.fn(async (id: number) => {
          calls.push(`messages:${id}`)
          return [msg(id)]
        })
      },
      calls
    )
    useAiChatStore.setState({ currentChatId: 5, chats: [{ id: 5 } as AiChat, { id: 2 } as AiChat] })

    await useAiChatStore.getState().openChat(2)

    expect(ai.chatDiscardIfEmpty).toHaveBeenCalledWith(5)
    expect(calls).toEqual(['discard:5', 'chatList', 'messages:2'])
    const s = useAiChatStore.getState()
    expect(s.currentChatId).toBe(2)
    expect(s.chats.map((c) => c.id)).toEqual([2])
  })

  it('같은 채팅을 다시 열면 지우지 않는다', async () => {
    const ai = mockAi()
    useAiChatStore.setState({ currentChatId: 5 })
    await useAiChatStore.getState().openChat(5)
    expect(ai.chatDiscardIfEmpty).not.toHaveBeenCalled()
  })

  it('빈 채팅을 연 채로 새 채팅을 누르면 이전 채팅을 지운 뒤 새로 만든다 (새 채팅은 지우지 않는다)', async () => {
    const calls: Calls = []
    const ai = mockAi({}, calls)
    useAiChatStore.setState({ currentChatId: 5 })

    const id = await useAiChatStore.getState().createChat()

    expect(id).toBe(7)
    expect(calls).toEqual(['discard:5', 'chatCreate'])
    expect(ai.chatDiscardIfEmpty).toHaveBeenCalledTimes(1)
    expect(useAiChatStore.getState().currentChatId).toBe(7)
  })

  it('메시지가 있는 채팅은 화면 상태로 걸러 IPC 를 부르지 않는다', async () => {
    const ai = mockAi()
    useAiChatStore.setState({ currentChatId: 5, messages: [msg(5)] })
    await useAiChatStore.getState().openChat(2)
    expect(ai.chatDiscardIfEmpty).not.toHaveBeenCalled()
  })

  it('응답 중인 채팅은 지우지 않는다', async () => {
    const ai = mockAi()
    useAiChatStore.setState({ currentChatId: 5, isStreaming: true })
    await useAiChatStore.getState().createChat()
    expect(ai.chatDiscardIfEmpty).not.toHaveBeenCalled()
  })

  it('main 이 deleted:false 면 화면과 목록을 건드리지 않는다', async () => {
    const ai = mockAi({ chatDiscardIfEmpty: vi.fn(async () => ({ deleted: false })) })
    useAiChatStore.setState({ currentChatId: 5, chats: [{ id: 5 } as AiChat] })
    await useAiChatStore.getState().discardIfEmpty(5)
    expect(ai.chatDiscardIfEmpty).toHaveBeenCalledWith(5)
    expect(ai.chatList).not.toHaveBeenCalled()
    expect(useAiChatStore.getState().currentChatId).toBe(5)
  })

  it('보고 있는 채팅이 지워지면 화면을 비우되 오류 문구는 남긴다', async () => {
    mockAi()
    useAiChatStore.setState({ currentChatId: 5, error: 'x' })
    await useAiChatStore.getState().discardIfEmpty(5)
    const s = useAiChatStore.getState()
    expect(s.currentChatId).toBeNull()
    expect(s.error).toBe('x')
  })

  it('keepView 면 지워도 화면을 비우지 않는다', async () => {
    mockAi()
    useAiChatStore.setState({ currentChatId: 5 })
    await useAiChatStore.getState().discardIfEmpty(5, { keepView: true })
    expect(useAiChatStore.getState().currentChatId).toBe(5)
  })

  it.each([
    ['openChat', () => useAiChatStore.getState().openChat(2)],
    ['createChat', () => useAiChatStore.getState().createChat()]
  ])('%s 로 빈 채팅을 떠날 때 중간에 빈 화면(currentChatId null)을 거치지 않는다', async (_label, act) => {
    const ai = mockAi()
    useAiChatStore.setState({ currentChatId: 5 })
    const seen: Array<number | null> = []
    const unsub = useAiChatStore.subscribe((st) => seen.push(st.currentChatId))
    await act()
    unsub()
    expect(ai.chatDiscardIfEmpty).toHaveBeenCalledWith(5)
    expect(seen).not.toContain(null)
    expect(useAiChatStore.getState().currentChatId).not.toBe(5)
  })

  it('전송이 거절돼 낙관적 메시지만 남은 채팅은 빈 채팅으로 보고 정리한다', async () => {
    const ai = mockAi({ send: vi.fn(async () => ({ started: false, error: '동시 실행 한도' })) })
    useAiChatStore.setState({ currentChatId: 5 })
    await useAiChatStore.getState().sendMessage('안녕')
    expect(useAiChatStore.getState().messages).toHaveLength(1)
    expect(useAiChatStore.getState().messages[0].id).toBeLessThan(0)

    await useAiChatStore.getState().openChat(2)
    expect(ai.chatDiscardIfEmpty).toHaveBeenCalledWith(5)
  })

  it('IPC 가 실패해도 throw 하지 않는다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockAi({ chatDiscardIfEmpty: vi.fn(async () => Promise.reject(new Error('ipc'))) })
    useAiChatStore.setState({ currentChatId: 5 })
    await expect(useAiChatStore.getState().discardIfEmpty(5)).resolves.toBeUndefined()
    expect(useAiChatStore.getState().currentChatId).toBe(5)
  })

  it('closeChat 은 바로 닫고 떠나는 빈 채팅 정리를 시작한다', async () => {
    const ai = mockAi()
    useAiChatStore.setState({ currentChatId: 5 })
    useAiChatStore.getState().closeChat()
    expect(useAiChatStore.getState().currentChatId).toBeNull()
    expect(ai.chatDiscardIfEmpty).toHaveBeenCalledWith(5)
    await vi.waitFor(() => expect(ai.chatList).toHaveBeenCalled())
  })

  it('startChatWith 는 생성~전송 사이에 새 채팅을 지우지 않는다', async () => {
    let resolveMode: (v: { success: boolean }) => void = () => {}
    const ai = mockAi({
      setChatWriteMode: vi.fn(() => new Promise((r) => (resolveMode = r)))
    })
    const started = useAiChatStore.getState().startChatWith('이번 주 일정 알려줘', { writeMode: 'ask' })
    await vi.waitFor(() => expect(ai.setChatWriteMode).toHaveBeenCalled())
    // 모드 변경을 기다리는 동안 다른 곳에서 정리를 시도해도 지우지 않는다
    await useAiChatStore.getState().discardIfEmpty(7)
    expect(ai.chatDiscardIfEmpty).not.toHaveBeenCalled()
    resolveMode({ success: true })
    await started
    expect(ai.send).toHaveBeenCalledWith(7, '이번 주 일정 알려줘', undefined)
    expect(ai.chatDiscardIfEmpty).not.toHaveBeenCalled()
  })

  it('startChatWith 는 열려 있던 빈 채팅을 정리하고 새 채팅으로 보낸다', async () => {
    const calls: Calls = []
    mockAi({}, calls)
    useAiChatStore.setState({ currentChatId: 5 })
    await useAiChatStore.getState().startChatWith('오늘 마감인 할 일 알려줘')
    expect(calls).toEqual(['status', 'discard:5', 'chatCreate', 'send:7:오늘 마감인 할 일 알려줘'])
  })
})

describe('installAiStreamSync', () => {
  beforeEach(resetStores)
  afterEach(() => vi.unstubAllGlobals())

  it('ai:stream 을 1번 구독해 스토어에 반영하고 해제 함수를 돌려준다', () => {
    let listener: ((e: unknown) => void) | null = null
    const unsubscribe = vi.fn()
    const onStream = vi.fn((cb: (e: unknown) => void) => {
      listener = cb
      return unsubscribe
    })
    mockAi({ onStream })
    useAiChatStore.setState({ currentChatId: 7 })

    const off = installAiStreamSync()
    expect(onStream).toHaveBeenCalledTimes(1)

    listener!({ event: 'start', chatId: 7 })
    listener!({ event: 'text', chatId: 7, delta: '안녕' })
    expect(useAiChatStore.getState().isStreaming).toBe(true)
    expect(useAiChatStore.getState().streamingText).toBe('안녕')

    off()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('api 가 없는 창에서는 아무것도 하지 않는다', () => {
    vi.stubGlobal('window', {})
    expect(() => installAiStreamSync()()).not.toThrow()
  })
})
