import { useEffect, useState } from 'react'
import { useTodoStore } from '../../stores/todoStore'
import TodoItem from './TodoItem'
import TodoForm from './TodoForm'
import TagManager from './TagManager'

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
    setShowCompleted,
    setFilterTagId,
    setEditingTodo,
    setShowTagManager,
    fetchTodos,
    fetchCompletedTodos,
    fetchTags
  } = useTodoStore()

  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    fetchTodos()
    fetchCompletedTodos()
    fetchTags()
  }, [])

  useEffect(() => {
    fetchTodos()
    fetchCompletedTodos()
  }, [filterTagId])

  const handleCloseForm = (): void => {
    setShowForm(false)
    setEditingTodo(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">TODO</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTagManager(true)}
            className="px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            태그 관리
          </button>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition-colors"
          >
            + 새 TODO
          </button>
        </div>
      </div>

      {tags.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">필터:</span>
          <button
            onClick={() => setFilterTagId(null)}
            className={`px-3 py-1 text-xs rounded-full border transition-colors ${
              filterTagId === null
                ? 'bg-gray-900 text-white border-gray-900'
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
          진행 중 ({todos.length})
        </button>
        <button
          onClick={() => setShowCompleted(true)}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            showCompleted
              ? 'border-blue-500 text-blue-600'
              : 'border-transparent text-gray-400 hover:text-gray-600'
          }`}
        >
          완료됨 ({completedTodos.length})
        </button>
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-8">로딩 중...</div>
      ) : (
        <div className="space-y-2">
          {(!showCompleted ? todos : completedTodos).length === 0 ? (
            <div className="text-center text-gray-400 py-12 bg-white border border-gray-200 rounded-lg">
              <div className="text-3xl mb-2">{showCompleted ? '📋' : '☐'}</div>
              <div className="text-sm">
                {showCompleted ? '완료된 TODO가 없습니다' : 'TODO가 없습니다'}
              </div>
            </div>
          ) : (
            (!showCompleted ? todos : completedTodos).map((todo) => (
              <TodoItem key={todo.id} todo={todo} />
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
