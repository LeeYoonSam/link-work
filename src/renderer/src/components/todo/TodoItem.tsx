import { format } from 'date-fns'
import { useTodoStore } from '../../stores/todoStore'
import type { Todo } from '../../types'

interface TodoItemProps {
  todo: Todo
}

const priorityConfig = {
  high: { label: '높음', bg: 'bg-red-50', text: 'text-red-600', dot: 'bg-red-500' },
  medium: { label: '중간', bg: 'bg-blue-50', text: 'text-blue-600', dot: 'bg-blue-500' },
  low: { label: '낮음', bg: 'bg-gray-50', text: 'text-gray-500', dot: 'bg-gray-400' }
}

export default function TodoItem({ todo }: TodoItemProps): React.ReactNode {
  const { completeTodo, restoreTodo, deleteTodo, setEditingTodo } = useTodoStore()
  const priority = priorityConfig[todo.priority]
  const isCompleted = todo.is_completed === 1

  const isOverdue = Boolean(
    todo.due_date && !isCompleted && new Date(todo.due_date) < new Date()
  )

  const hasTags = todo.tags && todo.tags.length > 0

  return (
    <div
      className={`group flex items-start gap-3 p-3 rounded-lg border transition-colors ${
        isCompleted
          ? 'bg-gray-50 border-gray-200'
          : isOverdue
            ? 'bg-red-50/50 border-red-200'
            : 'bg-white border-gray-200 hover:border-gray-300'
      }`}
    >
      <button
        onClick={() => (isCompleted ? restoreTodo(todo.id) : completeTodo(todo.id))}
        className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
          isCompleted
            ? 'bg-green-500 border-green-500 text-white'
            : 'border-gray-300 hover:border-green-400'
        }`}
      >
        {isCompleted ? (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : null}
      </button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`text-sm ${
              isCompleted ? 'line-through text-gray-400' : 'text-gray-900'
            }`}
          >
            {todo.title}
          </span>
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${priority.dot}`} title={priority.label} />
        </div>

        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {hasTags
            ? todo.tags!.map((tag) => (
                <span
                  key={tag.id}
                  className="px-2 py-0.5 text-xs rounded-full text-white"
                  style={{ backgroundColor: tag.color }}
                >
                  {tag.name}
                </span>
              ))
            : null}
          {todo.due_date ? (
            <span
              className={`text-xs ${
                isOverdue ? 'text-red-500 font-medium' : 'text-gray-400'
              }`}
            >
              {isOverdue ? '⚠ ' : ''}
              {format(new Date(todo.due_date), 'yyyy-MM-dd HH:mm')}
              {todo.due_reminder === 1 ? ' 🔔' : ''}
            </span>
          ) : null}
          {isCompleted && todo.completed_at ? (
            <span className="text-xs text-gray-400">
              완료: {format(new Date(todo.completed_at), 'yyyy-MM-dd HH:mm')}
            </span>
          ) : null}
        </div>
      </div>

      {!isCompleted ? (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => setEditingTodo(todo)}
            className="p-1 text-gray-400 hover:text-blue-500 transition-colors"
            title="수정"
          >
            ✏️
          </button>
          <button
            onClick={() => {
              if (confirm('이 TODO를 삭제하시겠습니까?')) deleteTodo(todo.id)
            }}
            className="p-1 text-gray-400 hover:text-red-500 transition-colors"
            title="삭제"
          >
            🗑️
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => restoreTodo(todo.id)}
            className="p-1 text-gray-400 hover:text-green-500 transition-colors"
            title="복구"
          >
            ↩️
          </button>
          <button
            onClick={() => {
              if (confirm('이 TODO를 영구 삭제하시겠습니까?')) deleteTodo(todo.id)
            }}
            className="p-1 text-gray-400 hover:text-red-500 transition-colors"
            title="삭제"
          >
            🗑️
          </button>
        </div>
      )}
    </div>
  )
}
