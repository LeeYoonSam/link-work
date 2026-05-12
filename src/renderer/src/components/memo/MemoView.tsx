import { useEffect, useMemo, useState } from 'react'
import { useMemoStore } from '../../stores/memoStore'
import MemoCard from './MemoCard'
import MemoForm from './MemoForm'
import MemoViewer from './MemoViewer'
import type { Memo } from '../../types'

export default function MemoView(): React.ReactNode {
  const {
    memos,
    archivedMemos,
    showArchived,
    sortOrder,
    setShowArchived,
    setSortOrder,
    fetchMemos,
    fetchArchivedMemos,
    archiveMemo,
    restoreMemo,
    toggleImportant,
    deleteMemo
  } = useMemoStore()

  const [showForm, setShowForm] = useState(false)
  const [editingMemo, setEditingMemo] = useState<Memo | null>(null)
  const [viewingMemo, setViewingMemo] = useState<Memo | null>(null)

  useEffect(() => {
    fetchMemos()
    fetchArchivedMemos()
  }, [])

  const handleEdit = (memo: Memo): void => {
    setViewingMemo(null)
    setEditingMemo(memo)
    setShowForm(true)
  }

  const handleCloseForm = (): void => {
    setShowForm(false)
    setEditingMemo(null)
  }

  const currentMemos = useMemo(() => {
    const list = showArchived ? archivedMemos : memos
    const sorted = [...list].sort((a, b) => {
      const aTime = new Date(a.created_at).getTime()
      const bTime = new Date(b.created_at).getTime()
      return sortOrder === 'newest' ? bTime - aTime : aTime - bTime
    })
    return sorted
  }, [showArchived, memos, archivedMemos, sortOrder])

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-bold text-gray-900">Memos</h2>
        <div className="flex items-center gap-3">
          <div className="flex bg-gray-100 rounded-md p-0.5">
            <button
              onClick={() => setShowArchived(false)}
              className={`px-3 py-1.5 text-xs rounded font-medium transition-colors ${
                !showArchived ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Active ({memos.length})
            </button>
            <button
              onClick={() => setShowArchived(true)}
              className={`px-3 py-1.5 text-xs rounded font-medium transition-colors ${
                showArchived ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              History ({archivedMemos.length})
            </button>
          </div>
          <div className="flex bg-gray-100 rounded-md p-0.5">
            <button
              onClick={() => setSortOrder('newest')}
              className={`px-3 py-1.5 text-xs rounded font-medium transition-colors ${
                sortOrder === 'newest'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              title="최신순 정렬"
            >
              최신순
            </button>
            <button
              onClick={() => setSortOrder('oldest')}
              className={`px-3 py-1.5 text-xs rounded font-medium transition-colors ${
                sortOrder === 'oldest'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              title="오래된순 정렬"
            >
              오래된순
            </button>
          </div>
          {!showArchived && (
            <button
              onClick={() => setShowForm(true)}
              className="px-4 py-2 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700"
            >
              + New Memo
            </button>
          )}
        </div>
      </div>

      {currentMemos.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-3">{showArchived ? '📦' : '📝'}</div>
          <p className="text-sm">
            {showArchived
              ? 'No archived memos.'
              : 'No memos yet. Create your first memo.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {currentMemos.map((memo) => (
            <MemoCard
              key={memo.id}
              memo={memo}
              isArchived={showArchived}
              onClick={setViewingMemo}
              onEdit={handleEdit}
              onArchive={archiveMemo}
              onRestore={restoreMemo}
              onDelete={deleteMemo}
              onToggleImportant={toggleImportant}
            />
          ))}
        </div>
      )}

      {showForm && <MemoForm onClose={handleCloseForm} editingMemo={editingMemo} />}

      {viewingMemo && (
        <MemoViewer
          memo={viewingMemo}
          onClose={() => setViewingMemo(null)}
          onEdit={!showArchived ? handleEdit : undefined}
        />
      )}
    </div>
  )
}
