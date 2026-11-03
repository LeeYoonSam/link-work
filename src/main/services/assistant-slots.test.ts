import { describe, expect, it } from 'vitest'
import { buildStartPlanItems, buildTimeline, calendarToBusy, computeFreeSlots, roundUpToQuarter } from './assistant-slots'
import type { CalendarRef, PlanItem, TimelineEntry } from './assistant-types'
import { cand, deepFreeze, item, TODAY } from './__fixtures__/assistant/factories'

function ev(id: string, start: string, end: string, title = id): CalendarRef {
  return { id, title, start, end, allDay: false }
}

type TimelineArgs = Parameters<typeof buildTimeline>[0]
function tl(over: Partial<TimelineArgs> & { items: PlanItem[] }): ReturnType<typeof buildTimeline> {
  return buildTimeline({
    calendar: [], dayStart: '09:00', nowHHmm: '09:00', workEnd: '18:00', today: TODAY, closed: false, ...over
  })
}

type Block = Extract<TimelineEntry, { kind: 'block' }>
function blocks(t: ReturnType<typeof buildTimeline>): Block[] {
  return t.entries.filter((e): e is Block => e.kind === 'block')
}
/** [start, state, itemId, reason, continued] 요약 */
function brief(t: ReturnType<typeof buildTimeline>): Array<[string, string, number | null, string | null, boolean]> {
  return blocks(t).map((b) => [b.start, b.state, b.itemId, b.reason, b.continued])
}

describe('roundUpToQuarter', () => {
  it('15분 단위로 올린다', () => {
    expect(roundUpToQuarter('09:40')).toBe('09:45')
    expect(roundUpToQuarter('09:45')).toBe('09:45')
    expect(roundUpToQuarter('09:46')).toBe('10:00')
    expect(roundUpToQuarter('00:00')).toBe('00:00')
    expect(roundUpToQuarter('23:50')).toBe('24:00')
  })
})

describe('calendarToBusy', () => {
  it('종일 일정을 빼고 시작 순으로 정렬한다', () => {
    const busy = calendarToBusy([
      { id: 'b', title: '회의2', start: '14:00', end: '15:00', allDay: false },
      { id: 'a', title: '휴가', start: '00:00', end: '23:59', allDay: true },
      { id: 'c', title: '회의1', start: '10:00', end: '10:30', allDay: false }
    ])
    expect(busy).toEqual([
      { start: '10:00', end: '10:30' },
      { start: '14:00', end: '15:00' }
    ])
  })
})

describe('computeFreeSlots §5.2', () => {
  it('겹치는 일정을 합친 뒤 뺀다', () => {
    const slots = computeFreeSlots('09:00', '18:00', [
      { start: '10:00', end: '11:00' },
      { start: '10:30', end: '12:00' },
      { start: '12:00', end: '12:30' }
    ])
    expect(slots).toEqual([
      { start: '09:00', end: '10:00' },
      { start: '12:30', end: '18:00' }
    ])
  })

  it('30분 미만 구간을 버린다', () => {
    const slots = computeFreeSlots('09:00', '12:00', [
      { start: '09:20', end: '10:00' },
      { start: '10:29', end: '11:00' }
    ])
    // 09:00~09:20(20분), 10:00~10:29(29분) 은 버린다
    expect(slots).toEqual([{ start: '11:00', end: '12:00' }])
  })

  it('from 이 workEnd 이후면 빈 슬롯이 없다', () => {
    expect(computeFreeSlots('18:15', '18:00', [])).toEqual([])
    expect(computeFreeSlots('18:00', '18:00', [])).toEqual([])
  })

  it('from 이전·workEnd 이후 일정은 잘라서 본다', () => {
    expect(computeFreeSlots('10:00', '12:00', [{ start: '08:00', end: '10:30' }, { start: '11:30', end: '19:00' }])).toEqual([
      { start: '10:30', end: '11:30' }
    ])
  })
})

