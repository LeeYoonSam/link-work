import { useEffect, useRef, useState } from 'react'
import { useAiChatStore } from '../../stores/aiChatStore'
import { useProjectStore } from '../../stores/projectStore'
import { useTodoStore } from '../../stores/todoStore'
import { useMemoStore } from '../../stores/memoStore'
import { useVariableStore } from '../../stores/variableStore'
import MarkdownContent from '../memo/MarkdownContent'
import type {
  AiApprovalRequest,
  AiChat,
  AiMessage,
  AiStatus,
  AiStreamEvent,
  AiWriteMode
} from '../../types'
import { AlertTriangleIcon, Card, XIcon, button } from '../ui'

// 채팅별 데이터 작성 모드 선택지 (헤더 세그먼트 컨트롤)
const WRITE_MODES: { value: AiWriteMode; label: string; title: string }[] = [
  { value: 'readonly', label: '읽기 전용', title: 'AI가 데이터를 조회만 합니다' },
  { value: 'ask', label: '승인 후 쓰기', title: 'AI가 생성·수정 전 항목마다 승인을 요청합니다' },
  { value: 'auto', label: '자동 쓰기', title: 'AI가 승인 없이 즉시 생성·수정합니다 (변수는 항상 승인)' }
]

// auto 모드에서도 항상 승인 카드를 거치는 도구 (main의 ALWAYS_CONFIRM_WRITE_TOOLS와 동일)
const ALWAYS_CONFIRM_TOOLS = ['create_variable', 'update_variable']

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
    // AI 쓰기 도구가 데이터를 생성하면 열려 있는 화면(store)을 갱신한다
    const unsubscribeData = window.api.ai.onDataChanged(({ entity }) => {
      if (entity === 'project') {
        const projectStore = useProjectStore.getState()
        void projectStore.fetchProjects()
        // 상세 화면이 "실제로 열려 있을 때만" 상세 재조회 (태스크 수정 반영).
        // currentProject는 목록으로 나가도 유지되므로 projectView로 추가 게이트한다.
        if (projectStore.projectView === 'detail' && projectStore.currentProject) {
          void projectStore.fetchProject(projectStore.currentProject.id)
        }
      } else if (entity === 'todo') {
        const todoStore = useTodoStore.getState()
        void todoStore.fetchTodos()
        void todoStore.fetchActiveTodos()
        void todoStore.fetchTags()
      } else if (entity === 'memo') {
        const memoStore = useMemoStore.getState()
        void memoStore.fetchMemos()
        void memoStore.fetchCategories()
      } else if (entity === 'variable') {
        void useVariableStore.getState().fetchVariables()
      }
    })
    return () => {
      unsubscribe()
      unsubscribeData()
    }
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
            className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${button.dark}`}
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
              className={`flex-1 px-3 py-2 text-sm ${button.dark}`}
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
              <br />
              승인을 거쳐 프로젝트·TODO·메모·변수를 만들거나 수정해 드릴 수도 있습니다.
              (작성 방식은 채팅 상단에서 채팅별로 선택)
            </p>
            <div className="grid grid-cols-2 gap-2 w-full max-w-xl">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => handleExampleClick(prompt)}
                  className={`px-4 py-3 text-left text-sm ${button.subtle} border border-gray-200 hover:border-gray-300`}
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
      <Card padding="md" className="max-w-md w-full text-center">
        <AlertTriangleIcon size={28} className="mx-auto text-amber-400 mb-3" />
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
          className={`px-4 py-2 text-sm rounded-lg ${button.dark}`}
        >
          다시 확인
        </button>
        <p className="mt-4 text-xs text-gray-400">
          AI 대화 외 다른 기능(프로젝트/TODO/메모 등)은 정상적으로 사용할 수 있습니다.
        </p>
      </Card>
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
            <XIcon size={14} />
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
    pendingApproval,
    sendMessage,
    cancelStream,
    respondApproval,
    renameChat,
    setWriteMode
  } = useAiChatStore()
  const { setView, setProjectView, fetchProject } = useProjectStore()
  const [input, setInput] = useState('')
  const [editingTitle, setEditingTitle] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const chat = chats.find((c) => c.id === currentChatId)
  const writeMode: AiWriteMode = chat?.write_mode ?? 'ask'

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText, toolStatus, pendingApproval])

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
        {chat && (
          <div
            className="shrink-0 flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5"
            title="이 채팅에서 AI의 데이터 작성 방식 (삭제는 항상 불가)"
          >
            {WRITE_MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => void setWriteMode(chat.id, m.value)}
                title={m.title}
                className={`px-2 py-1 text-[11px] font-medium rounded-md transition-colors ${
                  writeMode === m.value
                    ? m.value === 'auto'
                      ? 'bg-amber-100 text-amber-800 shadow-sm'
                      : 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
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

        {pendingApproval && (
          <ApprovalCard
            request={pendingApproval}
            allowAlways={
              writeMode === 'ask' && !ALWAYS_CONFIRM_TOOLS.includes(pendingApproval.name)
            }
            onRespond={(approved, always) =>
              void respondApproval(pendingApproval.requestId, approved, always)
            }
          />
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
              className={`px-4 py-2 text-sm rounded-lg shrink-0 ${button.subtle}`}
            >
              중단
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim() || disabled}
              className={`px-4 py-2 text-sm rounded-lg shrink-0 ${button.dark} disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              전송
            </button>
          )}
        </div>
      </div>
    </>
  )
}

// 쓰기 도구 실행 전 사용자 승인 카드 (HITL — docs/AI_GUARDRAILS.md 7.2절)
// allowAlways: "이 채팅에서 항상 승인" 노출 여부 (변수 도구는 항상 승인이 필요해 제외)
function ApprovalCard({
  request,
  allowAlways,
  onRespond
}: {
  request: AiApprovalRequest
  allowAlways: boolean
  onRespond: (approved: boolean, always?: boolean) => void
}): React.ReactNode {
  return (
    <div className="max-w-[85%] border border-amber-300 bg-amber-50 rounded-lg px-4 py-3">
      <p className="text-sm font-semibold text-gray-900">
        AI가 <span className="text-amber-700">{request.label}</span> 승인을 요청했습니다
      </p>
      <p className="mt-0.5 text-xs text-gray-500">
        승인하면 아래 내용이 즉시 저장됩니다. 5분 안에 응답하지 않으면 자동으로 거절됩니다.
      </p>
      {request.current && (
        <>
          <p className="mt-2 text-[11px] font-medium text-gray-500">변경 전 (요청 시점 값)</p>
          <pre className="mt-1 bg-gray-100 border border-gray-200 rounded p-2.5 text-xs font-mono text-gray-500 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
            {JSON.stringify(request.current, null, 2)}
          </pre>
          <p className="mt-2 text-[11px] font-medium text-amber-700">변경 내용</p>
        </>
      )}
      <pre className="mt-2 mb-3 bg-white border border-amber-200 rounded p-2.5 text-xs font-mono text-gray-700 whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
        {JSON.stringify(request.input, null, 2)}
      </pre>
      <div className="flex gap-2">
        <button
          onClick={() => onRespond(true)}
          className={`px-4 py-1.5 text-sm rounded-lg ${button.dark}`}
        >
          승인
        </button>
        {allowAlways && (
          <button
            onClick={() => onRespond(true, true)}
            title="이 채팅을 자동 쓰기 모드로 바꾸고 승인합니다. 이후 이 채팅에서는 승인 없이 즉시 실행됩니다 (변수 제외)"
            className="px-4 py-1.5 text-sm rounded-lg bg-amber-100 text-amber-800 hover:bg-amber-200 transition-colors"
          >
            이 채팅에서 항상 승인
          </button>
        )}
        <button
          onClick={() => onRespond(false)}
          className={`px-4 py-1.5 text-sm rounded-lg ${button.subtle} border border-gray-300`}
        >
          거절
        </button>
      </div>
    </div>
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
        <div className={`max-w-[75%] text-white text-sm rounded-lg rounded-tr-none px-4 py-2.5 whitespace-pre-wrap break-words ${button.dark}`}>
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
