import { format } from 'date-fns'
import type { Memo } from '../../types'

interface MemoCardProps {
  memo: Memo
  isArchived?: boolean
  onClick?: (memo: Memo) => void
  onEdit?: (memo: Memo) => void
  onArchive?: (id: number) => void
  onRestore?: (id: number) => void
  onDelete?: (id: number) => void
  onToggleImportant?: (id: number) => void
}

export default function MemoCard({
  memo,
  isArchived,
  onClick,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
  onToggleImportant
}: MemoCardProps): React.ReactNode {
  return (
    <div
      className={`break-inside-avoid mb-4 bg-white border rounded-lg p-4 shadow-sm hover:shadow-md transition ${onClick ? 'cursor-pointer' : ''} ${
        isArchived ? 'opacity-60 border-gray-200' : memo.is_important ? 'border-yellow-300 bg-yellow-50/30' : 'border-gray-200'
      }`}
      onClick={() => onClick?.(memo)}
    >
      <div className="whitespace-pre-wrap text-sm text-gray-800 mb-3">{memo.content}</div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">
          {format(new Date(memo.created_at), 'yyyy-MM-dd HH:mm:ss')}
        </span>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {isArchived ? (
            <>
              <button
                onClick={() => onRestore?.(memo.id)}
                className="p-1 text-gray-400 hover:text-blue-600 rounded"
                title="Restore"
              >
                ↩️
              </button>
              <button
                onClick={() => {
                  if (confirm('Permanently delete this memo?')) onDelete?.(memo.id)
                }}
                className="p-1 text-gray-400 hover:text-red-600 rounded"
                title="Delete permanently"
              >
                🗑️
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => onToggleImportant?.(memo.id)}
                className={`p-1 rounded ${memo.is_important ? 'text-yellow-500' : 'text-gray-400 hover:text-yellow-500'}`}
                title={memo.is_important ? 'Unmark important' : 'Mark important'}
              >
                {memo.is_important ? '★' : '☆'}
              </button>
              <button
                onClick={() => onEdit?.(memo)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded"
                title="Edit"
              >
                ✏️
              </button>
              <button
                onClick={() => onArchive?.(memo.id)}
                className="p-1 text-gray-400 hover:text-yellow-600 rounded"
                title="Archive"
              >
                📥
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