describe('buildStartPlanItems B.6', () => {
  it('점수 순 상위 planSize 개를 slot NULL·pinned false·status planned 로 만든다', () => {
    const items = buildStartPlanItems(
      [
        cand({ id: 'todo:1', dueDate: '2026-11-10' }),
        cand({ id: 'jira:P-1', jiraKey: 'P-1', jiraPriority: 'Highest', priority: 'high', link: 'u' }),
        cand({ id: 'todo:3' })
      ],
      TODAY,
      2
    )
    expect(items).toEqual([
      expect.objectContaining({
        candidate_id: 'jira:P-1', rank: 1, slot_start: null, slot_end: null, added_by: 'start',
        status: 'planned', pinned: false, urgent: true, jira_issue_key: 'P-1', link: 'u'
      }),
      expect.objectContaining({ candidate_id: 'todo:1', rank: 2, slot_start: null, slot_end: null, urgent: false })
    ])
    expect(items[0]).not.toHaveProperty('first_planned_date')
  })

  it('planSize 가 0 이면 빈 목록이다', () => {
    expect(buildStartPlanItems([cand({ id: 'todo:1' })], TODAY, 0)).toEqual([])
  })

  it('A14: 입력을 바꾸지 않고 같은 입력에 같은 결과를 낸다', () => {
    const cands = deepFreeze([cand({ id: 'todo:2' }), cand({ id: 'todo:1', dueDate: TODAY })])
    expect(buildStartPlanItems(cands, TODAY, 5)).toEqual(buildStartPlanItems(cands, TODAY, 5))
  })
})

