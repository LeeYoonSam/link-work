import { useState } from 'react'
import type { CommandApplyOutcome, CommandInterpretation, CommandOp } from '../../types'
import { useAssistantStore } from '../../stores/assistantStore'
import { AlertTriangleIcon, button } from '../ui'

// 명령 입력창 (docs/ASSISTANT.md 부록 G.10.3).
// 오늘 화면은 scopeItemId 없이 쓴다. MVP4 체크인 패널은 scopeItemId 로 항목 1개를 지정한다.

export const COMMAND_PLACEHOLDER = '비서에게 말하기. 예: PROJ-12 끝났어 · API 문서는 내일 할게'
export const COMMAND_SCOPE_PLACEHOLDER = '완료, 미룸, 또는 진행 상황 한 줄'
export const COMMAND_NO_AI_HINT =
  'AI 해석이 꺼져 있습니다. 항목 이름이나 Jira 키가 있는 짧은 문장만 처리합니다.'
const COMMAND_TEXT_MAX = 500

const inputClass =
  'flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400'

// 미리보기에서 실행 가능한 조작만 고른다. 적용 버튼의 건수와 스토어가 보내는 목록이 같다
export function executableOps(command: CommandInterpretation | null): CommandOp[] {
  if (!command) return []
  return command.ops.filter((o) => o.executable).map((o) => o.op)
}

type CommandSlice = {
  command: CommandInterpretation | null
  commandPhase: 'idle' | 'interpreting' | 'applying'
  commandError: string
  commandResult: Pick<CommandApplyOutcome, 'results' | 'applied' | 'failed'> | null
  commandScope: number | null
}

// 스토어 상태 중 이 입력창에 보일 부분을 고른다.
// 미리보기는 해석의 scopeItemId 가 같을 때만 보인다 (부록 G.10.2).
// 진행 중·오류·결과는 마지막 요청을 보낸 입력창에만 보인다.
export function commandViewOf(
  s: CommandSlice,
  scopeItemId?: number
): Pick<CommandInputViewProps, 'preview' | 'interpreting' | 'applying' | 'error' | 'result'> {
  const scope = scopeItemId ?? null
  const mine = s.commandScope === scope
  return {
    preview: s.command && s.command.scopeItemId === scope ? s.command : null,
    interpreting: mine && s.commandPhase === 'interpreting',
    applying: mine && s.commandPhase === 'applying',
    error: mine ? s.commandError : '',
    result: mine ? s.commandResult : null
  }
}

export interface CommandInputViewProps {
  text: string
  scoped: boolean
  // today.aiAvailable && today.settings.llmEnabled
  aiOn: boolean
  busy: boolean
  interpreting: boolean
  applying: boolean
  // 이 입력창의 범위와 같은 해석만 넘긴다
  preview: CommandInterpretation | null
  error: string
  result: Pick<CommandApplyOutcome, 'results' | 'applied' | 'failed'> | null
  onTextChange: (text: string) => void
  onSubmit: () => void
  onApply: () => void
  onCancel: () => void
}

// 상태를 props 로만 받는 표시 컴포넌트. 헤드리스 테스트가 이 컴포넌트를 그린다
export function CommandInputView({
  text,
  scoped,
  aiOn,
  busy,
  interpreting,
  applying,
  preview,
  error,
  result,
  onTextChange,
  onSubmit,
  onApply,
  onCancel
}: CommandInputViewProps): React.ReactNode {
  const runnable = executableOps(preview).length
  const canSubmit = text.trim().length > 0 && !interpreting && !applying

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={text}
          maxLength={COMMAND_TEXT_MAX}
          disabled={interpreting}
          placeholder={scoped ? COMMAND_SCOPE_PLACEHOLDER : COMMAND_PLACEHOLDER}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            // 한글 조합 중 Enter 는 조합 확정이다. 해석을 보내지 않는다
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (canSubmit) onSubmit()
            }
          }}
          className={inputClass}
        />
        <button
          type="button"
          disabled={!canSubmit}
          onClick={onSubmit}
          className={`px-3 py-1.5 text-xs shrink-0 ${button.subtle} disabled:opacity-50`}
        >
          {interpreting ? '해석 중…' : '해석'}
        </button>
      </div>

      {!aiOn ? <p className="text-[11px] text-gray-500">{COMMAND_NO_AI_HINT}</p> : null}

      {error ? <p className="text-xs text-red-600">{error}</p> : null}

      {preview ? (
        <div className="border border-gray-200 rounded-md px-3 py-2 space-y-2">
          {preview.source === 'rules' && preview.error ? (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs text-amber-800">
              <AlertTriangleIcon size={14} className="shrink-0 mt-0.5" />
              <span>AI 해석에 실패해 규칙으로 해석했습니다: {preview.error}</span>
            </div>
          ) : null}
          {preview.ops.length > 0 ? (
            <ul className="space-y-1">
              {preview.ops.map((o, i) => (
                <li
                  key={i}
                  className={`text-xs ${o.executable ? 'text-gray-800' : 'text-gray-400'}`}
                >
                  · {o.label}
                </li>
              ))}
            </ul>
          ) : null}
          {preview.dropped > 0 ? (
            <p className="text-[11px] text-gray-500">
              {preview.dropped}건은 오늘 계획에 없는 항목이라 뺐습니다.
            </p>
          ) : null}
          {runnable === 0 ? <p className="text-xs text-gray-500">적용할 조작이 없습니다.</p> : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={applying}
              onClick={onCancel}
              className={`px-3 py-1.5 text-xs ${button.ghost} disabled:opacity-50`}
            >
              취소
            </button>
            <button
              type="button"
              disabled={runnable === 0 || busy}
              onClick={onApply}
              className={`px-3 py-1.5 text-xs ${button.primary} disabled:opacity-50`}
            >
              {applying ? '적용 중…' : `적용 (${runnable}건)`}
            </button>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="space-y-0.5">
          <p className="text-xs text-gray-600">{result.applied}건 적용</p>
          {result.failed > 0 ? (
            <ul className="space-y-0.5">
              {result.results
                .filter((r) => !r.ok)
                .map((r, i) => (
                  <li key={i} className="text-xs text-red-600">
                    · {r.label}: {r.error ?? '실패'}
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// 스토어에 연결한 입력창. props 는 고정 인터페이스다 (부록 G.1)
export default function CommandInput({
  scopeItemId,
  onApplied
}: {
  scopeItemId?: number
  onApplied?: () => void
}): React.ReactNode {
  const store = useAssistantStore()
  const { today, busy, interpretCommand, applyCommand, clearCommand } = store
  const [text, setText] = useState('')

  return (
    <CommandInputView
      {...commandViewOf(store, scopeItemId)}
      text={text}
      scoped={scopeItemId !== undefined}
      aiOn={!!today?.aiAvailable && !!today?.settings.llmEnabled}
      busy={busy}
      onTextChange={setText}
      onSubmit={() => {
        // 빈 문장은 보내지 않는다
        if (!text.trim()) return
        void interpretCommand(text, scopeItemId)
      }}
      onApply={() => {
        void applyCommand().then((ok) => {
          if (!ok) return
          setText('')
          onApplied?.()
        })
      }}
      onCancel={clearCommand}
    />
  )
}
