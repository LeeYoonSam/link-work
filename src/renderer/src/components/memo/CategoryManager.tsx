import { useState } from 'react'
import { useMemoStore } from '../../stores/memoStore'
import type { MemoCategory } from '../../types'
import { EmptyState, SectionTitle, button } from '../ui'

interface CategoryManagerProps {
  onClose: () => void
}

const presetColors = [
  '#EF4444', '#F97316', '#EAB308', '#22C55E', '#14B8A6',
  '#3B82F6', '#6366F1', '#8B5CF6', '#EC4899', '#6B7280'
]

export default function CategoryManager({ onClose }: CategoryManagerProps): React.ReactNode {
  const { categories, createCategory, updateCategory, deleteCategory } = useMemoStore()
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#3B82F6')
  const [editingCategory, setEditingCategory] = useState<MemoCategory | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')

  const handleCreate = async (): Promise<void> => {
    if (!newName.trim()) return
    try {
      await createCategory({ name: newName.trim(), color: newColor })
      setNewName('')
      setNewColor('#3B82F6')
    } catch (err) {
      alert('카테고리 생성에 실패했습니다. 이름이 중복되었을 수 있습니다.')
      console.error(err)
    }
  }

  const startEdit = (category: MemoCategory): void => {
    setEditingCategory(category)
    setEditName(category.name)
    setEditColor(category.color)
  }

  const handleUpdate = async (): Promise<void> => {
    if (!editingCategory || !editName.trim()) return
    try {
      await updateCategory(editingCategory.id, { name: editName.trim(), color: editColor })
      setEditingCategory(null)
    } catch (err) {
      alert('카테고리 수정에 실패했습니다. 이름이 중복되었을 수 있습니다.')
      console.error(err)
    }
  }

  const handleDelete = async (category: MemoCategory): Promise<void> => {
    if (
      confirm(
        `"${category.name}" 카테고리를 삭제하시겠습니까?\n해당 카테고리에 속한 메모는 "미분류"로 이동됩니다.`
      )
    ) {
      await deleteCategory(category.id)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <SectionTitle variant="page" className="mb-4">카테고리 관리</SectionTitle>

          <div className="mb-4">
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="새 카테고리 이름"
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
            <div className="flex gap-1.5 flex-wrap">
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
            {categories.length === 0 ? (
              <EmptyState compact>카테고리가 없습니다</EmptyState>
            ) : (
              categories.map((category) => (
                <div
                  key={category.id}
                  className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-50"
                >
                  {editingCategory?.id === category.id ? (
                    <>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="flex-1 min-w-0 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                        autoFocus
                        onKeyDown={(e) => e.key === 'Enter' && handleUpdate()}
                      />
                      <div className="flex gap-1 flex-wrap">
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
                        onClick={() => setEditingCategory(null)}
                        className="text-xs text-gray-400 hover:text-gray-600"
                      >
                        취소
                      </button>
                    </>
                  ) : (
                    <>
                      <span
                        className="w-4 h-4 rounded-full flex-shrink-0"
                        style={{ backgroundColor: category.color }}
                      />
                      <span className="flex-1 text-sm text-gray-700 truncate">{category.name}</span>
                      <button
                        onClick={() => startEdit(category)}
                        className="text-gray-400 hover:text-blue-500 transition-colors text-sm"
                        title="수정"
                      >
                        ✏️
                      </button>
                      <button
                        onClick={() => handleDelete(category)}
                        className="text-gray-400 hover:text-red-500 transition-colors text-sm"
                        title="삭제"
                      >
                        🗑️
                      </button>
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
