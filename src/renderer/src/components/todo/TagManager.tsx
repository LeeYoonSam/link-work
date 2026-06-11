import { useState } from 'react'
import { useTodoStore } from '../../stores/todoStore'
import type { TodoTag } from '../../types'
import { EmptyState, IconButton, PencilIcon, SectionTitle, TrashIcon, button } from '../ui'

interface TagManagerProps {
  onClose: () => void
}

const presetColors = [
  '#EF4444', '#F97316', '#EAB308', '#22C55E', '#14B8A6',
  '#3B82F6', '#6366F1', '#8B5CF6', '#EC4899', '#6B7280'
]

export default function TagManager({ onClose }: TagManagerProps): React.ReactNode {
  const { tags, createTag, updateTag, deleteTag } = useTodoStore()
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#3B82F6')
  const [editingTag, setEditingTag] = useState<TodoTag | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')

  const handleCreate = async (): Promise<void> => {
    if (!newName.trim()) return
    await createTag({ name: newName.trim(), color: newColor })
    setNewName('')
    setNewColor('#3B82F6')
  }

  const startEdit = (tag: TodoTag): void => {
    setEditingTag(tag)
    setEditName(tag.name)
    setEditColor(tag.color)
  }

  const handleUpdate = async (): Promise<void> => {
    if (!editingTag || !editName.trim()) return
    await updateTag(editingTag.id, { name: editName.trim(), color: editColor })
    setEditingTag(null)
  }

  const handleDelete = async (tag: TodoTag): Promise<void> => {
    if (confirm(`"${tag.name}" 태그를 삭제하시겠습니까? 연결된 TODO에서 제거됩니다.`)) {
      await deleteTag(tag.id)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="p-6">
          <SectionTitle variant="page" className="mb-4">태그 관리</SectionTitle>

          <div className="mb-4">
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="새 태그 이름"
                className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                className={`px-4 py-2 text-sm font-medium disabled:opacity-40 ${button.primary}`}
              >
                추가
              </button>
            </div>
            <div className="flex gap-1.5">
              {presetColors.map((color) => (
                <button
                  key={color}
                  onClick={() => setNewColor(color)}
                  className={`w-6 h-6 rounded-full transition-transform ${
                    newColor === color ? 'ring-2 ring-offset-2 ring-blue-500 scale-110' : ''
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2 max-h-64 overflow-auto">
            {tags.length === 0 ? (
              <EmptyState compact>태그가 없습니다</EmptyState>
            ) : (
              tags.map((tag) => (
                <div key={tag.id} className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-50">
                  {editingTag?.id === tag.id ? (
                    <>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                        autoFocus
                        onKeyDown={(e) => e.key === 'Enter' && handleUpdate()}
                      />
                      <div className="flex gap-1">
                        {presetColors.map((color) => (
                          <button
                            key={color}
                            onClick={() => setEditColor(color)}
                            className={`w-4 h-4 rounded-full ${
                              editColor === color ? 'ring-2 ring-offset-1 ring-blue-500' : ''
                            }`}
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>
                      <button
                        onClick={handleUpdate}
                        className="text-xs text-blue-500 hover:text-blue-700"
                      >
                        저장
                      </button>
                      <button
                        onClick={() => setEditingTag(null)}
                        className="text-xs text-gray-400 hover:text-gray-600"
                      >
                        취소
                      </button>
                    </>
                  ) : (
                    <>
                      <span
                        className="w-4 h-4 rounded-full flex-shrink-0"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="flex-1 text-sm text-gray-700">{tag.name}</span>
                      <IconButton
                        title="수정"
                        onClick={() => startEdit(tag)}
                      >
                        <PencilIcon size={14} />
                      </IconButton>
                      <IconButton
                        tone="danger"
                        title="삭제"
                        onClick={() => handleDelete(tag)}
                      >
                        <TrashIcon size={14} />
                      </IconButton>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex justify-end px-6 py-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className={`px-4 py-2 text-sm font-medium ${button.subtle}`}
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}
