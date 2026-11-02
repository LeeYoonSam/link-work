import { useState } from 'react'
import type {
  AssistantEvent,
  MeetingBriefingPayload,
  MeetingLlmStatus,
  MeetingProjectRef
} from '../../types'
import MarkdownContent from '../memo/MarkdownContent'
import { AlertTriangleIcon, Badge, Card, SectionTitle, button } from '../ui'
import { hhmmOf, openInternalLink } from './PlanItemRow'

// 회의 전 브리핑 카드 (docs/ASSISTANT.md 부록 I.10.1).
// 계획이 없어도 보인다. 이유: 브리핑은 근무 중 여부와 무관하다.

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

interface RowProps {
  row: MeetingBriefingRow
  now: string
  // 이 행의 AI 본문을 다시 만드는 중이면 true
  regenerating: boolean
  canRegenerate: boolean
  onRegenerate: (eventId: number) => void
}

function MeetingBriefingItem({
  row,
  now,
  regenerating,
  canRegenerate,
  onRegenerate
}: RowProps): React.ReactNode {
  const { event, payload } = row
  // 기본은 회의 시작이 지났으면 접힘이다. 이유: 지난 브리핑은 참고용이다
  const [collapsed, setCollapsed] = useState(() =>
    meetingStarted(payload.meeting.startAt, now)
  )
  const isLlm = payload.llmStatus === 'done'
  const content = payload.llmMarkdown ?? payload.ruleMarkdown

  return (
    <div id={`meeting-briefing-${event.id}`} className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-gray-500 tabular-nums shrink-0">
            {hhmmOf(payload.meeting.startAt)}
          </span>
          <span className="text-sm font-medium text-gray-800 truncate" title={payload.meeting.title}>
            {payload.meeting.title}
          </span>
          <Badge
            color={isLlm ? 'bg-purple-50 text-purple-600' : 'bg-slate-100 text-slate-600'}
            size="xs"
          >
            {briefingBadge(payload.llmStatus)}
          </Badge>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className={`px-2 py-1 text-xs ${button.ghost}`}
          >
            {collapsed ? '펼치기' : '접기'}
          </button>
          {canRegenerate ? (
            <button
              type="button"
              disabled={regenerating}
              onClick={() => onRegenerate(event.id)}
              className={`px-2.5 py-1 text-xs ${button.subtle} disabled:opacity-50`}
            >
              다시 만들기
            </button>
          ) : null}
        </div>
      </div>

      {!collapsed ? (
        <div className="mt-2">
          {payload.llmStatus === 'pending' ? (
            <p className="text-[11px] text-gray-500 mb-2">AI 브리핑 만드는 중…</p>
          ) : null}
          {payload.llmStatus === 'failed' ? (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3 text-xs text-amber-800">
              <AlertTriangleIcon size={14} className="shrink-0 mt-0.5" />
              <span>AI 브리핑을 마치지 못했습니다. {payload.llmError ?? ''}</span>
            </div>
          ) : null}
          <MarkdownContent
            content={content}
            compact
            onInternalLink={(href) => void openInternalLink(href)}
          />
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
}

export default function MeetingBriefingCard({
  rows,
  now,
  regeneratingIds,
  canRegenerate,
  onRegenerate
}: MeetingBriefingCardProps): React.ReactNode {
  if (rows.length === 0) return null
  return (
    <Card padding="sm">
      <SectionTitle>회의 브리핑</SectionTitle>
      <div className="mt-3 divide-y divide-gray-100">
        {rows.map((row) => (
          <MeetingBriefingItem
            key={row.event.id}
            row={row}
            now={now}
            regenerating={regeneratingIds.includes(row.event.id)}
            canRegenerate={canRegenerate}
            onRegenerate={onRegenerate}
          />
        ))}
      </div>
    </Card>
  )
}
