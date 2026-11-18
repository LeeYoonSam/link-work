// 프로젝트 보드 전용 작은 조각: 유형 아이콘, 상태 배지, 우선순위 점, 3구간 막대.
// 공용 ui/ 에 없는 것만 여기 둔다.
import type { ReactNode } from 'react'
import { Badge, Tooltip } from '../ui'
import {
  issueTypeKind,
  priorityVisual,
  statusVisual,
  type CategoryCounts,
  type IssueLevel,
  type IssueTypeKind
} from './boardModel'

function Svg({ size = 14, className = '', children }: { size?: number; className?: string; children: ReactNode }): React.ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  )
}

export function ExternalLinkIcon({ size = 12, className = '' }: { size?: number; className?: string }): React.ReactNode {
  return (
    <Svg size={size} className={className}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Svg>
  )
}

export function RefreshIcon({ size = 14, className = '' }: { size?: number; className?: string }): React.ReactNode {
  return (
    <Svg size={size} className={className}>
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
      <path d="M3 21v-5h5" />
      <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
      <path d="M21 3v5h-5" />
    </Svg>
  )
}

// 유형별 모양과 색. Jira 공식 아이콘은 베끼지 않는다. 빨강은 마감 뜻만 가지므로 버그는 주황이다
const TYPE_STYLE: Record<IssueTypeKind, { color: string; path: ReactNode }> = {
  epic: { color: 'text-purple-500', path: <path d="M12 2 22 12 12 22 2 12Z" /> },
  story: { color: 'text-green-600', path: <path d="M6 3h12v18l-6-4-6 4Z" /> },
  task: {
    color: 'text-blue-600',
    path: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="m8 12 3 3 5-6" />
      </>
    )
  },
  bug: {
    color: 'text-orange-600',
    path: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="3" />
      </>
    )
  },
  subtask: { color: 'text-gray-500', path: <path d="M12 6 18 12 12 18 6 12Z" /> },
  other: { color: 'text-gray-400', path: <rect x="4" y="4" width="16" height="16" rx="3" /> }
}

/** 유형 아이콘. 이름은 aria-label 과 툴팁으로 준다 */
export function IssueTypeIcon({ level, typeName }: { level: IssueLevel; typeName: string }): React.ReactNode {
  const s = TYPE_STYLE[issueTypeKind(level, typeName)]
  return (
    <span role="img" aria-label={typeName} title={typeName} className={`inline-flex flex-shrink-0 ${s.color}`}>
      <Svg size={14}>{s.path}</Svg>
    </span>
  )
}

/** 상태 배지: 카테고리 색 + 도트 모양(○◐●) + 세부 상태명. 범위 밖 조상은 흐리게 */
export function JiraStatusBadge({
  status,
  category,
  dimmed = false,
  size = 'xs'
}: {
  status: string
  category: string
  dimmed?: boolean
  size?: 'sm' | 'xs'
}): React.ReactNode {
  const v = statusVisual(category)
  return (
    <span className={dimmed ? 'opacity-50' : undefined} data-status-category={v.categoryLabel}>
      <Badge color={v.badge} size={size} title={dimmed ? `${v.categoryLabel} · 조회 범위 밖(백로그)` : v.categoryLabel}>
        <span aria-hidden className="mr-1">
          {v.shape}
        </span>
        {status}
      </Badge>
    </span>
  )
}

/** 우선순위 점(●●●/●●/●). 모르는 값이면 그리지 않는다 */
export function PriorityMarks({ priority }: { priority: string | null }): React.ReactNode {
  const v = priorityVisual(priority)
  if (!v) return null
  return (
    <span className={`text-[10px] tracking-tighter ${v.text}`} aria-label={`우선순위 ${v.label}`} title={`우선순위 ${v.label}`}>
      {v.marks}
    </span>
  )
}

/** 롤업 막대 설명 문장. 막대 aria-label 과 옆 텍스트가 같은 말을 한다 */
export function rollupText(c: CategoryCounts & { total: number }): string {
  return `${c.done}/${c.total} 완료 · 진행 ${c.indeterminate} · 할 일 ${c.new}`
}

/** 3구간 누적 막대(완료 초록 · 진행 파랑 · 할 일 회색). 색에만 기대지 않도록 옆에 숫자를 함께 쓴다 */
export function SegmentedBar({
  counts,
  height = 'h-1.5',
  className = 'w-32'
}: {
  counts: CategoryCounts
  height?: string
  className?: string
}): React.ReactNode {
  const total = counts.done + counts.indeterminate + counts.new
  const pct = (n: number): string => (total === 0 ? '0%' : `${(n / total) * 100}%`)
  return (
    <Tooltip content="조회 범위 기준(백로그 제외)" className="inline-flex" focusable={false}>
      <span
        role="img"
        aria-label={`${total}건 중 ${counts.done}건 완료, 진행 ${counts.indeterminate}, 할 일 ${counts.new}`}
        className={`flex overflow-hidden rounded-full bg-gray-100 ${height} ${className}`}
      >
        <span className="bg-green-500" style={{ width: pct(counts.done) }} />
        <span className="bg-blue-500" style={{ width: pct(counts.indeterminate) }} />
        <span className="bg-gray-300" style={{ width: pct(counts.new) }} />
      </span>
    </Tooltip>
  )
}

/**
 * fixVersion 칩. 누르면 릴리스 탭의 그 릴리스로 간다.
 * 트리 행 안에서는 행이 포커스를 가지므로 tabbable=false 로 탭 정지점을 만들지 않는다(상세 패널에서는 true).
 */
export function FixVersionChips({
  versions,
  onOpen,
  tabbable = true
}: {
  versions: { id: string; name: string }[]
  onOpen: (versionId: string) => void
  tabbable?: boolean
}): React.ReactNode {
  if (!versions || versions.length === 0) return null
  return (
    <>
      {versions.map((v) => (
        <button
          key={v.id}
          type="button"
          tabIndex={tabbable ? undefined : -1}
          title={`릴리스 ${v.name} 보기`}
          aria-label={`릴리스 ${v.name} 보기`}
          data-fix-version={v.id}
          onClick={(e) => {
            e.stopPropagation()
            onOpen(v.id)
          }}
          className="inline-flex items-center rounded px-1.5 text-[11px] font-mono bg-slate-100 text-slate-600 hover:bg-slate-200"
        >
          {v.name}
        </button>
      ))}
    </>
  )
}
