import { format } from 'date-fns'
import { useMemo } from 'react'
import type { Memo } from '../../types'
import MarkdownContent from './MarkdownContent'

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

interface ParsedMemo {
  title: string
  preview: string
  hasMore: boolean
}

const PREVIEW_LINES = 6

function parseMemo(content: string): ParsedMemo {
  const lines = content.split('\n')
  let titleLineIndex = 0
  while (titleLineIndex < lines.length && lines[titleLineIndex].trim() === '') {
    titleLineIndex += 1
  }
  const rawTitle = (lines[titleLineIndex] ?? '').trim()
  const title = rawTitle.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').slice(0, 80) || 'Untitled'

  const bodyLines: string[] = []
  let remaining = 0
  for (let i = titleLineIndex + 1; i < lines.length; i += 1) {
    if (bodyLines.length < PREVIEW_LINES) {
      if (bodyLines.length === 0 && lines[i].trim() === '') continue
      bodyLines.push(lines[i])
    } else {
      if (lines[i].trim() !== '') {
        remaining += 1
      }
    }
  }

  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
    bodyLines.pop()
  }

  return {
    title,
    preview: bodyLines.join('\n'),
    hasMore: remaining > 0
  }
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
  const { title, preview, hasMore } = useMemo(() => parseMemo(memo.content), [memo.content])
  const isImportant = memo.is_important === 1

  return (
    <div
      className={`break-inside-avoid mb-4 bg-white border rounded-lg shadow-sm hover:shadow-md transition flex flex-col overflow-hidden ${
        onClick ? 'cursor-pointer' : ''
      } ${
        isArchived
          ? 'opacity-60 border-gray-200'
          : isImportant
            ? 'border-yellow-300 bg-yellow-50/30'
            : 'border-gray-200'
      }`}
      onClick={() => onClick?.(memo)}
    >
      <div className="px-4 pt-3 pb-2 border-b border-gray-100 flex items-start gap-2">
        {isImportant ? <span className="text-yellow-500 flex-shrink-0 mt-0.5">★</span> : null}
        <h3 className="text-sm font-semibold text-gray-900 line-clamp-2 flex-1 min-w-0">
          {title}
        </h3>
      </div>

      {preview.trim() !== '' ? (
        <div className="px-4 py-3 relative">
          <div className="max-h-[9.5rem] overflow-hidden">
            <MarkdownContent content={preview} compact />
          </div>
          {hasMore ? (
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-white to-transparent" />
          ) : null}
        </div>
      ) : null}

      <div className="px-4 py-2 flex items-center justify-between border-t border-gray-100 bg-gray-50/50 mt-auto">
        <span className="text-xs text-gray-400">
          {format(new Date(memo.created_at), 'yyyy-MM-dd HH:mm')}
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
                className={`p-1 rounded ${
                  isImportant ? 'text-yellow-500' : 'text-gray-400 hover:text-yellow-500'
                }`}
                title={isImportant ? 'Unmark important' : 'Mark important'}
              >
                {isImportant ? '★' : '☆'}
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
