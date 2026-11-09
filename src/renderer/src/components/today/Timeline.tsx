import { useState } from 'react'
import type { DayTimeline, TimelineEntry } from '../../types'
import { button } from '../ui'
import {
  MeetingBriefingBody,
  meetingKey,
  nearestUpcomingEventId,
  splitBriefingsByTimeline,
  type MeetingBriefingRow
} from './MeetingBriefingCard'
import { hhmmOf } from './PlanItemRow'
import MarkdownContent from '../memo/MarkdownContent'
import {
  EMPHASIS,
  MEETING_BAR,
  MEETING_BAR_NEXT,
  MEETING_ROW_GRID,
  NO_BAR,
  ROW_BOX,
  TIME_TEXT,
  TITLE_TEXT
} from './todayTokens'

// 장소·메모는 선택 필드다 (부록 M.9, M.10). 메모는 캘린더 설명 원문이다. 옛 스냅샷에는 없다. 없으면 null 로 본다
export type MeetingEntry = Extract<TimelineEntry, { kind: 'meeting' }> & {
  location?: string | null
  note?: string | null
}
export type MeetingTiming = 'past' | 'current' | 'soon' | 'later'

// 시작 전 이 분 이내면 임박이다 (부록 M.4)
export const SOON_MEETING_MIN = 15

