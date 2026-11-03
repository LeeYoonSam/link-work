import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AssistantEvent, MeetingBriefingPayload } from '../../types'
import MeetingBriefingCard, {
  briefingBadge,
  meetingBriefings,
  meetingStarted,
  nearestUpcomingEventId,
  parseMeetingPayload,
  type MeetingBriefingRow
} from './MeetingBriefingCard'

// 회의 전 브리핑 카드 (docs/ASSISTANT.md 부록 I.10.1·I.11.11).
// 자동 클릭 검증은 불가하다. renderToStaticMarkup 으로 4가지 상태를 그린다

const basePayload = (over: Partial<MeetingBriefingPayload> = {}): MeetingBriefingPayload => ({
  meeting: {
    id: 'cal-1',
    title: '결제 주간 회의',
    startAt: '2026-11-02 11:00:00',
    endAt: '2026-11-02 12:00:00'
  },
  title: '결제 주간 회의 15분 전',
  body: '결제 · 미완료 액션 2건',
  projects: [{ id: 3, name: '결제' }],
  hasContext: true,
  ruleMarkdown: '# 결제 주간 회의 11:00\n- 관련 프로젝트: 결제\n## 지난 회의\n- 10-26 결제 주간 회의 — 환불 정책 확정',
  llmStatus: 'off',
  llmMarkdown: null,
  llmModel: null,
  llmAt: null,
  llmError: null,
  ...over
})

const event = (
  over: Partial<AssistantEvent> & Pick<AssistantEvent, 'id'>,
  payload: MeetingBriefingPayload | null = basePayload()
): AssistantEvent => ({
  event_key: `meeting_briefing:2026-11-02:cal-${over.id}`,
  kind: 'meeting_briefing',
  plan_date: '2026-11-02',
  scheduled_at: '2026-11-02 10:45:00',
  fired_at: '2026-11-02 10:45:05',
  status: 'sent',
  ref_id: `cal-${over.id}`,
  payload: payload ? JSON.stringify(payload) : null,
  response: null,
  responded_at: null,
  created_at: '2026-11-02 10:45:05',
  ...over
})

const rowOf = (p: MeetingBriefingPayload, id = 7): MeetingBriefingRow => ({
  event: event({ id }, p),
  payload: p
})

const render = (
  rows: MeetingBriefingRow[],
  opts: { now?: string; regeneratingIds?: number[]; canRegenerate?: boolean } = {}
): string =>
  renderToStaticMarkup(
    <MeetingBriefingCard
      rows={rows}
      now={opts.now ?? '2026-11-02 10:50:00'}
      regeneratingIds={opts.regeneratingIds ?? []}
      canRegenerate={opts.canRegenerate ?? true}
      onRegenerate={() => {}}
    />
  )

describe('MeetingBriefingCard 4상태 렌더링', () => {
  it('규칙만: 규칙 브리핑 배지와 규칙 본문을 보이고 행 루트 id 는 meeting-briefing-<eventId> 다', () => {
    const html = render([rowOf(basePayload())])
    expect(html).toContain('id="meeting-briefing-7"')
    expect(html).toContain('회의 브리핑')
    expect(html).toContain('11:00')
    expect(html).toContain('결제 주간 회의')
    expect(html).toContain('규칙 브리핑')
    expect(html).not.toContain('AI 브리핑')
    expect(html).toContain('환불 정책 확정')
    expect(html).toContain('다시 만들기')
    expect(html).not.toContain('만드는 중')
  })

  it('pending: AI 브리핑 만드는 중… 을 보이고 규칙 본문을 그대로 둔다', () => {
    const html = render([rowOf(basePayload({ llmStatus: 'pending' }))])
    expect(html).toContain('meeting-briefing-7')
    expect(html).toContain('AI 브리핑 만드는 중…')
    expect(html).toContain('규칙 브리핑')
    expect(html).toContain('환불 정책 확정')
  })

  it('failed: amber 경고에 오류를 보이고 규칙 본문을 그대로 둔다', () => {
    const html = render([
      rowOf(basePayload({ llmStatus: 'failed', llmError: '응답 형식이 맞지 않습니다' }))
    ])
    expect(html).toContain('meeting-briefing-7')
    expect(html).toContain('AI 브리핑을 마치지 못했어요. 응답 형식이 맞지 않습니다')
    expect(html).toContain('bg-amber-50')
    expect(html).toContain('규칙 브리핑')
    expect(html).toContain('환불 정책 확정')
  })

  it('done: AI 브리핑 배지와 LLM 본문을 보인다', () => {
    const html = render([
      rowOf(
        basePayload({
          llmStatus: 'done',
          llmMarkdown: '## 결제 주간 회의 준비\n- 환불 API 일정 확인',
          llmModel: 'sonnet',
          llmAt: '2026-11-02 10:45:30'
        })
      )
    ])
    expect(html).toContain('meeting-briefing-7')
    expect(html).toContain('AI 브리핑')
    expect(html).not.toContain('규칙 브리핑')
    expect(html).toContain('환불 API 일정 확인')
    expect(html).not.toContain('환불 정책 확정')
  })
})

