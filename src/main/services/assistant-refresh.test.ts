import { describe, expect, it } from 'vitest'
import {
  bucketOf,
  buildPlanUpdateNotices,
  diffSources,
  focusUpdates,
  isInMeeting,
  planRefresh,
  rerank,
  shouldNotifyPlanUpdate
} from './assistant-refresh'
import { buildTimeline } from './assistant-slots'
import { buildCandidates } from './assistant-candidates'
import { scoreCandidate } from './assistant-score'
import type {
  CalendarRef,
  CurrentSources,
  DayTimeline,
  NoticeInput,
  PlanItem,
  RefreshContext,
  RefreshDiff,
  RefreshSummary,
  SourceSnapshot,
  TaskRow
} from './assistant-types'
import { cand, deepFreeze, item, snapshot, TODAY } from './__fixtures__/assistant/factories'

function ev(id: string, start: string, end: string, title = id): CalendarRef {
  return { id, title, start, end, allDay: false }
}

function ctx(over: Partial<RefreshContext> = {}): RefreshContext {
  return { today: TODAY, nowHHmm: '09:00', workEnd: '18:00', dayStart: '09:00', resolutions: {}, ...over }
}

function run(
  prev: SourceSnapshot,
  current: CurrentSources,
  items: PlanItem[],
  c: Partial<RefreshContext> = {}
): ReturnType<typeof planRefresh> {
  const diff = diffSources(prev, current, items)
  return planRefresh(diff, current, prev, items, ctx(c))
}

describe('diffSources §8.3', () => {
  it('일정 추가·변경·취소를 구분한다', () => {
    const prev = snapshot({ calendar: [ev('a', '10:00', '11:00'), ev('b', '13:00', '14:00'), ev('c', '15:00', '16:00')] })
    const diff = diffSources(
      prev,
      { candidates: [], calendar: [ev('a', '10:00', '11:00'), ev('b', '13:30', '14:30'), ev('d', '16:00', '17:00')], jira: [] },
      []
    )
    expect(diff.calendarAdded.map((e) => e.id)).toEqual(['d'])
    expect(diff.calendarChanged.map((e) => e.id)).toEqual(['b'])
    expect(diff.calendarRemoved.map((e) => e.id)).toEqual(['c'])
  })

  it('캘린더를 보지 않았으면 일정 변경이 없다', () => {
    const diff = diffSources(snapshot({ calendar: [ev('a', '10:00', '11:00')] }), { candidates: [], calendar: null, jira: null }, [])
    expect(diff.calendarRemoved).toEqual([])
  })

  it('새 후보는 스냅샷에서 본 적이 없고 계획 항목도 아닌 것이다', () => {
    const items = [item({ id: 1, candidate_id: 'todo:9', status: 'dismissed', rank: null })]
    const diff = diffSources(
      snapshot({ seenCandidateIds: ['todo:1'] }),
      { candidates: [cand({ id: 'todo:1' }), cand({ id: 'todo:2' }), cand({ id: 'todo:9' })], calendar: [], jira: [] },
      items
    )
    expect(diff.newCandidates.map((c) => c.id)).toEqual(['todo:2'])
  })

  it('jira 가 null 이면 jira 항목을 사라진 것으로 보지 않는다', () => {
    const items = [item({ id: 1, candidate_id: 'jira:P-1', source: 'jira' }), item({ id: 2, candidate_id: 'todo:2' })]
    const diff = diffSources(snapshot(), { candidates: [], calendar: [], jira: null }, items)
    expect(diff.vanishedCandidateIds).toEqual(['todo:2'])
  })

  it('계획 항목의 제목·마감·Jira 상태 변경을 찾는다', () => {
    const items = [
      item({ id: 1, candidate_id: 'todo:1', title: '옛 제목' }),
      item({ id: 2, candidate_id: 'jira:P-2', source: 'jira', jira_issue_key: 'P-2', title: 'jira:P-2' }),
      item({ id: 3, candidate_id: 'todo:3', title: 'todo:3' })
    ]
    const prev = snapshot({ jira: [{ key: 'P-2', status: '할 일', priority: 'Low', duedate: null, updated: 'x' }] })
    const diff = diffSources(
      prev,
      {
        candidates: [
          cand({ id: 'todo:1', title: '새 제목' }),
          cand({ id: 'jira:P-2', jiraKey: 'P-2' }),
          cand({ id: 'todo:3' })
        ],
        calendar: [],
        jira: [{ key: 'P-2', status: '할 일', priority: 'High', duedate: null, updated: 'y' }]
      },
      items
    )
    expect(diff.updatedCandidates.map((c) => c.id)).toEqual(['todo:1', 'jira:P-2'])
  })

  it('A14: 입력을 바꾸지 않고 같은 입력에 같은 결과를 낸다', () => {
    const prev = deepFreeze(snapshot({ calendar: [ev('a', '10:00', '11:00')], seenCandidateIds: ['todo:1'] }))
    const current = deepFreeze({ candidates: [cand({ id: 'todo:2' })], calendar: [ev('b', '12:00', '13:00')], jira: [] })
    const items = deepFreeze([item({ id: 1, candidate_id: 'todo:1' })])
    expect(diffSources(prev, current, items)).toEqual(diffSources(prev, current, items))
  })
})

