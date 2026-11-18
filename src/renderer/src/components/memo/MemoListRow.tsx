import type { MemoCategory } from '../../types'
import { FOCUS_RING_CLASS, focusDomId, useFocusScroll } from '../../hooks/useFocusFlash'
import { StarIcon } from '../ui'
import HighlightedText from './HighlightedText'
import CategoryBadge from './CategoryBadge'
import { formatDbTime, formatRelative, isValidDate, parseDbTime } from './memoText'
import type { MemoListItem } from './memoSearch'

export interface MemoListRowProps {
  item: MemoListItem
  category: MemoCategory | null
  selected: boolean
  // 전체·중요·최근 본·검색 결과에서만 분류 배지를 보인다. 특정 분류 안에서는 뺀다
  showCategory: boolean
  // 앱 내 링크로 찾아온 행이면 true. 강조하고 가운데로 스크롤한다
  flashed?: boolean
  now: Date
  onSelect: (id: number) => void
  onToggleImportant?: (id: number) => void
}

// 시각 툴팁: 수정·작성 절대 시각
export function memoTimeTitle(created: string, updated: string): string {
  const c = formatDbTime(created, 'yyyy-MM-dd HH:mm')
  if (updated === created) return `작성 ${c}`
  return `수정 ${formatDbTime(updated, 'yyyy-MM-dd HH:mm')} · 작성 ${c}`
}

// 메모 목록 한 행: ★ + 제목 + 상대 수정 시각 / 본문 발췌 2줄 / 분류 배지
export default function MemoListRow({
  item,
  category,
  selected,
  showCategory,
  flashed = false,
  now,
  onSelect,
  onToggleImportant
}: MemoListRowProps): React.ReactNode {
  const { memo } = item
  const isImportant = memo.is_important === 1
  const isArchived = memo.is_archived === 1
  const ref = useFocusScroll<HTMLDivElement>(flashed)
  const updated = parseDbTime(memo.updated_at)

  return (
    <div
      ref={ref}
      id={focusDomId('memo', memo.id)}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onClick={() => onSelect(memo.id)}
      className={`group relative cursor-pointer px-3 py-2.5 border-b border-gray-100 border-l-[3px] transition-colors ${
        selected ? 'bg-blue-50 border-l-blue-600' : 'border-l-transparent hover:bg-gray-50'
      } ${isArchived ? 'opacity-60' : ''} ${flashed ? FOCUS_RING_CLASS : ''}`}
    >
      <div className="flex items-start gap-1.5">
        {isImportant ? (
          <span className="flex-shrink-0 mt-0.5 text-amber-400" title="중요">
            <StarIcon size={13} filled />
            <span className="sr-only">중요</span>
          </span>
        ) : null}
        <span
          className={`flex-1 min-w-0 truncate text-sm ${selected ? 'font-semibold text-gray-900' : 'font-medium text-gray-800'}`}
        >
          <HighlightedText text={item.title} ranges={item.titleRanges} />
        </span>
        <time
          dateTime={isValidDate(updated) ? updated.toISOString() : undefined}
          title={memoTimeTitle(memo.created_at, memo.updated_at)}
          className={`flex-shrink-0 text-[11px] text-gray-400 tabular-nums whitespace-nowrap mt-0.5 ${
            onToggleImportant && !isArchived ? 'group-hover:invisible' : ''
          }`}
        >
          {formatRelative(updated, now)}
        </time>
      </div>
      {item.excerpt.text ? (
        <p className="mt-0.5 text-xs text-gray-500 line-clamp-2 break-all">
          <HighlightedText text={item.excerpt.text} ranges={item.excerpt.ranges} />
        </p>
      ) : null}
      {showCategory || isArchived ? (
        <div className="mt-1 flex items-center gap-1.5">
          {showCategory ? <CategoryBadge category={category} /> : null}
          {isArchived ? (
            <span className="text-[11px] text-gray-500 rounded-full bg-gray-100 px-1.5 py-0.5">보관됨</span>
          ) : null}
        </div>
      ) : null}
      {onToggleImportant && !isArchived ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={isImportant ? '중요 해제' : '중요 표시'}
          title={isImportant ? '중요 해제' : '중요 표시'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleImportant(memo.id)
          }}
          className={`absolute right-2 top-1.5 p-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-amber-50 ${
            isImportant ? 'text-amber-400' : 'text-gray-300 hover:text-amber-400'
          }`}
        >
          <StarIcon size={14} filled={isImportant} />
        </button>
      ) : null}
    </div>
  )
}
