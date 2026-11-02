import type { AssistantEvent, RefreshSummary } from '../../types'
import { Card, SectionTitle } from '../ui'
import { hhmmOf } from './PlanItemRow'

// payload 에서 변경 요약을 꺼낸다. main 은 RefreshSummary 를 그대로 저장한다. { summary } 감싼 형태도 받는다
export function parseSummary(payload: string | null): Partial<RefreshSummary> | null {
  if (!payload) return null
  try {
    const raw = JSON.parse(payload) as unknown
    if (!raw || typeof raw !== 'object') return null
    const obj = raw as Record<string, unknown>
    const s = obj.summary && typeof obj.summary === 'object' ? obj.summary : obj
    return s as Partial<RefreshSummary>
  } catch {
    return null
  }
}

// 받침이 있고 ㄹ 받침이 아니면 '으로', 아니면 '로'
function withRo(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00
  if (code < 0 || code > 11171) return `${word}로`
  const jong = code % 28
  return jong === 0 || jong === 8 ? `${word}로` : `${word}으로`
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// plan_update 이벤트 1건을 규칙 문장으로 바꾼다. 예: '10:42 회의 1건 추가로 시간표 갱신'
export function describePlanUpdate(ev: Pick<AssistantEvent, 'scheduled_at' | 'fired_at' | 'payload'>): string {
  const time = hhmmOf(ev.fired_at ?? ev.scheduled_at)
  const s = parseSummary(ev.payload)
  if (!s) return `${time} 계획 최신화`.trim()

  const calendar: string[] = []
  if (n(s.calendarAdded) > 0) calendar.push(`회의 ${n(s.calendarAdded)}건 추가`)
  if (n(s.calendarChanged) > 0) calendar.push(`회의 ${n(s.calendarChanged)}건 변경`)
  if (n(s.calendarRemoved) > 0) calendar.push(`회의 ${n(s.calendarRemoved)}건 취소`)

  const parts: string[] = []
  const timelineChanged = s.timelineChanged === true
  if (calendar.length > 0 && timelineChanged) {
    const head = calendar.slice(0, -1)
    const last = calendar[calendar.length - 1]
    parts.push([...head, `${withRo(last)} 시간표 갱신`].join(' · '))
  } else {
    parts.push(...calendar)
    if (timelineChanged) parts.push('시간표 갱신')
  }
  if (s.currentOrNextChanged === true) parts.push('지금·다음 블록 변경')

  const suggested = n(s.suggested)
  const urgent = Array.isArray(s.urgentSuggestedIds) ? s.urgentSuggestedIds.length : 0
  if (suggested > 0) {
    parts.push(urgent > 0 ? `새로 들어온 일 ${suggested}건 (긴급 ${urgent}건)` : `새로 들어온 일 ${suggested}건`)
  }
  if (n(s.completed) > 0) parts.push(`${n(s.completed)}건 완료 반영`)
  if (n(s.dropped) > 0) parts.push(`${n(s.dropped)}건 제외`)
  if (n(s.replaced) > 0) parts.push(`액션아이템 ${n(s.replaced)}건 TODO 로 교체`)

  const body = parts.length > 0 ? parts.join(' · ') : '변경 없음'
  // 알림 행 INSERT 에 성공한 종류가 있으면 표시한다 (부록 E.3.3)
  const notified = Array.isArray(s.notified) && s.notified.length > 0 ? ' · 알림 보냄' : ''
  return `${time} ${body}${notified}`.trim()
}

// 변경 기록 행만 고른다. 알림 행은 ref_id 가 있다 (부록 E.3.3)
export function planUpdateEvents(events: AssistantEvent[]): AssistantEvent[] {
  return events
    .filter((e) => e.kind === 'plan_update' && e.ref_id === null)
    .sort((a, b) => {
      const ta = a.fired_at ?? a.scheduled_at
      const tb = b.fired_at ?? b.scheduled_at
      return ta < tb ? -1 : ta > tb ? 1 : a.id - b.id
    })
}

export default function ChangeLog({ events }: { events: AssistantEvent[] }): React.ReactNode {
  const list = planUpdateEvents(events)
  if (list.length === 0) return null
  return (
    <Card padding="sm">
      <SectionTitle className="mb-2">변경 내역</SectionTitle>
      <ul className="space-y-1">
        {list.map((ev) => (
          <li key={ev.id} className="text-xs text-gray-600 tabular-nums">
            {describePlanUpdate(ev)}
          </li>
        ))}
      </ul>
    </Card>
  )
}
