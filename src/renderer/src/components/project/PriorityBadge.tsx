import { useEffect, useRef, useState } from 'react'
import type { ProjectPriority } from '../../types'
import { Badge, projectPriority, type PriorityStyle } from '../ui'

// 드롭다운에 나오는 순서. 미지정(null)은 레벨이 아니라 "해제"라서 맨 뒤에 둔다.
const OPTIONS: (ProjectPriority | null)[] = ['now', 'next', 'later', null]

export function priorityStyleOf(priority: ProjectPriority | null | undefined): PriorityStyle {
  return projectPriority[priority ?? 'none']
}

/**
 * 프로젝트 우선순위 뱃지.
 *
 * onChange를 주면 눌러서 레벨을 바꾸는 드롭다운이 열린다. 목록 카드 위에 놓이므로
 * 클릭이 카드의 상세 열기까지 번지지 않게 래퍼에서 전파를 끊는다.
 */
export default function PriorityBadge({
  priority,
  onChange,
  size = 'sm'
}: {
  priority: ProjectPriority | null
  onChange?: (p: ProjectPriority | null) => void
  size?: 'sm' | 'xs'
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  // 바깥을 누르면 닫는다. 목록에 뱃지가 여러 개라 다른 뱃지를 눌렀을 때도 이 경로로 닫힌다.
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const style = priorityStyleOf(priority)
  const label = (
    <>
      <span aria-hidden="true" className="mr-1 text-[8px] leading-none tracking-tighter">
        {style.marks}
      </span>
      {style.label}
    </>
  )

  if (!onChange) {
    return (
      <Badge color={style.badge} size={size}>
        {label}
      </Badge>
    )
  }

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <Badge
        color={style.badge}
        size={size}
        title="우선순위 변경"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        {label}
      </Badge>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-40 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
        >
          {OPTIONS.map((option) => {
            const optionStyle = priorityStyleOf(option)
            const selected = option === priority
            return (
              <button
                key={option ?? 'none'}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                  if (!selected) onChange(option)
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50 ${
                  selected ? 'font-semibold text-gray-900' : 'text-gray-600'
                }`}
              >
                <span
                  className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${optionStyle.dot}`}
                />
                <span aria-hidden="true" className="w-6 text-[8px] tracking-tighter text-gray-400">
                  {optionStyle.marks}
                </span>
                <span className="truncate">{optionStyle.label}</span>
                {selected && <span className="ml-auto text-blue-600">✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
