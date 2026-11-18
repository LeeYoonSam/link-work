import type { CategoryKey, ScopeChip } from './memoSearch'

// 검색 결과를 분류로 좁히는 칩. 누르면 좁히고 다시 누르면 푼다
export default function MemoScopeChips({
  chips,
  selected,
  onToggle
}: {
  chips: ScopeChip[]
  selected: CategoryKey | null
  onToggle: (key: CategoryKey | null) => void
}): React.ReactNode {
  if (chips.length === 0) return null
  return (
    <div role="group" aria-label="분류로 좁히기" className="flex flex-wrap gap-1">
      {chips.map((c) => {
        const on = c.key === selected
        return (
          <button
            key={String(c.key)}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(on ? null : c.key)}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
              on
                ? 'bg-blue-50 border-blue-300 text-blue-700'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            <span
              aria-hidden
              className={`inline-block w-2 h-2 rounded-full ${c.color ? '' : 'border border-gray-400'}`}
              style={c.color ? { backgroundColor: c.color } : undefined}
            />
            {c.label}
            <span className="tabular-nums text-gray-400">{c.count}</span>
            {on ? <span aria-hidden>✓</span> : null}
          </button>
        )
      })}
    </div>
  )
}
