import { useEffect, useMemo, useRef, useState } from 'react'
import { format, isToday, isYesterday } from 'date-fns'
import { ko } from 'date-fns/locale'
import { useTodoStore } from '../../stores/todoStore'
import TodoItem from './TodoItem'
import TodoForm from './TodoForm'
import TagManager from './TagManager'
import type { Todo } from '../../types'
import { Badge, EmptyState, SearchIcon, XIcon, InboxIcon, button } from '../ui'

function matchesSearch(todo: Todo, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    todo.title.toLowerCase().includes(q) ||
    (todo.notes?.toLowerCase().includes(q) ?? false) ||
    (todo.tags?.some((t) => t.name.toLowerCase().includes(q)) ?? false)
  )
}

interface CompletedGroup {
  key: string
  label: string
  badge: string | null
  items: Todo[]
}

// Group completed todos by completion date, newest day first, newest item first.
function groupByCompletedDate(todos: Todo[]): CompletedGroup[] {
  const map = new Map<string, Todo[]>()
  for (const todo of todos) {
    const key = todo.completed_at ? todo.completed_at.slice(0, 10) : ''
    const list = map.get(key) ?? []
    list.push(todo)
    map.set(key, list)
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, items]) => {
      items.sort((a, b) => {
        const av = a.completed_at ?? ''
        const bv = b.completed_at ?? ''
        return av < bv ? 1 : av > bv ? -1 : 0
      })

      let label = '날짜 미상'
      let badge: string | null = null
      if (key) {
        const d = new Date(`${key}T00:00:00`)
        label = format(d, 'yyyy년 M월 d일 (EEE)', { locale: ko })
        if (isToday(d)) badge = '오늘'
        else if (isYesterday(d)) badge = '어제'
      }
      return { key: key || 'unknown', label, badge, items }
    })
}

