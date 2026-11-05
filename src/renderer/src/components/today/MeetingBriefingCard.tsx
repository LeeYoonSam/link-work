import { useState } from 'react'
import type {
  AssistantEvent,
  MeetingBriefingPayload,
  MeetingLlmStatus,
  MeetingProjectRef,
  TimelineEntry
} from '../../types'
import MarkdownContent from '../memo/MarkdownContent'
import { AlertTriangleIcon, Badge, Card, SectionTitle, button } from '../ui'
import { hhmmOf } from './PlanItemRow'
import { openInternalLink } from '../../utils/openInternalLink'

// 회의 전 브리핑 카드 (docs/ASSISTANT.md 부록 I.10.1).
// 계획이 없어도 보인다. 이유: 브리핑은 근무 중 여부와 무관하다.
// 2차 개편(부록 L.8)에서 시간표에 짝이 있는 브리핑은 시간표 회의 행에 붙는다.
// 이 카드는 짝이 없는 브리핑과 계획 없음 화면에만 보인다.

export interface MeetingBriefingRow {
  event: AssistantEvent
  payload: MeetingBriefingPayload
}

const LLM_STATUSES: MeetingLlmStatus[] = ['off', 'pending', 'done', 'failed']
// 카드에 보이는 행 상태. skipped 는 보이지 않는다
const VISIBLE_STATUSES: AssistantEvent['status'][] = ['sent', 'late', 'failed']

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

// 회의 브리핑 이벤트의 payload 를 읽는다. 모양이 틀리면 null 이다
export function parseMeetingPayload(payload: string | null): MeetingBriefingPayload | null {
  if (!payload) return null
  try {
    const p = JSON.parse(payload) as Record<string, unknown> | null
    if (!p || typeof p !== 'object') return null
    const m = p.meeting as Record<string, unknown> | null | undefined
    if (!m || typeof m !== 'object') return null
    const id = str(m.id)
    const startAt = str(m.startAt)
    if (id === null || startAt === null) return null
    const ruleMarkdown = str(p.ruleMarkdown)
    if (ruleMarkdown === null) return null
    const status = LLM_STATUSES.includes(p.llmStatus as MeetingLlmStatus)
      ? (p.llmStatus as MeetingLlmStatus)
      : 'off'
    const projects: MeetingProjectRef[] = Array.isArray(p.projects)
      ? (p.projects as unknown[]).filter(
          (x): x is MeetingProjectRef =>
            !!x &&
            typeof x === 'object' &&
            typeof (x as MeetingProjectRef).id === 'number' &&
            typeof (x as MeetingProjectRef).name === 'string'
        )
      : []
    return {
      meeting: { id, title: str(m.title) ?? '', startAt, endAt: str(m.endAt) ?? '' },
      title: str(p.title) ?? '',
      body: str(p.body) ?? '',
      projects,
      hasContext: p.hasContext === true,
      ruleMarkdown,
      llmStatus: status,
      llmMarkdown: str(p.llmMarkdown),
      llmModel: str(p.llmModel),
      llmAt: str(p.llmAt),
      llmError: str(p.llmError)
    }
  } catch {
    return null
  }
}

// 카드에 그릴 회의 브리핑 행을 scheduled_at 오름차순으로 고른다 (부록 I.10.1)
export function meetingBriefings(events: AssistantEvent[]): MeetingBriefingRow[] {
  const rows: MeetingBriefingRow[] = []
  for (const event of events) {
    if (event.kind !== 'meeting_briefing') continue
    if (!VISIBLE_STATUSES.includes(event.status)) continue
    const payload = parseMeetingPayload(event.payload)
    if (payload) rows.push({ event, payload })
  }
  return rows.sort(
    (a, b) =>
      a.event.scheduled_at.localeCompare(b.event.scheduled_at) || a.event.id - b.event.id
  )
}

// AI 본문이 있으면 'AI 브리핑', 아니면 '규칙 브리핑'
export function briefingBadge(status: MeetingLlmStatus): string {
  return status === 'done' ? 'AI 브리핑' : '규칙 브리핑'
}

// 회의 시작이 지났는지 판정한다. 둘 다 'YYYY-MM-DD HH:mm:ss' 다.
// 날짜까지 비교한다. 이유: 23:50 에 다음 날 00:30 회의를 시작 지남으로 보지 않는다
export function meetingStarted(startAt: string, now: string): boolean {
  return startAt !== '' && startAt <= now
}