describe('MeetingBriefingCard 동작', () => {
  it('행이 없으면 카드를 그리지 않는다', () => {
    expect(render([])).toBe('')
  })

  it('회의 시작이 지났으면 기본으로 접힌다', () => {
    const html = render([rowOf(basePayload())], { now: '2026-11-02 11:30:00' })
    expect(html).toContain('meeting-briefing-7')
    expect(html).toContain('펼치기')
    expect(html).not.toContain('환불 정책 확정')
  })

  it('날짜를 넘는 회의: 23:50 에 다음 날 00:30 회의는 시작 전이라 펼친다', () => {
    const p = basePayload({
      meeting: { id: 'cal-1', title: '결제 주간 회의', startAt: '2026-11-03 00:30:00', endAt: '2026-11-03 01:00:00' }
    })
    const html = render([rowOf(p)], { now: '2026-11-02 23:50:00' })
    expect(html).toContain('접기')
    expect(html).toContain('환불 정책 확정')
  })

  it('A53 시작 전 회의 중 가장 가까운 1건만 펼치고 나머지와 지난 회의는 접는다', () => {
    const at = (id: string, startAt: string): MeetingBriefingPayload =>
      basePayload({ meeting: { id, title: `회의 ${id}`, startAt, endAt: startAt } })
    const rows = [
      rowOf(at('a', '2026-11-02 10:00:00'), 1),
      rowOf(at('b', '2026-11-02 14:00:00'), 2),
      rowOf(at('c', '2026-11-02 11:00:00'), 3)
    ]
    const html = render(rows, { now: '2026-11-02 10:50:00' })
    const row = (id: number): string => {
      const start = html.indexOf(`id="meeting-briefing-${id}"`)
      const next = html.indexOf('id="meeting-briefing-', start + 1)
      return html.slice(start, next === -1 ? undefined : next)
    }
    // 1 은 시작이 지났다. 3 이 가장 가깝다. 2 는 그다음이다
    expect(row(1)).toContain('펼치기')
    expect(row(1)).not.toContain('환불 정책 확정')
    expect(row(3)).toContain('접기')
    expect(row(3)).toContain('환불 정책 확정')
    expect(row(2)).toContain('펼치기')
    expect(row(2)).not.toContain('환불 정책 확정')
  })

  it('다시 만들기: canRegenerate 가 false 면 숨긴다', () => {
    expect(render([rowOf(basePayload())], { canRegenerate: false })).not.toContain('다시 만들기')
  })

  it('다시 만들기: 다시 만드는 중인 행의 버튼만 비활성이다', () => {
    const html = render([rowOf(basePayload(), 7), rowOf(basePayload(), 8)], { regeneratingIds: [8] })
    const row = (id: number): string => {
      const start = html.indexOf(`id="meeting-briefing-${id}"`)
      const next = html.indexOf('id="meeting-briefing-', start + 1)
      return html.slice(start, next === -1 ? undefined : next)
    }
    const disabledBtn = /<button[^>]*disabled=""[^>]*>다시 만들기<\/button>/
    expect(row(7)).toContain('다시 만들기')
    expect(row(7)).not.toMatch(disabledBtn)
    expect(row(8)).toMatch(disabledBtn)
  })
})

