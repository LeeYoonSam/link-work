import { create } from 'zustand'
import type { AiApprovalRequest, AiChat, AiMessage, AiStreamEvent } from '../types'

interface AiChatStore {
  chats: AiChat[]
  currentChatId: number | null
  messages: AiMessage[]
  streamingText: string
  toolStatus: string | null
  isStreaming: boolean
  error: string | null
  pendingApproval: AiApprovalRequest | null

  fetchChats: () => Promise<void>
  createChat: () => Promise<number>
  deleteChat: (id: number) => Promise<void>
  renameChat: (id: number, title: string) => Promise<void>
  openChat: (id: number) => Promise<void>
  closeChat: () => void
  sendMessage: (text: string) => Promise<void>
  cancelStream: () => Promise<void>
  respondApproval: (requestId: string, approved: boolean) => Promise<void>
  handleStreamEvent: (event: AiStreamEvent) => void
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

  fetchChats: async () => {
    const chats = await window.api.ai.chatList()
    set({ chats })
  },

  createChat: async () => {
    const { id } = await window.api.ai.chatCreate()
    await get().fetchChats()
    await get().openChat(id)
    return id
  },

  deleteChat: async (id) => {
    await window.api.ai.chatDelete(id)
    if (get().currentChatId === id) {
      set({ currentChatId: null, messages: [], streamingText: '', toolStatus: null, isStreaming: false, error: null, pendingApproval: null })
    }
    await get().fetchChats()
  },

  renameChat: async (id, title) => {
    await window.api.ai.chatRename(id, title)
    await get().fetchChats()
  },

  openChat: async (id) => {
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
  },

  closeChat: () => {
    set({ currentChatId: null, messages: [], streamingText: '', toolStatus: null, error: null, pendingApproval: null })
  },

  sendMessage: async (text) => {
    const chatId = get().currentChatId
    const trimmed = text.trim()
    if (!chatId || !trimmed || get().isStreaming) return

    // 사용자 메시지 낙관적 추가 (done/오류와 무관하게 서버에 이미 저장됨)
    const optimistic: AiMessage = {
      id: -Date.now(),
      chat_id: chatId,
      role: 'user',
      content: trimmed,
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

    const result = await window.api.ai.send(chatId, trimmed)
    if (!result.started) {
      set({ isStreaming: false, error: result.error ?? '메시지 전송에 실패했습니다.' })
      return
    }
    // 첫 메시지로 제목이 자동 설정되므로 리스트 갱신
    void get().fetchChats()
  },

  cancelStream: async () => {
    const chatId = get().currentChatId
    if (!chatId) return
    await window.api.ai.cancel(chatId)
  },

  respondApproval: async (requestId, approved) => {
    // main이 approval_resolved 이벤트로도 정리하지만, 클릭 즉시 카드를 닫는다
    set((s) => (s.pendingApproval?.requestId === requestId ? { pendingApproval: null } : s))
    await window.api.ai.approve(requestId, approved)
  },

  handleStreamEvent: (event) => {
    const { currentChatId } = get()
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
        set({ pendingApproval: event.request, toolStatus: null })
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
