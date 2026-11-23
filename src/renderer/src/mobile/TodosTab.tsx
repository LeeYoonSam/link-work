// 모바일 '할 일' 탭. 진행 중 목록에서 체크하면 짧게 빠지는 전환 뒤 낙관적으로 빼고 완료를 보낸다(실패하면 되돌리고 문구).
// 세그먼트 컨트롤로 '진행 중' / '완료 보기' 를 바꾼다. 완료 목록은 최근 완료 순이고 되돌리기 버튼이 있다.
// 진행 중 목록 위의 입력 줄로 할 일을 추가한다. 데스크톱과 같은 자연어 인식(todo/todoParse.ts, 태그 제외)으로
// 마감·우선순위를 알아보고 구조화한 필드를 POST /api/todos 로 보낸다. 성공하면 목록을 다시 읽는다.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Todo } from '../types'
import type { MobileTodoCreateBody, MobileTodoCreated } from './contract'
import { toPlainText } from '../components/memo/memoText'
import { todoPriority } from '../components/ui/tokens'
import { parseTodoInput } from '../components/todo/todoParse'
import { todoInputSummary } from '../components/today/todayModel'
import { errorText, isNetworkError, type MobileApi } from './api'
import { acceptTodosResponse, createRequestGate, dueLabel, localDay, monthDay, removeOptimistically, sortActiveTodos, sortCompletedTodos } from './mobileModel'
import type { TabProps } from './TodayTab'
import { CheckButton, Empty, ErrorNote, PageHeader, RefreshButton, Skeleton } from './ui'

/** 체크한 행이 빠지는 전환 시간(mobile.css .m-leaving 과 같다) */
const LEAVE_MS = 180

const DUE_TONE = { overdue: 'danger', today: 'warn', later: undefined, none: undefined } as const

/**
 * 입력 줄 글을 POST /api/todos 본문으로 바꾼다. 태그는 알아보지 않는다(모바일은 태그 목록을 받지 않는다).
 * 비어 있으면 null. 알림(due_reminder)은 마감에 시각이 있으면 1 이다(서버도 같은 규칙으로 다시 정한다)
 */
export function mobileTodoBody(raw: string, now: Date): MobileTodoCreateBody | null {
  if (!raw.trim()) return null
  const p = parseTodoInput(raw, { now, tags: [] })
  const title = p.title.trim()
  if (!title) return null
  const body: MobileTodoCreateBody = { title }
  if (p.priority) body.priority = p.priority
  if (p.due_date) {
    body.due_date = p.due_date
    body.due_reminder = p.due_date.length > 10 ? 1 : 0
  }
  return body
}

/** 입력 줄 글로 할 일을 추가한다. 비어 있으면 호출하지 않고 null */
export async function addTodoFromInput(
  api: Pick<MobileApi, 'createTodo'>,
  raw: string,
  now: Date
): Promise<MobileTodoCreated | null> {
  const body = mobileTodoBody(raw, now)
  if (!body) return null
  return api.createTodo(body)
}

export interface TodoAddBarProps {
  draft: string
  /** 알아본 마감·우선순위 한 줄(없으면 '') */
  summary: string
  busy: boolean
  onDraft: (v: string) => void
  onSubmit: () => void
}

/** 할 일 추가 입력 줄. 훅을 쓰지 않는다 */
export function TodoAddBar(p: TodoAddBarProps): React.ReactNode {
  return (
    <form
      className="m-add"
      aria-label="할 일 추가"
      onSubmit={(e) => {
        e.preventDefault()
        p.onSubmit()
      }}
    >
      <div className="m-add-row">
        <input
          type="text"
          value={p.draft}
          onChange={(e) => p.onDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            // 한글 조합 중 Enter 는 글자 확정이다. 제출하지 않는다
            if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault()
          }}
          placeholder="할 일 추가 (예: 내일 3시 회의 준비)"
          aria-label="새 할 일"
          enterKeyHint="done"
          readOnly={p.busy}
        />
        <button type="submit" disabled={p.busy || !p.draft.trim()} className="m-text-btn shrink-0">
          {p.busy ? '추가 중' : '추가'}
        </button>
      </div>
      {p.summary ? (
        <p data-add-summary className="m-meta m-add-summary">
          {p.summary}
        </p>
      ) : null}
    </form>
  )
}

/** 태그는 한 칩으로 묶는다: '팀 업무 외 2'. 한 행의 정보를 3개 이하로 둔다 */
function TagChip({ tags }: { tags: NonNullable<Todo['tags']> }): React.ReactNode {
  if (tags.length === 0) return null
  const first = tags[0]
  return (
    <span className="m-chip max-w-[12rem]" title={tags.map((t) => t.name).join(', ')}>
      <span aria-hidden className="m-dot" style={{ backgroundColor: first.color }} />
      <span className="m-ellipsis">{first.name}</span>
      {tags.length > 1 ? <span className="shrink-0">외 {tags.length - 1}</span> : null}
    </span>
  )
}