// 시작 전 회의 중 가장 가까운 행의 이벤트 id. 없으면 null 이다 (부록 J.8).
// 카드는 이 1건만 기본으로 펼친다. 이유: 여러 브리핑이 화면을 밀어내지 않는다
export function nearestUpcomingEventId(rows: MeetingBriefingRow[], now: string): number | null {
  let best: MeetingBriefingRow | null = null
  for (const row of rows) {
    const start = row.payload.meeting.startAt
    if (start === '' || meetingStarted(start, now)) continue
    if (
      best === null ||
      start < best.payload.meeting.startAt ||
      (start === best.payload.meeting.startAt && row.event.id < best.event.id)
    ) {
      best = row
    }
  }
  return best ? best.event.id : null
}

// 시간표 회의 행과 회의 브리핑을 짝짓는 키다 (부록 L.8 V4). hhmm 은 'HH:mm' 이다
export function meetingKey(hhmm: string, title: string): string {
  return `${hhmm}|${title}`
}

// 회의 브리핑을 시간표 회의 행과 짝짓는다 (부록 L.8 V4).
// 시간표 회의 항목에는 id 가 없다. 그래서 시작 HH:mm 과 제목이 같으면 짝이다.
// 한 키에는 브리핑 1건만 짝짓는다. 나머지 행과 시간표에 없는 회의의 행은 unmatched 다
export function splitBriefingsByTimeline(
  rows: MeetingBriefingRow[],
  entries: TimelineEntry[]
): { matched: Map<string, MeetingBriefingRow>; unmatched: MeetingBriefingRow[] } {
  const keys = new Set<string>()
  for (const e of entries) {
    if (e.kind === 'meeting') keys.add(meetingKey(hhmmOf(e.start) || e.start, e.title))
  }
  const matched = new Map<string, MeetingBriefingRow>()
  const unmatched: MeetingBriefingRow[] = []
  for (const row of rows) {
    const start = hhmmOf(row.payload.meeting.startAt)
    const key = meetingKey(start, row.payload.meeting.title)
    if (start !== '' && keys.has(key) && !matched.has(key)) matched.set(key, row)
    else unmatched.push(row)
  }
  return { matched, unmatched }
}

// 규칙 브리핑의 첫 줄 '# 제목 시각' 은 행 머리와 같은 정보라 감춘다
export function dropLeadingTitle(markdown: string): string {
  return markdown.replace(/^\s*# [^\n]*\n?/, '')
}

// 본문 제목을 행 글자 크기에 맞춘다. h1 은 본문 크기, h2·h3 은 작은 회색 소제목이다
const BODY_HEADING_CLASS = [
  '[&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-gray-800 [&_h1]:mt-0',
  '[&_h2]:text-xs [&_h2]:font-semibold [&_h2]:text-gray-500 [&_h2]:mt-3',
  '[&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-gray-500 [&_h3]:mt-2'
].join(' ')

interface RegenerateProps {
  // 이 행의 AI 본문을 다시 만드는 중이면 true
  regenerating: boolean
  canRegenerate: boolean
  onRegenerate: (eventId: number) => void
}

function RegenerateButton({
  eventId,
  regenerating,
  canRegenerate,
  onRegenerate
}: RegenerateProps & { eventId: number }): React.ReactNode {
  if (!canRegenerate) return null
  return (
    <button
      type="button"
      disabled={regenerating}
      onClick={() => onRegenerate(eventId)}
      className={`px-3 py-1.5 text-sm ${button.subtle} disabled:opacity-50`}
    >
      다시 만들기
    </button>
  )
}

function KindBadge({ status }: { status: MeetingLlmStatus }): React.ReactNode {
  return (
    <Badge color={status === 'done' ? 'bg-purple-50 text-purple-600' : 'bg-slate-100 text-slate-600'}>
      {briefingBadge(status)}
    </Badge>
  )
}

// 펼친 브리핑의 안내와 본문이다. pending·failed 안내를 본문 위에 둔다
function BriefingContent({ payload }: { payload: MeetingBriefingPayload }): React.ReactNode {
  const content = payload.llmMarkdown ?? dropLeadingTitle(payload.ruleMarkdown)
  return (
    <>
      {payload.llmStatus === 'pending' ? (
        <p className="text-sm text-gray-500 mb-2">AI 브리핑 만드는 중…</p>
      ) : null}
      {payload.llmStatus === 'failed' ? (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3 text-sm text-amber-800">
          <AlertTriangleIcon size={16} className="shrink-0 mt-0.5" />
          <span>AI 브리핑을 마치지 못했어요. {payload.llmError ?? ''}</span>
        </div>
      ) : null}
      <MarkdownContent
        content={content}
        compact
        className={BODY_HEADING_CLASS}
        onInternalLink={(href) => void openInternalLink(href)}
      />
    </>
  )
}

// 시간표 회의 행 아래에 펼치는 브리핑 본문이다 (부록 L.8 V3).
// 회의 시각·제목은 시간표 행에 있어 다시 쓰지 않는다. 배지·다시 만들기·안내·본문을 그린다
export function MeetingBriefingBody({
  row,
  regenerating,
  canRegenerate,
  onRegenerate
}: RegenerateProps & { row: MeetingBriefingRow }): React.ReactNode {
  const { event, payload } = row
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <KindBadge status={payload.llmStatus} />
        <RegenerateButton
          eventId={event.id}
          regenerating={regenerating}
          canRegenerate={canRegenerate}
          onRegenerate={onRegenerate}
        />
      </div>
      <BriefingContent payload={payload} />
    </div>
  )
}