export default function TodoView(): React.ReactNode {
  const {
    todos,
    completedTodos,
    tags,
    loading,
    showCompleted,
    filterTagId,
    editingTodo,
    showTagManager,
    selectedTodoId,
    setShowCompleted,
    setFilterTagId,
    setEditingTodo,
    setShowTagManager,
    setSelectedTodoId,
    fetchTodos,
    fetchCompletedTodos,
    fetchTags
  } = useTodoStore()

  const [showForm, setShowForm] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetchTodos()
    fetchCompletedTodos()
    fetchTags()
  }, [])

  useEffect(() => {
    fetchTodos()
    fetchCompletedTodos()
  }, [filterTagId])

  // 대시보드에서 선택해 들어온 직후 사용자가 클릭/키 입력 등 다른 액션을 하면
  // 강조를 해제한다. 전환을 유발한 클릭이 곧바로 트리거되지 않도록 다음 틱에 등록.
  // (StrictMode에서 마운트 직후 cleanup이 한 번 도는 문제를 피하기 위해
  //  언마운트 기반 해제 대신 사용자 인터랙션 기반으로만 해제한다.)
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

  // 대시보드에서 선택해 들어온 항목이 완료/진행중 어느 쪽에 있는지 보고
  // 알맞은 탭으로 한 번만 전환한다(이후 사용자의 탭 조작은 존중).
  const handledSelectionRef = useRef<number | null>(null)
  useEffect(() => {
    if (selectedTodoId == null) {
      handledSelectionRef.current = null
      return
    }
    if (handledSelectionRef.current === selectedTodoId) return
    const inCompleted = completedTodos.some((t) => t.id === selectedTodoId)
    const inActive = todos.some((t) => t.id === selectedTodoId)
    if (!inCompleted && !inActive) return // 데이터 로드 전이면 대기
    handledSelectionRef.current = selectedTodoId
    setShowCompleted(inCompleted && !inActive)
  }, [selectedTodoId, todos, completedTodos, setShowCompleted])

  const filteredTodos = useMemo(
    () => todos.filter((t) => matchesSearch(t, search)),
    [todos, search]
  )
  const filteredCompleted = useMemo(
    () => completedTodos.filter((t) => matchesSearch(t, search)),
    [completedTodos, search]
  )
  const completedGroups = useMemo(
    () => groupByCompletedDate(filteredCompleted),
    [filteredCompleted]
  )

  const handleCloseForm = (): void => {
    setShowForm(false)
    setEditingTodo(null)
  }

  const isSearching = search.trim().length > 0

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="제목, 메모, 태그 검색..."
            className="w-full pl-9 pr-8 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400 transition-colors"
          />
          {isSearching && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              title="검색어 지우기"
            >
              <XIcon size={14} />
            </button>
          )}
        </div>
        <button
          onClick={() => setShowTagManager(true)}
          className={`px-3 py-2 text-sm ${button.subtle}`}
        >
          태그 관리
        </button>
        <button
          onClick={() => setShowForm(true)}
          className={`px-4 py-2 text-sm font-medium ${button.primary}`}
        >
          + 새 TODO
        </button>
      </div>

      {tags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">필터:</span>
          <button
            onClick={() => setFilterTagId(null)}
            className={`px-3 py-1 text-xs rounded-full border transition-colors ${
              filterTagId === null
                ? `${button.dark} border-transparent`
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
            }`}
          >
            전체
          </button>
          {tags.map((tag) => (
            <button
              key={tag.id}
              onClick={() => setFilterTagId(filterTagId === tag.id ? null : tag.id)}
              className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                filterTagId === tag.id
                  ? 'text-white border-transparent'
                  : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
              }`}
              style={
                filterTagId === tag.id
                  ? { backgroundColor: tag.color, borderColor: tag.color }
                  : undefined
              }
            >
              {tag.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2 border-b border-gray-200">
        <button
          onClick={() => setShowCompleted(false)}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            !showCompleted
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-400 hover:text-gray-600'
          }`}
        >
          진행 중 ({filteredTodos.length})
        </button>
        <button
          onClick={() => setShowCompleted(true)}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            showCompleted
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-400 hover:text-gray-600'
          }`}
        >
          완료됨 ({filteredCompleted.length})
        </button>
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-8">로딩 중...</div>
      ) : !showCompleted ? (
        <div className="space-y-2">
          {filteredTodos.length === 0 ? (
            <EmptyState>
              <div className="flex justify-center mb-3 text-gray-300">
                {isSearching ? <SearchIcon size={28} /> : <InboxIcon size={28} />}
              </div>
              <div className="text-sm">
                {isSearching ? '검색 결과가 없습니다' : 'TODO가 없습니다'}
              </div>
            </EmptyState>
          ) : (
            filteredTodos.map((todo) => (
              <TodoItem key={todo.id} todo={todo} highlighted={todo.id === selectedTodoId} />
            ))
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {completedGroups.length === 0 ? (
            <EmptyState>
              <div className="flex justify-center mb-3 text-gray-300">
                {isSearching ? <SearchIcon size={28} /> : <InboxIcon size={28} />}
              </div>
              <div className="text-sm">
                {isSearching ? '검색 결과가 없습니다' : '완료된 TODO가 없습니다'}
              </div>
            </EmptyState>
          ) : (
            completedGroups.map((group) => (
              <div key={group.key} className="space-y-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-semibold text-gray-500">{group.label}</h3>
                  {group.badge && (
                    <Badge color="bg-blue-50 text-blue-600" size="xs">
                      {group.badge}
                    </Badge>
                  )}
                  <span className="text-xs text-gray-400">{group.items.length}</span>
                  <div className="flex-1 h-px bg-gray-100" />
                </div>
                <div className="space-y-2">
                  {group.items.map((todo) => (
                    <TodoItem key={todo.id} todo={todo} highlighted={todo.id === selectedTodoId} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {(showForm || editingTodo) && (
        <TodoForm todo={editingTodo} onClose={handleCloseForm} />
      )}
      {showTagManager && <TagManager onClose={() => setShowTagManager(false)} />}
    </div>
  )
}
