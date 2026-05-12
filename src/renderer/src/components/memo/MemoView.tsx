import { useEffect, useMemo, useState } from 'react'
import { useMemoStore } from '../../stores/memoStore'
import MemoCard from './MemoCard'
import MemoForm from './MemoForm'
import MemoViewer from './MemoViewer'
import CategoryManager from './CategoryManager'
import type { Memo, MemoCategory } from '../../types'

const UNCATEGORIZED_KEY = '__uncategorized__'

interface MemoGroup {
  key: string
  category: MemoCategory | null
  memos: Memo[]
}

export default function MemoView(): React.ReactNode {
  const {
    memos,
    archivedMemos,
    categories,
    showArchived,
    sortOrder,
    categoryFilter,
    setShowArchived,
    setSortOrder,
    setCategoryFilter,
    fetchMemos,
    fetchArchivedMemos,
    fetchCategories,
    archiveMemo,
    restoreMemo,
    toggleImportant,
    deleteMemo
  } = useMemoStore()

  const [showForm, setShowForm] = useState(false)
  const [showCategoryManager, setShowCategoryManager] = useState(false)
  const [editingMemo, setEditingMemo] = useState<Memo | null>(null)
  const [viewingMemo, setViewingMemo] = useState<Memo | null>(null)

  useEffect(() => {
    fetchMemos()
    fetchArchivedMemos()
    fetchCategories()
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

  const categoryMap = useMemo(() => {
    const map = new Map<number, MemoCategory>()
    categories.forEach((c) => map.set(c.id, c))
    return map
  }, [categories])

  const sortedMemos = useMemo(() => {
    const list = showArchived ? archivedMemos : memos
    return [...list].sort((a, b) => {
      const aTime = new Date(a.created_at).getTime()
      const bTime = new Date(b.created_at).getTime()
      return sortOrder === 'newest' ? bTime - aTime : aTime - bTime
    })
  }, [showArchived, memos, archivedMemos, sortOrder])

  const filteredMemos = useMemo(() => {
    if (categoryFilter === 'all') return sortedMemos
    if (categoryFilter === 'uncategorized') {
      return sortedMemos.filter((m) => m.category_id == null)
    }
    return sortedMemos.filter((m) => m.category_id === categoryFilter)
  }, [sortedMemos, categoryFilter])

  const groups = useMemo<MemoGroup[]>(() => {
    if (categoryFilter !== 'all') return []
    const buckets = new Map<string, MemoGroup>()
    // Seed in category sort order so empty buckets aren't shown but order is stable.
    categories.forEach((c) => {
      buckets.set(String(c.id), { key: String(c.id), category: c, memos: [] })
    })
    buckets.set(UNCATEGORIZED_KEY, { key: UNCATEGORIZED_KEY, category: null, memos: [] })

    filteredMemos.forEach((m) => {
      const key = m.category_id != null ? String(m.category_id) : UNCATEGORIZED_KEY
      const bucket = buckets.get(key) ?? buckets.get(UNCATEGORIZED_KEY)!
      bucket.memos.push(m)
    })

    return Array.from(buckets.values()).filter((g) => g.memos.length > 0)
  }, [filteredMemos, categories, categoryFilter])

  const totalActive = memos.length
  const totalArchived = archivedMemos.length
  const isEmpty = filteredMemos.length === 0

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-lg font-bold text-gray-900">Memos</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex bg-gray-100 rounded-md p-0.5">
            <button
              onClick={() => setShowArchived(false)}
              className={`px-3 py-1.5 text-xs rounded font-medium transition-colors ${
                !showArchived ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Active ({totalActive})
            </button>
            <button
              onClick={() => setShowArchived(true)}
              className={`px-3 py-1.5 text-xs rounded font-medium transition-colors ${
                showArchived ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              History ({totalArchived})
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
          <select
            value={
              categoryFilter === 'all'
                ? 'all'
                : categoryFilter === 'uncategorized'
                  ? 'uncategorized'
                  : String(categoryFilter)
            }
            onChange={(e) => {
              const v = e.target.value
              if (v === 'all') setCategoryFilter('all')
              else if (v === 'uncategorized') setCategoryFilter('uncategorized')
              else setCategoryFilter(Number(v))
            }}
            className="px-2 py-1.5 text-xs border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            title="카테고리 필터"
          >
            <option value="all">전체 (그룹화)</option>
            <option value="uncategorized">미분류</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowCategoryManager(true)}
            className="px-3 py-1.5 text-xs text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
            title="카테고리 관리"
          >
            카테고리 관리
          </button>
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

      {isEmpty ? (
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-3">{showArchived ? '📦' : '📝'}</div>
          <p className="text-sm">
            {showArchived
              ? 'No archived memos.'
              : categoryFilter === 'all'
                ? 'No memos yet. Create your first memo.'
                : '해당 카테고리에 메모가 없습니다.'}
          </p>
        </div>
      ) : categoryFilter === 'all' ? (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key}>
              <div className="flex items-center gap-2 mb-3">
                {group.category ? (
                  <>
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: group.category.color }}
                    />
                    <h3 className="text-sm font-semibold text-gray-800">{group.category.name}</h3>
                  </>
                ) : (
                  <>
                    <span className="w-2.5 h-2.5 rounded-full bg-gray-300" />
                    <h3 className="text-sm font-semibold text-gray-600">미분류</h3>
                  </>
                )}
                <span className="text-xs text-gray-400">({group.memos.length})</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {group.memos.map((memo) => (
                  <MemoCard
                    key={memo.id}
                    memo={memo}
                    category={memo.category_id != null ? categoryMap.get(memo.category_id) : null}
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
            </section>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {filteredMemos.map((memo) => (
            <MemoCard
              key={memo.id}
              memo={memo}
              category={memo.category_id != null ? categoryMap.get(memo.category_id) : null}
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

      {showCategoryManager && (
        <CategoryManager onClose={() => setShowCategoryManager(false)} />
      )}

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
