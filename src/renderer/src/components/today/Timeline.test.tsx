import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AssistantEvent, DayTimeline, MeetingBriefingPayload, PlanItem } from '../../types'
import type { MeetingBriefingRow } from './MeetingBriefingCard'
import Timeline from './Timeline'

// 시간표 회의 행의 인라인 회의 브리핑 (docs/ASSISTANT.md 부록 L.8 V3·V4·V7, 2차 개편 완료 조건 5).
// 자동 클릭 검증은 불가하다. renderToStaticMarkup 으로 첫 그리기를 확인한다

const timeline: DayTimeline = {
  entries: [
    { kind: 'meeting', start: '14:00', end: '15:00', title: '[디자인] 홈 화면 리뷰와 다음 분기 우선순위 정리' },
    { kind: 'block', start: '09:00', end: '10:00', minutes: 60, state: 'past', itemId: null, reason: null, continued: false },
    { kind: 'meeting', start: '10:00', end: '10:30', title: '아침 스탠드업' },
    { kind: 'block', start: '10:30', end: '11:00', minutes: 30, state: 'current', itemId: 1, reason: 'focus', continued: false },
    { kind: 'meeting', start: '11:00', end: '12:00', title: '결제 주간 회의' },
    { kind: 'meeting', start: '16:00', end: '17:00', title: '브리핑 없는 회의' }
  ],
  freeMinutesLeft: 30,
  focusItemId: 1,
  unplacedDeadlineItemIds: []
}

const items = [
  {
    id: 1,
    title: '환불 API 정리',
    status: 'in_progress',
    first_planned_date: '2026-11-02',
    due_date: null
  }
] as unknown as PlanItem[]

const payloadAt = (
  title: string,
  startAt: string,
  over: Partial<MeetingBriefingPayload> = {}
): MeetingBriefingPayload => ({
  meeting: { id: `cal-${title}`, title, startAt, endAt: startAt },
  title: `${title} 15분 전`,
  body: '',
  projects: [],
  hasContext: true,
  ruleMarkdown: `# ${title}\n- 본문 ${title}`,
  llmStatus: 'off',
  llmMarkdown: null,
  llmModel: null,
  llmAt: null,
  llmError: null,
  ...over
})

const rowOf = (id: number, payload: MeetingBriefingPayload): MeetingBriefingRow => ({
  event: {
    id,
    event_key: `meeting_briefing:2026-11-02:${payload.meeting.id}`,
    kind: 'meeting_briefing',
    plan_date: '2026-11-02',
    scheduled_at: payload.meeting.startAt,
    fired_at: payload.meeting.startAt,
    status: 'sent',
    ref_id: payload.meeting.id,
    payload: JSON.stringify(payload),
    response: null,
    responded_at: null,
    created_at: payload.meeting.startAt
  } as AssistantEvent,
  payload
})

const BRIEFINGS: MeetingBriefingRow[] = [
  rowOf(40, payloadAt('결제 주간 회의', '2026-11-02 11:00:00')),
  rowOf(41, payloadAt('[디자인] 홈 화면 리뷰와 다음 분기 우선순위 정리', '2026-11-02 14:00:00')),
  rowOf(42, payloadAt('아침 스탠드업', '2026-11-02 10:00:00')),
  // 시간표에 없는 회의다. 시간표에 붙지 않는다
  rowOf(43, payloadAt('외부 미팅', '2026-11-02 13:00:00'))
]

const render = (
  opts: {
    briefings?: MeetingBriefingRow[]
    now?: string
    regeneratingIds?: number[]
    canRegenerate?: boolean
  } = {}
): string =>
  renderToStaticMarkup(
    <Timeline
      timeline={timeline}
      items={items}
      logicalDate="2026-11-02"
      meetingBriefings={opts.briefings}
      now={opts.now}
      regeneratingIds={opts.regeneratingIds}
      canRegenerate={opts.canRegenerate}
      onRegenerate={() => {}}
    />
  )

// 회의 행 하나(<li>…</li>)의 마크업이다
const rowHtml = (html: string, title: string): string => {
  const at = html.indexOf(title)
  const start = html.lastIndexOf('<li', at)
  const end = html.indexOf('</li>', at)
  return html.slice(start, end + '</li>'.length)
}

