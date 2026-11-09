import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AssistantEvent, DayTimeline, MeetingBriefingPayload } from '../../types'
import type { MeetingBriefingRow } from './MeetingBriefingCard'
import Timeline, { isOnlineLocation, meetingEntriesOf, meetingTiming, nextMeetingIndex } from './Timeline'

// 오늘 카드의 회의 구역 (docs/ASSISTANT.md 부록 M.4·M.5.7)과 인라인 회의 브리핑 (부록 L.8 V3·V4·V7).
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
      meetingBriefings={opts.briefings}
      now={opts.now ?? ''}
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

  it('now 가 빈 문자열이면 기본 펼침이 없다', () => {
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
        meetingBriefings={BRIEFINGS}
        now="2026-11-02 10:50:00"
      />
    )
    expect(html.split('id="meeting-briefing-40"')).toHaveLength(2)
  })
})

describe('meetingTiming·nextMeetingIndex (부록 M.5.7)', () => {
  const m = { start: '11:00', end: '12:00' }

  it('끝났으면 past, 진행 중이면 current, 15분 이내면 soon, 나머지는 later 다', () => {
    expect(meetingTiming(m, '12:00')).toBe('past')
    expect(meetingTiming(m, '13:10')).toBe('past')
    expect(meetingTiming(m, '11:00')).toBe('current')
    expect(meetingTiming(m, '11:59')).toBe('current')
    expect(meetingTiming(m, '10:45')).toBe('soon')
    expect(meetingTiming(m, '10:59')).toBe('soon')
    expect(meetingTiming(m, '10:44')).toBe('later')
    expect(meetingTiming(m, '09:00')).toBe('later')
  })

  it('형식이 아닌 시각은 later 로 본다', () => {
    expect(meetingTiming(m, '')).toBe('later')
  })

  it('진행 중 행이 있으면 그 행, 없으면 시작 전 첫 행, 둘 다 없으면 -1 이다', () => {
    const entries = [
      { start: '10:00', end: '10:30' },
      { start: '11:00', end: '12:00' },
      { start: '14:00', end: '15:00' }
    ]
    expect(nextMeetingIndex(entries, '11:20')).toBe(1)
    expect(nextMeetingIndex(entries, '10:40')).toBe(1)
    expect(nextMeetingIndex(entries, '09:00')).toBe(0)
    expect(nextMeetingIndex(entries, '12:30')).toBe(2)
    expect(nextMeetingIndex(entries, '16:00')).toBe(-1)
  })

  it('meetingEntriesOf 는 회의만 시작순으로 꺼낸다', () => {
    expect(meetingEntriesOf(timeline).map((e) => e.start)).toEqual(['10:00', '11:00', '14:00', '16:00'])
  })
})

