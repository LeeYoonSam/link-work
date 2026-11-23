// 할 일 화면. 위에서부터 빠른 입력 → 뷰 탭(오늘·예정·전체·완료) → 검색·태그 필터 → 구획별 조밀한 목록.
// 편집은 행을 그 자리에서 펼쳐서 한다. 키보드 단축키는 todoKeys.ts 가 정한다
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTodoStore } from '../../stores/todoStore'
import type { Todo, TodoInput } from '../../types'
import { Card, SearchIcon, XIcon, button, showToast } from '../ui'
import { isTypingTarget, moveSelection, neighborAfterRemoval } from '../memo/memoNav'
import QuickAddInput from './QuickAddInput'
import TodoItem from './TodoItem'
import TagManager from './TagManager'
import BulkAddPanel from './BulkAddPanel'
import {
  buildTodoSections,
  localDateKey,
  todoBucket,
  viewForTodo,
  type TodoSection,
  type TodoViewKey
} from './todoModel'
import { todoKeyAction } from './todoKeys'

export const VIEW_TABS: { key: TodoViewKey; label: string }[] = [
  { key: 'today', label: '오늘' },
  { key: 'upcoming', label: '예정' },
  { key: 'all', label: '전체' },
  { key: 'done', label: '완료' }
]

const VIEW_LABEL: Record<TodoViewKey, string> = {
  today: '오늘',
  upcoming: '예정',
  all: '전체',
  done: '완료'
}

const EMPTY_TEXT: Record<TodoViewKey, string> = {
  today: '오늘 할 일이 없어요',
  upcoming: '예정된 할 일이 없어요',
  all: '남은 할 일이 없어요',
  done: '완료한 할 일이 없어요'
}

/** 제목·메모·태그 이름에서 찾는다(대소문자 무시) */
// 화면 위에 떠 있는 대화상자(빠른 추가 팝오버 등)가 있으면 목록 단축키를 멈춘다
export const OVERLAY_SELECTOR = '[aria-modal="true"], [role="dialog"]'

export function hasOpenOverlay(root: Pick<ParentNode, 'querySelector'>): boolean {
  return root.querySelector(OVERLAY_SELECTOR) !== null
}

export function matchesSearch(todo: Todo, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    todo.title.toLowerCase().includes(q) ||
    (todo.notes?.toLowerCase().includes(q) ?? false) ||
    (todo.tags?.some((t) => t.name.toLowerCase().includes(q)) ?? false)
  )
}

export interface VisibleFilter {
  search: string
  filterTagId: number | null
  pendingDeleteIds: number[]
}

/**
 * 화면에 보일 항목만 남긴다: 삭제 대기 중인 항목을 빼고, 태그 필터와 검색을 건다.
 * 태그 필터는 조회(listByTag)에서도 걸리지만, 필터를 바꾼 직후 재조회가 끝나기 전에도 맞게 보이도록 여기서 한 번 더 건다
 */
export function visibleTodos(list: Todo[], f: VisibleFilter): Todo[] {
  return list.filter(
    (t) =>
      !f.pendingDeleteIds.includes(t.id) &&
      (f.filterTagId == null || !t.tags || t.tags.some((tag) => tag.id === f.filterTagId)) &&
      matchesSearch(t, f.search)
  )
}

/** 뷰별 구획과 개수. 개수는 그 뷰 구획에 들어간 항목 수다 */
export function buildViewData(input: {
  todos: Todo[]
  completedTodos: Todo[]
  today: string
}): { sections: Record<TodoViewKey, TodoSection[]>; counts: Record<TodoViewKey, number> } {
  const sections = {} as Record<TodoViewKey, TodoSection[]>
  const counts = {} as Record<TodoViewKey, number>
  for (const { key } of VIEW_TABS) {
    sections[key] = buildTodoSections(key, input)
    counts[key] = sections[key].reduce((n, s) => n + s.todos.length, 0)
  }
  return { sections, counts }
}

/**
 * 딥링크(selectedTodoId)로 들어온 항목이 보일 뷰. 진행 중 목록에 있으면 마감으로 정하고,
 * 완료 목록에만 있으면 완료 뷰다. 아직 어느 목록에도 없으면(조회 전) null
 */
export function deepLinkView(id: number, todos: Todo[], completedTodos: Todo[], today: string): TodoViewKey | null {
  const active = todos.find((t) => t.id === id)
  if (active) return viewForTodo(active, today)
  const done = completedTodos.find((t) => t.id === id)
  if (done) return 'done'
  return null
}

