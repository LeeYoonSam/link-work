// 오늘 대시보드의 '할 일' 카드 (docs/ASSISTANT.md §11.3).
// 대시보드에서 직접 하는 동작은 할 일 체크와 빠른 추가뿐이다.
// 빠른 추가는 할 일 화면과 같은 자연어 인식(todo/todoParse.ts)을 거친다: '내일 3시 회의 준비 !높음'
import { useState } from 'react'
import type { TodoInput, TodoTag } from '../../types'
import type { TodoRow, TodayDashboard } from './todayModel'
import { todoInputSummary } from './todayModel'
import { todoDueText, localDateKey } from '../todo/todoModel'
import { parseTodoInput, toTodoInput } from '../todo/todoParse'
import { Card, todoPriority } from '../ui'
import { CARD_COUNT, CARD_HEAD, MORE_LINK, ROW, ROW_TITLE, SIGNALED_MARK } from './todayTokens'

/** 마감 표시. 지남은 빨강, 오늘은 앰버, 그 밖은 회색 'M/D' (todo/todoModel.ts 와 같은 함수) */
export { todoDueText }

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : '알 수 없는 오류')

type QuickAddTag = Pick<TodoTag, 'id' | 'name'>

/** 빠른 추가 입력을 할 일 입력으로 바꾼다. 날짜·시각·우선순위·#태그(있는 태그만)를 알아보고 나머지를 제목으로 둔다 */
export function quickAddInput(raw: string, now: Date, tags: QuickAddTag[] = []): TodoInput {
  return toTodoInput(parseTodoInput(raw, { now, tags }))
}

/**
 * 빠른 추가 입력의 키 처리. Enter 면 자연어를 인식해 추가한다. 한글 조합 중·빈 값·다른 키는 무시한다.
 * 입력은 추가에 성공한 뒤에만 비운다(onCleared 로 알린다). 실패하면 입력을 그대로 두고 onError 로 문구를 넘긴다.
 * 성공을 기다리는 사이 사용자가 입력을 바꿨으면 지우지 않는다
 */
export async function handleQuickAddKey(
  e: {
    key: string
    nativeEvent?: { isComposing?: boolean }
    currentTarget: { value: string }
    preventDefault: () => void
  },
  onAdd: (input: TodoInput) => Promise<void> | void,
  onError: (message: string) => void = () => {},
  opts: { now?: () => Date; tags?: QuickAddTag[]; onCleared?: () => void } = {}
): Promise<void> {
  if (e.key !== 'Enter' || e.nativeEvent?.isComposing) return
  e.preventDefault()
  // React 이벤트의 currentTarget 은 핸들러가 끝나면 비므로 먼저 잡아 둔다
  const target = e.currentTarget
  const raw = target.value
  if (!raw.trim()) return
  const input = quickAddInput(raw, opts.now ? opts.now() : new Date(), opts.tags)
  if (!input.title.trim()) return
  try {
    await onAdd(input)
    if (target.value === raw) {
      target.value = ''
      opts.onCleared?.()
    }
    onError('')
  } catch (err) {
    onError(`할 일을 추가하지 못했어요. ${errText(err)}`)
  }
}

