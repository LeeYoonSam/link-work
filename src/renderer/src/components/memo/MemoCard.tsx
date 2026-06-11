import { format } from 'date-fns'
import { useMemo } from 'react'
import type { Memo, MemoCategory } from '../../types'
import MarkdownContent from './MarkdownContent'
import { IconButton, StarIcon, PencilIcon, TrashIcon, UndoIcon, ArchiveIcon } from '../ui'

interface MemoCardProps {
  memo: Memo
  category?: MemoCategory | null
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
  category,
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
      className={`h-72 bg-white border rounded-lg shadow-sm hover:shadow-md transition flex flex-col overflow-hidden ${
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
      <div className="px-4 pt-3 pb-2 border-b border-gray-100 flex flex-col gap-1 flex-shrink-0">
        <div className="flex items-start gap-1.5">
          {isImportant ? (
            <StarIcon size={14} filled className="text-amber-400 flex-shrink-0 mt-0.5" />
          ) : null}
          <h3 className="text-sm font-semibold text-gray-900 line-clamp-2 flex-1 min-w-0">
            {title}
          </h3>
        </div>
        {category ? (
          <span
            className="inline-flex items-center gap-1 self-start px-1.5 py-0.5 rounded text-[10px] font-medium text-white"
            style={{ backgroundColor: category.color }}
          >
            {category.name}
          </span>
        ) : null}
      </div>

      {preview.trim() !== '' ? (
        <div className="px-4 py-3 relative flex-1 min-h-0 overflow-hidden">
          <div className="h-full overflow-hidden">
            <MarkdownContent content={preview} compact />
          </div>
          {hasMore ? (
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-white to-transparent" />
          ) : null}
        </div>
      ) : (
        <div className="flex-1 min-h-0" />
      )}

      <div className="px-4 py-2 flex items-center justify-between gap-2 border-t border-gray-100 bg-gray-50/50 flex-shrink-0">
        <span className="text-xs text-gray-400 whitespace-nowrap truncate">
          {format(new Date(memo.created_at), 'yyyy-MM-dd HH:mm')}
        </span>
        <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {isArchived ? (
            <>
              <IconButton tone="primary" title="Restore" onClick={() => onRestore?.(memo.id)}>
                <UndoIcon size={14} />
              </IconButton>
              <IconButton
                tone="danger"
                title="Delete permanently"
                onClick={() => {
                  if (confirm('Permanently delete this memo?')) onDelete?.(memo.id)
                }}
              >
                <TrashIcon size={14} />
              </IconButton>
            </>
          ) : (
            <>
              <IconButton
                tone="star"
                active={isImportant}
                title={isImportant ? 'Unmark important' : 'Mark important'}
                onClick={() => onToggleImportant?.(memo.id)}
              >
                <StarIcon size={14} filled={isImportant} />
              </IconButton>
              <IconButton title="Edit" onClick={() => onEdit?.(memo)}>
                <PencilIcon size={14} />
              </IconButton>
              <IconButton tone="danger" title="Archive" onClick={() => onArchive?.(memo.id)}>
                <ArchiveIcon size={14} />
              </IconButton>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
