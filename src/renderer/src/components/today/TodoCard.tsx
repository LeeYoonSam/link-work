// 오늘 대시보드의 '할 일' 카드 (docs/ASSISTANT.md 부록 O).
// 대시보드에서 직접 하는 동작은 할 일 체크와 빠른 추가뿐이다.
import { useState } from 'react'
import type { TodoRow, TodayDashboard } from './todayModel'
import { Card, todoPriority } from '../ui'
import { CARD_COUNT, CARD_HEAD, DUE_OVERDUE, DUE_TODAY, MORE_LINK, ROW, ROW_TITLE, SIGNALED_MARK } from './todayTokens'

/** 마감 표시. 지남은 빨강, 오늘은 앰버, 그 밖은 회색 'M/D' */
export function todoDueText(row: Pick<TodoRow, 'dueDate' | 'bucket'>): { text: string; cls: string } | null {
  if (!row.dueDate) return null
  const m = row.dueDate.slice(0, 10).match(/^\d{4}-(\d{2})-(\d{2})$/)
  const md = m ? `${Number(m[1])}/${Number(m[2])}` : row.dueDate
  if (row.bucket === 'overdue') return { text: `${md} 지남`, cls: DUE_OVERDUE }
  if (row.bucket === 'today') return { text: '오늘', cls: DUE_TODAY }
  return { text: md, cls: 'text-gray-500' }
}

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : '알 수 없는 오류')

/**
 * 빠른 추가 입력의 키 처리. Enter 면 공백을 다듬어 추가한다. 한글 조합 중·빈 값·다른 키는 무시한다.
 * 입력은 추가에 성공한 뒤에만 비운다. 실패하면 입력을 그대로 두고 onError 로 문구를 넘긴다.
 * 성공을 기다리는 사이 사용자가 입력을 바꿨으면 지우지 않는다
 */
export async function handleQuickAddKey(
  e: {
    key: string
    nativeEvent?: { isComposing?: boolean }
    currentTarget: { value: string }
    preventDefault: () => void
  },
  onAdd: (title: string) => Promise<void> | void,
  onError: (message: string) => void = () => {}
): Promise<void> {
  if (e.key !== 'Enter' || e.nativeEvent?.isComposing) return
  e.preventDefault()
  // React 이벤트의 currentTarget 은 핸들러가 끝나면 비므로 먼저 잡아 둔다
  const target = e.currentTarget
  const raw = target.value
  const title = raw.trim()
  if (!title) return
  try {
    await onAdd(title)
    if (target.value === raw) target.value = ''
    onError('')
  } catch (err) {
    onError(`할 일을 추가하지 못했어요. ${errText(err)}`)
  }
}

export function TodoItemRow({
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
        {row.signaled ? <span className={SIGNALED_MARK} title="지금 챙길 것에 있음" aria-label="지금 챙길 것에 있음" /> : null}
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
  onComplete,
  onAdd,
  onOpenTodo,
  onOpenTodos
}: {
  todos: TodayDashboard['todos']
  onComplete: (id: number) => Promise<void> | void
  onAdd: (title: string) => Promise<void> | void
  onOpenTodo: (id: number) => void
  onOpenTodos: () => void
}): React.ReactNode {
  // 체크 중인 행. 연타로 같은 할 일을 두 번 완료하지 않는다
  const [busyIds, setBusyIds] = useState<number[]>([])
  // 체크·빠른 추가 실패 문구. 다음 성공 때 지운다
  const [error, setError] = useState('')
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
            placeholder="+ 할 일 추가 (Enter)"
            onKeyDown={(e) => void handleQuickAddKey(e, onAdd, setError)}
            className="w-full min-w-0 rounded-md border border-transparent bg-gray-50 px-2.5 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-blue-300 focus:bg-white focus:outline-none"
          />
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