describe('Timeline 인라인 회의 브리핑 (완료 조건 5)', () => {
  it('짝이 맞는 회의 행 아래에 meeting-briefing-<eventId> 블록을 그린다', () => {
    const html = render({ briefings: BRIEFINGS, now: '2026-11-02 10:50:00' })
    const pay = rowHtml(html, '결제 주간 회의')
    expect(pay).toContain('id="meeting-briefing-40"')
    expect(pay.indexOf('결제 주간 회의')).toBeLessThan(pay.indexOf('id="meeting-briefing-40"'))
    expect(rowHtml(html, '[디자인] 홈 화면 리뷰')).toContain('id="meeting-briefing-41"')
    expect(rowHtml(html, '아침 스탠드업')).toContain('id="meeting-briefing-42"')
  })

  it('시간표에 없는 회의의 브리핑과 짝 없는 회의 행에는 블록이 없다', () => {
    const html = render({ briefings: BRIEFINGS, now: '2026-11-02 10:50:00' })
    expect(html).not.toContain('meeting-briefing-43')
    expect(html).not.toContain('외부 미팅')
    const lonely = rowHtml(html, '브리핑 없는 회의')
    expect(lonely).not.toContain('meeting-briefing-')
    expect(lonely).not.toContain('<button')
  })

  it('가장 가까운 시작 전 회의는 본문이 보이고 다른 회의는 접혀 본문이 없다', () => {
    const html = render({ briefings: BRIEFINGS, now: '2026-11-02 10:50:00' })
    // 10:00 은 지났다. 11:00 이 가장 가깝다. 14:00 은 그다음이다
    const pay = rowHtml(html, '결제 주간 회의')
    expect(pay).toContain('본문 결제 주간 회의')
    expect(pay).toContain('aria-expanded="true"')
    expect(pay).toContain('브리핑 접기')
    for (const title of ['[디자인] 홈 화면 리뷰', '아침 스탠드업']) {
      const row = rowHtml(html, title)
      expect(row).toContain('aria-expanded="false"')
      expect(row).toMatch(/>브리핑<\/button>/)
      expect(row).not.toContain('본문 ')
      expect(row).not.toContain('규칙 브리핑')
    }
  })

  it('now 가 없으면 기본 펼침이 없다', () => {
    const html = render({ briefings: BRIEFINGS })
    expect(html).not.toContain('aria-expanded="true"')
    expect(html).not.toContain('본문 ')
  })

  it('펼친 본문에 배지·다시 만들기·pending 안내를 둔다', () => {
    const briefings = [
      rowOf(40, payloadAt('결제 주간 회의', '2026-11-02 11:00:00', { llmStatus: 'pending' }))
    ]
    const html = render({ briefings, now: '2026-11-02 10:50:00', canRegenerate: true })
    const pay = rowHtml(html, '결제 주간 회의')
    expect(pay).toContain('규칙 브리핑')
    expect(pay).toContain('AI 브리핑 만드는 중…')
    expect(pay).toContain('다시 만들기')
  })

  it('펼친 본문에 failed 안내를 두고, 다시 만드는 중이면 버튼이 비활성이다', () => {
    const briefings = [
      rowOf(
        40,
        payloadAt('결제 주간 회의', '2026-11-02 11:00:00', { llmStatus: 'failed', llmError: '시간 초과' })
      )
    ]
    const html = render({
      briefings,
      now: '2026-11-02 10:50:00',
      canRegenerate: true,
      regeneratingIds: [40]
    })
    const pay = rowHtml(html, '결제 주간 회의')
    expect(pay).toContain('AI 브리핑을 마치지 못했어요. 시간 초과')
    expect(pay).toMatch(/<button[^>]*disabled=""[^>]*>다시 만들기<\/button>/)
  })

  it('canRegenerate 가 없으면 다시 만들기를 숨긴다', () => {
    const html = render({ briefings: BRIEFINGS, now: '2026-11-02 10:50:00' })
    expect(html).not.toContain('다시 만들기')
  })

  it('브리핑 모드의 회의 제목은 자르지 않고 줄바꿈한다 (V7)', () => {
    const html = render({ briefings: BRIEFINGS, now: '2026-11-02 10:50:00' })
    const design = rowHtml(html, '[디자인] 홈 화면 리뷰')
    expect(design).toContain('break-words')
    expect(design).not.toContain('truncate')
  })

  it('같은 키의 회의 행이 둘이면 앞 행에만 붙여 블록 id 가 겹치지 않는다', () => {
    const dup: DayTimeline = {
      ...timeline,
      entries: [
        { kind: 'meeting', start: '11:00', end: '11:30', title: '결제 주간 회의' },
        { kind: 'meeting', start: '11:00', end: '12:00', title: '결제 주간 회의' }
      ]
    }
    const html = renderToStaticMarkup(
      <Timeline
        timeline={dup}
        items={[]}
        logicalDate="2026-11-02"
        meetingBriefings={BRIEFINGS}
        now="2026-11-02 10:50:00"
      />
    )
    expect(html.split('id="meeting-briefing-40"')).toHaveLength(2)
  })
})

describe('Timeline 브리핑 prop 이 없을 때 (완료 조건 5)', () => {
  it('회의 행에 브리핑 버튼과 블록이 없고 개편 전 모양이다', () => {
    const html = render()
    expect(html).not.toContain('<button')
    expect(html).not.toMatch(/>브리핑( 접기)?</)
    expect(html).not.toContain('meeting-briefing-')
    // 회의 행 모양은 그대로다. 제목은 말줄임 없이 줄바꿈한다(사용자 피드백 2026-11-05)
    expect(html).toContain(
      '<li class="flex items-center gap-3 px-5 py-3 border-b border-gray-100 last:border-b-0">'
    )
    expect(html).toContain('<span class="min-w-0 break-words text-base text-gray-700">')
    expect(html).not.toContain('truncate')
  })

  it('항목이 없으면 그리지 않는다', () => {
    const empty: DayTimeline = { ...timeline, entries: [] }
    expect(
      renderToStaticMarkup(
        <Timeline timeline={empty} items={[]} logicalDate="2026-11-02" meetingBriefings={BRIEFINGS} />
      )
    ).toBe('')
  })
})