/** 새로 만든 항목이 들어갈 뷰. 마감 문자열만으로 정한다 */
export function viewForInput(input: TodoInput, today: string): TodoViewKey {
  const bucket = todoBucket(input.due_date ?? null, today)
  if (bucket === 'overdue' || bucket === 'today') return 'today'
  if (bucket === 'later') return 'upcoming'
  return 'all'
}

const SECTION_TITLE_CLS: Record<TodoSection['kind'], string> = {
  overdue: 'text-red-600',
  today: 'text-amber-700',
  date: 'text-gray-600',
  none: 'text-gray-500',
  done: 'text-gray-500'
}

/** 구획 머리. 지난 항목 구획에는 '모두 오늘로' 버튼이 붙는다 */
export function SectionHeader({
  section,
  onAllToToday
}: {
  section: TodoSection
  onAllToToday?: (todos: Todo[]) => void
}): React.ReactNode {
  return (
    <div className="flex items-center gap-2 px-4 pt-3 pb-1">
      <h3 className={`text-xs font-semibold ${SECTION_TITLE_CLS[section.kind]}`}>
        {section.title}
        <span className="ml-1.5 font-normal text-gray-400 tabular-nums">{section.todos.length}</span>
      </h3>
      {section.kind === 'overdue' && onAllToToday ? (
        <button
          type="button"
          onClick={() => onAllToToday(section.todos)}
          className="ml-auto text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline"
        >
          모두 오늘로
        </button>
      ) : null}
    </div>
  )
}

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : '알 수 없는 오류')