function TodoItemRow({
  row,
  disabled,
  onComplete,
  onOpen
}: {
  row: TodoRow
  disabled: boolean
  onComplete: (id: number) => void
  onOpen: (id: number) => void
}): React.ReactNode {
  const due = todoDueText(row)
  const pri = todoPriority[row.priority]
  return (
    <li data-todo={row.id} className={ROW}>
      <span className="flex h-5 w-2 shrink-0 items-center">
        {row.signaled ? <span className={SIGNALED_MARK} title="먼저 챙길 항목" aria-label="먼저 챙길 항목" /> : null}
      </span>
      <button
        type="button"
        role="checkbox"
        aria-checked={false}
        aria-label={`${row.title} 완료`}
        title="완료로 표시"
        disabled={disabled}
        onClick={() => onComplete(row.id)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border border-gray-300 bg-white transition-colors hover:border-green-500 hover:bg-green-50 disabled:opacity-40"
      />
      <button
        type="button"
        onClick={() => onOpen(row.id)}
        className={`${ROW_TITLE} text-left hover:text-blue-700 ${row.signaled ? 'font-medium text-gray-900' : ''}`}
      >
        {row.title}
      </button>
      <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
        {/* 우선순위는 점이 아닌 글자 배지다. 점은 '신호에 있음' 1가지 뜻만 가진다 */}
        {row.priority === 'high' && pri ? (
          <span className={`rounded px-1 py-px text-[11px] font-medium whitespace-nowrap ${pri.badge}`} title={`우선순위 ${pri.label}`}>
            {pri.label}
          </span>
        ) : null}
        {due ? <span className={`text-xs tabular-nums whitespace-nowrap ${due.cls}`}>{due.text}</span> : null}
      </span>
    </li>
  )
}

export default function TodoCard({
  todos,
  tags,
  onComplete,
  onAdd,
  onOpenTodo,
  onOpenTodos,
  now = () => new Date()
}: {
  todos: TodayDashboard['todos']
  /** #태그 인식에 쓰는 태그 목록. 없으면 태그를 알아보지 않는다 */
  tags?: TodoTag[]
  onComplete: (id: number) => Promise<void> | void
  onAdd: (input: TodoInput) => Promise<void> | void
  onOpenTodo: (id: number) => void
  onOpenTodos: () => void
  /** 날짜 인식 기준 시각(테스트용) */
  now?: () => Date
}): React.ReactNode {
  // 체크 중인 행. 연타로 같은 할 일을 두 번 완료하지 않는다
  const [busyIds, setBusyIds] = useState<number[]>([])
  // 체크·빠른 추가 실패 문구. 다음 성공 때 지운다
  const [error, setError] = useState('')
  // 빠른 추가 입력값. 입력 아래 인식 요약만 그린다(입력 자체는 비제어)
  const [draft, setDraft] = useState('')
  const tagList = tags ?? []
  const summary = draft.trim()
    ? todoInputSummary(quickAddInput(draft, now(), tagList), localDateKey(now()), tagList)
    : ''
  const complete = (id: number): void => {
    if (busyIds.includes(id)) return
    setBusyIds((ids) => [...ids, id])
    void Promise.resolve()
      .then(() => onComplete(id))
      .then(() => setError(''))
      .catch((e: unknown) => setError(`할 일을 완료하지 못했어요. ${errText(e)}`))
      .finally(() => setBusyIds((ids) => ids.filter((x) => x !== id)))
  }
  const total = todos.rows.length + todos.moreCount
  return (
    <Card padding="none">
      <section id="today-todos" aria-labelledby="today-todos-title">
        <div className={CARD_HEAD}>
          <h3 id="today-todos-title" className="text-sm font-semibold text-gray-700">
            할 일{total > 0 ? <span className={CARD_COUNT}>{total}</span> : null}
          </h3>
          {todos.doneTodayCount > 0 ? (
            <span className="text-xs text-green-700 tabular-nums">오늘 완료 {todos.doneTodayCount}</span>
          ) : null}
        </div>

        {todos.rows.length === 0 ? (
          <p className="px-4 pb-2 text-sm text-gray-400">남은 할 일이 없어요.</p>
        ) : (
          <ul className="pb-1">
            {todos.rows.map((row) => (
              <TodoItemRow
                key={row.id}
                row={row}
                disabled={busyIds.includes(row.id)}
                onComplete={complete}
                onOpen={onOpenTodo}
              />
            ))}
          </ul>
        )}

        <div className="px-4 pb-2">
          <input
            type="text"
            aria-label="할 일 빠른 추가"
            placeholder="+ 할 일 추가 (예: 내일 3시 회의 준비)"
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) =>
              void handleQuickAddKey(e, onAdd, setError, { now, tags: tagList, onCleared: () => setDraft('') })
            }
            className="w-full min-w-0 rounded-md border border-transparent bg-gray-50 px-2.5 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-blue-300 focus:bg-white focus:outline-none"
          />
          {summary ? (
            <p data-quick-add-summary className="mt-1 truncate px-1 text-xs text-blue-700" title="알아본 마감·우선순위·태그">
              {summary}
            </p>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="mx-4 mb-2 break-words rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end border-t border-gray-100 px-4 py-2">
          <button type="button" onClick={onOpenTodos} className={MORE_LINK}>
            {todos.moreCount > 0 ? `외 ${todos.moreCount}건 →` : '할 일 화면 →'}
          </button>
        </div>
      </section>
    </Card>
  )
}
