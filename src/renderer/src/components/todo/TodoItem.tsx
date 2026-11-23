// 할 일 한 행. 접힌 행은 체크박스·제목·값 있는 메타만 보인다.
// 클릭하거나 Enter 로 그 자리에서 펼쳐 고친다. 텍스트는 blur·⌘Enter 에 저장, Esc 는 저장 없이 접는다.
// 날짜·우선순위·태그 버튼은 누르는 즉시 저장한다. 삭제는 실행 취소 토스트로 확인을 대신한다
import { useEffect, useRef, useState } from 'react'
import { useTodoStore } from '../../stores/todoStore'
import type { Todo, TodoInput, TodoTag } from '../../types'
import { FileTextIcon, TrashIcon, UndoIcon, todoPriority } from '../ui'
import { ROW } from '../today/todayTokens'
import { quickDates, shiftDueDate, todoBucket, todoDueText } from './todoModel'
import { isSafeSourceLink, sourceLinkLabel } from './sourceLink'
import { openInternalLink } from '../../utils/openInternalLink'

/** 출처 링크를 연다. 앱 안 링크는 그 화면으로, https 는 기본 브라우저로(메인의 setWindowOpenHandler 가 연다) */
export function openSourceLink(link: string): void {
  if (!isSafeSourceLink(link)) return
  if (link.startsWith('linkwork://')) {
    void openInternalLink(link)
    return
  }
  window.open(link, '_blank', 'noopener,noreferrer')
}

// 오늘 대시보드 행(ROW_TITLE)과 같은 줄바꿈 규칙. 색은 완료 여부로 따로 준다
const ROW_TITLE = 'min-w-0 flex-1 break-keep text-pretty [overflow-wrap:anywhere] text-left text-sm'
const CHIP = 'rounded px-1.5 py-0.5 text-xs transition-colors'

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : '알 수 없는 오류')

/** 'YYYY-MM-DD' 또는 'YYYY-MM-DD HH:mm' 을 날짜·시각으로 나눈다 */
export function splitDue(due: string | null): { date: string; time: string } {
  if (!due) return { date: '', time: '' }
  const [date = '', time = ''] = due.split(' ')
  return { date, time: time.slice(0, 5) }
}

/** 날짜 입력값이 바뀌었을 때 저장할 마감. 시각이 있던 항목은 시각을 유지한다 */
export function dueFromDateInput(prev: string | null, date: string): Pick<TodoInput, 'due_date' | 'due_reminder'> {
  return shiftDueDate(prev, date || null)
}

/** 시각 입력값이 바뀌었을 때 저장할 마감. 날짜가 없으면 오늘에 붙인다. 시각을 지우면 날짜만 남는다 */
export function dueFromTimeInput(
  prev: string | null,
  time: string,
  today: string
): Pick<TodoInput, 'due_date' | 'due_reminder'> {
  const { date } = splitDue(prev)
  if (!time) return { due_date: date || null, due_reminder: 0 }
  return { due_date: `${date || today} ${time}`, due_reminder: 1 }
}

