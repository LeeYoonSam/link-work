import { ArchiveIcon, ChevronDownIcon, DropdownMenu, StarIcon, type DropdownItem } from '../ui'
import type { RailItem, RailKey } from './memoSearch'
import { ChevronLeftIcon, ClockIcon, SettingsIcon } from './memoIcons'

const FOCUS_VISIBLE = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'

function RailLeading({ item }: { item: RailItem }): React.ReactNode {
  if (item.key === 'important') return <StarIcon size={13} className="text-amber-400" filled />
  if (item.key === 'recent') return <ClockIcon size={13} className="text-gray-400" />
  if (item.key === 'archived') return <ArchiveIcon size={13} className="text-gray-400" />
  if (item.key === 'all') return <span aria-hidden className="inline-block w-[13px]" />
  return (
    <span
      aria-hidden
      className={`inline-block w-2 h-2 mx-[2.5px] rounded-full flex-shrink-0 ${item.color ? '' : 'border border-gray-400'}`}
      style={item.color ? { backgroundColor: item.color } : undefined}
    />
  )
}

function railItemLabel(item: RailItem): string {
  return item.count === null ? item.label : `${item.label} ${item.count}`
}

interface MemoRailProps {
  items: RailItem[]
  selected: RailKey
  // 검색 중이면 레일은 범위를 정하지 않는다. 흐리게 보여 "지금은 전체 검색"임을 알린다
  dimmed: boolean
  onSelect: (key: RailKey) => void
  onManageCategories: () => void
  onCollapse?: () => void
}

// 분류 레일: 전체·중요·최근 본 / 분류(개수) / 보관함 / 분류 관리
export default function MemoRail({
  items,
  selected,
  dimmed,
  onSelect,
  onManageCategories,
  onCollapse
}: MemoRailProps): React.ReactNode {
  const groups: RailItem['group'][] = ['smart', 'category', 'archive']
  return (
    <nav aria-label="메모 분류" className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">분류</span>
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            title="분류 레일 접기"
            aria-label="분류 레일 접기"
            className={`p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 ${FOCUS_VISIBLE}`}
          >
            <ChevronLeftIcon size={14} />
          </button>
        ) : null}
      </div>
      {dimmed ? <p className="px-3 pb-1 text-[11px] text-blue-600">검색 중 · 전체 대상</p> : null}
      <div className={`flex-1 min-h-0 overflow-y-auto px-1.5 pb-2 ${dimmed ? 'opacity-50' : ''}`}>
        {groups.map((g, gi) => (
          <ul key={g} className={gi > 0 ? 'mt-1.5 pt-1.5 border-t border-gray-100' : ''}>
            {items
              .filter((it) => it.group === g)
              .map((it) => {
                const active = it.key === selected
                const empty = it.count === 0
                return (
                  <li key={String(it.key)}>
                    <button
                      type="button"
                      onClick={() => onSelect(it.key)}
                      aria-current={active ? 'true' : undefined}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-sm transition-colors ${FOCUS_VISIBLE} ${
                        active
                          ? 'bg-gray-100 text-gray-900 font-medium'
                          : empty
                            ? 'text-gray-400 hover:bg-gray-50'
                            : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                      }`}
                    >
                      <RailLeading item={it} />
                      <span className="flex-1 min-w-0 truncate">{it.label}</span>
                      {it.count !== null ? (
                        <span className="text-xs text-gray-400 tabular-nums">{it.count}</span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
          </ul>
        ))}
      </div>
      <div className="border-t border-gray-100 p-1.5">
        <button
          type="button"
          onClick={onManageCategories}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-800 ${FOCUS_VISIBLE}`}
        >
          <SettingsIcon size={13} />
          분류 관리
        </button>
      </div>
    </nav>
  )
}

// 2단 이하 레이아웃에서 레일 대신 쓰는 분류 드롭다운
export function MemoRailDropdown({
  items,
  selected,
  onSelect,
  onManageCategories
}: {
  items: RailItem[]
  selected: RailKey
  onSelect: (key: RailKey) => void
  onManageCategories: () => void
}): React.ReactNode {
  const current = items.find((it) => it.key === selected) ?? items[0]
  const menu: DropdownItem[] = items.map((it, i) => ({
    key: String(it.key),
    label: railItemLabel(it),
    leading: <RailLeading item={it} />,
    selected: it.key === selected,
    separatorBefore: i > 0 && items[i - 1].group !== it.group,
    onSelect: () => onSelect(it.key)
  }))
  menu.push({
    key: '__manage',
    label: '분류 관리',
    leading: <SettingsIcon size={13} />,
    separatorBefore: true,
    onSelect: onManageCategories
  })
  return (
    <DropdownMenu
      align="left"
      width="w-52"
      items={menu}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 max-w-[11rem] ${FOCUS_VISIBLE}`}
        >
          <span className="text-gray-400">분류:</span>
          <span className="truncate font-medium text-gray-800">{current ? current.label : '전체'}</span>
          <ChevronDownIcon size={12} />
        </button>
      )}
    />
  )
}