describe('Timeline 회의 구역 (부록 M.4)', () => {
  // 회의 행 <li> 들만 순서대로 꺼낸다
  const meetingRows = (html: string): string[] =>
    [...html.matchAll(/<li data-timing="[^"]*"[\s\S]*?<\/li>/g)].map((x) => x[0])

  it('회의 행만 그리고 빈 시간 블록 행은 그리지 않는다', () => {
    const html = render({ now: '2026-11-02 10:50:00' })
    expect(meetingRows(html)).toHaveLength(4)
    expect(html).not.toContain('빈 시간')
    expect(html).not.toContain('data-state=')
  })

  it('회의 제목 앞에 회의 접두사를 붙이지 않는다', () => {
    const html = render({ now: '2026-11-02 10:50:00' })
    expect(html).not.toContain('[회의]')
    expect(html).toContain('>아침 스탠드업<')
  })

  it('회의 행은 4열 그리드이고 1열에 오른쪽 정렬 HH:mm - HH:mm 을 쓴다 (P1)', () => {
    const html = render({ now: '2026-11-02 10:50:00' })
    const row = rowHtml(html, '결제 주간 회의')
    expect(row).toContain('grid grid-cols-[6.5rem_0.125rem_minmax(0,1fr)_auto]')
    expect(row).toMatch(/<span class="pt-0\.5 text-right [^"]*whitespace-nowrap">11:00 - 12:00<\/span>/)
    expect(row).toContain('border-l-[3px]')
    // 제목은 text-base font-medium 이다 (P5)
    expect(row).toMatch(/<p class="[^"]*text-base[^"]*font-medium">결제 주간 회의<\/p>/)
  })

  it('지난 회의는 흐리고 다음 회의 1건만 보라 막대를 받는다', () => {
    const html = render({ now: '2026-11-02 10:50:00' })
    const rows = meetingRows(html)
    expect(rows[0]).toContain('data-timing="past"')
    expect(rows[0]).toContain('opacity-60')
    expect(rows[1]).toContain('data-timing="soon"')
    expect(rows[1]).toContain('<div data-meeting-bar="" class="w-0.5 rounded-full bg-purple-400"></div>')
    expect(html.split('bg-purple-400')).toHaveLength(2)
    for (const r of [rows[0], rows[2], rows[3]]) {
      expect(r).toContain('<div data-meeting-bar="" class="w-0.5 rounded-full bg-gray-200"></div>')
    }
    // 바깥 3px 막대는 모든 회의 행에서 투명이다 (P2)
    for (const r of rows) expect(r).toContain('border-l-transparent')
    expect(html).not.toContain('border-l-purple-400')
  })

  it('15분 이내 회의는 n분 후 를 보라 굵은 글자로 쓴다', () => {
    const html = render({ now: '2026-11-02 10:50:00' })
    const row = rowHtml(html, '결제 주간 회의')
    expect(row).toMatch(/<p class="[^"]*text-purple-700 font-semibold[^"]*">10분 후<\/p>/)
    expect(rowHtml(html, '[디자인] 홈 화면 리뷰')).not.toContain('분 후')
  })

  it('진행 중 회의는 진행 중 을 쓰고 그 행이 강조를 받는다', () => {
    const html = render({ now: '2026-11-02 11:20:00' })
    const row = rowHtml(html, '결제 주간 회의')
    expect(row).toContain('data-timing="current"')
    expect(row).toContain('bg-purple-400')
    expect(row).toMatch(/text-purple-700 font-semibold[^"]*">진행 중<\/p>/)
    expect(html.split('bg-purple-400')).toHaveLength(2)
  })

  it('지난·진행 중 회의와 시작 전 회의 사이에 현재 시각 선을 1줄 그린다', () => {
    const html = render({ now: '2026-11-02 11:20:00' })
    expect(html.split('data-now-line')).toHaveLength(2)
    expect(html).toContain('지금 11:20')
    expect(html).toContain('h-px flex-1 bg-blue-500')
    const line = html.indexOf('data-now-line')
    expect(html.indexOf('결제 주간 회의')).toBeLessThan(line)
    expect(line).toBeLessThan(html.indexOf('[디자인] 홈 화면 리뷰'))
  })

  it('모든 회의가 시작 전이거나 모두 지났으면 현재 시각 선이 없다', () => {
    expect(render({ now: '2026-11-02 08:00:00' })).not.toContain('data-now-line')
    expect(render({ now: '2026-11-02 18:00:00' })).not.toContain('data-now-line')
  })

  it('모든 회의가 지났으면 강조 막대가 없다', () => {
    expect(render({ now: '2026-11-02 18:00:00' })).not.toContain('bg-purple-400')
  })

  it('브리핑이 없으면 버튼과 블록이 없다', () => {
    const html = render({ now: '2026-11-02 10:50:00' })
    expect(html).not.toContain('<button')
    expect(html).not.toContain('meeting-briefing-')
    expect(html).not.toContain('truncate')
  })

  it('회의가 없으면 그리지 않는다', () => {
    const blocksOnly: DayTimeline = {
      ...timeline,
      entries: timeline.entries.filter((e) => e.kind === 'block')
    }
    expect(
      renderToStaticMarkup(<Timeline timeline={blocksOnly} now="2026-11-02 10:50:00" meetingBriefings={BRIEFINGS} />)
    ).toBe('')
    expect(
      renderToStaticMarkup(<Timeline timeline={{ ...timeline, entries: [] }} now="2026-11-02 10:50:00" />)
    ).toBe('')
  })
})

describe('Timeline 회의 메모·장소 (부록 M.10 P3·P4)', () => {
  const HTML_NOTE =
    '<p>안건을 미리 봐 주세요.</p><ul><li>환불 API</li><li>정산 일정</li></ul>' +
    '<p>자료: <a href="https://docs.example.com/x">회의 자료</a></p><script>alert(1)</script>'
  const withPlaces: DayTimeline = {
    ...timeline,
    entries: [
      { kind: 'meeting', start: '10:00', end: '10:30', title: '아침 스탠드업', location: '본사 3층 회의실 A', note: null },
      {
        kind: 'meeting',
        start: '11:00',
        end: '12:00',
        title: '결제 주간 회의',
        location: 'https://meet.google.com/abc-defg-hij',
        note: HTML_NOTE
      },
      { kind: 'meeting', start: '14:00', end: '15:00', title: '메모 없는 회의' },
      { kind: 'meeting', start: '16:00', end: '17:00', title: '빈 값 회의', location: '  ', note: '  ' }
    ]
  }
  const renderPlaces = (notesExpandedInitial?: boolean): string =>
    renderToStaticMarkup(
      <Timeline
        timeline={withPlaces}
        now="2026-11-02 10:50:00"
        notesExpandedInitial={notesExpandedInitial}
      />
    )
  // 메모 안에 <li> 가 있다. 그래서 다음 회의 행 앞까지를 한 행으로 자른다
  const rowOfTitle = (html: string, title: string): string => {
    const at = html.indexOf(title)
    const start = html.lastIndexOf('<li data-timing=', at)
    const next = html.indexOf('<li data-timing=', at)
    return html.slice(start, next === -1 ? undefined : next)
  }

  it('isOnlineLocation 은 http 로 시작하는 값만 참이다', () => {
    expect(isOnlineLocation('https://zoom.us/j/1')).toBe(true)
    expect(isOnlineLocation('http://meet.example.com')).toBe(true)
    expect(isOnlineLocation('본사 3층')).toBe(false)
  })

  it('HTML 메모를 링크·목록 태그로 그린다', () => {
    const row = rowOfTitle(renderPlaces(), '결제 주간 회의')
    expect(row).toContain('data-meeting-note')
    expect(row).toMatch(/<ul[^>]*>[\s\S]*<li[^>]*>환불 API<\/li>[\s\S]*<li[^>]*>정산 일정<\/li>/)
    expect(row).toMatch(/<a [^>]*href="https:\/\/docs\.example\.com\/x"[^>]*>회의 자료<\/a>/)
    expect(row).toContain('안건을 미리 봐 주세요.')
  })

  it('위험 태그 script 는 메모에서 빠진다', () => {
    const html = renderPlaces(true)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('메모는 기본으로 접혀 있고 더 보기 버튼이 있다', () => {
    const row = rowOfTitle(renderPlaces(), '결제 주간 회의')
    expect(row).toContain('<div class="mt-1 max-h-[3.25rem] overflow-hidden">')
    expect(row).toMatch(/<button type="button" aria-expanded="false" class="mt-1 text-sm text-blue-600[^"]*">더 보기<\/button>/)
  })

  it('펼친 상태를 주입하면 접힘 클래스가 없고 접기 버튼이 있다', () => {
    const row = rowOfTitle(renderPlaces(true), '결제 주간 회의')
    expect(row).not.toContain('max-h-[3.25rem]')
    expect(row).toMatch(/aria-expanded="true" class="mt-1 text-sm text-blue-600[^"]*">접기<\/button>/)
  })

  it('메모 본문 글자는 text-sm 이고 text-xs 를 쓰지 않는다 (P5)', () => {
    const row = rowOfTitle(renderPlaces(), '결제 주간 회의')
    expect(row).toContain('[&amp;_p]:text-sm')
    expect(row).not.toContain('text-xs')
  })

  it('장소는 메모 아래에 라벨 없이 회색 글자로 보인다', () => {
    const html = renderPlaces()
    const row = rowOfTitle(html, '아침 스탠드업')
    expect(row).toContain('<p data-meeting-location="" class="mt-1 text-sm text-gray-400 break-words">본사 3층 회의실 A</p>')
    expect(html).not.toContain('장소 ')
    const pay = rowOfTitle(html, '결제 주간 회의')
    expect(pay.indexOf('data-meeting-note')).toBeLessThan(pay.indexOf('data-meeting-location'))
  })

  it('http 장소는 온라인 회의 글자의 외부 링크로 보인다', () => {
    const row = rowOfTitle(renderPlaces(), '결제 주간 회의')
    expect(row).toMatch(
      /<a href="https:\/\/meet\.google\.com\/abc-defg-hij" target="_blank" rel="noreferrer"[^>]*>온라인 회의<\/a>/
    )
    expect(row).not.toContain('>https://meet.google.com')
  })

  it('장소와 메모가 없거나 비면 줄과 더 보기 버튼이 없다', () => {
    const html = renderPlaces()
    for (const title of ['메모 없는 회의', '빈 값 회의']) {
      const row = rowOfTitle(html, title)
      expect(row).not.toContain('data-meeting-location')
      expect(row).not.toContain('data-meeting-note')
      expect(row).not.toContain('더 보기')
    }
  })

  it('지난 회의 흐림과 다음 회의 보라 막대를 유지한다', () => {
    const html = renderPlaces()
    expect(rowOfTitle(html, '아침 스탠드업')).toContain('opacity-60')
    expect(rowOfTitle(html, '결제 주간 회의')).toContain('bg-purple-400')
  })
})
