// 태그 관리 패널. 할 일 화면 도구줄 아래에 펼쳐진다. Esc 로 닫는다(태그 이름을 고치는 중이면 고치기만 취소한다).
// 삭제는 그 자리에서 한 번 더 눌러 확인한다
import { useEffect, useRef, useState } from 'react'
import { useTodoStore } from '../../stores/todoStore'
import type { TodoTag } from '../../types'
import { Card, EmptyState, IconButton, PencilIcon, TrashIcon, XIcon, button } from '../ui'

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
  const [deletingId, setDeletingId] = useState<number | null>(null)

  // Esc: 고치는 중·삭제 확인 중이면 그것만 취소하고, 아니면 패널을 닫는다
  const escRef = useRef<() => void>(() => {})
  escRef.current = (): void => {
    if (editingTag) setEditingTag(null)
    else if (deletingId !== null) setDeletingId(null)
    else onClose()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      escRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleCreate = async (): Promise<void> => {
    if (!newName.trim()) return
    await createTag({ name: newName.trim(), color: newColor })
    setNewName('')
    setNewColor('#3B82F6')
  }

  const startEdit = (tag: TodoTag): void => {
    setDeletingId(null)
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
    setDeletingId(null)
    await deleteTag(tag.id)
  }

  return (
    <Card padding="none">
      <section aria-labelledby="tag-manager-title" className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 id="tag-manager-title" className="text-sm font-semibold text-gray-700">태그 관리</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            title="닫기 (Esc)"
            aria-label="태그 관리 닫기"
          >
            <XIcon size={14} />
          </button>
        </div>

        <div className="mb-3">
          <div className="mb-2 flex gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="새 태그 이름"
              aria-label="새 태그 이름"
              className="min-w-0 flex-1 rounded-md border border-gray-200 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && handleCreate()}
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={!newName.trim()}
              className={`px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${button.primary}`}
            >
              추가
            </button>
          </div>
          <div className="flex gap-1.5">
            {presetColors.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`색 ${color}`}
                onClick={() => setNewColor(color)}
                className={`h-5 w-5 rounded-full transition-transform ${
                  newColor === color ? 'scale-110 ring-2 ring-blue-500 ring-offset-2' : ''
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>

        <div className="max-h-64 space-y-1 overflow-auto">
          {tags.length === 0 ? (
            <EmptyState compact>태그가 없어요</EmptyState>
          ) : (
            tags.map((tag) => (
              <div key={tag.id} className="flex items-center gap-2 rounded-md p-1.5 hover:bg-gray-50">
                {editingTag?.id === tag.id ? (
                  <>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      aria-label="태그 이름"
                      className="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                      autoFocus
                      onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && handleUpdate()}
                    />
                    <div className="flex gap-1">
                      {presetColors.map((color) => (
                        <button
                          key={color}
                          type="button"
                          aria-label={`색 ${color}`}
                          onClick={() => setEditColor(color)}
                          className={`h-4 w-4 rounded-full ${
                            editColor === color ? 'ring-2 ring-blue-500 ring-offset-1' : ''
                          }`}
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                    <button type="button" onClick={handleUpdate} className="text-xs text-blue-600 hover:text-blue-700">
                      저장
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingTag(null)}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      취소
                    </button>
                  </>
                ) : deletingId === tag.id ? (
                  <>
                    <span className="min-w-0 flex-1 break-keep text-sm text-gray-700">
                      &lsquo;{tag.name}&rsquo; 태그를 지울까요? 연결된 할 일에서 빠져요.
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDelete(tag)}
                      className={`px-2 py-1 text-xs font-medium ${button.danger}`}
                    >
                      삭제
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeletingId(null)}
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      취소
                    </button>
                  </>
                ) : (
                  <>
                    <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                    <span className="flex-1 text-sm text-gray-700">{tag.name}</span>
                    <IconButton title="수정" onClick={() => startEdit(tag)}>
                      <PencilIcon size={14} />
                    </IconButton>
                    <IconButton tone="danger" title="삭제" onClick={() => setDeletingId(tag.id)}>
                      <TrashIcon size={14} />
                    </IconButton>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </Card>
  )
}
