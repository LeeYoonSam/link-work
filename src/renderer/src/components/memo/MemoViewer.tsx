import { useEffect } from 'react'
import { format } from 'date-fns'
import type { Memo } from '../../types'

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

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg w-full max-w-2xl max-h-[80vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            {memo.is_important && <span className="text-yellow-500">★</span>}
            <span className="text-xs text-gray-400">
              {format(new Date(memo.created_at), 'yyyy-MM-dd HH:mm:ss')}
            </span>
            {memo.updated_at !== memo.created_at && (
              <span className="text-xs text-gray-400">
                (edited {format(new Date(memo.updated_at), 'yyyy-MM-dd HH:mm:ss')})
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onEdit && (
              <button
                onClick={() => onEdit(memo)}
                className="px-3 py-1.5 text-xs text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200"
              >
                Edit
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-600 rounded"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="px-6 py-5 overflow-y-auto flex-1 whitespace-pre-wrap text-sm text-gray-800 leading-relaxed">
          {memo.content}
        </div>
      </div>
    </div>
  )
}
