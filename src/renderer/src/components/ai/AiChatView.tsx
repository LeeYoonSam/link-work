import { useEffect, useRef, useState } from 'react'
import { useAiChatStore } from '../../stores/aiChatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { openInternalLink } from '../../utils/openInternalLink'
import MarkdownContent from '../memo/MarkdownContent'
import type {
  AiApprovalRequest,
  AiAttachmentInput,
  AiAttachmentMeta,
  AiChat,
  AiChatModelOption,
  AiMessage,
  AiStatus,
  AiWriteMode
} from '../../types'
import { AlertTriangleIcon, Card, ImageIcon, XIcon, button } from '../ui'

// 채팅별 데이터 작성 모드 선택지. 입력창 아래 모드 select 에 이 순서로 표시한다
export const WRITE_MODES: { value: AiWriteMode; label: string; title: string }[] = [
  { value: 'auto', label: '자동 모드 (Auto)', title: '쓰기를 자동 승인합니다.' },
  { value: 'ask', label: '승인 후 쓰기 (Ask)', title: '쓰기마다 승인을 받습니다.' },
  { value: 'plan', label: '계획 모드 (Plan)', title: '조회만 하고 계획을 먼저 보여 줍니다. 승인하면 실행합니다.' },
  { value: 'readonly', label: '읽기 전용', title: '데이터를 바꾸지 않습니다.' }
]

// chat 이 없거나 write_mode 가 없으면 자동 모드로 본다
export const DEFAULT_WRITE_MODE: AiWriteMode = 'auto'

export function resolveWriteMode(chat: Pick<AiChat, 'write_mode'> | undefined | null): AiWriteMode {
  return chat?.write_mode ?? DEFAULT_WRITE_MODE
}

// 계획 승인 요청 판정. kind 가 없는 payload 도 도구 이름으로 판정한다
export function isPlanApproval(request: Pick<AiApprovalRequest, 'kind' | 'name'>): boolean {
  return request.kind === 'plan' || request.name === 'ExitPlanMode'
}

// 모드 select 의 약한 색 강조. auto 는 기존 세그먼트의 amber 관례를 따른다
const WRITE_MODE_STYLE: Record<AiWriteMode, string> = {
  auto: 'border-amber-300 bg-amber-50 text-amber-800',
  ask: 'border-gray-300 bg-white text-gray-700',
  plan: 'border-indigo-300 bg-indigo-50 text-indigo-800',
  readonly: 'border-gray-300 bg-gray-50 text-gray-500'
}

// "이 채팅에서 항상 승인"을 노출하지 않는 도구 — fetch_url은 쓰기 모드와 무관한 별도 게이트
const ALWAYS_CONFIRM_TOOLS = ['fetch_url']

// 이미지 첨부 제한 (main의 ai-attachments.ts와 동일 기준 — renderer 검증은 UX용)
const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_MB = 8
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

