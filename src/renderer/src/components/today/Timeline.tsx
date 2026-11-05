import { useState } from 'react'
import type { DayTimeline, PlanItem, TimelineEntry } from '../../types'
import { Badge, button } from '../ui'
import {
  MeetingBriefingBody,
  meetingKey,
  nearestUpcomingEventId,
  splitBriefingsByTimeline,
  type MeetingBriefingRow
} from './MeetingBriefingCard'
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

type MeetingEntry = Extract<TimelineEntry, { kind: 'meeting' }>

function MeetingRow({ entry }: { entry: MeetingEntry }): React.ReactNode {
  return (
    <li className="flex items-center gap-3 px-5 py-3 border-b border-gray-100 last:border-b-0">
      <span className="w-28 shrink-0 text-sm text-gray-500 tabular-nums">{timeRange(entry)}</span>
      <span className="min-w-0 break-words text-base text-gray-700">
        <span className="text-purple-600">[회의]</span> {entry.title}
      </span>
    </li>
  )
}

interface BriefingMeetingRowProps {
  entry: MeetingEntry
  // 이 회의와 짝이 맞는 브리핑. 없으면 null 이다
  briefing: MeetingBriefingRow | null
  // 기본으로 펼칠 브리핑이면 true
  expandedByDefault: boolean
  regenerating: boolean
  canRegenerate: boolean
  onRegenerate: (eventId: number) => void
}

// 브리핑을 붙이는 시간표의 회의 행이다 (부록 L.8 V3·V7).
// 제목은 자르지 않고 줄바꿈한다. 짝 브리핑이 있으면 '브리핑' 버튼으로 행 아래 본문을 펼친다
function BriefingMeetingRow({
  entry,
  briefing,
  expandedByDefault,
  regenerating,
  canRegenerate,
  onRegenerate
}: BriefingMeetingRowProps): React.ReactNode {
  const [open, setOpen] = useState(expandedByDefault)
  const blockId = briefing ? `meeting-briefing-${briefing.event.id}` : undefined
  return (
    <li className="px-5 py-3 border-b border-gray-100 last:border-b-0">
      <div className="flex items-start gap-3">
        <span className="w-28 shrink-0 pt-0.5 text-sm text-gray-500 tabular-nums">
          {timeRange(entry)}
        </span>
        <span className="min-w-0 flex-1 break-words text-base text-gray-700">
          <span className="text-purple-600">[회의]</span> {entry.title}
        </span>
        {briefing ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={blockId}
            onClick={() => setOpen((o) => !o)}
            className={`shrink-0 px-3 py-1.5 text-sm ${button.subtle}`}
          >
            {open ? '브리핑 접기' : '브리핑'}
          </button>
        ) : null}
      </div>
      {briefing ? (
        // 접혀도 블록 id 를 남긴다. 이유: 알림 클릭이 이 id 로 스크롤한다
        <div id={blockId}>
          {open ? (
            <div className="mt-3 rounded-md border border-gray-100 bg-gray-50 px-4 py-3">
              <MeetingBriefingBody
                row={briefing}
                regenerating={regenerating}
                canRegenerate={canRegenerate}
                onRegenerate={onRegenerate}
              />
            </div>
          ) : null}
        </div>
      ) : null}
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
      className={`border-b border-gray-100 last:border-b-0 ${short ? 'px-5 py-1' : 'px-5 py-3'} ${tone}`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`w-28 shrink-0 text-sm tabular-nums ${short ? 'text-gray-400' : 'text-gray-700 font-medium'}`}
        >
          {timeRange(entry)}
        </span>
        <span className={`text-sm ${short ? 'text-gray-400' : 'text-gray-500'}`}>
          {`빈 시간 ${durationLabel(entry.minutes)}`}
        </span>
        {entry.state === 'current' ? (
          <Badge color="bg-blue-100 text-blue-700">
            지금
          </Badge>
        ) : null}
      </div>
      {item ? (
        <div className="mt-1 ml-[7.75rem] flex items-center gap-2 min-w-0">
          <span className={`shrink-0 text-xs ${deadline ? 'text-red-500' : 'text-blue-500'}`}>▶</span>
          <span
            className={`min-w-0 break-words text-base ${entry.continued ? 'text-gray-500' : 'text-gray-900'}`}
            title={item.title}
          >
            {item.title}
          </span>
          {meta ? (
            <span
              className={`shrink-0 text-sm tabular-nums ${deadline ? 'text-red-600' : 'text-gray-500'}`}
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
  // 회의 브리핑 행 (부록 L.8 V3). 주면 회의 행이 브리핑을 붙이는 모양으로 바뀐다.
  // 주지 않으면 출력이 개편 전과 같다
  meetingBriefings?: MeetingBriefingRow[]
  // 'YYYY-MM-DD HH:mm:ss'. 기본 펼침 브리핑을 고른다. 없으면 기본 펼침이 없다
  now?: string
  // 다시 만드는 중인 이벤트 id. 그 브리핑의 버튼만 비활성이다
  regeneratingIds?: number[]
  // aiAvailable && settings.llmEnabled
  canRegenerate?: boolean
  onRegenerate?: (eventId: number) => void
}

const noop = (): void => {}

// 오늘의 회의와 빈 시간 블록을 시간순으로 그린다 (부록 B.3)
export default function Timeline({
  timeline,
  items,
  logicalDate,
  meetingBriefings,
  now,
  regeneratingIds = [],
  canRegenerate = false,
  onRegenerate = noop
}: TimelineProps): React.ReactNode {
  if (timeline.entries.length === 0) return null
  const byId = new Map(items.map((i) => [i.id, i]))
  const entries = [...timeline.entries].sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0
  )
  // 브리핑을 붙이는 모드. 시간표에 짝이 있는 브리핑만 행에 붙는다 (부록 L.8 V4).
  // 같은 키의 회의 행이 둘이면 앞 행에만 붙인다. 이유: 블록 id 가 겹치지 않는다
  const briefingAt = new Map<number, MeetingBriefingRow>()
  if (meetingBriefings) {
    const { matched } = splitBriefingsByTimeline(meetingBriefings, entries)
    entries.forEach((e, i) => {
      if (e.kind !== 'meeting') return
      const key = meetingKey(hhmmOf(e.start) || e.start, e.title)
      const row = matched.get(key)
      if (!row) return
      briefingAt.set(i, row)
      matched.delete(key)
    })
  }
  // 기본 펼침은 가장 가까운 시작 전 회의 1건이다. 시간표에 없는 회의도 후보로 센다
  const nearest =
    meetingBriefings && now !== undefined ? nearestUpcomingEventId(meetingBriefings, now) : null
  return (
    <ul className="border-t border-gray-100">
      {entries.map((e, i) =>
        e.kind === 'meeting' ? (
          meetingBriefings ? (
            <BriefingMeetingRow
              key={`m-${e.start}-${e.title}`}
              entry={e}
              briefing={briefingAt.get(i) ?? null}
              expandedByDefault={nearest !== null && briefingAt.get(i)?.event.id === nearest}
              regenerating={regeneratingIds.includes(briefingAt.get(i)?.event.id ?? -1)}
              canRegenerate={canRegenerate}
              onRegenerate={onRegenerate}
            />
          ) : (
            <MeetingRow key={`m-${e.start}-${e.title}`} entry={e} />
          )
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