describe('buildTimeline B.3', () => {
  it('A23: 회의를 뺀 구간이 블록이고 회의와 시간순으로 섞인다. 종일 일정은 뺀다', () => {
    const t = tl({
      calendar: [ev('b', '14:00', '15:00', '리뷰'), ev('a', '10:00', '11:00', '스탠드업'), { id: 'h', title: '휴가', start: '00:00', end: '23:59', allDay: true }],
      items: [item({ id: 1, rank: 1 })]
    })
    expect(t.entries.map((e) => [e.kind, e.start, e.end])).toEqual([
      ['block', '09:00', '10:00'],
      ['meeting', '10:00', '11:00'],
      ['block', '11:00', '14:00'],
      ['meeting', '14:00', '15:00'],
      ['block', '15:00', '18:00']
    ])
    expect(t.entries[1]).toMatchObject({ kind: 'meeting', title: '스탠드업' })
    expect(blocks(t).map((b) => b.minutes)).toEqual([60, 180, 180])
  })

  it('A23: dayStart 를 15분 단위로 올린다', () => {
    const t = tl({ dayStart: '09:40', nowHHmm: '09:40', items: [] })
    expect(blocks(t)[0]).toMatchObject({ start: '09:45', end: '18:00' })
  })

  it('A23: 첫 블록은 집중 작업이 지키고 마감 항목은 가장 늦은 블록을 받는다', () => {
    const items = [
      item({ id: 1, rank: 1 }),
      item({ id: 2, rank: 2, due_date: TODAY }),
      item({ id: 3, rank: 3, due_date: '2026-10-30' }), // 지난 마감
      item({ id: 4, rank: 4, due_date: '2026-11-03' }) // 내일 마감은 마감 항목이 아니다
    ]
    const t = tl({
      calendar: [ev('a', '10:00', '11:00'), ev('b', '12:00', '13:00'), ev('c', '14:00', '15:00')],
      items
    })
    expect(brief(t)).toEqual([
      ['09:00', 'current', 1, 'focus', false],
      ['11:00', 'future', 1, 'focus', true],
      ['13:00', 'future', 3, 'deadline', false],
      ['15:00', 'future', 2, 'deadline', false]
    ])
    expect(t.focusItemId).toBe(1)
    expect(t.unplacedDeadlineItemIds).toEqual([])
  })

  it('A23: 블록이 모자라면 배정받지 못한 마감 항목이 unplacedDeadlineItemIds 에 들어간다', () => {
    const items = [item({ id: 1, rank: 1 }), item({ id: 2, rank: 2, due_date: TODAY }), item({ id: 3, rank: 3, due_date: TODAY })]
    const t = tl({ calendar: [ev('a', '12:00', '13:00')], items })
    expect(brief(t)).toEqual([
      ['09:00', 'current', 1, 'focus', false],
      ['13:00', 'future', 2, 'deadline', false]
    ])
    expect(t.unplacedDeadlineItemIds).toEqual([3])

    // 배정 가능 블록이 하나뿐이면 집중 작업이 지킨다
    const one = tl({ items })
    expect(brief(one)).toEqual([['09:00', 'current', 1, 'focus', false]])
    expect(one.unplacedDeadlineItemIds).toEqual([2, 3])
  })

  it('A23: 같은 항목이 이어지면 continued 이고, 30분 미만 블록은 배정하지 않고 건너뛴다', () => {
    const t = tl({
      calendar: [ev('a', '10:00', '11:00'), ev('b', '11:20', '12:00')],
      items: [item({ id: 7, rank: 1 })]
    })
    expect(brief(t)).toEqual([
      ['09:00', 'current', 7, 'focus', false],
      ['11:00', 'future', null, null, false], // 20분 블록. 보이지만 배정하지 않는다
      ['12:00', 'future', 7, 'focus', true]
    ])
    expect(blocks(t)[1].minutes).toBe(20)
  })

  it('A23: past·current·future 를 판정하고 current 의 남은 길이가 30분 미만이면 배정하지 않는다', () => {
    const calendar = [ev('a', '10:00', '11:00'), ev('b', '12:00', '13:00')]
    const items = [item({ id: 1, rank: 1 })]
    const t = tl({ calendar, nowHHmm: '11:40', items })
    expect(brief(t)).toEqual([
      ['09:00', 'past', null, null, false],
      ['11:00', 'current', null, null, false], // 남은 20분
      ['13:00', 'future', 1, 'focus', false]
    ])
    // 블록 끝 시각이 지금이면 past 다
    expect(brief(tl({ calendar, nowHHmm: '10:00', items }))[0][1]).toBe('past')
    // current 의 남은 길이가 30분 이상이면 배정한다
    expect(brief(tl({ calendar, nowHHmm: '11:30', items }))[1]).toEqual(['11:00', 'current', 1, 'focus', false])
  })

  it('A23: freeMinutesLeft 는 배정 가능 블록의 남은 길이 합이다', () => {
    const calendar = [ev('a', '10:00', '11:00'), ev('b', '11:20', '12:00')]
    // 10:30 기준: 09~10 past, 11:00~11:20 은 20분이라 제외, 12~18 은 360분
    expect(tl({ calendar, nowHHmm: '10:30', items: [] }).freeMinutesLeft).toBe(360)
    // 09:15 기준: current 09:15~10:00 남은 45분 + 360분
    expect(tl({ calendar, nowHHmm: '09:15', items: [] }).freeMinutesLeft).toBe(405)
  })

  it('A23: 닫힌 계획은 모든 블록이 past 이고 배정하지 않는다', () => {
    const t = tl({
      closed: true,
      calendar: [ev('a', '12:00', '13:00')],
      items: [item({ id: 1, rank: 1 }), item({ id: 2, rank: 2, due_date: TODAY })]
    })
    expect(brief(t)).toEqual([
      ['09:00', 'past', null, null, false],
      ['13:00', 'past', null, null, false]
    ])
    expect(t.freeMinutesLeft).toBe(0)
    expect(t.unplacedDeadlineItemIds).toEqual([])
  })

  it('A23: 집중 작업은 활성 항목 중 rank 가 가장 앞이고, 활성 항목이 없으면 null 이다', () => {
    const items = [
      item({ id: 1, rank: 1, status: 'done' }),
      item({ id: 2, rank: 2, status: 'deferred' }),
      item({ id: 3, rank: 3, status: 'in_progress' }),
      item({ id: 4, rank: null, status: 'suggested', due_date: TODAY }),
      item({ id: 5, rank: 4, due_date: TODAY })
    ]
    const t = tl({ calendar: [ev('a', '12:00', '13:00')], items })
    expect(t.focusItemId).toBe(3)
    expect(brief(t)).toEqual([
      ['09:00', 'current', 3, 'focus', false],
      ['13:00', 'future', 5, 'deadline', false]
    ])

    const none = tl({ items: [item({ id: 1, status: 'done' })] })
    expect(none.focusItemId).toBeNull()
    expect(brief(none)).toEqual([['09:00', 'current', null, null, false]])
  })

  it('A23: dayStart 가 workEnd 이후면 블록이 없다', () => {
    const t = tl({ dayStart: '18:10', nowHHmm: '18:10', calendar: [ev('a', '17:00', '17:30')], items: [item({ id: 1 })] })
    expect(blocks(t)).toEqual([])
    expect(t.entries.map((e) => e.kind)).toEqual(['meeting'])
    expect(t.freeMinutesLeft).toBe(0)
  })

  it('A14: 입력을 바꾸지 않고 같은 입력에 같은 결과를 낸다', () => {
    const input = deepFreeze({
      calendar: [ev('b', '14:00', '15:00'), ev('a', '10:00', '11:00')],
      dayStart: '09:00',
      nowHHmm: '10:30',
      workEnd: '18:00',
      items: [item({ id: 2, rank: 2, due_date: TODAY }), item({ id: 1, rank: 1 })],
      today: TODAY,
      closed: false
    })
    const a = buildTimeline(input)
    expect(a).toEqual(buildTimeline(input))
    expect(input.items[0].id).toBe(2)
  })
})

