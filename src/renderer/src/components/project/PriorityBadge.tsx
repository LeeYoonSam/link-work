import type { ProjectPriority } from '../../types'
import { Badge, DropdownMenu, projectPriority, type DropdownItem, type PriorityStyle } from '../ui'

// 드롭다운에 나오는 순서. 미지정(null)은 레벨이 아니라 "해제"라서 맨 뒤에 둔다.
const OPTIONS: (ProjectPriority | null)[] = ['now', 'next', 'later', null]

export function priorityStyleOf(priority: ProjectPriority | null | undefined): PriorityStyle {
  return projectPriority[priority ?? 'none']
}

/**
 * 프로젝트 우선순위 뱃지.
 *
 * onChange를 주면 눌러서 레벨을 바꾸는 드롭다운이 열린다. 목록 카드 위에 놓이므로
 * 클릭이 카드의 상세 열기까지 번지지 않아야 하는데, 그 처리는 DropdownMenu가 맡는다.
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

  const items: DropdownItem[] = OPTIONS.map((option) => {
    const optionStyle = priorityStyleOf(option)
    return {
      key: option ?? 'none',
      label: optionStyle.label,
      selected: option === priority,
      leading: (
        <>
          <span className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${optionStyle.dot}`} />
          <span aria-hidden="true" className="w-6 text-[8px] tracking-tighter text-gray-400">
            {optionStyle.marks}
          </span>
        </>
      ),
      onSelect: () => {
        if (option !== priority) onChange(option)
      }
    }
  })

  return (
    <DropdownMenu
      items={items}
      width="w-40"
      trigger={({ toggle }) => (
        <Badge color={style.badge} size={size} title="우선순위 변경" onClick={toggle}>
          {label}
        </Badge>
      )}
    />
  )
}