describe('planRefresh §8.4', () => {
  it('A19: 새 후보는 suggested 로만 들어간다', () => {
    const plan = run(
      snapshot({ seenCandidateIds: ['todo:1'] }),
      {
        candidates: [cand({ id: 'todo:1' }), cand({ id: 'jira:P-9', jiraKey: 'P-9', dueDate: TODAY, link: 'u' })],
        calendar: [],
        jira: []
      },
      [item({ id: 1, candidate_id: 'todo:1' })]
    )
    expect(plan.inserts).toEqual([
      expect.objectContaining({
        candidate_id: 'jira:P-9',
        status: 'suggested',
        added_by: 'refresh',
        rank: null,
        slot_start: null,
        slot_end: null,
        pinned: false,
        urgent: true,
        jira_issue_key: 'P-9',
        score: 90
      })
    ])
    expect(plan.updates.some((u) => u.patch.status === 'planned')).toBe(false)
    expect(plan.summary.suggested).toBe(1)
    expect(plan.summary.urgentSuggestedIds).toEqual(['jira:P-9'])
  })

  it('A19: 액션아이템이 todo 로 옮겨지면 같은 행을 replace 하고 제안으로 넣지 않는다', () => {
    const items = [item({ id: 4, candidate_id: 'action_item:7:0', source: 'action_item', rank: 2, status: 'in_progress', link: 'linkwork://view/notes' })]
    const todo = cand({ id: 'todo:30', title: '자료 공유', link: 'linkwork://view/todos' })
    const plan = run(
      snapshot({ seenCandidateIds: ['action_item:7:0'] }),
      { candidates: [todo], calendar: [], jira: [] },
      items,
      { resolutions: { 'action_item:7:0': { kind: 'replace', candidate: todo } } }
    )
    expect(plan.inserts).toEqual([])
    expect(plan.updates).toEqual([
      {
        id: 4,
        patch: expect.objectContaining({ candidate_id: 'todo:30', source: 'todo', link: 'linkwork://view/todos', title: '자료 공유' })
      }
    ])
    expect(plan.updates[0].patch).not.toHaveProperty('status')
    expect(plan.updates[0].patch).not.toHaveProperty('rank')
    expect(plan.summary.replaced).toBe(1)
  })

  it('A19: dismissed 로 둔 제안 항목은 다시 제안하지 않는다', () => {
    const plan = run(
      snapshot({ seenCandidateIds: [] }),
      { candidates: [cand({ id: 'todo:5' })], calendar: [], jira: [] },
      [item({ id: 1, candidate_id: 'todo:5', status: 'dismissed', rank: null })]
    )
    expect(plan.inserts).toEqual([])
    expect(plan.updates).toEqual([])
  })

  it('A15: 출처 완료는 done 으로 반영한다. deferred 도 완료 반영만 받는다', () => {
    const items = [
      item({ id: 1, candidate_id: 'todo:1', status: 'planned' }),
      item({ id: 2, candidate_id: 'todo:2', status: 'deferred' }),
      item({ id: 3, candidate_id: 'todo:3', status: 'deferred' })
    ]
    const plan = run(snapshot(), { candidates: [], calendar: [], jira: [] }, items, {
      resolutions: {
        'todo:1': { kind: 'done' },
        'todo:2': { kind: 'done' },
        'todo:3': { kind: 'dropped', note: '삭제됨' }
      }
    })
    expect(plan.updates).toEqual([
      { id: 1, patch: { status: 'done' } },
      { id: 2, patch: { status: 'done' } }
    ])
    expect(plan.summary.completed).toBe(2)
  })

  it('A15: done·deferred·dropped·dismissed 상태는 일정 변경과 최신화에도 유지된다', () => {
    const items = [
      item({ id: 1, candidate_id: 'todo:1', status: 'done', slot_start: '09:00', slot_end: '10:00' }),
      item({ id: 2, candidate_id: 'todo:2', status: 'deferred', rank: null }),
      item({ id: 3, candidate_id: 'todo:3', status: 'dropped', rank: null }),
      item({ id: 4, candidate_id: 'todo:4', status: 'dismissed', rank: null }),
      item({ id: 5, candidate_id: 'todo:5', status: 'planned', slot_start: '10:00', slot_end: '11:00' })
    ]
    const plan = run(
      snapshot({ calendar: [], seenCandidateIds: items.map((i) => i.candidate_id) }),
      { candidates: items.map((i) => cand({ id: i.candidate_id })), calendar: [ev('m', '10:00', '11:00')], jira: [] },
      items
    )
    expect(plan.updates.filter((u) => 'status' in u.patch)).toEqual([])
    // 3판은 슬롯을 다시 쓰지 않는다
    expect(plan.updates).toEqual([])
    expect(plan.summary.timelineChanged).toBe(true)
  })

  it('A15: 해석이 없는 사라진 항목은 바꾸지 않는다. 사라진 suggested 는 dropped 가 된다', () => {
    const items = [
      item({ id: 1, candidate_id: 'todo:1', status: 'planned' }),
      item({ id: 2, candidate_id: 'todo:2', status: 'suggested', rank: null })
    ]
    const plan = run(snapshot(), { candidates: [], calendar: [], jira: [] }, items)
    expect(plan.updates).toEqual([{ id: 2, patch: { status: 'dropped' } }])
    expect(plan.summary.dropped).toBe(1)
  })

  it('사라진 Jira 후보가 담당 변경이면 dropped 와 메모. 슬롯은 건드리지 않는다', () => {
    const items = [item({ id: 1, candidate_id: 'jira:P-1', source: 'jira', slot_start: '10:00', slot_end: '11:00' })]
    const plan = run(snapshot(), { candidates: [], calendar: [], jira: [] }, items, {
      resolutions: { 'jira:P-1': { kind: 'dropped', note: '담당 변경' } }
    })
    expect(plan.updates).toEqual([
      { id: 1, patch: { status: 'dropped', status_note: '담당 변경' } }
    ])
  })

  it('jira 가 null 이면 jira 항목을 사라진 것으로 보지 않고 스냅샷 jira 를 유지한다', () => {
    const prevJira = [{ key: 'P-1', status: '진행 중', priority: null, duedate: null, updated: 'x' }]
    const items = [item({ id: 1, candidate_id: 'jira:P-1', source: 'jira' })]
    const plan = run(snapshot({ jira: prevJira }), { candidates: [], calendar: [], jira: null }, items, {
      resolutions: { 'jira:P-1': { kind: 'done' } }
    })
    expect(plan.updates).toEqual([])
    expect(plan.snapshot.jira).toEqual(prevJira)
  })

  it('A23: 일정이 바뀌어도 current·다음 블록의 키가 같으면 currentOrNextChanged 는 거짓이다', () => {
    // 블록: 09~12 current, 13~15 next, 16~18. 15~16 회의의 끝만 16:30 으로 바뀐다
    const items = [item({ id: 1, rank: 1, status: 'in_progress' }), item({ id: 2, rank: 2 })]
    const all = items.map((i) => i.candidate_id)
    const plan = run(
      snapshot({ calendar: [ev('m', '12:00', '13:00'), ev('k', '15:00', '16:00')], seenCandidateIds: all }),
      { candidates: all.map((id) => cand({ id })), calendar: [ev('m', '12:00', '13:00'), ev('k', '15:00', '16:30')], jira: [] },
      items,
      { nowHHmm: '09:30' }
    )
    expect(plan.updates).toEqual([])
    expect(plan.summary.calendarChanged).toBe(1)
    expect(plan.summary.timelineChanged).toBe(true)
    expect(plan.summary.currentOrNextChanged).toBe(false)
  })

  it('A23·E.3.1: 회의 이동으로 current 블록 end 가 바뀌면 itemId 가 같아도 참이다', () => {
    // 전: 09~12 current. 후: 09~12:30 current. 항목은 둘 다 1
    const items = [item({ id: 1, rank: 1, status: 'in_progress' }), item({ id: 2, rank: 2 })]
    const all = items.map((i) => i.candidate_id)
    const plan = run(
      snapshot({ calendar: [ev('m', '12:00', '13:00')], seenCandidateIds: all }),
      { candidates: all.map((id) => cand({ id })), calendar: [ev('m', '12:30', '13:30')], jira: [] },
      items,
      { nowHHmm: '09:30' }
    )
    expect(plan.summary.currentOrNextChanged).toBe(true)
  })

  it('A23·E.3.1: 14:00 회의가 들어와 지금 블록이 줄면 참이다', () => {
    const items = [item({ id: 1, rank: 1, status: 'in_progress' })]
    const plan = run(
      snapshot({ calendar: [], seenCandidateIds: ['todo:1'] }),
      { candidates: [cand({ id: 'todo:1' })], calendar: [ev('p', '14:00', '15:00', '제품 리뷰')], jira: [] },
      items,
      { nowHHmm: '13:10' }
    )
    expect(plan.summary.calendarAdded).toBe(1)
    expect(plan.summary.currentOrNextChanged).toBe(true)
  })

  it('A23·E.3.1: current 블록의 start 만 바뀌면 거짓이다', () => {
    // 전: 09~11 회의 없음 → current 09~18. 후: 08~09:15 회의 → current 09:15~18. end·itemId 는 같다
    const items = [item({ id: 1, rank: 1 })]
    const plan = run(
      snapshot({ calendar: [], seenCandidateIds: ['todo:1'] }),
      { candidates: [cand({ id: 'todo:1' })], calendar: [ev('a', '08:00', '09:15')], jira: [] },
      items,
      { nowHHmm: '10:00' }
    )
    expect(plan.summary.timelineChanged).toBe(true)
    expect(plan.summary.currentOrNextChanged).toBe(false)
  })

  it('A23·E.3.1: 지금 블록이 회의로 없어지면 참이다', () => {
    const items = [item({ id: 1, rank: 1 })]
    const plan = run(
      snapshot({ calendar: [], seenCandidateIds: ['todo:1'] }),
      { candidates: [cand({ id: 'todo:1' })], calendar: [ev('a', '09:30', '10:30')], jira: [] },
      items,
      { nowHHmm: '10:00' }
    )
    expect(plan.summary.currentOrNextChanged).toBe(true)
  })

  it('A23: 회의 추가로 다음 블록의 항목이 바뀌면 currentOrNextChanged 가 참이다', () => {
    // 전: 09~12 집중(1), 13~18 마감(2). 후: 09~12 집중(1), 13~15 집중(1), 16~18 마감(2)
    const items = [item({ id: 1, rank: 1 }), item({ id: 2, rank: 2, due_date: TODAY })]
    const all = items.map((i) => i.candidate_id)
    const plan = run(
      snapshot({ calendar: [ev('m', '12:00', '13:00')], seenCandidateIds: all }),
      {
        candidates: [cand({ id: 'todo:1' }), cand({ id: 'todo:2', dueDate: TODAY })],
        calendar: [ev('m', '12:00', '13:00'), ev('n', '15:00', '16:00')],
        jira: []
      },
      items,
      { nowHHmm: '09:30' }
    )
    expect(plan.summary.calendarAdded).toBe(1)
    expect(plan.summary.timelineChanged).toBe(true)
    expect(plan.summary.currentOrNextChanged).toBe(true)
  })

  it('A23: 집중 작업이 출처에서 완료되면 current 블록 항목이 바뀐다', () => {
    const items = [item({ id: 1, rank: 1 }), item({ id: 2, rank: 2 })]
    const plan = run(
      snapshot({ seenCandidateIds: ['todo:1', 'todo:2'] }),
      { candidates: [cand({ id: 'todo:2' })], calendar: [], jira: [] },
      items,
      { nowHHmm: '10:00', resolutions: { 'todo:1': { kind: 'done' } } }
    )
    expect(plan.updates).toEqual([{ id: 1, patch: { status: 'done' } }])
    expect(plan.summary.timelineChanged).toBe(false)
    expect(plan.summary.currentOrNextChanged).toBe(true)
  })

  it('A23: 캘린더를 보지 않았으면 이전 스냅샷 일정으로 타임라인을 비교한다', () => {
    const prevCal = [ev('a', '10:00', '11:00')]
    const items = [item({ id: 1, rank: 1 })]
    const plan = run(
      snapshot({ calendar: prevCal, seenCandidateIds: ['todo:1'] }),
      { candidates: [cand({ id: 'todo:1' })], calendar: null, jira: null },
      items,
      { nowHHmm: '09:30' }
    )
    expect(plan.summary.timelineChanged).toBe(false)
    expect(plan.summary.currentOrNextChanged).toBe(false)
  })

  it('캘린더를 보지 않았으면 일정 변경이 없고 스냅샷 calendar 를 유지한다', () => {
    const prevCal = [ev('a', '10:00', '11:00')]
    const items = [item({ id: 1, rank: 1 })]
    const plan = run(
      snapshot({ calendar: prevCal, seenCandidateIds: ['todo:1'] }),
      { candidates: [cand({ id: 'todo:1' })], calendar: null, jira: null },
      items
    )
    expect(plan.updates).toEqual([])
    expect(plan.summary.timelineChanged).toBe(false)
    expect(plan.snapshot.calendar).toEqual(prevCal)
  })

  it('계획 항목의 출처 갱신은 제목·마감·점수를 바꾸고 rank 는 유지한다', () => {
    const items = [item({ id: 1, candidate_id: 'todo:1', title: '옛', score: 0, rank: 3 })]
    const c = cand({ id: 'todo:1', title: '새', dueDate: TODAY })
    const plan = run(snapshot({ seenCandidateIds: ['todo:1'] }), { candidates: [c], calendar: [], jira: [] }, items)
    expect(plan.updates).toEqual([{ id: 1, patch: { title: '새', due_date: TODAY, score: scoreCandidate(c, TODAY) } }])
  })

  it('A14: jira 가 null 이면 Jira 와 병합된 task 항목의 값을 task 값으로 덮지 않는다', () => {
    const task: TaskRow = {
      id: 12, project_id: 1, project_name: 'P', project_priority: 'later', name: '작업',
      status: 'pending', end_date: '2026-11-30', jira_issue_key: 'PROJ-1'
    }
    const jiraIssue = {
      key: 'PROJ-1', summary: 'Jira 제목', status: '진행 중', statusCategory: 'indeterminate' as const,
      priority: 'Highest', duedate: '2026-11-03', updatedLocal: null, url: null
    }
    const jiraRef = { key: 'PROJ-1', status: '진행 중', priority: 'Highest', duedate: '2026-11-03', updated: 'x' }
    const base = { tasks: [task], todos: [], actionItems: [], taskTouchedAt: {} }
    const [merged] = buildCandidates({ ...base, jiraIssues: [jiraIssue] })
    const [localOnly] = buildCandidates({ ...base, jiraIssues: null })
    const items = [
      item({
        id: 1, candidate_id: merged.id, source: 'task', title: '옛 제목', jira_issue_key: 'PROJ-1',
        due_date: merged.dueDate, score: scoreCandidate(merged, TODAY)
      }),
      item({ id: 2, candidate_id: 'todo:2', title: '옛' })
    ]
    const prev = snapshot({ jira: [jiraRef], seenCandidateIds: [merged.id, 'todo:2'] })

    // local 최신화: jira null. 병합 항목은 제목·마감·점수 모두 그대로, Jira 무관 항목은 갱신한다
    const local: CurrentSources = { candidates: [localOnly, cand({ id: 'todo:2', title: '새' })], calendar: null, jira: null }
    const localDiff = diffSources(prev, local, items)
    expect(localDiff.updatedCandidates.map((c) => c.id)).toEqual(['todo:2'])
    expect(planRefresh(localDiff, local, prev, items, ctx()).updates).toEqual([{ id: 2, patch: { title: '새' } }])

    // full 최신화: jira 값이 같으면 바뀌는 값이 없다. 제목은 task 값으로 갱신된다
    const full: CurrentSources = { candidates: [merged, cand({ id: 'todo:2', title: '옛' })], calendar: [], jira: [jiraRef] }
    expect(planRefresh(diffSources(prev, full, items), full, prev, items, ctx()).updates).toEqual([
      { id: 1, patch: { title: '작업' } }
    ])
  })

  it('seenCandidateIds 는 이전 값과 현재 후보 ID 의 합집합이다', () => {
    const plan = run(
      snapshot({ seenCandidateIds: ['todo:1', 'jira:X-1'] }),
      { candidates: [cand({ id: 'todo:2' })], calendar: [], jira: null },
      []
    )
    expect(plan.snapshot.seenCandidateIds).toEqual(['jira:X-1', 'todo:1', 'todo:2'])
  })

  it('A14: 입력을 바꾸지 않고 같은 입력에 같은 결과를 낸다', () => {
    const prev = deepFreeze(snapshot({ seenCandidateIds: ['todo:1', 'todo:2'] }))
    const current = deepFreeze({
      candidates: [cand({ id: 'todo:1' }), cand({ id: 'todo:3' })],
      calendar: [ev('m', '10:00', '11:00')],
      jira: []
    })
    const items = deepFreeze([
      item({ id: 1, candidate_id: 'todo:1' }),
      item({ id: 2, candidate_id: 'todo:2', status: 'suggested', rank: null })
    ])
    const c = deepFreeze(ctx({ nowHHmm: '09:30', resolutions: { 'todo:2': { kind: 'done' } } }))
    const diff = deepFreeze(diffSources(prev, current, items))
    const a = planRefresh(diff, current, prev, items, c)
    const b = planRefresh(diff, current, prev, items, c)
    expect(a).toEqual(b)
  })
})

