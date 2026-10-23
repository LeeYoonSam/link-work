import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import type { Memo } from '../../types'
import MarkdownContent from './MarkdownContent'
import { StarIcon, XIcon } from '../ui'

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

  const [copied, setCopied] = useState(false)

  // 다른 메모로 바뀌면 이전 메모의 '복사됨' 표시가 남지 않게 한다.
  useEffect(() => {
    setCopied(false)
  }, [memo.id])

  // 렌더된 HTML이 아니라 마크다운 원문을 복사한다.
  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(memo.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      console.warn('[MemoViewer] 메모 복사 실패', e)
    }
  }

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
            {isImportant ? <StarIcon size={16} filled className="text-amber-400 flex-shrink-0" /> : null}
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
            <button
              type="button"
              onClick={handleCopy}
              className="px-3 py-1.5 text-xs text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200"
            >
              {copied ? '복사됨' : '메모 복사'}
            </button>
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
              <XIcon size={16} />
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
