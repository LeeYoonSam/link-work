import { useEffect, useRef, useState } from 'react'
import { useAiChatStore } from '../../stores/aiChatStore'
import { useProjectStore } from '../../stores/projectStore'
import { useTodoStore } from '../../stores/todoStore'
import { useMemoStore } from '../../stores/memoStore'
import { useVariableStore } from '../../stores/variableStore'
import MarkdownContent from '../memo/MarkdownContent'
import type {
  AiApprovalRequest,
  AiAttachmentInput,
  AiAttachmentMeta,
  AiChat,
  AiMessage,
  AiStatus,
  AiStreamEvent,
  AiWriteMode
} from '../../types'
import { AlertTriangleIcon, Card, ImageIcon, XIcon, button } from '../ui'

// 채팅별 데이터 작성 모드 선택지 (헤더 세그먼트 컨트롤)
const WRITE_MODES: { value: AiWriteMode; label: string; title: string }[] = [
  { value: 'readonly', label: '읽기 전용', title: 'AI가 데이터를 조회만 합니다' },
  { value: 'ask', label: '승인 후 쓰기', title: 'AI가 생성·수정 전 항목마다 승인을 요청합니다' },
  { value: 'auto', label: '자동 쓰기', title: 'AI가 승인 없이 즉시 생성·수정합니다 (변수는 항상 승인)' }
]

// "이 채팅에서 항상 승인"을 노출하지 않는 도구 — 변수는 auto 모드에서도 항상 승인
// (main의 ALWAYS_CONFIRM_WRITE_TOOLS), fetch_url은 쓰기 모드와 무관한 별도 게이트
const ALWAYS_CONFIRM_TOOLS = ['create_variable', 'update_variable', 'fetch_url']