describe('rerank B.4', () => {
  it('planned 는 점수 순으로 rank 를 다시 매기고 in_progress 는 rank 를 유지한다', () => {
    const items = [
      item({ id: 1, rank: 1, score: 10 }),
      item({ id: 2, rank: 2, score: 5, status: 'in_progress' }),
      item({ id: 3, rank: null, score: 90 }), // 방금 수락한 제안
      item({ id: 4, rank: null, score: 99, status: 'suggested' })
    ]
    expect(rerank(items)).toEqual([
      { id: 1, patch: { rank: 3 } },
      { id: 3, patch: { rank: 1 } }
    ])
  })

  it('A14: 입력을 바꾸지 않고 같은 입력에 같은 결과를 낸다', () => {
    const items = deepFreeze([item({ id: 1, rank: 2, score: 1 }), item({ id: 2, rank: 1, score: 50 })])
    const a = rerank(items)
    expect(a).toEqual(rerank(items))
    expect(a).toEqual([])
  })
})

describe('focusUpdates B.4', () => {
  const items = [
    item({ id: 1, rank: 1, status: 'in_progress' }),
    item({ id: 2, rank: 2 }),
    item({ id: 3, rank: 3 }),
    item({ id: 4, rank: null, status: 'deferred' }),
    item({ id: 5, rank: 4, status: 'done' })
  ]

  it('대상을 rank 1·in_progress 로 두고 다른 활성 항목은 순서를 유지해 2부터 매긴다', () => {
    expect(focusUpdates(items, 3)).toEqual([
      { id: 1, patch: { rank: 2 } },
      { id: 2, patch: { rank: 3 } },
      { id: 3, patch: { rank: 1, status: 'in_progress' } }
    ])
  })

  it('대상이 이미 in_progress 면 상태를 바꾸지 않는다', () => {
    const list = [item({ id: 1, rank: 1 }), item({ id: 2, rank: 2, status: 'in_progress' })]
    expect(focusUpdates(list, 2)).toEqual([
      { id: 1, patch: { rank: 2 } },
      { id: 2, patch: { rank: 1 } }
    ])
  })

  it('이미 집중 작업이면 변경이 없다', () => {
    expect(focusUpdates(items, 1)).toEqual([])
  })

  it('대상이 없거나 활성 항목이 아니면 빈 목록이다', () => {
    expect(focusUpdates(items, 99)).toEqual([])
    expect(focusUpdates(items, 4)).toEqual([])
    expect(focusUpdates(items, 5)).toEqual([])
  })

  it('A14: 입력을 바꾸지 않고 같은 입력에 같은 결과를 낸다', () => {
    const frozen = deepFreeze(items.map((i) => ({ ...i })))
    expect(focusUpdates(frozen, 2)).toEqual(focusUpdates(frozen, 2))
  })
})

