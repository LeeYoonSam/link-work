import { useEffect, useRef, useState } from 'react'
import { format, subDays } from 'date-fns'
import { useTodoStore } from '../../stores/todoStore'
import MarkdownContent from '../memo/MarkdownContent'
import type { Todo } from '../../types'
import {
  IconButton,
  PencilIcon,
  TrashIcon,
  UndoIcon,
  BellIcon,
  AlertTriangleIcon,
  FileTextIcon,
  XIcon,
  todoPriority
} from '../ui'

interface TodoItemProps {
  todo: Todo
  highlighted?: boolean
}

export default function TodoItem({ todo, highlighted = false }: TodoItemProps): React.ReactNode {
  const { completeTodo, restoreTodo, deleteTodo, setEditingTodo, setCompletedAt } = useTodoStore()
  const priority = todoPriority[todo.priority]
  const isCompleted = todo.is_completed === 1

  // 대시보드에서 선택해 들어온 항목은 화면 중앙으로 스크롤한다.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (highlighted) {
      rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [highlighted])

  const isOverdue = Boolean(
    todo.due_date && !isCompleted && new Date(todo.due_date) < new Date()
  )

  const hasTags = todo.tags && todo.tags.length > 0
  const hasNotes = Boolean(todo.notes && todo.notes.trim().length > 0)
  const [showNotes, setShowNotes] = useState(false)

  // 박스 클릭 시 메모가 있으면 펼치고 접는다.
  // 단, 내부의 버튼/링크/입력 등 인터랙티브 요소 클릭은 토글에서 제외한다.
  const handleBoxClick = (e: React.MouseEvent): void => {
    if (!hasNotes) return
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, textarea, select')) return
    setShowNotes((v) => !v)
  }

  const [isEditingDate, setIsEditingDate] = useState(false)
  const [draftDate, setDraftDate] = useState('')

  const openDateEditor = (): void => {
    if (!todo.completed_at) return
    setDraftDate(format(new Date(todo.completed_at), "yyyy-MM-dd'T'HH:mm"))
    setIsEditingDate(true)
  }

  const saveDate = (date: Date): void => {
    setCompletedAt(todo.id, format(date, 'yyyy-MM-dd HH:mm:ss'))
    setIsEditingDate(false)
  }

  const handleSaveDraft = (): void => {
    if (!draftDate) return
    saveDate(new Date(draftDate))
  }

  const handleYesterday = (): void => {
    if (!todo.completed_at) return
    saveDate(subDays(new Date(todo.completed_at), 1))
  }

  return (
    <div
      ref={rootRef}
      onClick={handleBoxClick}
      className={`group rounded-lg border transition-colors ${
        hasNotes ? 'cursor-pointer' : ''
      } ${
        highlighted
          ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-300 shadow-sm'
          : isCompleted
            ? 'bg-gray-50 border-gray-200'
            : isOverdue
              ? 'bg-red-50/50 border-red-200'
              : 'bg-white border-gray-200 hover:border-gray-300'
      }`}
    >
      <div className="flex items-start gap-3 p-3">
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
              className={`w-2 h-2 rounded-full flex-shrink-0 ${priority.dot}`}
              title={priority.label}
            />
            <span
              className={`text-sm ${
                isCompleted ? 'line-through text-gray-400' : 'text-gray-900'
              }`}
            >
              {todo.title}
            </span>
            {hasNotes ? (
              <button
                type="button"
                onClick={() => setShowNotes((v) => !v)}
                className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full transition-colors ${
                  showNotes
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                }`}
                title={showNotes ? '메모 접기' : '메모 펼치기'}
                aria-label={showNotes ? '메모 접기' : '메모 펼치기'}
                aria-expanded={showNotes}
              >
                <FileTextIcon size={12} />
                <span>{showNotes ? '접기' : '메모'}</span>
              </button>
            ) : null}
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
                className={`inline-flex items-center gap-1 text-xs ${
                  isOverdue ? 'text-red-500 font-medium' : 'text-gray-400'
                }`}
              >
                {isOverdue ? <AlertTriangleIcon size={12} /> : null}
                {format(new Date(todo.due_date), 'yyyy-MM-dd HH:mm')}
                {todo.due_reminder === 1 ? (
                  <BellIcon size={12} className="text-amber-400" />
                ) : null}
              </span>
            ) : null}
            {isCompleted && todo.completed_at ? (
              isEditingDate ? (
                <span className="inline-flex items-center gap-1">
                  <input
                    type="datetime-local"
                    value={draftDate}
                    autoFocus
                    onChange={(e) => setDraftDate(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveDraft()
                      if (e.key === 'Escape') setIsEditingDate(false)
                    }}
                    className="text-xs border border-gray-300 rounded px-1 py-0.5 text-gray-700"
                  />
                  <button
                    type="button"
                    onClick={handleYesterday}
                    className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
                    title="하루 전으로"
                  >
                    어제
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveDraft}
                    className="text-xs px-1.5 py-0.5 rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                  >
                    저장
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsEditingDate(false)}
                    className="text-xs px-1 text-gray-400 hover:text-gray-600 transition-colors"
                    title="취소"
                  >
                    <XIcon size={12} />
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={openDateEditor}
                  className="text-xs text-gray-400 hover:text-blue-500 hover:underline transition-colors"
                  title="완료 날짜 수정"
                >
                  완료: {format(new Date(todo.completed_at), 'yyyy-MM-dd HH:mm')}
                </button>
              )
            ) : null}
          </div>
        </div>

        {!isCompleted ? (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <IconButton title="수정" onClick={() => setEditingTodo(todo)}>
              <PencilIcon size={14} />
            </IconButton>
            <IconButton
              tone="danger"
              title="삭제"
              onClick={() => {
                if (confirm('이 TODO를 삭제하시겠습니까?')) deleteTodo(todo.id)
              }}
            >
              <TrashIcon size={14} />
            </IconButton>
          </div>
        ) : (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <IconButton tone="primary" title="복구" onClick={() => restoreTodo(todo.id)}>
              <UndoIcon size={14} />
            </IconButton>
            <IconButton
              tone="danger"
              title="삭제"
              onClick={() => {
                if (confirm('이 TODO를 영구 삭제하시겠습니까?')) deleteTodo(todo.id)
              }}
            >
              <TrashIcon size={14} />
            </IconButton>
          </div>
        )}
      </div>

      {hasNotes && showNotes ? (
        <div className="px-3 pb-3 pl-11" onClick={(e) => e.stopPropagation()}>
          <div className="rounded-md bg-amber-50/40 border border-amber-100 px-3 py-2">
            <MarkdownContent content={todo.notes as string} compact />
          </div>
        </div>
      ) : null}
    </div>
  )
}