// 이미지 첨부 제한 (main의 ai-attachments.ts와 동일 기준 — renderer 검증은 UX용)
const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_MB = 8
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

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
  const [notionConnected, setNotionConnected] = useState(false)
  const [showNotionSettings, setShowNotionSettings] = useState(false)

  const checkStatus = (): void => {
    window.api.ai.status().then(setAiStatus)
  }

  const refreshNotionStatus = (): void => {
    window.api.ai.notionStatus().then((s) => setNotionConnected(s.connected))
  }

  useEffect(() => {
    fetchChats()
    checkStatus()
    refreshNotionStatus()
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
          <div className="p-2 border-t border-gray-200">
            <button
              onClick={() => setShowNotionSettings(true)}
              title="AI가 Notion 문서를 읽을 수 있게 연동합니다"
              className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  notionConnected ? 'bg-green-500' : 'bg-gray-300'
                }`}
              />
              Notion 연동{notionConnected ? ' 중' : ''}
            </button>
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
              Notion 문서와 웹 링크를 읽고, 첨부한 이미지를 보고 답할 수 있습니다.
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

      {showNotionSettings && (
        <NotionSettingsModal
          connected={notionConnected}
          onClose={() => setShowNotionSettings(false)}
          onChanged={refreshNotionStatus}
        />
      )}
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
  // 전송 전 이미지 첨부 대기열 (previewUrl은 blob URL — 제거/전송 시 revoke)
  const [attachments, setAttachments] = useState<{ file: File; previewUrl: string }[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const chat = chats.find((c) => c.id === currentChatId)
  const writeMode: AiWriteMode = chat?.write_mode ?? 'ask'

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText, toolStatus, pendingApproval])

  // 채팅 전환 시 첨부 대기열 초기화 (blob URL 정리 포함)
  useEffect(() => {
    setAttachments((prev) => {
      prev.forEach((a) => URL.revokeObjectURL(a.previewUrl))
      return []
    })
  }, [currentChatId])

  const addAttachmentFiles = (files: Iterable<File>): void => {
    setAttachments((prev) => {
      const next = [...prev]
      for (const file of files) {
        if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
          window.alert(`지원하지 않는 이미지 형식입니다: ${file.name}\n(PNG/JPEG/WebP/GIF만 첨부할 수 있습니다)`)
          continue
        }
        if (file.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
          window.alert(`이미지가 너무 큽니다 (최대 ${MAX_ATTACHMENT_MB}MB): ${file.name}`)
          continue
        }
        if (next.length >= MAX_ATTACHMENTS) {
          window.alert(`이미지는 한 번에 최대 ${MAX_ATTACHMENTS}장까지 첨부할 수 있습니다.`)
          break
        }
        next.push({ file, previewUrl: URL.createObjectURL(file) })
      }
      return next
    })
  }

  const removeAttachment = (index: number): void => {
    setAttachments((prev) => {
      URL.revokeObjectURL(prev[index].previewUrl)
      return prev.filter((_, i) => i !== index)
    })
  }

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
        'releases',
        'reports'
      ] as const
      const target = views.find((v) => v === rest)
      if (target) setView(target)
    }
  }

  const handleSend = async (): Promise<void> => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || isStreaming || disabled) return
    const pending = attachments
    setInput('')
    setAttachments([])
    let payload: AiAttachmentInput[] | undefined
    if (pending.length > 0) {
      payload = await Promise.all(
        pending.map(async (a) => ({
          name: a.file.name,
          type: a.file.type,
          bytes: await a.file.arrayBuffer()
        }))
      )
      pending.forEach((a) => URL.revokeObjectURL(a.previewUrl))
    }
    void sendMessage(text, payload)
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

      {/* 입력 영역 (이미지 첨부: 버튼/붙여넣기/드래그&드롭) */}
      <div
        className="border-t border-gray-200 p-3"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
          if (files.length > 0) {
            e.preventDefault()
            addAttachmentFiles(files)
          }
        }}
      >
        {attachments.length > 0 && (
          <div className="flex gap-2 mb-2">
            {attachments.map((a, i) => (
              <div key={a.previewUrl} className="relative group">
                <img
                  src={a.previewUrl}
                  alt={a.file.name}
                  title={a.file.name}
                  className="w-14 h-14 object-cover rounded-lg border border-gray-200"
                />
                <button
                  onClick={() => removeAttachment(i)}
                  title="첨부 제거"
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center bg-gray-800 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <XIcon size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addAttachmentFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || isStreaming}
            title="이미지 첨부 (클립보드 붙여넣기, 드래그&드롭도 가능)"
            className="p-2 rounded-lg shrink-0 text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ImageIcon size={18} />
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void handleSend()
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
                f.type.startsWith('image/')
              )
              if (files.length > 0) {
                e.preventDefault()
                addAttachmentFiles(files)
              }
            }}
            rows={Math.min(5, Math.max(1, input.split('\n').length))}
            disabled={disabled}
            placeholder={
              disabled
                ? 'Claude Code 설치/로그인 후 사용할 수 있습니다.'
                : 'LinkWork 데이터, Notion 문서, 웹 링크에 대해 질문해 보세요… (Enter 전송, 이미지 붙여넣기 가능)'
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
              onClick={() => void handleSend()}
              disabled={(!input.trim() && attachments.length === 0) || disabled}
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
  // fetch_url은 저장이 아니라 외부 페이지 읽기 승인 (사용자 메시지에 없는 주소일 때만 표시됨)
  const isFetch = request.name === 'fetch_url'
  return (
    <div className="max-w-[85%] border border-amber-300 bg-amber-50 rounded-lg px-4 py-3">
      <p className="text-sm font-semibold text-gray-900">
        AI가 <span className="text-amber-700">{request.label}</span> 승인을 요청했습니다
      </p>
      <p className="mt-0.5 text-xs text-gray-500">
        {isFetch
          ? '대화에서 직접 언급하지 않은 주소입니다. 승인하면 AI가 이 웹 페이지의 내용을 읽습니다. 5분 안에 응답하지 않으면 자동으로 거절됩니다.'
          : '승인하면 아래 내용이 즉시 저장됩니다. 5분 안에 응답하지 않으면 자동으로 거절됩니다.'}
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

// ai_messages.meta JSON에서 이미지 첨부 목록 파싱 (없거나 손상 시 빈 배열)
function parseAttachments(meta: string | null): AiAttachmentMeta[] {
  if (!meta) return []
  try {
    const parsed = JSON.parse(meta) as { attachments?: AiAttachmentMeta[] }
    return Array.isArray(parsed.attachments) ? parsed.attachments : []
  } catch {
    return []
  }
}

function MessageBubble({
  message,
  onInternalLink
}: {
  message: AiMessage
  onInternalLink: (href: string) => void
}): React.ReactNode {
  if (message.role === 'user') {
    const attachments = parseAttachments(message.meta)
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] flex flex-col items-end gap-1.5">
          {attachments.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {attachments.map((a) => (
                <img
                  key={a.file}
                  src={`linkwork-media://attachment/${encodeURIComponent(a.file)}`}
                  alt={a.name}
                  title={a.name}
                  className="max-h-48 max-w-[200px] object-contain rounded-lg border border-gray-200 bg-gray-50"
                />
              ))}
            </div>
          )}
          {message.content && (
            <div className={`text-white text-sm rounded-lg rounded-tr-none px-4 py-2.5 whitespace-pre-wrap break-words ${button.dark}`}>
              {message.content}
            </div>
          )}
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