function TodoItem({
  todo,
  today,
  completed,
  leaving,
  onToggle
}: {
  todo: Todo
  today: string
  completed: boolean
  leaving: boolean
  onToggle: (id: number) => void
}): React.ReactNode {
  const due = completed ? null : dueLabel(todo.due_date, today)
  const pri = todoPriority[todo.priority]
  const notes = todo.notes ? toPlainText(todo.notes).trim() : ''
  const showPri = !completed && pri && todo.priority !== 'medium'
  return (
    <li
      data-todo={todo.id}
      data-priority={completed ? undefined : todo.priority}
      className={`m-card m-todo m-pri ${leaving ? 'm-leaving' : ''}`}
    >
      {completed ? (
        <CheckButton checked label={`${todo.title} 완료됨`} disabled onClick={() => {}} />
      ) : (
        <CheckButton checked={leaving} disabled={leaving} label={`${todo.title} 완료`} onClick={() => onToggle(todo.id)} />
      )}
      <div className="min-w-0 flex-1">
        <p data-primary className={completed || leaving ? 'm-body m-done-title' : 'm-body'}>
          {todo.title}
        </p>
        {due || showPri || completed || (todo.tags ?? []).length > 0 ? (
          <div className="m-row-meta">
            {due ? (
              <span data-tone={DUE_TONE[due.bucket]} className="m-chip">
                {due.bucket === 'today' ? '오늘 마감' : due.bucket === 'overdue' ? due.text : `${due.text} 마감`}
              </span>
            ) : null}
            {showPri ? (
              <span data-tone={todo.priority === 'high' ? 'danger' : undefined} className="m-chip" title={`우선순위 ${pri.label}`}>
                {todo.priority === 'high' ? '우선순위 높음' : '우선순위 낮음'}
              </span>
            ) : null}
            {completed && todo.completed_at ? <span className="m-meta">{monthDay(todo.completed_at)} 완료</span> : null}
            <TagChip tags={todo.tags ?? []} />
          </div>
        ) : null}
        {notes ? <p className="m-sub m-clamp-2 mt-1.5">{notes}</p> : null}
      </div>
      {completed ? (
        <button type="button" onClick={() => onToggle(todo.id)} className="m-text-btn -my-2 -mr-2 shrink-0">
          되돌리기
        </button>
      ) : null}
    </li>
  )
}

export interface TodoListViewProps {
  todos: Todo[] | null
  today: string
  showCompleted: boolean
  error: string | null
  refreshing: boolean
  /** 체크해 빠지는 전환 중인 행 */
  leavingIds?: number[]
  onToggle: (id: number) => void
  onShowCompleted: (show: boolean) => void
  onRefresh: () => void
  /** 진행 중 목록 위 입력 줄. 없으면 그리지 않는다 */
  add?: TodoAddBarProps
}

