// 여러 줄 붙여넣기 확인 패널. 줄마다 자연어 인식 결과를 미리 보여 주고, 뺄 줄을 고른 뒤 한 번에 추가한다.
// 중간에 실패하면 멈추고 성공 건수와 남은 줄을 패널에 남긴다
import { useState } from 'react'
import { useTodoStore } from '../../stores/todoStore'
import type { TodoTag } from '../../types'
import { Card, button, showToast } from '../ui'
import { parseTodoInput, toTodoInput, type ParsedTodo } from './todoParse'

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : '알 수 없는 오류')

export interface BulkAddPanelProps {
  /** splitPastedLines 로 정리한 줄 */
  lines: string[]
  tags: TodoTag[]
  onClose: () => void
  /** 테스트용 기준 시각 */
  now?: () => Date
}

/** 인식 결과 한 줄 요약. 예: '내일 15:00 · 높음 · #업무' */
export function parsedSummary(p: ParsedTodo): string {
  return p.tokens.map((t) => t.label).join(' · ')
}

export default function BulkAddPanel({ lines, tags, onClose, now }: BulkAddPanelProps): React.ReactNode {
  const { fetchTodos, fetchActiveTodos } = useTodoStore()
  // 남은 줄. 일부만 추가하고 실패하면 남은 줄로 바뀐다
  const [items, setItems] = useState<string[]>(lines)
  const [excluded, setExcluded] = useState<number[]>([])
  const [running, setRunning] = useState(false)
  const [addedCount, setAddedCount] = useState(0)
  const [error, setError] = useState('')

  const parse = (raw: string): ParsedTodo => parseTodoInput(raw, { now: now ? now() : new Date(), tags })
  const selectedCount = items.length - excluded.filter((i) => i < items.length).length

  const toggle = (i: number): void => {
    setExcluded((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]))
  }

  const addAll = async (): Promise<void> => {
    if (running) return
    const selected = items.filter((_, i) => !excluded.includes(i))
    if (selected.length === 0) return
    setRunning(true)
    let ok = 0
    let failure: unknown = null
    for (const raw of selected) {
      try {
        await window.api.todo.create(toTodoInput(parse(raw)))
        ok++
      } catch (e) {
        failure = e
        break
      }
    }
    try {
      await fetchTodos({ silent: true })
      await fetchActiveTodos()
    } catch {
      // 재조회 실패는 다음 동기화가 메운다
    }
    setRunning(false)
    if (failure !== null) {
      const remaining = selected.slice(ok)
      setItems(remaining)
      setExcluded([])
      setAddedCount((n) => n + ok)
      setError(`${ok}개를 추가했고 남은 ${remaining.length}개는 추가하지 못했어요. ${errText(failure)}`)
      return
    }
    showToast({ message: `할 일 ${addedCount + ok}개를 추가했어요` })
    onClose()
  }

  return (
    <Card padding="none">
      <section aria-labelledby="bulk-add-title" className="py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-2 pb-1">
          <h3 id="bulk-add-title" className="text-sm font-semibold text-gray-700">
            여러 줄 추가
            <span className="ml-1.5 text-xs font-normal text-gray-400 tabular-nums">{items.length}줄</span>
          </h3>
          {addedCount > 0 ? <span className="text-xs text-green-700 tabular-nums">{addedCount}개 추가됨</span> : null}
        </div>

        <ul className="max-h-72 overflow-auto">
          {items.map((raw, i) => {
            const p = parse(raw)
            const summary = parsedSummary(p)
            const on = !excluded.includes(i)
            return (
              <li key={`${i}-${raw}`} data-bulk-line={i} className="flex items-start gap-2 px-4 py-1.5 min-w-0">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={running}
                  aria-label={`${p.title} 포함`}
                  onChange={() => toggle(i)}
                  className="mt-1 h-3.5 w-3.5 shrink-0 accent-blue-600"
                />
                <span className={`min-w-0 flex-1 break-keep text-pretty [overflow-wrap:anywhere] text-sm ${on ? 'text-gray-800' : 'text-gray-400 line-through'}`}>
                  {p.title}
                </span>
                {summary ? <span className="shrink-0 pt-0.5 text-xs text-gray-500">{summary}</span> : null}
              </li>
            )
          })}
        </ul>

        {error ? (
          <p role="alert" className="mx-4 mt-1 break-words rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 px-4 pt-2 pb-1">
          <button type="button" onClick={onClose} disabled={running} className={`px-3 py-1.5 text-sm ${button.subtle}`}>
            취소
          </button>
          <button
            type="button"
            onClick={addAll}
            disabled={running || selectedCount === 0}
            className={`px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${button.primary}`}
          >
            {running ? '추가하는 중…' : `${selectedCount}개 추가`}
          </button>
        </div>
      </section>
    </Card>
  )
}