// ── 최신화 알림 (A21, 부록 E.3) ──

function summary(over: Partial<RefreshSummary> = {}): RefreshSummary {
  return {
    calendarAdded: 0, calendarChanged: 0, calendarRemoved: 0,
    suggested: 0, urgentSuggestedIds: [], completed: 0, dropped: 0, replaced: 0,
    timelineChanged: false, currentOrNextChanged: false, ...over
  }
}

function emptyDiff(over: Partial<RefreshDiff> = {}): RefreshDiff {
  return {
    calendarAdded: [], calendarChanged: [], calendarRemoved: [],
    newCandidates: [], vanishedCandidateIds: [], updatedCandidates: [], ...over
  }
}

function timeline(calendar: CalendarRef[], items: PlanItem[], nowHHmm: string): DayTimeline {
  return buildTimeline({ calendar, dayStart: '09:00', nowHHmm, workEnd: '18:00', items, today: TODAY, closed: false })
}

function noticeInput(over: Partial<NoticeInput> = {}): NoticeInput {
  const items = over.items ?? [item({ id: 1, rank: 1, title: 'API 설계' })]
  return {
    diff: emptyDiff(),
    summary: summary({ currentOrNextChanged: true }),
    after: timeline([], items, '10:00'),
    items,
    today: TODAY,
    nowHHmm: '10:00',
    ctx: { refreshNotify: true, inMeeting: false },
    ...over
  }
}