/** 할 일 목록 본문. 훅을 쓰지 않는다 */
export function TodoListView(p: TodoListViewProps): React.ReactNode {
  const list = p.todos ? (p.showCompleted ? sortCompletedTodos(p.todos) : sortActiveTodos(p.todos)) : null
  const leaving = p.leavingIds ?? []
  return (
    <>
      <PageHeader title="할 일" actions={<RefreshButton busy={p.refreshing} onClick={p.onRefresh} />} />
      <div className="m-stack">
        <div role="tablist" aria-label="할 일 보기" className="m-segmented">
          {[
            { v: false, label: '진행 중' },
            { v: true, label: '완료 보기' }
          ].map((o) => (
            <button key={o.label} type="button" role="tab" aria-selected={p.showCompleted === o.v} onClick={() => p.onShowCompleted(o.v)}>
              {o.label}
            </button>
          ))}
        </div>
        {p.add && !p.showCompleted ? <TodoAddBar {...p.add} /> : null}
        <ErrorNote text={p.error} />
        {list === null ? (
          <Skeleton />
        ) : list.length === 0 ? (
          <div className="m-card">
            <Empty>{p.showCompleted ? '완료한 할 일이 없어요.' : '남은 할 일이 없어요.'}</Empty>
          </div>
        ) : (
          <>
            {!p.showCompleted ? <p className="m-meta px-1">진행 중 {list.length}건 · 마감 이른 순</p> : null}
            <ul className="m-stack" aria-label={p.showCompleted ? '완료한 할 일' : '진행 중인 할 일'}>
              {list.map((t) => (
                <TodoItem key={t.id} todo={t} today={p.today} completed={p.showCompleted} leaving={leaving.includes(t.id)} onToggle={p.onToggle} />
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  )
}

const prefersReducedMotion = (): boolean => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export default function TodosTab({ api, reloadKey, onOk, onFail }: TabProps): React.ReactNode {
  const [showCompleted, setShowCompleted] = useState(false)
  const [todos, setTodos] = useState<Todo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // 늦게 도착한 옛 응답(다른 목록 종류·이전 요청)을 버린다. 렌더와 무관한 값이라 ref 에 둔다
  const gate = useRef(createRequestGate()).current
  const showRef = useRef(showCompleted)
  showRef.current = showCompleted

  const load = useCallback(
    async (completed: boolean): Promise<void> => {
      const seq = gate.begin()
      setRefreshing(true)
      try {
        const res = await api.getTodos(completed)
        if (!acceptTodosResponse(gate, seq, completed, showRef.current)) return
        setTodos(res.todos)
        setError(null)
        onOk()
      } catch (e) {
        if (!acceptTodosResponse(gate, seq, completed, showRef.current)) return
        onFail(e)
        setError(isNetworkError(e) ? null : errorText(e))
      } finally {
        if (gate.isLatest(seq)) setRefreshing(false)
      }
    },
    [api, onOk, onFail, gate]
  )

  useEffect(() => {
    void load(showCompleted)
  }, [load, showCompleted, reloadKey])

  const [leavingIds, setLeavingIds] = useState<number[]>([])
  const todosRef = useRef(todos)
  todosRef.current = todos

  const toggle = (id: number): void => {
    if (!todos || leavingIds.includes(id)) return
    setError(null)
    // 진행 중인 목록 읽기가 낙관적으로 뺀 항목을 다시 넣지 않게 버린다
    gate.invalidate()
    setRefreshing(false)
    const restoring = showCompleted
    const run = (): void => {
      setLeavingIds((cur) => cur.filter((x) => x !== id))
      const items = todosRef.current
      if (!items) return
      void removeOptimistically({
        id,
        items,
        setItems: (fn) => setTodos((cur) => (cur ? fn(cur) : cur)),
        call: (x) => (restoring ? api.restoreTodo(x) : api.completeTodo(x)),
        onError: (e) => {
          onFail(e)
          const what = restoring ? '되돌리지' : '완료하지'
          setError(isNetworkError(e) ? `Mac 에 연결할 수 없어 ${what} 못했어요.` : `${what} 못했어요: ${errorText(e)}`)
        }
      }).then((ok) => {
        if (ok) onOk()
      })
    }
    // 체크 표시 후 짧게 빠지는 전환을 보인 뒤 목록에서 뺀다. 움직임 줄이기 설정이면 바로 뺀다
    if (prefersReducedMotion()) run()
    else {
      setLeavingIds((cur) => [...cur, id])
      setTimeout(run, LEAVE_MS)
    }
  }

  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const draftBody = mobileTodoBody(draft, new Date())
  const summary = draftBody ? todoInputSummary(draftBody, localDay(new Date())) : ''

  const submitAdd = (): void => {
    if (adding || !draft.trim()) return
    const raw = draft
    setAdding(true)
    setError(null)
    void addTodoFromInput(api, raw, new Date())
      .then((out) => {
        if (!out) return
        // 기다리는 사이 사용자가 입력을 바꿨으면 지우지 않는다
        setDraft((cur) => (cur === raw ? '' : cur))
        onOk()
        if (!showRef.current) void load(false)
      })
      .catch((e: unknown) => {
        onFail(e)
        setError(isNetworkError(e) ? 'Mac 에 연결할 수 없어 추가하지 못했어요.' : `추가하지 못했어요: ${errorText(e)}`)
      })
      .finally(() => setAdding(false))
  }

  const switchView = (show: boolean): void => {
    if (show === showCompleted) return
    // 렌더를 기다리지 않고 바로 옛 목록 응답을 무효로 만든다
    showRef.current = show
    gate.invalidate()
    setTodos(null)
    setError(null)
    setShowCompleted(show)
  }

  return (
    <TodoListView
      todos={todos}
      today={localDay(new Date())}
      showCompleted={showCompleted}
      error={error}
      refreshing={refreshing}
      leavingIds={leavingIds}
      onToggle={toggle}
      onShowCompleted={switchView}
      onRefresh={() => void load(showCompleted)}
      add={{ draft, summary, busy: adding, onDraft: setDraft, onSubmit: submitAdd }}
    />
  )
}
