import { useState } from 'react'
import { useMemoStore } from '../../stores/memoStore'
import type { Memo } from '../../types'
import MarkdownContent from './MarkdownContent'

interface MemoFormProps {
  onClose: () => void
  editingMemo?: Memo | null
}

type Mode = 'write' | 'preview'

export default function MemoForm({ onClose, editingMemo }: MemoFormProps): React.ReactNode {
  const { createMemo, updateMemo } = useMemoStore()
  const [content, setContent] = useState(editingMemo?.content || '')
  const [mode, setMode] = useState<Mode>('write')

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!content.trim()) return

    if (editingMemo) {
      await updateMemo(editingMemo.id, { content: content.trim() })
    } else {
      await createMemo({ content: content.trim() })
    }
    onClose()
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h3 className="text-lg font-bold text-gray-900">
            {editingMemo ? 'Edit Memo' : 'New Memo'}
          </h3>
          <div className="flex bg-gray-100 rounded-md p-0.5">
            <button
              type="button"
              onClick={() => setMode('write')}
              className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                mode === 'write'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Write
            </button>
            <button
              type="button"
              onClick={() => setMode('preview')}
              className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                mode === 'preview'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Preview
            </button>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="px-6 flex-1 min-h-0 flex flex-col">
            {mode === 'write' ? (
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="w-full flex-1 min-h-[320px] px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                placeholder={`# 제목\n\n마크다운 문법을 사용할 수 있습니다.\n\n- **굵게**, *기울임*, ~~취소선~~\n- \`인라인 코드\`\n- [링크](https://example.com)\n- - [ ] 체크리스트\n\n> 인용문`}
                autoFocus
                required
              />
            ) : (
              <div className="flex-1 min-h-[320px] border border-gray-200 rounded-md px-4 py-3 overflow-y-auto bg-gray-50/30">
                {content.trim() ? (
                  <MarkdownContent content={content} />
                ) : (
                  <div className="text-sm text-gray-400 italic">미리볼 내용이 없습니다.</div>
                )}
              </div>
            )}
            <div className="text-xs text-gray-400 mt-2">
              Markdown 지원: # 제목, **굵게**, *기울임*, - 리스트, `코드`, &gt; 인용, - [ ] 체크박스
            </div>
          </div>
          <div className="flex justify-end gap-2 px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700"
            >
              {editingMemo ? 'Save' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
