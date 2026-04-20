import { useEffect } from 'react'
import { format } from 'date-fns'
import type { Memo } from '../../types'
import MarkdownContent from './MarkdownContent'

interface MemoViewerProps {
  memo: Memo
  onClose: () => void
  onEdit?: (memo: Memo) => void
}

export default function MemoViewer({ memo, onClose, onEdit }: MemoViewerProps): React.ReactNode {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [onClose])

  const isImportant = memo.is_important === 1
  const edited = memo.updated_at !== memo.created_at

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg w-full max-w-4xl max-h-[85vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2 min-w-0">
            {isImportant ? <span className="text-yellow-500 flex-shrink-0">★</span> : null}
            <span className="text-xs text-gray-500">
              {format(new Date(memo.created_at), 'yyyy-MM-dd HH:mm:ss')}
            </span>
            {edited ? (
              <span className="text-xs text-gray-400">
                (edited {format(new Date(memo.updated_at), 'yyyy-MM-dd HH:mm:ss')})
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {onEdit ? (
              <button
                onClick={() => onEdit(memo)}
                className="px-3 py-1.5 text-xs text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200"
              >
                Edit
              </button>
            ) : null}
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-600 rounded"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="px-6 py-5 overflow-y-auto flex-1">
          <MarkdownContent content={memo.content} />
        </div>
      </div>
    </div>
  )
}