describe('isInMeeting·bucketOf E.3', () => {
  it('종일이 아닌 일정 중 start ≤ now < end 이면 회의 중이다', () => {
    const cal = [ev('a', '10:00', '11:00'), { ...ev('d', '00:00', '24:00'), allDay: true }]
    expect(isInMeeting(cal, '10:00')).toBe(true)
    expect(isInMeeting(cal, '10:59')).toBe(true)
    expect(isInMeeting(cal, '11:00')).toBe(false)
    expect(isInMeeting(cal, '09:59')).toBe(false)
    expect(isInMeeting([{ ...ev('d', '00:00', '24:00'), allDay: true }], '12:00')).toBe(false)
  })

  it('A21: 버킷 키는 분을 30으로 내린 HHmm 이다', () => {
    expect(bucketOf('14:42')).toBe('1430')
    expect(bucketOf('14:29')).toBe('1400')
    expect(bucketOf('09:30')).toBe('0930')
    expect(bucketOf('00:05')).toBe('0000')
  })
})

describe('shouldNotifyPlanUpdate A21', () => {
  const ctxOn = { refreshNotify: true, inMeeting: false }

  it('A21: refreshNotify 가 꺼져 있으면 알리지 않는다', () => {
    const s = summary({ currentOrNextChanged: true, urgentSuggestedIds: ['jira:P-1'] })
    expect(shouldNotifyPlanUpdate(s, { refreshNotify: false, inMeeting: false })).toBe(false)
    expect(buildPlanUpdateNotices(noticeInput({ summary: s, ctx: { refreshNotify: false, inMeeting: false } }))).toEqual([])
  })

  it('A21: 회의 중이면 알리지 않는다', () => {
    const s = summary({ currentOrNextChanged: true, urgentSuggestedIds: ['jira:P-1'] })
    expect(shouldNotifyPlanUpdate(s, { refreshNotify: true, inMeeting: true })).toBe(false)
    expect(buildPlanUpdateNotices(noticeInput({ summary: s, ctx: { refreshNotify: true, inMeeting: true } }))).toEqual([])
  })

  it('A21: 지금·다음 변경도 긴급 제안도 없으면 알리지 않는다', () => {
    expect(shouldNotifyPlanUpdate(summary({ timelineChanged: true, suggested: 2 }), ctxOn)).toBe(false)
  })

  it('A21: 지금·다음 변경 또는 긴급 제안이 있으면 알린다', () => {
    expect(shouldNotifyPlanUpdate(summary({ currentOrNextChanged: true }), ctxOn)).toBe(true)
    expect(shouldNotifyPlanUpdate(summary({ urgentSuggestedIds: ['todo:1'] }), ctxOn)).toBe(true)
  })
})