interface RowProps extends RegenerateProps {
  row: MeetingBriefingRow
  // 기본으로 펼칠 행이면 true
  expandedByDefault: boolean
}

function MeetingBriefingItem({
  row,
  expandedByDefault,
  regenerating,
  canRegenerate,
  onRegenerate
}: RowProps): React.ReactNode {
  const { event, payload } = row
  // 기본은 가장 가까운 시작 전 회의 1건만 펼친다. 지난 브리핑은 참고용이라 접힌다
  const [collapsed, setCollapsed] = useState(() => !expandedByDefault)

  return (
    <div id={`meeting-briefing-${event.id}`} className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <span className="text-sm text-gray-500 tabular-nums shrink-0 pt-0.5">
            {hhmmOf(payload.meeting.startAt)}
          </span>
          {/* 제목은 자르지 않고 줄바꿈한다 (부록 L.8 V7) */}
          <span className="min-w-0 break-words text-base font-medium text-gray-900">
            {payload.meeting.title}
          </span>
          <span className="shrink-0">
            <KindBadge status={payload.llmStatus} />
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className={`px-3 py-1.5 text-sm ${button.ghost}`}
          >
            {collapsed ? '펼치기' : '접기'}
          </button>
          <RegenerateButton
            eventId={event.id}
            regenerating={regenerating}
            canRegenerate={canRegenerate}
            onRegenerate={onRegenerate}
          />
        </div>
      </div>

      {!collapsed ? (
        <div className="mt-2">
          <BriefingContent payload={payload} />
        </div>
      ) : null}
    </div>
  )
}

interface MeetingBriefingCardProps {
  rows: MeetingBriefingRow[]
  // 'YYYY-MM-DD HH:mm:ss'. 회의 시작이 지났는지 판정한다
  now: string
  // 다시 만드는 중인 이벤트 id. 그 행의 버튼만 비활성이다
  regeneratingIds: number[]
  // aiAvailable && settings.llmEnabled
  canRegenerate: boolean
  onRegenerate: (eventId: number) => void
  // 카드 제목. 짝 없는 묶음은 '기타 회의 브리핑' 이다 (부록 L.8 V4)
  title?: string
  // 기본으로 펼칠 이벤트 id. 주면 카드가 nearest 를 다시 계산하지 않는다.
  // 이유: 시간표와 이 카드를 합쳐 화면 전체에서 1건만 펼친다 (부록 L.8)
  expandedEventId?: number | null
}

export default function MeetingBriefingCard({
  rows,
  now,
  title = '회의 브리핑',
  expandedEventId,
  regeneratingIds,
  canRegenerate,
  onRegenerate
}: MeetingBriefingCardProps): React.ReactNode {
  if (rows.length === 0) return null
  const nearest = expandedEventId !== undefined ? expandedEventId : nearestUpcomingEventId(rows, now)
  return (
    <Card>
      <SectionTitle variant="page">{title}</SectionTitle>
      <div className="mt-4 divide-y divide-gray-100">
        {rows.map((row) => (
          <MeetingBriefingItem
            key={row.event.id}
            row={row}
            expandedByDefault={row.event.id === nearest}
            regenerating={regeneratingIds.includes(row.event.id)}
            canRegenerate={canRegenerate}
            onRegenerate={onRegenerate}
          />
        ))}
      </div>
    </Card>
  )
}