describe('A49: 묶음 항목 (부록 J.4)', () => {
  it('A49: buildStartPlanItems 는 묶음 후보를 순위 매기기 전에 뺀다', () => {
    const items = buildStartPlanItems(
      [
        cand({ id: 'jira:ICA-8054', jiraKey: 'ICA-8054', jiraPriority: 'Highest', priority: 'high', title: '안드로이드QA-2026', workType: 'qa' }),
        cand({
          id: 'jira:ICA-8971', jiraKey: 'ICA-8971', parentKey: 'ICA-8054', groupName: '안드로이드QA-2026',
          workType: 'qa', workVersion: '4.174.0'
        }),
        cand({ id: 'todo:1' })
      ],
      TODAY,
      2
    )
    expect(items.map((i) => i.candidate_id)).toEqual(['jira:ICA-8971', 'todo:1'])
    expect(items[0]).toMatchObject({
      rank: 1, work_type: 'qa', work_version: '4.174.0', parent_key: 'ICA-8054', group_name: '안드로이드QA-2026'
    })
    expect(items[1]).toMatchObject({ work_type: 'etc', work_version: null, parent_key: null, group_name: null })
  })

  it('A49: 하위가 없는 에픽 후보는 보통 후보로 계획에 든다', () => {
    const items = buildStartPlanItems([cand({ id: 'jira:ICA-8929', jiraKey: 'ICA-8929', workType: 'prd' })], TODAY, 3)
    expect(items.map((i) => i.candidate_id)).toEqual(['jira:ICA-8929'])
  })

  it('A49: buildTimeline 은 묶음 항목을 집중 작업·블록 배정에서 뺀다', () => {
    const items = [
      item({ id: 1, rank: 1, candidate_id: 'jira:ICA-8054', jira_issue_key: 'ICA-8054', status: 'in_progress', due_date: TODAY }),
      item({ id: 2, rank: 2, candidate_id: 'jira:ICA-8971', jira_issue_key: 'ICA-8971', parent_key: 'ICA-8054' }),
      item({ id: 3, rank: 3, due_date: TODAY })
    ]
    const t = tl({ calendar: [ev('a', '10:00', '11:00'), ev('b', '14:00', '15:00')], items })
    expect(t.focusItemId).toBe(2)
    const assigned = blocks(t).map((b) => b.itemId)
    expect(assigned).not.toContain(1)
    expect(assigned).toEqual([2, 2, 3])
    expect(t.unplacedDeadlineItemIds).not.toContain(1)
  })

  it('A49: 하위가 suggested 뿐이면 에픽이 집중 작업이 된다', () => {
    const items = [
      item({ id: 1, rank: 1, candidate_id: 'jira:ICA-8054', jira_issue_key: 'ICA-8054' }),
      item({ id: 2, rank: null, candidate_id: 'jira:ICA-8971', parent_key: 'ICA-8054', status: 'suggested' })
    ]
    expect(tl({ items }).focusItemId).toBe(1)
  })
})