/** '2026-11-20 14:05:00' → '11/20 14:05' */
function completedText(at: string | null): string {
  if (!at) return ''
  const m = at.match(/^\d{4}-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  return m ? `${Number(m[1])}/${Number(m[2])} ${m[3]}:${m[4]}` : at
}

/** datetime-local 값('YYYY-MM-DDTHH:mm')을 하루 앞당긴다 */
function previousDay(local: string): string {
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return local
  d.setDate(d.getDate() - 1)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export interface TodoItemProps {
  todo: Todo
  /** 로컬 'YYYY-MM-DD' */
  today: string
  tags: TodoTag[]
  expanded?: boolean
  focused?: boolean
  highlighted?: boolean
  onExpand: () => void
  onCollapse: () => void
  /** 테스트용 기준 시각 */
  now?: () => Date
}

export default function TodoItem({
  todo,
  today,
  tags,
  expanded = false,
  focused = false,
  highlighted = false,
  onExpand,
  onCollapse,
  now
}: TodoItemProps): React.ReactNode {
  const { completeWithUndo, restoreTodo } = useTodoStore()
  const isCompleted = todo.is_completed === 1
  const [busy, setBusy] = useState(false)

  // 딥링크로 들어온 항목은 화면 가운데로 스크롤한다
  const rootRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (highlighted) rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [highlighted])

  const due = isCompleted ? null : todoDueText({ dueDate: todo.due_date, bucket: todoBucket(todo.due_date, today) }, today)
  const pri = todoPriority[todo.priority]
  const hasNotes = Boolean(todo.notes && todo.notes.trim())
  const sourceLink = todo.source_link && isSafeSourceLink(todo.source_link) ? todo.source_link : null

  const toggleComplete = (): void => {
    if (busy) return
    setBusy(true)
    const p = isCompleted ? restoreTodo(todo.id) : completeWithUndo(todo)
    void p.catch(() => {}).finally(() => setBusy(false))
  }

  // 행 아무 곳이나 누르면 펼치고 접는다. 안쪽 버튼·입력은 제외한다(제목 버튼은 토글 자체다)
  const handleRowClick = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement | null
    if (target?.closest?.('button:not([data-row-toggle]), a, input, textarea, select')) return
    if (expanded) onCollapse()
    else onExpand()
  }

  const rowTone = highlighted
    ? 'bg-blue-50 ring-2 ring-inset ring-blue-300'
    : expanded
      ? 'bg-gray-50/70'
      : focused
        ? 'bg-blue-50/50'
        : 'hover:bg-gray-50'

  return (
    <li
      ref={rootRef}
      data-todo-id={todo.id}
      aria-current={focused ? 'true' : undefined}
      className={`relative transition-colors ${rowTone}`}
    >
      {focused ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-blue-500" /> : null}
      <div className={`${ROW} cursor-pointer`} onClick={handleRowClick}>
        <button
          type="button"
          role="checkbox"
          aria-checked={isCompleted}
          aria-label={isCompleted ? `${todo.title} 완료 취소` : `${todo.title} 완료`}
          title={isCompleted ? '진행 중으로 되돌리기' : '완료로 표시'}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation()
            toggleComplete()
          }}
          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors disabled:opacity-40 ${
            isCompleted
              ? 'border-green-500 bg-green-500 text-white'
              : 'border-gray-300 bg-white hover:border-green-500 hover:bg-green-50'
          }`}
        >
          {isCompleted ? (
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : null}
        </button>

        <button
          type="button"
          data-row-toggle
          aria-expanded={expanded}
          className={`${ROW_TITLE} ${isCompleted ? 'text-gray-400 line-through' : 'text-gray-800'}`}
        >
          {todo.title}
        </button>

        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 pt-0.5">
          {todo.priority === 'high' && pri ? (
            <span className={`rounded px-1 py-px text-[11px] font-medium whitespace-nowrap ${pri.badge}`} title={`우선순위 ${pri.label}`}>
              {pri.label}
            </span>
          ) : null}
          {todo.priority === 'low' && pri ? (
            <span className="text-[11px] text-gray-400 whitespace-nowrap" title="우선순위 낮음">
              낮음
            </span>
          ) : null}
          {todo.tags?.map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-px text-[11px] text-gray-600 whitespace-nowrap"
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
              {tag.name}
            </span>
          ))}
          {sourceLink ? (
            <button
              type="button"
              aria-label={`출처 열기: ${sourceLinkLabel(sourceLink)}`}
              title={sourceLink}
              onClick={(e) => {
                e.stopPropagation()
                openSourceLink(sourceLink)
              }}
              className="max-w-[10rem] truncate rounded bg-blue-50 px-1.5 py-px text-[11px] text-blue-700 whitespace-nowrap hover:bg-blue-100"
            >
              {sourceLinkLabel(sourceLink)}
            </button>
          ) : null}
          {hasNotes ? (
            <span className="text-gray-400" title="메모 있음" aria-label="메모 있음">
              <FileTextIcon size={12} />
            </span>
          ) : null}
          {due ? <span className={`text-xs tabular-nums whitespace-nowrap ${due.cls}`}>{due.text}</span> : null}
          {isCompleted && todo.completed_at ? (
            <span className="text-xs text-gray-400 tabular-nums whitespace-nowrap">{completedText(todo.completed_at)} 완료</span>
          ) : null}
        </span>
      </div>

      {expanded ? (
        <TodoEditor todo={todo} today={today} tags={tags} onCollapse={onCollapse} now={now} autoFocus={!highlighted} />
      ) : null}
    </li>
  )
}

/**
 * 펼친 편집 영역. 제목·메모 초안은 펼칠 때 만든 로컬 상태라 배경 재조회가 덮어쓰지 않는다
 */
export function TodoEditor({
  todo,
  today,
  tags,
  onCollapse,
  now,
  autoFocus = true
}: {
  todo: Todo
  today: string
  tags: TodoTag[]
  onCollapse: () => void
  now?: () => Date
  /** 딥링크로 펼친 경우에는 입력칸에 포커스를 주지 않는다(단축키가 계속 먹게) */
  autoFocus?: boolean
}): React.ReactNode {
  const { updateTodo, restoreTodo, setCompletedAt, requestDelete } = useTodoStore()
  const isCompleted = todo.is_completed === 1
  const [title, setTitle] = useState(todo.title)
  const [notes, setNotes] = useState(todo.notes ?? '')
  const [error, setError] = useState('')
  const [completedDraft, setCompletedDraft] = useState(
    todo.completed_at ? todo.completed_at.slice(0, 16).replace(' ', 'T') : ''
  )
  // Esc 로 접을 때 뒤따르는 blur 가 저장하지 않게 막는다
  const skipBlurRef = useRef(false)

  const save = (input: Partial<TodoInput>): Promise<void> =>
    updateTodo(todo.id, input).then(
      () => setError(''),
      (e: unknown) => setError(`저장하지 못했어요. ${errText(e)}`)
    )

  const commitTitle = (value: string): Promise<void> | void => {
    const v = value.trim()
    if (!v) {
      setTitle(todo.title)
      return
    }
    if (v === todo.title) return
    return save({ title: v })
  }

  const commitNotes = (value: string): Promise<void> | void => {
    const v = value.trim()
    if (v === (todo.notes ?? '').trim()) return
    return save({ notes: v ? v : null })
  }

  const textKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    commit: (value: string) => Promise<void> | void,
    enterSaves: boolean
  ): void => {
    if (e.nativeEvent?.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      skipBlurRef.current = true
      onCollapse()
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      skipBlurRef.current = true
      void commit(e.currentTarget.value)
      onCollapse()
      return
    }
    if (e.key === 'Enter' && enterSaves) {
      e.preventDefault()
      void commit(e.currentTarget.value)
    }
  }

  const onTextBlur = (value: string, commit: (value: string) => Promise<void> | void): void => {
    if (skipBlurRef.current) return
    void commit(value)
  }

  const { date, time } = splitDue(todo.due_date)
  const q = quickDates(now ? now() : new Date())
  const quick: { label: string; target: string | null }[] = [
    { label: '오늘', target: q.today },
    { label: '내일', target: q.tomorrow },
    { label: '다음 주', target: q.nextWeek },
    { label: '날짜 없음', target: null }
  ]
  const tagIds = (todo.tags ?? []).map((t) => t.id)

  const remove = (): void => {
    skipBlurRef.current = true
    onCollapse()
    requestDelete(todo)
  }

  const inputCls =
    'w-full min-w-0 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-800 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100'

  return (
    <div className="space-y-2.5 px-4 pb-3 pl-10" onClick={(e) => e.stopPropagation()}>
      <input
        type="text"
        aria-label="제목"
        value={title}
        autoFocus={autoFocus}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={(e) => onTextBlur(e.currentTarget.value, commitTitle)}
        onKeyDown={(e) => textKeyDown(e, commitTitle, true)}
        className={`${inputCls} font-medium`}
      />
      <textarea
        aria-label="메모"
        value={notes}
        rows={3}
        placeholder="메모 (⌘Enter 저장)"
        onChange={(e) => setNotes(e.target.value)}
        onBlur={(e) => onTextBlur(e.currentTarget.value, commitNotes)}
        onKeyDown={(e) => textKeyDown(e, commitNotes, false)}
        className={`${inputCls} resize-y`}
      />

      {isCompleted ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-gray-500">완료한 때</span>
          <input
            type="datetime-local"
            aria-label="완료 날짜"
            value={completedDraft}
            onChange={(e) => setCompletedDraft(e.target.value)}
            className="rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-700"
          />
          <button
            type="button"
            onClick={() => setCompletedDraft((v) => (v ? previousDay(v) : v))}
            className={`${CHIP} bg-gray-100 text-gray-600 hover:bg-gray-200`}
            title="하루 전으로"
          >
            어제
          </button>
          <button
            type="button"
            disabled={!completedDraft}
            onClick={() =>
              setCompletedAt(todo.id, `${completedDraft.replace('T', ' ')}:00`).then(
                () => setError(''),
                (e: unknown) => setError(`저장하지 못했어요. ${errText(e)}`)
              )
            }
            className={`${CHIP} bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40`}
          >
            완료 날짜 저장
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5" aria-label="마감">
            <span className="w-12 shrink-0 text-xs text-gray-500">마감</span>
            {quick.map((b) => {
              const on = b.target === null ? !todo.due_date : date === b.target
              return (
                <button
                  key={b.label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => save(shiftDueDate(todo.due_date, b.target))}
                  className={`${CHIP} ${on ? 'bg-blue-50 font-medium text-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >
                  {b.label}
                </button>
              )
            })}
            <input
              type="date"
              aria-label="마감 날짜"
              // 값은 blur 나 Enter 에 저장한다. 이유: 키보드로 치는 도중의 중간 날짜가 저장되면 행이 다른 구획으로 옮겨져 포커스를 잃는다
              key={`d-${date}`}
              defaultValue={date}
              onBlur={(e) => {
                if (e.target.value !== date) void save(dueFromDateInput(todo.due_date, e.target.value))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              className="rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-700"
            />
            <input
              type="time"
              aria-label="마감 시각"
              key={`t-${time}`}
              defaultValue={time}
              onBlur={(e) => {
                if (e.target.value !== time) void save(dueFromTimeInput(todo.due_date, e.target.value, today))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              className="rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-700"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5" aria-label="우선순위">
            <span className="w-12 shrink-0 text-xs text-gray-500">우선순위</span>
            {(['high', 'medium', 'low'] as const).map((p) => {
              const on = todo.priority === p
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={on}
                  onClick={() => (on ? undefined : save({ priority: p }))}
                  className={`${CHIP} ${on ? `${todoPriority[p].badge} font-medium` : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >
                  {todoPriority[p].label}
                </button>
              )
            })}
          </div>
        </>
      )}

      {tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="태그">
          <span className="w-12 shrink-0 text-xs text-gray-500">태그</span>
          {tags.map((tag) => {
            const on = tagIds.includes(tag.id)
            return (
              <button
                key={tag.id}
                type="button"
                aria-pressed={on}
                onClick={() => save({ tag_ids: on ? tagIds.filter((id) => id !== tag.id) : [...tagIds, tag.id] })}
                className={`${CHIP} inline-flex items-center gap-1 ${on ? 'bg-blue-50 font-medium text-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                {tag.name}
              </button>
            )
          })}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="break-words rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2 pt-0.5">
        {isCompleted ? (
          <button
            type="button"
            onClick={() => void restoreTodo(todo.id).catch((e: unknown) => setError(`되돌리지 못했어요. ${errText(e)}`))}
            className={`inline-flex items-center gap-1 ${CHIP} text-blue-600 hover:bg-blue-50`}
          >
            <UndoIcon size={12} />
            진행 중으로 되돌리기
          </button>
        ) : null}
        {todo.source_link ? (
          <button
            type="button"
            onClick={() => void save({ source_link: null })}
            title="이 할 일과 출처의 연결을 끊습니다"
            className={`${CHIP} text-gray-500 hover:bg-gray-100 hover:text-gray-700`}
          >
            출처 연결 해제
          </button>
        ) : null}
        <span className="text-[11px] text-gray-400">Esc 닫기 · ⌘Enter 저장</span>
        <button
          type="button"
          onClick={remove}
          className={`ml-auto inline-flex items-center gap-1 ${CHIP} text-gray-500 hover:bg-red-50 hover:text-red-600`}
        >
          <TrashIcon size={12} />
          삭제
        </button>
      </div>
    </div>
  )
}
