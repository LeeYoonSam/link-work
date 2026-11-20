import type { AssistantEvent, MeetingBriefingPayload, MeetingLlmStatus } from '../../types'
import MarkdownContent from '../memo/MarkdownContent'
import { AlertTriangleIcon, Badge, button } from '../ui'
import { openInternalLink } from '../../utils/openInternalLink'

// 회의 전 브리핑의 읽기·표시 조각 (docs/ASSISTANT.md §11.5).
// 오늘 대시보드에서는 일정 카드(ScheduleCard)의 회의 행 아래에 인라인으로 펼친다.
// 짝짓기는 payload.meeting.id === CalendarEvent.id 다. 별도 카드는 두지 않는다.

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
    return {
      meeting: { id, title: str(m.title) ?? '', startAt, endAt: str(m.endAt) ?? '' },
      title: str(p.title) ?? '',
      body: str(p.body) ?? '',
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

// 카드에 그릴 회의 브리핑 행을 scheduled_at 오름차순으로 고른다
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

// 시작 전 회의 중 가장 가까운 행의 이벤트 id. 없으면 null 이다.
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

// 회의 브리핑을 캘린더 일정 id 로 묶는다. 같은 일정에 여러 행이 있으면 scheduled_at 이 늦은 것이 남는다.
// rows 는 meetingBriefings() 의 결과(오름차순)다
export function briefingsByMeetingId(rows: MeetingBriefingRow[]): Map<string, MeetingBriefingRow> {
  const map = new Map<string, MeetingBriefingRow>()
  for (const row of rows) map.set(row.payload.meeting.id, row)
  return map
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

// 일정 카드의 회의 행 아래에 펼치는 브리핑 본문이다.
// 회의 시각·제목은 일정 행에 있어 다시 쓰지 않는다. 배지·다시 만들기·안내·본문을 그린다
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
