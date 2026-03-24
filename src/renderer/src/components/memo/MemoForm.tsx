import { useState } from 'react'
import { useMemoStore } from '../../stores/memoStore'
import type { Memo } from '../../types'

interface MemoFormProps {
  onClose: () => void
  editingMemo?: Memo | null
}

export default function MemoForm({ onClose, editingMemo }: MemoFormProps): React.ReactNode {
  const { createMemo, updateMemo } = useMemoStore()
  const [content, setContent] = useState(editingMemo?.content || '')

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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <h3 className="text-lg font-bold text-gray-900 mb-4">
          {editingMemo ? 'Edit Memo' : 'New Memo'}
        </h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              placeholder="Write your memo..."
              rows={6}
              autoFocus
              required
            />
          </div>
          <div className="flex justify-end gap-2">
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
