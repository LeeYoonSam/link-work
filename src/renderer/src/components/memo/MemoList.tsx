import type { ReactNode } from 'react'
import type { MemoCategory } from '../../types'
import MemoListRow from './MemoListRow'
import type { MemoListItem } from './memoSearch'

export interface MemoListSection {
  key: string
  // null 이면 머리 없이 그린다
  label: string | null
  items: MemoListItem[]
}

export interface MemoListProps {
  listboxId: string
  sections: MemoListSection[]
  selectedId: number | null
  flashId: number | null
  categoryOf: (categoryId: number | null) => MemoCategory | null
  showCategory: boolean
  now: Date
  onSelect: (id: number) => void
  onToggleImportant?: (id: number) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
  listRef?: React.Ref<HTMLDivElement>
  empty?: ReactNode
}

// 메모 목록 listbox. 행은 option 이고 선택은 aria-selected 와 왼쪽 막대로 보인다
export default function MemoList({
  listboxId,
  sections,
  selectedId,
  flashId,
  categoryOf,
  showCategory,
  now,
  onSelect,
  onToggleImportant,
  onKeyDown,
  listRef,
  empty
}: MemoListProps): React.ReactNode {
  const total = sections.reduce((n, s) => n + s.items.length, 0)
  const activeId = selectedId !== null ? `memo-${selectedId}` : undefined
  return (
    <div
      id={listboxId}
      ref={listRef}
      role="listbox"
      aria-label="메모 목록"
      aria-activedescendant={total > 0 ? activeId : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex-1 min-h-0 overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
    >
      {total === 0
        ? empty
        : sections.map((s) =>
            s.items.length === 0 ? null : (
              <div key={s.key} role="group" aria-label={s.label ?? undefined}>
                {s.label ? (
                  <div
                    role="presentation"
                    className="sticky top-0 z-10 bg-white/95 px-3 pt-2 pb-1 text-[11px] font-medium text-gray-400 uppercase tracking-wide border-b border-gray-100"
                  >
                    {s.label}
                  </div>
                ) : null}
                {s.items.map((item) => (
                  <MemoListRow
                    key={item.memo.id}
                    item={item}
                    category={categoryOf(item.memo.category_id)}
                    selected={item.memo.id === selectedId}
                    showCategory={showCategory}
                    flashed={item.memo.id === flashId}
                    now={now}
                    onSelect={onSelect}
                    onToggleImportant={onToggleImportant}
                  />
                ))}
              </div>
            )
          )}
    </div>
  )
}