// 빈 화면 추천 질문. 클릭하면 새 채팅에 바로 보낸다.
// 링크·대상이 필요한 질문은 넣지 않는다 (빈 값으로 전송되기 때문)
export const EXAMPLE_PROMPTS = [
  '오늘 마감인 할 일 알려줘',
  '끝나지 않은 회의 액션아이템 정리해줘',
  '이번 주 일정 알려줘',
  '끝나지 않은 할 일을 우선순위별로 보여줘'
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
    error,
    fetchChats,
    loadModel,
    loadModelOptions,
    createChat,
    deleteChat,
    openChat,
    sendMessage
  } = useAiChatStore()
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [listCollapsed, setListCollapsed] = useState(false)

  const checkStatus = (): void => {
    window.api.ai.status().then(setAiStatus)
  }

  useEffect(() => {
    fetchChats()
    void loadModel()
    // 첫 조회는 main 의 모델 탐침 때문에 수 초 걸린다. 그동안 폴백 목록을 보여 준다
    void loadModelOptions()
    checkStatus()
    // 응답 스트림(ai:stream)은 App 의 installAiStreamSync 가 앱 수준에서 구독한다.
    // AI 쓰기 도구의 데이터 변경(ai:dataChanged)은 App 의 installDataSync 가 반영한다
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
            <span className="shrink-0 flex items-center gap-1.5">
              <button
                onClick={() => useSettingsStore.getState().open('ai')}
                className="px-2 py-1 text-xs text-red-700 underline-offset-2 hover:underline"
              >
                설정 &gt; AI에서 확인
              </button>
              <button
                onClick={checkStatus}
                className="px-2 py-1 text-xs border border-red-300 rounded hover:bg-red-100 transition-colors"
              >
                다시 확인
              </button>
            </span>
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
              할 일·메모를 찾아 정리하고, Jira 티켓·릴리스 노트·회의 액션아이템·캘린더 일정을 조회합니다.
              <br />
              Notion·Bitbucket·Slack 문서와 웹 링크를 읽고, 첨부한 이미지를 보고 답할 수 있습니다.
              <br />
              할 일과 메모를 만들거나 수정해 드릴 수도 있습니다.
              (작성 방식은 입력창 아래에서 채팅별로 선택)
            </p>
            {/* 채팅이 없을 때의 오류 (예: 다른 화면에서 대화 생성 실패). 새 채팅을 열면 지워진다 */}
            {error && (
              <p role="alert" className="mb-4 w-full max-w-xl px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {error}
              </p>
            )}
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
          AI 대화 외 다른 기능(할 일·메모·프로젝트 등)은 정상적으로 사용할 수 있습니다.
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
    respondPlan,
    renameChat,
    setWriteMode,
    model,
    modelOptions,
    setModel
  } = useAiChatStore()
  const [input, setInput] = useState('')
  const [editingTitle, setEditingTitle] = useState<string | null>(null)
  // 전송 전 이미지 첨부 대기열 (previewUrl은 blob URL — 제거/전송 시 revoke)
  const [attachments, setAttachments] = useState<{ file: File; previewUrl: string }[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const chat = chats.find((c) => c.id === currentChatId)
  const writeMode: AiWriteMode = resolveWriteMode(chat)

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
      <div className="px-4 py-2.5 border-b border-gray-200 flex items-center justify-between gap-3">
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
            className="flex-1 min-w-0 text-sm font-semibold text-gray-800 border border-gray-300 rounded px-2 py-1 focus:outline-none focus:border-gray-500"
          />
        ) : (
          <h3
            className="min-w-0 text-sm font-semibold text-gray-800 truncate cursor-text"
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
          <MessageBubble key={message.id} message={message} onInternalLink={(href) => void openInternalLink(href)} />
        ))}

        {isStreaming && (
          <div className="max-w-[85%]">
            {streamingText ? (
              <div className="bg-gray-50 border border-gray-200 rounded-lg rounded-tl-none px-4 py-3">
                <MarkdownContent
                  content={streamingText}
                  compact
                  onInternalLink={(href) => void openInternalLink(href)}
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

        {pendingApproval && isPlanApproval(pendingApproval) && (
          <PlanApprovalCard
            request={pendingApproval}
            onRespond={(approved, mode) =>
              void respondPlan(pendingApproval.requestId, approved, mode)
            }
          />
        )}

        {pendingApproval && !isPlanApproval(pendingApproval) && (
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
                : '할 일·메모·Jira·일정이나 Notion·Bitbucket·Slack 문서, 웹 링크에 대해 질문해 보세요… (Enter 전송, 이미지 붙여넣기 가능)'
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
        <ComposerControls
          writeMode={writeMode}
          onWriteModeChange={chat ? (mode) => void setWriteMode(chat.id, mode) : undefined}
          model={model}
          modelOptions={modelOptions}
          onModelChange={(value) => void setModel(value)}
        />
      </div>
    </>
  )
}

// 입력창 아래 한 줄 툴바: 모드 select 와 모델 select.
// 모드는 스트리밍 중에도 바꿀 수 있다. 모델은 다음 메시지부터 적용한다.
// onWriteModeChange 가 없으면 모드 select 를 비활성화한다 (채팅이 아직 없을 때)
export function ComposerControls({
  writeMode,
  onWriteModeChange,
  model,
  modelOptions,
  onModelChange
}: {
  writeMode: AiWriteMode
  onWriteModeChange?: (mode: AiWriteMode) => void
  model: string
  modelOptions: AiChatModelOption[]
  onModelChange: (model: string) => void
}): React.ReactNode {
  const modeInfo = WRITE_MODES.find((m) => m.value === writeMode) ?? WRITE_MODES[0]
  // 저장된 모델이 목록에 없으면 현재 값을 그대로 보여 준다
  const models = modelOptions.some((m) => m.value === model)
    ? modelOptions
    : [...modelOptions, { value: model, label: model, description: '' }]
  const modelInfo = models.find((m) => m.value === model)
  const selectBase =
    'h-7 pl-2 pr-6 text-xs font-medium border rounded-md focus:outline-none focus:border-gray-500 disabled:opacity-50 disabled:cursor-not-allowed'
  return (
    <div className="mt-2 flex items-center gap-2">
      <select
        aria-label="모드"
        title={`${modeInfo.label}: ${modeInfo.title} (삭제는 항상 불가)`}
        value={writeMode}
        disabled={!onWriteModeChange}
        onChange={(e) => onWriteModeChange?.(e.target.value as AiWriteMode)}
        className={`${selectBase} ${WRITE_MODE_STYLE[writeMode]}`}
      >
        {WRITE_MODES.map((m) => (
          <option key={m.value} value={m.value} title={m.title}>
            {m.label}
          </option>
        ))}
      </select>
      <select
        aria-label="모델"
        title={`${modelInfo?.description || modelInfo?.label || model} (모든 채팅 공통, 다음 메시지부터 적용)`}
        value={model}
        onChange={(e) => onModelChange(e.target.value)}
        className={`${selectBase} border-gray-300 bg-white text-gray-700`}
      >
        {models.map((m) => (
          <option key={m.value} value={m.value} title={m.description || m.label}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  )
}

// 계획 모드에서 AI 가 실행 전에 보여 주는 계획 승인 카드.
// 승인하면 고른 쓰기 모드(auto/ask)로 바꾸고 실행한다. 거절하면 AI 는 실행하지 않는다
export function PlanApprovalCard({
  request,
  onRespond
}: {
  request: AiApprovalRequest
  onRespond: (approved: boolean, mode?: 'auto' | 'ask') => void
}): React.ReactNode {
  const raw = request.input.plan
  const plan = typeof raw === 'string' ? raw : JSON.stringify(request.input, null, 2)
  return (
    <div className="max-w-[85%] border border-indigo-300 bg-indigo-50 rounded-lg px-4 py-3">
      <p className="text-sm font-semibold text-gray-900">계획 승인</p>
      <p className="mt-0.5 text-xs text-gray-500">
        AI가 아래 계획을 실행하려고 합니다. 승인 방식을 고르세요.
      </p>
      <div className="mt-2 mb-3 bg-white border border-indigo-200 rounded p-3 max-h-80 overflow-y-auto">
        <MarkdownContent content={plan} compact />
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onRespond(true, 'auto')}
          title="자동 모드로 바꾸고 계획을 실행합니다."
          className={`px-4 py-1.5 text-sm rounded-lg ${button.dark}`}
        >
          승인 후 자동 실행
        </button>
        <button
          onClick={() => onRespond(true, 'ask')}
          title="승인 후 쓰기 모드로 바꾸고 계획을 실행합니다. 쓰기마다 승인을 받습니다."
          className="px-4 py-1.5 text-sm rounded-lg bg-indigo-100 text-indigo-800 hover:bg-indigo-200 transition-colors"
        >
          승인 후 하나씩 확인
        </button>
        <button
          onClick={() => onRespond(false)}
          className={`px-4 py-1.5 text-sm rounded-lg ${button.subtle} border border-gray-300`}
        >
          거절
        </button>
      </div>
      <p className="mt-2 text-[11px] text-gray-500">
        거절한 뒤 입력창에 수정 요청을 쓰면 AI가 계획을 다시 세웁니다.
      </p>
    </div>
  )
}

// 쓰기 도구 실행 전 사용자 승인 카드 (HITL — docs/AI_GUARDRAILS.md 7.2절)
// allowAlways: "이 채팅에서 항상 승인" 노출 여부 (fetch_url 은 별도 게이트라 제외)
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
            title="이 채팅을 자동 모드로 바꾸고 승인합니다. 이후 이 채팅에서는 승인 없이 즉시 실행됩니다"
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