export default function TodoView({
  now,
  initialView = 'today'
}: {
  /** 테스트용 기준 시각. 없으면 지금 */
  now?: Date
  initialView?: TodoViewKey
} = {}): React.ReactNode {
  const {
    todos,
    completedTodos,
    tags,
    loading,
    filterTagId,
    showTagManager,
    selectedTodoId,
    pendingDeleteIds,
    setShowCompleted,
    setFilterTagId,
    setShowTagManager,
    setSelectedTodoId,
    fetchTodos,
    fetchCompletedTodos,
    fetchTags,
    createTodo,
    updateTodo,
    restoreTodo,
    completeWithUndo,
    rescheduleWithUndo,
    requestDelete
  } = useTodoStore()

  const today = localDateKey(now ?? new Date())
  const [view, setView] = useState<TodoViewKey>(initialView)
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [focusedId, setFocusedId] = useState<number | null>(null)
  const [bulkLines, setBulkLines] = useState<string[] | null>(null)
  const [loadError, setLoadError] = useState('')
  // 이미 뷰를 맞춰 준 딥링크 id. 같은 id 로 다시 오면(null 을 거친 뒤) 다시 맞춘다
  const [handledSelId, setHandledSelId] = useState<number | null>(null)

  const addInputRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchTags().catch(() => {})
  }, [])

  useEffect(() => {
    Promise.all([fetchTodos(), fetchCompletedTodos()])
      .then(() => setLoadError(''))
      .catch((e: unknown) => setLoadError(`할 일을 불러오지 못했어요. ${errText(e)}`))
  }, [filterTagId])

  // dataSync 는 showCompleted 일 때만 완료 목록을 다시 읽는다. 완료 뷰에서는 켜 둔다
  useEffect(() => {
    setShowCompleted(view === 'done')
  }, [view])

  // 딥링크: 들어온 항목이 보일 뷰를 렌더 중에 바로 고른다(첫 화면부터 그 행이 보이게).
  // 실제 상태 반영(뷰·검색어 비우기·펼침)은 아래 effect 가 한 번만 한다. 이후 사용자의 탭 조작은 존중한다
  const pendingView =
    selectedTodoId != null && selectedTodoId !== handledSelId
      ? deepLinkView(selectedTodoId, todos, completedTodos, today)
      : null
  const activeView = pendingView ?? view
  const activeSearch = pendingView ? '' : search

  useEffect(() => {
    if (selectedTodoId == null) {
      setHandledSelId(null)
      return
    }
    if (!pendingView) return
    setHandledSelId(selectedTodoId)
    setView(pendingView)
    setSearch('')
    setFocusedId(selectedTodoId)
    setExpandedId(selectedTodoId)
  }, [selectedTodoId, pendingView])

  // 딥링크로 들어온 직후 사용자가 클릭·키 입력 등 다른 동작을 하면 강조를 푼다.
  // 전환을 일으킨 클릭이 곧바로 잡히지 않도록 다음 틱에 등록한다
  useEffect(() => {
    if (selectedTodoId == null) return
    const clear = (): void => setSelectedTodoId(null)
    const timer = window.setTimeout(() => {
      window.addEventListener('pointerdown', clear, { once: true })
      window.addEventListener('keydown', clear, { once: true })
    }, 0)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', clear)
      window.removeEventListener('keydown', clear)
    }
  }, [selectedTodoId, setSelectedTodoId])

  const filter: VisibleFilter = { search: activeSearch, filterTagId, pendingDeleteIds: pendingDeleteIds ?? [] }
  const shownTodos = useMemo(
    () => visibleTodos(todos, filter),
    [todos, activeSearch, filterTagId, pendingDeleteIds]
  )
  const shownCompleted = useMemo(
    () => visibleTodos(completedTodos, filter),
    [completedTodos, activeSearch, filterTagId, pendingDeleteIds]
  )
  const { sections: viewSections, counts } = useMemo(
    () => buildViewData({ todos: shownTodos, completedTodos: shownCompleted, today }),
    [shownTodos, shownCompleted, today]
  )
  const sections = viewSections[activeView]
  const orderedIds = sections.flatMap((s) => s.todos.map((t) => t.id))
  const byId = new Map<number, Todo>()
  for (const s of sections) for (const t of s.todos) byId.set(t.id, t)

  const changeView = (next: TodoViewKey): void => {
    setView(next)
    setExpandedId(null)
    setFocusedId(null)
  }

  const handleAdd = async (input: TodoInput, opts: { openAfter: boolean }): Promise<void> => {
    const id = await createTodo(input)
    const target = viewForInput(input, today)
    if (opts.openAfter) {
      setView(target)
      setSearch('')
      setFocusedId(id)
      setExpandedId(id)
      return
    }
    // 지금 뷰에 안 보이는 곳에 들어갔으면 그 뷰로 바로 옮겨 새 항목을 보여 주고, 어디로 갔는지 알려 준다
    if (target !== activeView && activeView !== 'all') {
      setView(target)
      setExpandedId(null)
      setFocusedId(id)
      showToast({ message: `'${VIEW_LABEL[target]}'에 추가했어요` })
    }
  }

  const handleAllToToday = (list: Todo[]): void => {
    void rescheduleWithUndo(list, today).catch((e: unknown) =>
      showToast({ message: `날짜를 옮기지 못했어요. ${errText(e)}` })
    )
  }

  const scrollToRow = (id: number): void => {
    document.querySelector(`[data-todo-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  // 키 처리기는 매 렌더 최신 상태를 보도록 ref 에 둔다. window 에는 한 번만 붙인다
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyHandlerRef.current = (e: KeyboardEvent): void => {
    const overlayOpen = bulkLines !== null || showTagManager || hasOpenOverlay(document)
    const action = todoKeyAction(e, { typing: isTypingTarget(e.target), overlayOpen })
    if (!action) return
    // 버튼·링크 위의 Enter·Space 는 그 컨트롤의 기본 동작(click)에 맡긴다
    const onControl = (e.target as HTMLElement | null)?.closest?.('button, a') != null
    if (onControl && (action === 'expand' || action === 'toggleComplete')) return
    const focused = focusedId != null ? byId.get(focusedId) ?? null : null
    switch (action) {
      case 'focusAdd':
        addInputRef.current?.focus()
        break
      case 'focusSearch':
        searchRef.current?.focus()
        break
      case 'next':
      case 'prev': {
        const next = moveSelection(orderedIds, focused ? focused.id : null, action === 'next' ? 'down' : 'up')
        if (next == null) return
        setFocusedId(next)
        scrollToRow(next)
        break
      }
      case 'toggleComplete':
        if (!focused) return
        if (focused.is_completed === 1) void restoreTodo(focused.id).catch(() => {})
        else void completeWithUndo(focused).catch(() => {})
        break
      case 'expand':
        if (!focused) return
        setExpandedId(focused.id)
        break
      case 'collapse':
        if (expandedId == null && focusedId == null) return
        if (expandedId != null) setExpandedId(null)
        else setFocusedId(null)
        break
      case 'toToday':
        if (!focused || focused.is_completed === 1) return
        handleAllToToday([focused])
        break
      case 'priorityHigh':
      case 'priorityMedium':
      case 'priorityLow':
        if (!focused || focused.is_completed === 1) return
        void updateTodo(focused.id, {
          priority: action === 'priorityHigh' ? 'high' : action === 'priorityMedium' ? 'medium' : 'low'
        }).catch(() => {})
        break
      case 'delete':
        if (!focused) return
        setFocusedId(neighborAfterRemoval(orderedIds, focused.id))
        requestDelete(focused)
        break
    }
    e.preventDefault()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => keyHandlerRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const isSearching = activeSearch.trim().length > 0

  return (
    <div className="space-y-3">
      <Card padding="none" className="px-4 py-3">
        <QuickAddInput
          tags={tags}
          onSubmit={handleAdd}
          onBulkPaste={(lines) => setBulkLines(lines)}
          inputRef={addInputRef}
          now={now ? () => now : undefined}
          placeholder="할 일 추가 — 예: 내일 3시 회의 준비 !높음 (Enter)"
          ariaLabel="할 일 추가"
          onEscape={() => addInputRef.current?.blur()}
        />
      </Card>

      {bulkLines ? (
        <BulkAddPanel
          lines={bulkLines}
          tags={tags}
          now={now ? () => now : undefined}
          onClose={() => setBulkLines(null)}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="할 일 보기" className="flex items-center gap-1">
          {VIEW_TABS.map((tab) => {
            const on = tab.key === activeView
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={on}
                data-view={tab.key}
                onClick={() => changeView(tab.key)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  on ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                }`}
              >
                {tab.label}
                <span className={`ml-1 text-xs tabular-nums ${on ? 'text-blue-500' : 'text-gray-400'}`}>
                  {counts[tab.key]}
                </span>
              </button>
            )
          })}
        </div>

        <div className="relative ml-auto min-w-[10rem] flex-1 sm:max-w-xs">
          <SearchIcon
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            ref={searchRef}
            type="text"
            value={activeSearch}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearch('')
                e.currentTarget.blur()
              }
            }}
            aria-label="할 일 검색"
            placeholder="검색 (/)"
            className="w-full rounded-md border border-gray-200 bg-white py-1.5 pl-8 pr-7 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
          {isSearching ? (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              title="검색어 지우기"
              aria-label="검색어 지우기"
            >
              <XIcon size={13} />
            </button>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => setShowTagManager(!showTagManager)}
          aria-expanded={showTagManager}
          className={`px-3 py-1.5 text-sm ${button.subtle}`}
        >
          태그 관리
        </button>
      </div>

      {tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="태그 필터">
          <button
            type="button"
            aria-pressed={filterTagId === null}
            onClick={() => setFilterTagId(null)}
            className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
              filterTagId === null ? 'bg-blue-50 font-medium text-blue-700' : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            모든 태그
          </button>
          {tags.map((tag) => {
            const on = filterTagId === tag.id
            return (
              <button
                key={tag.id}
                type="button"
                aria-pressed={on}
                onClick={() => setFilterTagId(on ? null : tag.id)}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                  on ? 'bg-blue-50 font-medium text-blue-700' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                {tag.name}
              </button>
            )
          })}
        </div>
      ) : null}

      {showTagManager ? <TagManager onClose={() => setShowTagManager(false)} /> : null}

      {loadError ? (
        <p role="alert" className="break-words rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {loadError}
        </p>
      ) : null}

      <Card padding="none">
        {loading && todos.length === 0 && completedTodos.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-400">불러오는 중…</p>
        ) : sections.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm text-gray-400">{isSearching ? '검색 결과가 없어요' : EMPTY_TEXT[activeView]}</p>
            {activeView === 'today' && !isSearching ? (
              <button
                type="button"
                onClick={() => changeView('all')}
                className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline"
              >
                전체 할 일 보기 →
              </button>
            ) : null}
          </div>
        ) : (
          <div className="pb-1">
            {sections.map((section, i) => (
              <section
                key={section.key}
                data-section={section.key}
                aria-label={section.title}
                className={i > 0 ? 'border-t border-gray-100' : ''}
              >
                <SectionHeader section={section} onAllToToday={handleAllToToday} />
                <ul>
                  {section.todos.map((todo) => (
                    <TodoItem
                      key={todo.id}
                      todo={todo}
                      today={today}
                      tags={tags}
                      expanded={expandedId === todo.id}
                      focused={focusedId === todo.id}
                      highlighted={todo.id === selectedTodoId}
                      onExpand={() => {
                        setExpandedId(todo.id)
                        setFocusedId(todo.id)
                      }}
                      onCollapse={() => setExpandedId(null)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
