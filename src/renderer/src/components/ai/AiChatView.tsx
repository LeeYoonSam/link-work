import { useEffect, useRef, useState } from 'react'
import { useAiChatStore } from '../../stores/aiChatStore'
import { useProjectStore } from '../../stores/projectStore'
import MarkdownContent from '../memo/MarkdownContent'
import type { AiChat, AiMessage, AiStatus, AiStreamEvent } from '../../types'

const EXAMPLE_PROMPTS = [
  '현재 진행중인 프로젝트 알려줘',
  '이번주에 진행한 작업들 정리해줘',
  '미완료 TODO를 우선순위별로 보여줘',
  '메모에서 클로드 관련 정보들을 알려줘'
]

function formatChatTime(value: string): string {
  const date = new Date(value.replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}

export default function AiChatView(): React.ReactNode {
  const {
    chats,
    currentChatId,
    fetchChats,
    createChat,
    deleteChat,
    openChat,
    sendMessage,
    handleStreamEvent
  } = useAiChatStore()
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [listCollapsed, setListCollapsed] = useState(false)

  const checkStatus = (): void => {
    window.api.ai.status().then(setAiStatus)
  }

  useEffect(() => {
    fetchChats()
    checkStatus()
    const unsubscribe = window.api.ai.onStream((event) =>
      handleStreamEvent(event as AiStreamEvent)
    )
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const aiUnavailable = aiStatus !== null && !aiStatus.available

  const handleExampleClick = async (prompt: string): Promise<void> => {
    await createChat()
    await sendMessage(prompt)
  }

  return (
    <div className="h-full flex bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* 채팅 리스트 (접기 가능) */}
      {listCollapsed ? (
        <div className="w-11 shrink-0 border-r border-gray-200 flex flex-col items-center py-3 gap-2 bg-gray-50">
          <button
            onClick={() => setListCollapsed(false)}
            className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded transition-colors"
            title="채팅 목록 펼치기"
          >
            »
          </button>
          <button
            onClick={() => createChat()}
            className="w-7 h-7 flex items-center justify-center bg-gray-900 text-white rounded hover:bg-gray-700 transition-colors"
            title="새 채팅"
          >
            +
          </button>
        </div>
      ) : (
        <div className="w-72 shrink-0 border-r border-gray-200 flex flex-col bg-gray-50">
          <div className="p-3 border-b border-gray-200 flex items-center gap-2">
            <button
              onClick={() => createChat()}
              className="flex-1 px-3 py-2 bg-gray-900 text-white text-sm rounded-md hover:bg-gray-700 transition-colors"
            >
              + 새 채팅
            </button>
            <button
              onClick={() => setListCollapsed(true)}
              className="px-2 py-2 text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded transition-colors"
              title="채팅 목록 접기"
            >
              «
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {chats.length === 0 ? (
              <p className="p-4 text-xs text-gray-400 text-center">
                아직 대화가 없습니다.
                <br />새 채팅을 시작해 보세요.
              </p>
            ) : (
              chats.map((chat) => (
                <ChatListItem
                  key={chat.id}
                  chat={chat}
                  active={chat.id === currentChatId}
                  onClick={() => openChat(chat.id)}
                  onDelete={() => {
                    if (window.confirm(`'${chat.title}' 대화를 삭제할까요?`)) {
                      deleteChat(chat.id)
                    }
                  }}
                />
              ))
            )}
          </div>
        </div>
      )}

      {/* 대화 영역 */}
      <div className="flex-1 flex flex-col min-w-0">
        {aiUnavailable && (
          <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 flex items-center justify-between gap-2">
            <span>{aiStatus?.error}</span>
            <button
              onClick={checkStatus}
              className="shrink-0 px-2 py-1 text-xs border border-red-300 rounded hover:bg-red-100 transition-colors"
            >
              다시 확인
            </button>
          </div>
        )}
        {!aiUnavailable && aiStatus?.warning && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-800">
            {aiStatus.warning}
          </div>
        )}
        {currentChatId ? (
          <ChatRoom disabled={aiUnavailable} />
        ) : aiUnavailable ? (
          <AiUnavailableNotice error={aiStatus?.error} onRecheck={checkStatus} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <div className="text-4xl mb-3">✦</div>
            <h3 className="text-lg font-semibold text-gray-800 mb-1">LinkWork AI</h3>
            <p className="text-sm text-gray-500 mb-6">
              프로젝트, TODO, 메모, 문서 등 LinkWork의 데이터를 검색하고 정리해 드립니다.
            </p>
            <div className="grid grid-cols-2 gap-2 w-full max-w-xl">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => handleExampleClick(prompt)}
                  className="px-4 py-3 text-left text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 hover:border-gray-300 transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function AiUnavailableNotice({
  error,
  onRecheck
}: {
  error?: string
  onRecheck: () => void
}): React.ReactNode {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="max-w-md w-full bg-amber-50 border border-amber-200 rounded-xl p-6 text-center">
        <div className="text-3xl mb-3">⚠</div>
        <h3 className="text-base font-semibold text-gray-900 mb-2">
          AI 대화를 사용할 수 없습니다
        </h3>
        <p className="text-sm text-gray-700 mb-4">{error}</p>
        <ol className="text-left text-sm text-gray-600 space-y-1.5 mb-5 list-decimal pl-5">
          <li>
            Claude Code 설치 —{' '}
            <a
              href="https://claude.com/claude-code"
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 hover:underline"
            >
              claude.com/claude-code
            </a>
          </li>
          <li>
            터미널에서 <code className="px-1 bg-gray-100 rounded text-xs font-mono">claude</code>{' '}
            실행 후 구독 계정으로 로그인
          </li>
          <li>아래 버튼으로 다시 확인</li>
        </ol>
        <button
          onClick={onRecheck}
          className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 transition-colors"
        >
          다시 확인
        </button>
        <p className="mt-4 text-xs text-gray-400">
          AI 대화 외 다른 기능(프로젝트/TODO/메모 등)은 정상적으로 사용할 수 있습니다.
        </p>
      </div>
    </div>
  )
}

function ChatListItem({
  chat,
  active,
  onClick,
  onDelete
}: {
  chat: AiChat
  active: boolean
  onClick: () => void
  onDelete: () => void
}): React.ReactNode {
  return (
    <div
      onClick={onClick}
      className={`group px-3 py-2.5 border-b border-gray-100 cursor-pointer transition-colors ${
        active ? 'bg-white border-l-2 border-l-gray-900' : 'hover:bg-gray-100'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-gray-800 truncate">{chat.title}</span>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[10px] text-gray-400">{formatChatTime(chat.updated_at)}</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="opacity-0 group-hover:opacity-100 px-1 text-gray-400 hover:text-red-500 transition-opacity"
            title="대화 삭제"
          >
            ✕
          </button>
        </div>
      </div>
      {chat.last_message && (
        <p className="mt-0.5 text-xs text-gray-400 truncate">{chat.last_message}</p>
      )}
    </div>
  )
}

function ChatRoom({ disabled = false }: { disabled?: boolean }): React.ReactNode {
  const {
    chats,
    currentChatId,
    messages,
    streamingText,
    toolStatus,
    isStreaming,
    error,
    sendMessage,
    cancelStream,
    renameChat
  } = useAiChatStore()
  const { setView, setProjectView, fetchProject } = useProjectStore()
  const [input, setInput] = useState('')
  const [editingTitle, setEditingTitle] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const chat = chats.find((c) => c.id === currentChatId)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText, toolStatus])

  // linkwork:// 링크 → 앱 내 네비게이션/문서 열기
  const handleInternalLink = async (href: string): Promise<void> => {
    const match = href.match(/^linkwork:\/\/([a-z]+)\/?(.*)$/)
    if (!match) return
    const [, kind, rest] = match
    if (kind === 'project' && /^\d+$/.test(rest)) {
      await fetchProject(Number(rest))
      setProjectView('detail')
      setView('projects')
    } else if (kind === 'document' && /^\d+$/.test(rest)) {
      const docs = await window.api.document.listAll()
      const doc = docs.find((d) => d.id === Number(rest))
      if (doc) {
        await window.api.document.open(doc.url, doc.type)
      } else {
        setView('documents')
      }
    } else if (kind === 'view') {
      const views = [
        'dashboard',
        'projects',
        'todos',
        'documents',
        'variables',
        'memos',
        'calendar',
        'reports'
      ] as const
      const target = views.find((v) => v === rest)
      if (target) setView(target)
    }
  }

  const handleSend = (): void => {
    const text = input.trim()
    if (!text || isStreaming || disabled) return
    setInput('')
    void sendMessage(text)
    textareaRef.current?.focus()
  }

  const submitTitle = (): void => {
    if (editingTitle !== null && currentChatId && editingTitle.trim()) {
      void renameChat(currentChatId, editingTitle.trim())
    }
    setEditingTitle(null)
  }

  return (
    <>
      {/* 채팅 헤더 */}
      <div className="px-4 py-2.5 border-b border-gray-200 flex items-center justify-between">
        {editingTitle !== null ? (
          <input
            autoFocus
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onBlur={submitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitTitle()
              if (e.key === 'Escape') setEditingTitle(null)
            }}
            className="flex-1 text-sm font-semibold text-gray-800 border border-gray-300 rounded px-2 py-1 focus:outline-none focus:border-gray-500"
          />
        ) : (
          <h3
            className="text-sm font-semibold text-gray-800 truncate cursor-text"
            onDoubleClick={() => setEditingTitle(chat?.title ?? '')}
            title="더블클릭하여 제목 수정"
          >
            {chat?.title ?? '대화'}
          </h3>
        )}
      </div>

      {/* 메시지 영역 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} onInternalLink={handleInternalLink} />
        ))}

        {isStreaming && (
          <div className="max-w-[85%]">
            {streamingText ? (
              <div className="bg-gray-50 border border-gray-200 rounded-lg rounded-tl-none px-4 py-3">
                <MarkdownContent
                  content={streamingText}
                  compact
                  onInternalLink={handleInternalLink}
                />
                <span className="inline-block w-1.5 h-4 bg-gray-400 animate-pulse align-text-bottom" />
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-gray-500 px-1">
                <span className="inline-block w-3.5 h-3.5 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                {toolStatus ? `${toolStatus} 중…` : '생각하는 중…'}
              </div>
            )}
            {streamingText && toolStatus && (
              <p className="mt-1 text-xs text-gray-400 px-1">{toolStatus} 중…</p>
            )}
          </div>
        )}

        {error && (
          <div className="max-w-[85%] px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 입력 영역 */}
      <div className="border-t border-gray-200 p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleSend()
              }
            }}
            rows={Math.min(5, Math.max(1, input.split('\n').length))}
            disabled={disabled}
            placeholder={
              disabled
                ? 'Claude Code 설치/로그인 후 사용할 수 있습니다.'
                : 'LinkWork 데이터에 대해 질문해 보세요… (Enter 전송, Shift+Enter 줄바꿈)'
            }
            className="flex-1 resize-none px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-gray-500 disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed"
          />
          {isStreaming ? (
            <button
              onClick={() => cancelStream()}
              className="px-4 py-2 text-sm bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors shrink-0"
            >
              중단
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim() || disabled}
              className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              전송
            </button>
          )}
        </div>
      </div>
    </>
  )
}

function MessageBubble({
  message,
  onInternalLink
}: {
  message: AiMessage
  onInternalLink: (href: string) => void
}): React.ReactNode {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] bg-gray-900 text-white text-sm rounded-lg rounded-tr-none px-4 py-2.5 whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    )
  }
  return (
    <div className="max-w-[85%] bg-gray-50 border border-gray-200 rounded-lg rounded-tl-none px-4 py-3">
      <MarkdownContent content={message.content} compact onInternalLink={onInternalLink} />
    </div>
  )
}
