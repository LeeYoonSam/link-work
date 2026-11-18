import { useEffect, useState } from 'react'
import { useMeetingNotesStore } from '../../stores/meetingNotesStore'
import type { MeetingNoteFilter } from '../../types'
import MeetingNoteList from './MeetingNoteList'
import MeetingNoteDoc from './MeetingNoteDoc'
import { EmptyState } from '../ui'

const KINDS: { id: NonNullable<MeetingNoteFilter['kind']>; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'meeting', label: '회의' },
  { id: 'interview', label: '면접' }
]

export default function MeetingNotesView(): React.ReactNode {
  const { filter, setFilter, fetch, selectedId, select } = useMeetingNotesStore()
  const [query, setQuery] = useState(filter.q ?? '')

  useEffect(() => {
    fetch()
    // 메뉴 재진입 시 선택된 회의록 상세를 다시 불러온다
    if (selectedId !== null) select(selectedId)
  }, [])

  // 검색어 디바운스 200ms
  useEffect(() => {
    if (query === (filter.q ?? '')) return
    const t = setTimeout(() => setFilter({ q: query }), 200)
    return () => clearTimeout(t)
  }, [query])

  return (
    <div className="flex h-full gap-0 min-h-0">
      <div className="flex flex-col w-80 shrink-0 border-r border-gray-200 bg-white">
        <div className="px-4 py-3 border-b border-gray-100 space-y-2">
          <span className="text-sm font-semibold text-gray-800">회의록</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="제목·요약 검색"
            className="w-full px-2.5 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:border-blue-400"
          />
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setFilter({ kind: k.id })}
                  className={`px-2 py-1 text-xs rounded-md transition-colors ${
                    (filter.kind ?? 'all') === k.id
                      ? 'bg-gray-900 text-white'
                      : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <MeetingNoteList />
        </div>
      </div>
      <div className="flex-1 min-w-0 overflow-y-auto bg-white">
        {selectedId === null ? (
          <EmptyState>왼쪽 목록에서 회의록을 선택하세요</EmptyState>
        ) : (
          <MeetingNoteDoc />
        )}
      </div>
    </div>
  )
}
