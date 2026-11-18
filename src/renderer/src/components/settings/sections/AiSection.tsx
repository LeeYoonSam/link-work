import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useAiChatStore } from '../../../stores/aiChatStore'
import { Badge, Card, button } from '../../ui'
import { AssistantSettingsFields, useAssistantSettings } from './AssistantSection'

// 설정 > AI. Claude Code 상태, AI 대화 모델, 비서 AI 브리핑·요약 모델.
// 두 모델 목록이 달라(fable/opus/haiku 와 opus/sonnet/haiku) 라벨을 "AI 대화 모델" 과 "비서 요약 모델" 로 나눈다.

const selectClass =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'

function ClaudeStatusCard(): React.ReactNode {
  const claude = useSettingsStore((s) => s.claude)
  const statusError = useSettingsStore((s) => s.statusErrors.claude)
  const refreshClaude = useSettingsStore((s) => s.refreshClaude)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    void refreshClaude()
  }, [refreshClaude])

  const recheck = async (): Promise<void> => {
    setChecking(true)
    try {
      await refreshClaude()
    } finally {
      setChecking(false)
    }
  }

  const label = claude === null ? '확인 중…' : claude.available ? '사용 가능' : '사용할 수 없음'
  const color =
    claude === null
      ? 'bg-gray-100 text-gray-600'
      : claude.available
        ? 'bg-green-100 text-green-700'
        : 'bg-red-100 text-red-700'

  return (
    <Card padding="sm" className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-gray-900">Claude Code</h4>
            <Badge color={color} size="xs">
              {label}
            </Badge>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            AI 대화와 비서 브리핑은 이 Mac 의 Claude Code 구독 로그인을 씁니다
          </p>
        </div>
        <button
          type="button"
          onClick={() => void recheck()}
          disabled={checking}
          className={`shrink-0 px-2.5 py-1 text-xs ${button.subtle} disabled:opacity-50`}
        >
          {checking ? '확인 중…' : '다시 확인'}
        </button>
      </div>
      {claude && !claude.available ? (
        <div className="text-xs text-gray-700 space-y-1.5">
          {claude.error ? <p className="text-red-600 break-all">{claude.error}</p> : null}
          <ol className="list-decimal pl-4 space-y-1 text-gray-600">
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
              터미널에서 <code className="px-1 bg-gray-100 rounded font-mono">claude</code> 실행 후 구독
              계정으로 로그인
            </li>
            <li>[다시 확인]을 누릅니다</li>
          </ol>
        </div>
      ) : null}
      {claude?.available && claude.warning ? (
        <p className="text-xs text-amber-700">{claude.warning}</p>
      ) : null}
      {statusError ? <p className="text-xs text-red-600 break-all">{statusError}</p> : null}
    </Card>
  )
}

function ChatModelSelect(): React.ReactNode {
  const model = useAiChatStore((s) => s.model)
  const options = useAiChatStore((s) => s.modelOptions)
  const loadModel = useAiChatStore((s) => s.loadModel)
  const loadModelOptions = useAiChatStore((s) => s.loadModelOptions)
  const setModel = useAiChatStore((s) => s.setModel)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void loadModel()
    void loadModelOptions()
  }, [loadModel, loadModelOptions])

  const handleChange = async (value: string): Promise<void> => {
    await setModel(value)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-700 mb-1">
        AI 대화 모델
        {saved ? <span className="ml-2 text-[11px] font-normal text-green-600">저장됨</span> : null}
      </span>
      <select
        value={model}
        onChange={(e) => void handleChange(e.target.value)}
        className={selectClass}
      >
        {options.some((o) => o.value === model) ? null : <option value={model}>{model || '불러오는 중…'}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label} — {o.description}
          </option>
        ))}
      </select>
      <span className="block mt-1 text-[11px] text-gray-500">
        모든 대화에 적용되며 다음 메시지부터 바뀝니다. AI 대화 입력창 아래에서도 바꿀 수 있습니다
      </span>
    </label>
  )
}

export default function AiSection(): React.ReactNode {
  const { settings, loadError, save } = useAssistantSettings()
  return (
    <div className="space-y-3">
      <ClaudeStatusCard />
      <Card padding="sm" className="space-y-3">
        <h4 className="text-sm font-semibold text-gray-900">AI 대화</h4>
        <ChatModelSelect />
      </Card>
      <Card padding="sm" className="space-y-2">
        <h4 className="text-sm font-semibold text-gray-900">비서 AI</h4>
        {loadError ? <p className="text-xs text-red-600">{loadError}</p> : null}
        <AssistantSettingsFields settings={settings} onSave={save} group="ai" />
      </Card>
    </div>
  )
}