// 'HH:mm' 또는 'YYYY-MM-DD HH:mm:ss' 를 0시 기준 분으로 바꾼다. 형식이 아니면 null
function minutesOf(value: string): number | null {
  const hhmm = hhmmOf(value)
  if (hhmm === '') return null
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// 회의 1건의 지금 상태다 (부록 M.5.7). nowHHmm 은 'HH:mm' 이다.
// 끝났으면 past, 진행 중이면 current, 시작 전 15분 이내면 soon, 나머지는 later 다
export function meetingTiming(
  entry: { start: string; end: string },
  nowHHmm: string
): MeetingTiming {
  const now = minutesOf(nowHHmm)
  const start = minutesOf(entry.start)
  const end = minutesOf(entry.end)
  if (now === null || start === null || end === null) return 'later'
  if (end <= now) return 'past'
  if (start <= now) return 'current'
  return start - now <= SOON_MEETING_MIN ? 'soon' : 'later'
}

// 강조할 회의 행의 위치다 (부록 M.5.7). 진행 중 행이 있으면 첫 진행 중 행이다.
// 없으면 시작 전 첫 행이다. 둘 다 없으면 -1 이다. entries 는 시작순이다
export function nextMeetingIndex(
  entries: Array<{ start: string; end: string }>,
  nowHHmm: string
): number {
  const timings = entries.map((e) => meetingTiming(e, nowHHmm))
  const current = timings.indexOf('current')
  if (current !== -1) return current
  return timings.findIndex((t) => t === 'soon' || t === 'later')
}

// 시간표에서 회의 항목만 시작순으로 꺼낸다. 오늘 카드의 '회의 n' 도 이 수를 쓴다
export function meetingEntriesOf(timeline: Pick<DayTimeline, 'entries'>): MeetingEntry[] {
  return timeline.entries
    .filter((e): e is MeetingEntry => e.kind === 'meeting')
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
}

// 장소 값이 http(s) 주소면 온라인 회의 링크로 본다 (부록 M.10 P4)
export const isOnlineLocation = (location: string): boolean => /^https?:\/\//i.test(location)

// 회의 장소 1줄이다. 라벨 없이 메모 아래에 둔다 (부록 M.10 P4). 값이 없으면 그리지 않는다.
// 외부 링크는 main 의 setWindowOpenHandler 가 브라우저로 연다. ItemLink 와 같은 방식이다
function MeetingLocation({ location }: { location: string | null | undefined }): React.ReactNode {
  const value = location?.trim() ?? ''
  if (value === '') return null
  return (
    <p data-meeting-location="" className="mt-1 text-sm text-gray-400 break-words">
      {isOnlineLocation(value) ? (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          title={value}
          className="text-blue-600 hover:underline"
        >
          온라인 회의
        </a>
      ) : (
        value
      )}
    </p>
  )
}

// 메모 본문 글자. 오늘 화면은 text-sm 이 최소다 (부록 M.10 P5)
const NOTE_TEXT =
  'break-words text-sm text-gray-600 [&_p]:text-sm [&_p]:text-gray-600 [&_li]:text-sm [&_li]:text-gray-600 [&_ul]:text-sm [&_ol]:text-sm'

// 회의 메모다 (부록 M.10 P3). 캘린더 설명 원문(HTML)을 그린다.
// MarkdownContent 가 rehype-sanitize 로 안전한 태그만 남긴다. 기본은 접힌 미리보기다
function MeetingNote({
  note,
  expandedInitial
}: {
  note: string
  expandedInitial: boolean
}): React.ReactNode {
  const [expanded, setExpanded] = useState(expandedInitial)
  return (
    <div data-meeting-note="">
      <div className={`mt-1 ${expanded ? '' : 'max-h-[3.25rem] overflow-hidden'}`}>
        <MarkdownContent content={note} allowHtml compact className={NOTE_TEXT} />
      </div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="mt-1 text-sm text-blue-600 hover:text-blue-700"
      >
        {expanded ? '접기' : '더 보기'}
      </button>
    </div>
  )
}

const timeRange = (e: Pick<TimelineEntry, 'start' | 'end'>): string =>
  `${hhmmOf(e.start) || e.start} - ${hhmmOf(e.end) || e.end}`

// 진행 중·임박 회의의 보조 글자. 나머지는 빈 문자열이다
function timingLabel(entry: MeetingEntry, timing: MeetingTiming, nowHHmm: string): string {
  if (timing === 'current') return '진행 중'
  if (timing !== 'soon') return ''
  const start = minutesOf(entry.start) as number
  const now = minutesOf(nowHHmm) as number
  return `${start - now}분 후`
}

interface MeetingRowProps {
  entry: MeetingEntry
  timing: MeetingTiming
  nowHHmm: string
  // 진행 중이거나 다음 회의 1건이면 true. 이 행만 보라 세로 막대를 받는다
  highlighted: boolean
  // 이 회의와 짝이 맞는 브리핑. 없으면 null 이다
  briefing: MeetingBriefingRow | null
  // 기본으로 펼칠 브리핑이면 true
  expandedByDefault: boolean
  // 메모를 펼친 채로 그리면 true. 테스트용이다
  noteExpandedInitial: boolean
  regenerating: boolean
  canRegenerate: boolean
  onRegenerate: (eventId: number) => void
}

// 회의 행 1개다 (부록 M.10 P1·P2, L.8 V3·V7). 캘린더 EventRow 와 같은 배치다.
// 1열 오른쪽 정렬 시각, 2열 세로 막대, 3열 제목·임박 표시·메모·장소, 4열 '브리핑' 버튼이다.
// 제목은 자르지 않고 줄바꿈한다
function MeetingRow({
  entry,
  timing,
  nowHHmm,
  highlighted,
  briefing,
  expandedByDefault,
  noteExpandedInitial,
  regenerating,
  canRegenerate,
  onRegenerate
}: MeetingRowProps): React.ReactNode {
  const [open, setOpen] = useState(expandedByDefault)
  const blockId = briefing ? `meeting-briefing-${briefing.event.id}` : undefined
  const label = timingLabel(entry, timing, nowHHmm)
  const dim = timing === 'past' ? EMPHASIS.dimmed : ''
  const note = entry.note?.trim() ?? ''
  return (
    <li data-timing={timing} className={`${ROW_BOX} ${NO_BAR} ${dim}`}>
      <div className={MEETING_ROW_GRID}>
        <span className={`pt-0.5 text-right ${TIME_TEXT}`}>{timeRange(entry)}</span>
        <div data-meeting-bar="" className={highlighted ? MEETING_BAR_NEXT : MEETING_BAR} />
        <div className="min-w-0">
          <p className={`${TITLE_TEXT} font-medium`}>{entry.title}</p>
          {label ? (
            <p className={`mt-1 text-sm tabular-nums ${EMPHASIS.soonMeetingText}`}>{label}</p>
          ) : null}
          {note !== '' ? <MeetingNote note={note} expandedInitial={noteExpandedInitial} /> : null}
          <MeetingLocation location={entry.location} />
        </div>
        <div className="self-start shrink-0">
          {briefing ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={blockId}
              onClick={() => setOpen((o) => !o)}
              className={`px-3 py-1.5 text-sm ${button.subtle}`}
            >
              {open ? '브리핑 접기' : '브리핑'}
            </button>
          ) : null}
        </div>
      </div>
      {briefing ? (
        // 접혀도 블록 id 를 남긴다. 이유: 알림 클릭이 이 id 로 스크롤한다
        <div id={blockId}>
          {open ? (
            // 들여쓰기는 시각 열 6.5rem + 막대 열 0.125rem + 열 간격 0.75rem 2개다. 본문이 제목과 같은 x 에서 시작한다
            <div className="mt-3 ml-[8.125rem] rounded-md border border-gray-100 bg-gray-50 px-4 py-3">
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

// 현재 시각 선이다 (부록 M.4). 지난·진행 중 회의와 시작 전 회의 사이에 둔다
function NowLine({ nowHHmm }: { nowHHmm: string }): React.ReactNode {
  return (
    <li data-now-line="" aria-label={`지금 ${nowHHmm}`} className="flex items-center gap-2 px-5 py-1">
      <span className="shrink-0 text-xs text-blue-600 font-medium tabular-nums">지금 {nowHHmm}</span>
      <span className="h-px flex-1 bg-blue-500" />
    </li>
  )
}

interface TimelineProps {
  timeline: DayTimeline
  // 'YYYY-MM-DD HH:mm:ss'. 회의 상태와 기본 펼침 브리핑을 고른다
  now: string
  // 회의 브리핑 행 (부록 L.8 V3). 짝이 맞는 회의 행에 '브리핑' 버튼을 붙인다
  meetingBriefings?: MeetingBriefingRow[]
  // 다시 만드는 중인 이벤트 id. 그 브리핑의 버튼만 비활성이다
  regeneratingIds?: number[]
  // aiAvailable && settings.llmEnabled
  canRegenerate?: boolean
  onRegenerate?: (eventId: number) => void
  // 회의 메모를 펼친 채로 그린다. 테스트용이다. 기본은 접힘이다
  notesExpandedInitial?: boolean
}

const noop = (): void => {}

// 오늘 카드의 회의 구역이다 (부록 M.5.7). 회의 행만 시작순으로 그린다.
// 회의가 없으면 아무것도 그리지 않는다. 빈 안내는 부르는 쪽이 그린다
export default function Timeline({
  timeline,
  now,
  meetingBriefings,
  regeneratingIds = [],
  canRegenerate = false,
  onRegenerate = noop,
  notesExpandedInitial = false
}: TimelineProps): React.ReactNode {
  const meetings = meetingEntriesOf(timeline)
  if (meetings.length === 0) return null
  const nowHHmm = hhmmOf(now)
  const timings = meetings.map((e) => meetingTiming(e, nowHHmm))
  const highlight = nextMeetingIndex(meetings, nowHHmm)
  // 시작 전 첫 행 앞에 현재 시각 선을 둔다. 모두 지났거나 모두 시작 전이면 선이 없다
  const firstUpcoming = timings.findIndex((t) => t === 'soon' || t === 'later')
  const nowLineAt = firstUpcoming > 0 ? firstUpcoming : -1

  // 시간표에 짝이 있는 브리핑만 행에 붙는다 (부록 L.8 V4).
  // 같은 키의 회의 행이 둘이면 앞 행에만 붙인다. 이유: 블록 id 가 겹치지 않는다
  const briefingAt = new Map<number, MeetingBriefingRow>()
  if (meetingBriefings) {
    const { matched } = splitBriefingsByTimeline(meetingBriefings, meetings)
    meetings.forEach((e, i) => {
      const key = meetingKey(hhmmOf(e.start) || e.start, e.title)
      const row = matched.get(key)
      if (!row) return
      briefingAt.set(i, row)
      matched.delete(key)
    })
  }
  // 기본 펼침은 가장 가까운 시작 전 회의 1건이다. 시간표에 없는 회의도 후보로 센다
  const nearest = meetingBriefings && now !== '' ? nearestUpcomingEventId(meetingBriefings, now) : null

  return (
    <ul className="border-t border-gray-100">
      {meetings.map((e, i) => {
        const briefing = briefingAt.get(i) ?? null
        const row = (
          <MeetingRow
            key={`m-${i}-${e.start}-${e.title}`}
            entry={e}
            timing={timings[i]}
            nowHHmm={nowHHmm}
            highlighted={i === highlight}
            briefing={briefing}
            expandedByDefault={nearest !== null && briefing?.event.id === nearest}
            noteExpandedInitial={notesExpandedInitial}
            regenerating={regeneratingIds.includes(briefing?.event.id ?? -1)}
            canRegenerate={canRegenerate}
            onRegenerate={onRegenerate}
          />
        )
        return i === nowLineAt ? [<NowLine key="now-line" nowHHmm={nowHHmm} />, row] : row
      })}
    </ul>
  )
}