describe('buildPlanUpdateNotices A21', () => {
  it('A21: slot 변경은 버킷 키·timeline focus 의 계획 변경 알림 1건이다 (E.3.4 예시)', () => {
    // 14:00 제품 리뷰 추가. 지금 블록 13:00~14:00, 다음 15:00~18:00 API 설계
    const items = [item({ id: 1, rank: 1, title: 'API 설계' })]
    const cal = [ev('p', '14:00', '15:00', '제품 리뷰')]
    const notices = buildPlanUpdateNotices(noticeInput({
      diff: emptyDiff({ calendarAdded: cal }),
      summary: summary({ calendarAdded: 1, timelineChanged: true, currentOrNextChanged: true }),
      after: timeline(cal, items, '13:42'),
      items,
      nowHHmm: '13:42'
    }))
    expect(notices).toEqual([{
      kind: 'slot',
      eventKey: `plan_update:${TODAY}:1330`,
      refId: '1330',
      title: '계획 변경',
      body: '14:00 제품 리뷰 추가 · 다음 15:00–18:00 API 설계',
      focus: { kind: 'timeline' }
    }])
  })

  it('A21: 일정 변경이 2건 이상이면 외 N건, 변경·취소 문구를 쓴다', () => {
    const items = [item({ id: 1, rank: 1, title: 'API 설계' })]
    const body = (diff: RefreshDiff): string =>
      buildPlanUpdateNotices(noticeInput({ diff, items, after: timeline([], items, '10:00') }))[0].body
    expect(body(emptyDiff({ calendarAdded: [ev('a', '14:00', '15:00', '리뷰')], calendarRemoved: [ev('b', '16:00', '17:00')] })))
      .toBe('14:00 리뷰 추가 외 1건 · 지금 API 설계 ~18:00')
    expect(body(emptyDiff({ calendarChanged: [ev('a', '11:00', '12:00', '주간')] }))).toBe('11:00 주간 변경 · 지금 API 설계 ~18:00')
    expect(body(emptyDiff({ calendarRemoved: [ev('a', '11:00', '12:00', '주간')], calendarChanged: [], calendarAdded: [] })))
      .toBe('11:00 주간 취소 · 지금 API 설계 ~18:00')
  })

  it('A21: 블록 조각 — 빈 블록·남은 블록 없음·제목 20자 자르기', () => {
    // 항목이 없으면 다음 블록은 빈 블록이다
    const empty = buildPlanUpdateNotices(noticeInput({ items: [], after: timeline([ev('m', '10:00', '18:00')], [], '09:10') }))
    expect(empty[0].body).toBe('지금 빈 블록 ~10:00')
    const nextEmpty = buildPlanUpdateNotices(noticeInput({ items: [], after: timeline([ev('m', '09:00', '11:00')], [], '09:10') }))
    expect(nextEmpty[0].body).toBe('다음 11:00–18:00 빈 블록')
    // 남은 블록이 없다
    const none = buildPlanUpdateNotices(noticeInput({ items: [], after: timeline([], [], '18:30') }))
    expect(none[0].body).toBe('남은 블록 없음')
    // 제목은 20자에서 자른다
    const long = '가나다라마바사아자차카타파하가나다라마바사아'
    const items = [item({ id: 1, rank: 1, title: long })]
    const cut = buildPlanUpdateNotices(noticeInput({ items, after: timeline([], items, '10:00') }))
    expect(cut[0].body).toBe(`지금 ${Array.from(long).slice(0, 20).join('')}… ~18:00`)
  })

  it('A21: 긴급 제안은 후보당 urgent 알림 1건이고 inbox focus 다 (E.3.4 예시)', () => {
    const items = [
      item({ id: 1, rank: 1, title: 'API 설계' }),
      item({ id: 2, candidate_id: 'jira:PROJ-123', source: 'jira', jira_issue_key: 'PROJ-123', status: 'suggested', rank: null, due_date: TODAY, urgent: true }),
      item({ id: 3, candidate_id: 'todo:9', title: '보고서 제출', status: 'suggested', rank: null, due_date: '2026-10-30', urgent: true }),
      item({ id: 4, candidate_id: 'todo:10', title: '장애 대응', status: 'suggested', rank: null, due_date: null, urgent: true })
    ]
    const notices = buildPlanUpdateNotices(noticeInput({
      items,
      summary: summary({ suggested: 3, urgentSuggestedIds: ['jira:PROJ-123', 'todo:9', 'todo:10'] })
    }))
    expect(notices).toEqual([
      { kind: 'urgent', eventKey: `plan_update:${TODAY}:urgent:jira:PROJ-123`, refId: 'urgent:jira:PROJ-123', title: '새로 들어온 일', body: 'PROJ-123 오늘 마감', focus: { kind: 'inbox' } },
      { kind: 'urgent', eventKey: `plan_update:${TODAY}:urgent:todo:9`, refId: 'urgent:todo:9', title: '새로 들어온 일', body: '보고서 제출 3일 지남', focus: { kind: 'inbox' } },
      { kind: 'urgent', eventKey: `plan_update:${TODAY}:urgent:todo:10`, refId: 'urgent:todo:10', title: '새로 들어온 일', body: '장애 대응 우선순위 최상', focus: { kind: 'inbox' } }
    ])
  })

  it('A21: slot 1건 + urgent 최대 3건, 최대 4건이다', () => {
    const items = [item({ id: 1, rank: 1, title: 'API 설계' })]
    const ids = ['todo:21', 'todo:22', 'todo:23', 'todo:24', 'todo:25']
    for (const [i, id] of ids.entries()) {
      items.push(item({ id: 21 + i, candidate_id: id, status: 'suggested', rank: null, urgent: true }))
    }
    const notices = buildPlanUpdateNotices(noticeInput({
      items,
      summary: summary({ currentOrNextChanged: true, suggested: 5, urgentSuggestedIds: ids })
    }))
    expect(notices.map((n) => n.kind)).toEqual(['slot', 'urgent', 'urgent', 'urgent'])
    expect(notices.slice(1).map((n) => n.refId)).toEqual(['urgent:todo:21', 'urgent:todo:22', 'urgent:todo:23'])
  })

  it('A21: 항목에 없는 긴급 후보는 diff.newCandidates 로 문구를 만든다', () => {
    const notices = buildPlanUpdateNotices(noticeInput({
      diff: emptyDiff({ newCandidates: [cand({ id: 'jira:X-1', jiraKey: 'X-1', dueDate: TODAY })] }),
      summary: summary({ urgentSuggestedIds: ['jira:X-1'] })
    }))
    expect(notices.map((n) => n.body)).toEqual(['X-1 오늘 마감'])
  })

  it('A14: 입력을 바꾸지 않고 같은 입력에 같은 결과를 낸다', () => {
    const input = deepFreeze(noticeInput({ summary: summary({ currentOrNextChanged: true, urgentSuggestedIds: ['todo:1'] }) }))
    expect(buildPlanUpdateNotices(input)).toEqual(buildPlanUpdateNotices(input))
  })
})
