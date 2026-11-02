import type { DayTimeline, PlanItem, TimelineEntry } from '../../types'
import { Badge } from '../ui'
import { STATUS_LABEL, dayCountLabel, dueLabel, durationLabel, hhmmOf } from './PlanItemRow'

type BlockEntry = Extract<TimelineEntry, { kind: 'block' }>

// 배정 가능 블록의 최소 길이 (부록 B.2). 이보다 짧은 블록은 작게 그린다
export const SHORT_BLOCK_MIN = 30

// 배정 작업 줄의 보조 문구를 만든다.
// 이어서 배정한 블록은 '(이어서)', 마감 배정은 마감 표시, 집중 배정은 '상태 · n일째 · 마감' 이다
export function blockItemMeta(
  entry: Pick<BlockEntry, 'reason' | 'continued'>,
  item: Pick<PlanItem, 'status' | 'first_planned_date' | 'due_date'>,
  logicalDate: string
): string {
  if (entry.continued) return '(이어서)'
  const due = dueLabel(item.due_date, logicalDate)
  if (entry.reason === 'deadline') return due || '마감'
  const status = item.status === 'in_progress' ? STATUS_LABEL.in_progress : ''
  return [status, dayCountLabel(item.first_planned_date, logicalDate), due].filter(Boolean).join(' · ')
}

const timeRange = (e: Pick<TimelineEntry, 'start' | 'end'>): string =>
  `${hhmmOf(e.start) || e.start}–${hhmmOf(e.end) || e.end}`

function MeetingRow({ entry }: { entry: Extract<TimelineEntry, { kind: 'meeting' }> }): React.ReactNode {
  return (
    <li className="flex items-center gap-3 px-4 py-2 border-b border-gray-100 last:border-b-0">
      <span className="w-24 shrink-0 text-xs text-gray-500 tabular-nums">{timeRange(entry)}</span>
      <span className="min-w-0 truncate text-sm text-gray-600" title={entry.title}>
        <span className="text-purple-600">[회의]</span> {entry.title}
      </span>
    </li>
  )
}

function BlockRow({
  entry,
  item,
  logicalDate
}: {
  entry: BlockEntry
  item: PlanItem | null
  logicalDate: string
}): React.ReactNode {
  const short = entry.minutes < SHORT_BLOCK_MIN
  const tone =
    entry.state === 'past'
      ? 'opacity-50'
      : entry.state === 'current'
        ? 'bg-blue-50 border-l-2 border-l-blue-500'
        : ''
  const meta = item ? blockItemMeta(entry, item, logicalDate) : ''
  const deadline = entry.reason === 'deadline' && !entry.continued

  return (
    <li
      data-state={entry.state}
      className={`border-b border-gray-100 last:border-b-0 ${short ? 'px-4 py-1' : 'px-4 py-2'} ${tone}`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`w-24 shrink-0 tabular-nums ${short ? 'text-[11px] text-gray-400' : 'text-xs text-gray-700 font-medium'}`}
        >
          {timeRange(entry)}
        </span>
        <span className={short ? 'text-[11px] text-gray-400' : 'text-xs text-gray-500'}>
          {`빈 시간 ${durationLabel(entry.minutes)}`}
        </span>
        {entry.state === 'current' ? (
          <Badge color="bg-blue-100 text-blue-700" size="xs">
            지금
          </Badge>
        ) : null}
      </div>
      {item ? (
        <div className="mt-1 ml-[6.75rem] flex items-center gap-2 min-w-0">
          <span className={`shrink-0 text-[10px] ${deadline ? 'text-red-500' : 'text-blue-500'}`}>▶</span>
          <span
            className={`min-w-0 truncate text-sm ${entry.continued ? 'text-gray-500' : 'text-gray-900'}`}
            title={item.title}
          >
            {item.title}
          </span>
          {meta ? (
            <span
              className={`shrink-0 text-xs tabular-nums ${deadline ? 'text-red-600' : 'text-gray-500'}`}
            >
              {meta}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

interface TimelineProps {
  timeline: DayTimeline
  items: PlanItem[]
  logicalDate: string
}

// 오늘의 회의와 빈 시간 블록을 시간순으로 그린다 (부록 B.3)
export default function Timeline({ timeline, items, logicalDate }: TimelineProps): React.ReactNode {
  if (timeline.entries.length === 0) return null
  const byId = new Map(items.map((i) => [i.id, i]))
  const entries = [...timeline.entries].sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0
  )
  return (
    <ul className="border-t border-gray-100">
      {entries.map((e) =>
        e.kind === 'meeting' ? (
          <MeetingRow key={`m-${e.start}-${e.title}`} entry={e} />
        ) : (
          <BlockRow
            key={`b-${e.start}`}
            entry={e}
            item={e.itemId !== null ? (byId.get(e.itemId) ?? null) : null}
            logicalDate={logicalDate}
          />
        )
      )}
    </ul>
  )
}
