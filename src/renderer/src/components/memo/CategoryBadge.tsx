import type { MemoCategory } from '../../types'

// 분류 배지: 중립 회색 필 + 분류 색 점. 분류 hex 색은 점에만 쓴다(파스텔 원칙).
// 이름을 글자로 함께 적어 색에만 의존하지 않는다
export default function CategoryBadge({
  category,
  size = 'xs'
}: {
  category: MemoCategory | null
  size?: 'xs' | 'sm'
}): React.ReactNode {
  const sizeCls = size === 'xs' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-600 font-medium whitespace-nowrap max-w-full ${sizeCls}`}
    >
      <span
        aria-hidden
        className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${category ? '' : 'border border-gray-400'}`}
        style={category ? { backgroundColor: category.color } : undefined}
      />
      <span className="truncate">{category ? category.name : '미분류'}</span>
    </span>
  )
}