describe('MeetingBriefingCard 순수 헬퍼', () => {
  it('meetingBriefings: meeting_briefing 의 sent·late·failed 만 scheduled_at 오름차순으로 고른다', () => {
    const rows = meetingBriefings([
      event({ id: 1, scheduled_at: '2026-11-02 14:45:00' }),
      event({ id: 2, scheduled_at: '2026-11-02 09:45:00', status: 'late' }),
      event({ id: 3, status: 'skipped' }, null),
      event({ id: 4, scheduled_at: '2026-11-02 11:45:00', status: 'failed' }),
      event({ id: 5, kind: 'checkin' }),
      event({ id: 6, payload: '{깨짐' })
    ])
    expect(rows.map((r) => r.event.id)).toEqual([2, 4, 1])
  })

  it('parseMeetingPayload: 모양이 틀리면 null, 모르는 llmStatus 는 off 다', () => {
    expect(parseMeetingPayload(null)).toBeNull()
    expect(parseMeetingPayload('{"reason":"window"}')).toBeNull()
    expect(parseMeetingPayload('not json')).toBeNull()
    const p = parseMeetingPayload(JSON.stringify({ ...basePayload(), llmStatus: 'weird' }))
    expect(p?.llmStatus).toBe('off')
    expect(p?.meeting.id).toBe('cal-1')
    expect(parseMeetingPayload(JSON.stringify(basePayload()))).toEqual(basePayload())
  })

  it('briefingBadge: done 이면 AI 브리핑, 아니면 규칙 브리핑', () => {
    expect(briefingBadge('done')).toBe('AI 브리핑')
    expect(briefingBadge('off')).toBe('규칙 브리핑')
    expect(briefingBadge('pending')).toBe('규칙 브리핑')
    expect(briefingBadge('failed')).toBe('규칙 브리핑')
  })

  it('nearestUpcomingEventId: 시작 전 회의 중 startAt 이 가장 이른 행의 이벤트 id. 없으면 null', () => {
    const at = (startAt: string, id: number): MeetingBriefingRow =>
      rowOf(basePayload({ meeting: { id: `cal-${id}`, title: 't', startAt, endAt: startAt } }), id)
    const now = '2026-11-02 10:50:00'
    expect(nearestUpcomingEventId([], now)).toBeNull()
    expect(nearestUpcomingEventId([at('2026-11-02 10:00:00', 1)], now)).toBeNull()
    expect(
      nearestUpcomingEventId(
        [at('2026-11-02 15:00:00', 1), at('2026-11-02 10:50:00', 2), at('2026-11-02 11:30:00', 3)],
        now
      )
    ).toBe(3)
    // 같은 시각이면 id 가 작은 행이다
    expect(nearestUpcomingEventId([at('2026-11-02 11:00:00', 9), at('2026-11-02 11:00:00', 4)], now)).toBe(4)
    // 날짜를 넘는 회의도 시작 전이다
    expect(nearestUpcomingEventId([at('2026-11-03 00:30:00', 5)], '2026-11-02 23:50:00')).toBe(5)
    // startAt 이 빈 행은 고르지 않는다
    expect(nearestUpcomingEventId([at('', 6)], now)).toBeNull()
  })

  it('meetingStarted: 시작 일시가 지금 이하면 시작한 회의다. 날짜까지 비교한다', () => {
    expect(meetingStarted('2026-11-02 11:00:00', '2026-11-02 10:59:59')).toBe(false)
    expect(meetingStarted('2026-11-02 11:00:00', '2026-11-02 11:00:00')).toBe(true)
    expect(meetingStarted('2026-11-03 00:30:00', '2026-11-02 23:50:00')).toBe(false)
    expect(meetingStarted('', '2026-11-02 11:00:00')).toBe(false)
  })
})