// Notion internal integration 토큰 등록/해제 모달.
// 토큰은 main에서 검증(API 호출) 후 safeStorage로 암호화 저장된다 (services/notion.ts).
function NotionSettingsModal({
  connected,
  onClose,
  onChanged
}: {
  connected: boolean
  onClose: () => void
  onChanged: () => void
}): React.ReactNode {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedWorkspace, setSavedWorkspace] = useState<string | null>(null)

  const handleSave = async (): Promise<void> => {
    if (!token.trim() || busy) return
    setBusy(true)
    setError('')
    const result = await window.api.ai.notionSaveToken(token.trim())
    setBusy(false)
    if (result.success) {
      setToken('')
      setSavedWorkspace(result.workspace ?? 'Notion')
      onChanged()
    } else {
      setError(result.error ?? '토큰 저장에 실패했습니다.')
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    if (!window.confirm('Notion 연동을 해제할까요? AI가 더 이상 Notion 문서를 읽을 수 없습니다.')) return
    await window.api.ai.notionDisconnect()
    setSavedWorkspace(null)
    onChanged()
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <Card padding="md" className="bg-white">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-base font-semibold text-gray-900">Notion 연동</h3>
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-700 transition-colors"
              title="닫기"
            >
              <XIcon size={16} />
            </button>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            연동하면 AI가 대화에서 Notion 문서를 검색하고 내용을 읽을 수 있습니다. (읽기 전용)
          </p>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-xs text-blue-900">
            <p className="font-medium mb-1">가장 간단한 방법: Claude 계정의 Notion 커넥터</p>
            <p>
              Claude 계정(claude.ai)에 Notion 커넥터가 연결되어 있으면 <b>여기서 아무 설정 없이</b>{' '}
              AI가 바로 Notion을 읽을 수 있습니다. 커넥터가 없다면{' '}
              <a
                href="https://claude.ai/settings/connectors"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                claude.ai → 설정 → 커넥터
              </a>
              에서 Notion을 연결하세요. 아래 토큰 방식은 커넥터를 쓰지 않을 때의 대안입니다.
            </p>
          </div>

          {connected ? (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4 flex items-center justify-between gap-2">
              <p className="text-sm text-green-800">
                연동됨{savedWorkspace ? ` — ${savedWorkspace}` : ''}
              </p>
              <button
                onClick={() => void handleDisconnect()}
                className="shrink-0 px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
              >
                연동 해제
              </button>
            </div>
          ) : (
            <ol className="text-xs text-gray-600 space-y-1 mb-4 list-decimal pl-4">
              <li>
                <a
                  href="https://www.notion.so/my-integrations"
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  notion.so/my-integrations
                </a>
                에서 내부 통합(Internal Integration)을 생성합니다. (권한은 &quot;콘텐츠 읽기&quot;만)
              </li>
              <li>Internal Integration Secret을 복사해 아래에 붙여넣습니다.</li>
              <li>
                AI가 읽을 페이지에서 <b>⋯ → 연결(Connections)</b>에 만든 통합을 추가합니다.
                (하위 페이지에 자동 적용)
              </li>
            </ol>
          )}

          <div className="flex gap-2">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSave()
              }}
              placeholder={connected ? '새 토큰으로 교체하려면 입력' : 'ntn_ 으로 시작하는 토큰'}
              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-gray-500"
            />
            <button
              onClick={() => void handleSave()}
              disabled={!token.trim() || busy}
              className={`px-4 py-2 text-sm rounded-lg shrink-0 ${button.dark} disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {busy ? '확인 중…' : '저장'}
            </button>
          </div>

          {error && (
            <p className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">
              {error}
            </p>
          )}
        </Card>
      </div>
    </div>
  )
}
