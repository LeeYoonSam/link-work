import { create } from 'zustand'
import type {
  AiApprovalRequest,
  AiAttachmentInput,
  AiChat,
  AiChatModelOption,
  AiMessage,
  AiStreamEvent,
  AiWriteMode
} from '../types'
import { useNavigationStore } from './navigationStore'

// main 의 모델 선택지를 받기 전에 보여 줄 폴백 목록이다.
// main 이 받은 목록으로 교체하므로, 버전 표기가 바뀌어도 이 목록은 고치지 않는다.
export const FALLBACK_MODEL_OPTIONS: AiChatModelOption[] = [
  { value: 'fable', label: 'Fable', description: '가장 강력, 느림' },
  { value: 'opus', label: 'Opus', description: '정확, 균형' },
  { value: 'haiku', label: 'Haiku', description: '가장 빠름' }
]

interface StartChatOptions {
  // 새 채팅의 쓰기 모드. 지정하면 전송 전에 바꾼다. 실패하면 전송하지 않는다
  writeMode?: AiWriteMode
}

// startChatWith 실행 중 잠금. 연타로 채팅이 2개 생기지 않게 한다
let startingChat = false
// startChatWith 가 만들고 아직 첫 메시지를 보내지 않은 채팅. 생성~전송 사이에 빈 채팅 정리로 지우지 않는다
const startingChatIds = new Set<number>()

// 보던 채팅이 지워졌을 때 비우는 화면 상태
function clearedChatState(): Partial<AiChatStore> {
  return {
    currentChatId: null,
    messages: [],
    streamingText: '',
    toolStatus: null,
    isStreaming: false,
    error: null,
    pendingApproval: null
  }
}

interface AiChatStore {
  chats: AiChat[]
  currentChatId: number | null
  messages: AiMessage[]
  streamingText: string
  toolStatus: string | null
  isStreaming: boolean
  error: string | null
  pendingApproval: AiApprovalRequest | null
  // pendingApproval 을 받은 채팅. 계획 승인 응답이 이 채팅의 모드를 바꾼다
  pendingApprovalChatId: number | null
  model: string
  modelOptions: AiChatModelOption[]

  fetchChats: () => Promise<void>
  createChat: () => Promise<number>
  deleteChat: (id: number) => Promise<void>
  renameChat: (id: number, title: string) => Promise<void>
  openChat: (id: number) => Promise<void>
  // 채팅을 닫는다. 메시지 없이 떠나는 빈 채팅은 정리한다 (비동기, 기다리지 않는다)
  closeChat: () => void
  // 메시지가 없고 응답 중이 아닌 채팅을 지운다. 최종 판정은 main(ai:chatDiscardIfEmpty)이 한다.
  // "+ 새 채팅" 후 보내지 않고 떠난 채팅이 목록에 "새 대화"로 남지 않게 한다. 실패는 무시한다
  // keepView: 곧 다른 채팅으로 화면을 바꾸는 호출(openChat·createChat)은 화면을 비우지 않는다 (빈 화면 깜빡임 방지)
  discardIfEmpty: (id: number, options?: { keepView?: boolean }) => Promise<void>
  sendMessage: (text: string, attachments?: AiAttachmentInput[]) => Promise<void>
  cancelStream: () => Promise<void>
  // 성공 여부를 돌려준다 (startChatWith 가 실패 시 전송을 멈춘다)
  setWriteMode: (chatId: number, mode: AiWriteMode) => Promise<boolean>
  loadModel: () => Promise<void>
  loadModelOptions: () => Promise<void>
  setModel: (model: string) => Promise<void>
  respondApproval: (requestId: string, approved: boolean, alwaysForChat?: boolean) => Promise<void>
  // 계획 승인 카드 응답. 승인하면 mode 로 쓰기 모드를 바꾸고 실행을 이어 간다
  respondPlan: (requestId: string, approved: boolean, mode?: 'auto' | 'ask') => Promise<void>
  handleStreamEvent: (event: AiStreamEvent) => void
  // 다른 화면에서 AI 대화를 연다: 새 채팅 생성 → (writeMode 지정 시) 모드 변경 → prompt 전송 → AI 화면 이동.
  // AI 를 쓸 수 없으면(ai:status) 전송하지 않고 AI 화면만 연다 (화면이 안내 카드를 보인다).
  // 실패는 throw 하지 않고 error 상태로 남긴다. 진행 중에 다시 부르면 화면 이동만 한다
  startChatWith: (prompt: string, options?: StartChatOptions) => Promise<void>
}

export const useAiChatStore = create<AiChatStore>((set, get) => ({
  chats: [],
  currentChatId: null,
  messages: [],
  streamingText: '',
  toolStatus: null,
  isStreaming: false,
  error: null,
  pendingApproval: null,
  pendingApprovalChatId: null,
  model: 'opus',
  modelOptions: FALLBACK_MODEL_OPTIONS,

  fetchChats: async () => {
    const chats = await window.api.ai.chatList()
    set({ chats })
  },

  createChat: async () => {
    // 보던 채팅이 비어 있으면 먼저 정리한다 (새 채팅 연타로 빈 채팅이 쌓이지 않게)
    const prev = get().currentChatId
    if (prev !== null) await get().discardIfEmpty(prev, { keepView: true })
    const { id } = await window.api.ai.chatCreate()
    await get().fetchChats()
    // openChat 을 거치지 않는다: 이전 채팅 정리는 위에서 했다
    await loadChat(id, get, set)
    return id
  },

  deleteChat: async (id) => {
    await window.api.ai.chatDelete(id)
    if (get().currentChatId === id) set(clearedChatState())
    await get().fetchChats()
  },

  discardIfEmpty: async (id, options) => {
    // 생성 직후 첫 메시지를 보내는 중인 채팅은 지우지 않는다
    if (startingChatIds.has(id)) return
    // 화면이 아는 상태로 먼저 거른다 (보고 있는 채팅만 메시지·응답 상태를 안다).
    // 저장된 메시지만 센다: 전송이 거절(started:false)되면 낙관적 메시지(음수 id)만 남는데, 그 채팅은 실제로 비어 있다
    const s = get()
    if (s.currentChatId === id && (s.messages.some((m) => m.id > 0) || s.isStreaming)) return
    let deleted = false
    try {
      deleted = (await window.api.ai.chatDiscardIfEmpty(id))?.deleted === true
    } catch (e) {
      console.warn('[aiChat] 빈 채팅 정리 실패:', e)
      return
    }
    if (!deleted) return
    // 그 사이 다른 채팅을 열었거나 호출자가 곧 화면을 바꾸면 화면은 그대로 둔다.
    // 비울 때도 error 는 남긴다 (startChatWith 등이 남긴 오류를 빈 화면이 보여 준다)
    if (!options?.keepView && get().currentChatId === id) {
      set({ ...clearedChatState(), error: get().error })
    }
    try {
      await get().fetchChats()
    } catch (e) {
      console.warn('[aiChat] 채팅 목록 갱신 실패:', e)
    }
  },

  renameChat: async (id, title) => {
    await window.api.ai.chatRename(id, title)
    await get().fetchChats()
  },

  openChat: async (id) => {
    // 다른 채팅으로 옮기면 떠나는 채팅이 비어 있을 때 정리한다
    const prev = get().currentChatId
    if (prev !== null && prev !== id) await get().discardIfEmpty(prev, { keepView: true })
    await loadChat(id, get, set)
  },

  closeChat: () => {
    // 상태를 비우기 전에 정리를 시작해야 화면 상태(메시지 수)로 거를 수 있다
    const prev = get().currentChatId
    if (prev !== null) void get().discardIfEmpty(prev)
    set({ currentChatId: null, messages: [], streamingText: '', toolStatus: null, error: null, pendingApproval: null })
  },

  sendMessage: async (text, attachments) => {
    const chatId = get().currentChatId
    const trimmed = text.trim()
    const hasAttachments = !!attachments?.length
    if (!chatId || (!trimmed && !hasAttachments) || get().isStreaming) return

    // 사용자 메시지 낙관적 추가 (done/오류와 무관하게 서버에 이미 저장됨).
    // 첨부 파일명은 저장 후에 정해지므로 전송 성공 뒤 재조회로 썸네일을 채운다.
    const optimistic: AiMessage = {
      id: -Date.now(),
      chat_id: chatId,
      role: 'user',
      content: trimmed || '(이미지 첨부)',
      meta: null,
      created_at: new Date().toISOString()
    }
    set((s) => ({
      messages: [...s.messages, optimistic],
      isStreaming: true,
      streamingText: '',
      toolStatus: null,
      error: null
    }))

    const result = await window.api.ai.send(chatId, trimmed, attachments)
    if (!result.started) {
      set({ isStreaming: false, error: result.error ?? '메시지 전송에 실패했습니다.' })
      return
    }
    if (hasAttachments) {
      const fresh = await window.api.ai.messages(chatId)
      if (get().currentChatId === chatId) set({ messages: fresh })
    }
    // 첫 메시지로 제목이 자동 설정되므로 리스트 갱신
    void get().fetchChats()
  },

  cancelStream: async () => {
    const chatId = get().currentChatId
    if (!chatId) return
    await window.api.ai.cancel(chatId)
  },

  setWriteMode: async (chatId, mode) => {
    const result = await window.api.ai.setChatWriteMode(chatId, mode)
    if (result.success) {
      set((s) => ({
        chats: s.chats.map((c) => (c.id === chatId ? { ...c, write_mode: mode } : c))
      }))
    }
    return result.success === true
  },

  loadModel: async () => {
    const model = await window.api.ai.getModel()
    set({ model })
  },

  loadModelOptions: async () => {
    // 조회가 실패하거나 빈 목록이면 폴백 목록을 유지한다
    try {
      const options = await window.api.ai.getModelOptions()
      if (Array.isArray(options) && options.length > 0) set({ modelOptions: options })
    } catch {
      // 폴백 목록을 그대로 둔다
    }
  },

  setModel: async (model) => {
    // 실패 시에도 main이 현재 저장값을 돌려주므로 응답 기준으로 맞춘다
    const result = await window.api.ai.setModel(model)
    set({ model: result.model })
  },

  respondApproval: async (requestId, approved, alwaysForChat = false) => {
    // main이 approval_resolved 이벤트로도 정리하지만, 클릭 즉시 카드를 닫는다
    set((s) => (s.pendingApproval?.requestId === requestId ? { pendingApproval: null } : s))
    // "이 채팅에서 항상 승인": 모드를 먼저 auto로 바꿔야 이후 호출이 자동 승인된다
    if (approved && alwaysForChat) {
      const chatId = get().currentChatId
      if (chatId) await get().setWriteMode(chatId, 'auto')
    }
    await window.api.ai.approve(requestId, approved)
  },

  respondPlan: async (requestId, approved, mode) => {
    // 승인 요청을 받은 채팅을 쓴다. 카드가 이미 닫혔으면 현재 채팅으로 본다
    const before = get()
    const chatId =
      before.pendingApproval?.requestId === requestId
        ? (before.pendingApprovalChatId ?? before.currentChatId)
        : before.currentChatId
    set((s) =>
      s.pendingApproval?.requestId === requestId
        ? { pendingApproval: null, pendingApprovalChatId: null }
        : s
    )
    const nextMode = approved && mode ? mode : null
    const prevMode = chatId ? before.chats.find((c) => c.id === chatId)?.write_mode : undefined
    // main 이 mode_changed 이벤트를 보낸다. 화면은 응답 전에 먼저 바꿔 둔다
    if (nextMode && chatId) {
      set((s) => ({
        chats: s.chats.map((c) => (c.id === chatId ? { ...c, write_mode: nextMode } : c))
      }))
    }
    let success = false
    try {
      const result = await window.api.ai.approve(
        requestId,
        approved,
        nextMode ? { mode: nextMode } : undefined
      )
      success = result?.success === true
    } catch {
      success = false
    }
    // 승인이 실패하면 (예: 이미 타임아웃) main 은 모드를 바꾸지 않았다. 화면 모드를 되돌린다.
    // 그 사이 다른 모드로 바뀌었으면 그 값을 존중한다
    if (!success && nextMode && chatId && prevMode) {
      set((s) => ({
        chats: s.chats.map((c) =>
          c.id === chatId && c.write_mode === nextMode ? { ...c, write_mode: prevMode } : c
        )
      }))
    }
  },

  startChatWith: async (prompt, options) => {
    const goAi = (): void => useNavigationStore.getState().setView('ai')
    if (startingChat) {
      goAi()
      return
    }
    startingChat = true
    try {
      const text = prompt.trim()
      let available = false
      try {
        available = (await window.api.ai.status()).available
      } catch {
        available = false
      }
      if (!available) {
        // 채팅을 닫아야 AI 화면이 사용 불가 안내 카드를 보인다
        get().closeChat()
        return
      }
      if (!text) return

      let chatId: number
      try {
        chatId = await get().createChat()
      } catch (e) {
        // 채팅이 없으면 AI 화면 빈 화면이 error 를 보인다
        set({ error: `새 대화를 만들지 못했습니다: ${errorText(e)}` })
        return
      }
      startingChatIds.add(chatId)

      const mode = options?.writeMode
      if (mode) {
        let ok = false
        try {
          ok = await get().setWriteMode(chatId, mode)
        } catch {
          ok = false
        }
        if (!ok) {
          set({ error: '대화의 쓰기 모드를 바꾸지 못해 메시지를 보내지 않았습니다. 모드를 확인한 뒤 직접 보내 주세요.' })
          return
        }
      }

      try {
        await get().sendMessage(text)
      } catch (e) {
        set({ isStreaming: false, error: `메시지 전송에 실패했습니다: ${errorText(e)}` })
      }
    } finally {
      // 전송했으면 메시지가 있어 정리 대상이 아니다. 전송 전에 멈췄으면 이후 떠날 때 정리된다
      startingChatIds.clear()
      startingChat = false
      // 실패해도 AI 화면을 연다. 오류는 AI 화면(채팅 안 또는 빈 화면)에 보인다
      goAi()
    }
  },

  handleStreamEvent: (event) => {
    const { currentChatId } = get()
    // 모드 변경은 채팅 목록 상태라서 보고 있지 않은 채팅에도 적용한다
    if (event.event === 'mode_changed') {
      set((s) => ({
        chats: s.chats.map((c) => (c.id === event.chatId ? { ...c, write_mode: event.mode } : c))
      }))
      return
    }
    // 보고 있지 않은 채팅의 이벤트: 리스트만 갱신
    if (event.chatId !== currentChatId) {
      if (event.event === 'done') void get().fetchChats()
      return
    }

    switch (event.event) {
      case 'start':
        set({ isStreaming: true, streamingText: '', toolStatus: null, error: null })
        break
      case 'text':
        set((s) => ({ streamingText: s.streamingText + event.delta, toolStatus: null }))
        break
      case 'tool':
        set({ toolStatus: event.label })
        break
      case 'approval':
        set({ pendingApproval: event.request, pendingApprovalChatId: event.chatId, toolStatus: null })
        break
      case 'approval_resolved':
        set((s) =>
          s.pendingApproval?.requestId === event.requestId ? { pendingApproval: null } : s
        )
        break
      case 'done':
        set((s) => ({
          isStreaming: false,
          streamingText: '',
          toolStatus: null,
          pendingApproval: null,
          messages: event.message ? [...s.messages, event.message] : s.messages
        }))
        void get().fetchChats()
        break
      case 'error':
        set({ isStreaming: false, streamingText: '', toolStatus: null, pendingApproval: null, error: event.error })
        break
    }
  }
}))

type StoreSet = (partial: Partial<AiChatStore>) => void

// 채팅 메시지와 진행 중 응답을 읽어 화면에 띄운다 (이전 채팅 정리는 호출자가 한다)
async function loadChat(id: number, get: () => AiChatStore, set: StoreSet): Promise<void> {
  const messages = await window.api.ai.messages(id)
  // 이 채팅에서 진행 중인 응답이 있으면 스트리밍 표시 복원
  const progress = await window.api.ai.progress(id)
  set({
    currentChatId: id,
    messages,
    isStreaming: progress.running,
    streamingText: progress.running ? progress.text : '',
    toolStatus: progress.running ? progress.toolLabel : null,
    pendingApproval: progress.running ? (progress.pendingApproval ?? null) : null,
    pendingApprovalChatId: progress.running && progress.pendingApproval ? id : null,
    error: null
  })
  if (progress.running) {
    // progress 조회와 set 사이에 done 이벤트가 끼어든 경우(놓친 완료) 보정
    const recheck = await window.api.ai.progress(id)
    if (!recheck.running && get().currentChatId === id && get().isStreaming) {
      const fresh = await window.api.ai.messages(id)
      set({ messages: fresh, isStreaming: false, streamingText: '', toolStatus: null, pendingApproval: null })
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// AI 응답 스트림(ai:stream)을 앱 수준에서 1번 구독한다.
// AI 화면 마운트 전에 보낸 초기 이벤트(start·text)를 놓치지 않기 위해서다.
// App 메인 창이 설치하고 해제 함수를 돌려준다. 화면별 구독을 두지 않는다 (중복 반영 방지)
export function installAiStreamSync(): () => void {
  const api = window.api?.ai
  if (!api?.onStream) return () => {}
  return api.onStream((event) => useAiChatStore.getState().handleStreamEvent(event as AiStreamEvent))
}
