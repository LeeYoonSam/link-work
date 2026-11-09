import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Candidate, PlanExclusion, PlanItem } from '../../types'
import CandidatesCard, { candidateOfExclusion } from './CandidatesCard'
import { candidatesNotInPlan, pickableCandidates } from './CandidatePicker'
import InboxSection from './InboxSection'

// 후보 카드 (docs/ASSISTANT.md 부록 M.5.7, M10).
// 자동 클릭 검증은 불가하다. 펼침 상태는 *OpenInitial prop 으로 주입해 첫 그리기를 확인한다

const item = (over: Partial<PlanItem> & Pick<PlanItem, 'id'>): PlanItem => ({
  plan_id: 1,
  candidate_id: `task:${over.id}`,
  source: 'task',
  title: `작업 ${over.id}`,
  link: null,
  jira_issue_key: null,
  project_id: null,
  due_date: null,
  score: 50,
  rank: over.id,
  slot_start: null,
  slot_end: null,
  pinned: false,
  added_by: 'start',
  urgent: false,
  status: 'planned',
  status_note: null,
  status_at: null,
  first_planned_date: null,
  work_type: 'etc',
  work_version: null,
  parent_key: null,
  group_name: null,
  ...over
})

const cand = (over: Partial<Candidate> & Pick<Candidate, 'id'>): Candidate => ({
  source: 'task',
  title: `후보 ${over.id}`,
  jiraKey: null,
  projectId: null,
  projectName: null,
  dueDate: null,
  dueTime: null,
  inProgress: false,
  priority: null,
  jiraPriority: null,
  lastTouchedAt: null,
  link: null,
  parentKey: null,
  groupName: null,
  workType: 'etc',
  workVersion: null,
  ...over
})

const excl = (over: Partial<PlanExclusion> & Pick<PlanExclusion, 'candidate_id'>): PlanExclusion => ({
  jira_key: null,
  title: `제외 ${over.candidate_id}`,
  source: 'jira',
  excluded_at: '2026-11-08 09:00:00',
  ...over
})

const ITEMS: PlanItem[] = [
  item({ id: 1, candidate_id: 'task:1', status: 'planned' }),
  item({ id: 2, candidate_id: 'action:2', source: 'action_item', status: 'suggested', title: '제안 A', rank: null }),
  item({ id: 3, candidate_id: 'jira:P-3', source: 'jira', status: 'suggested', title: '제안 B', rank: null }),
  item({ id: 4, candidate_id: 'task:4', status: 'dropped', title: '오늘 제외한 작업' })
]

const CANDIDATES: Candidate[] = [
  cand({ id: 'task:1', title: '계획에 있는 작업' }),
  cand({ id: 'task:4', title: '오늘 제외한 작업' }),
  cand({ id: 'todo:9', source: 'todo', title: '남은 할일' }),
  // 계속 제외 기록과 Jira 키로 맞는 후보다. id 는 task 로 바뀌었다
  cand({ id: 'task:77', jiraKey: 'P-77', title: '늘 열린 에픽', dueDate: '2026-11-09', excluded: true }),
  cand({ id: 'jira:P-88', source: 'jira', jiraKey: 'P-88', title: '다른 제외 티켓', excluded: true })
]

const EXCLUSIONS: PlanExclusion[] = [
  excl({ candidate_id: 'jira:P-77', jira_key: 'P-77', title: '늘 열린 에픽' }),
  excl({ candidate_id: 'jira:P-88', jira_key: 'P-88', title: '다른 제외 티켓', excluded_at: '2026-11-07 09:00:00' })
]

const render = (
  opts: {
    items?: PlanItem[]
    candidates?: Candidate[]
    exclusions?: PlanExclusion[]
    readOnly?: boolean
    candidatesOpen?: boolean
    excludedOpen?: boolean
  } = {}
): string =>
  renderToStaticMarkup(
    <CandidatesCard
      items={opts.items ?? ITEMS}
      candidates={opts.candidates ?? CANDIDATES}
      candidatesLoading={false}
      candidatesError=""
      exclusions={opts.exclusions ?? EXCLUSIONS}
      logicalDate="2026-11-09"
      busy={false}
      readOnly={opts.readOnly ?? false}
      onAccept={() => {}}
      onDismiss={() => {}}
      onLoadCandidates={() => {}}
      onAdd={() => {}}
      onRemoveExclusion={() => {}}
      candidatesOpenInitial={opts.candidatesOpen}
      excludedOpenInitial={opts.excludedOpen}
    />
  )

// 구역 하나의 마크업이다
const section = (html: string, name: string): string => {
  const at = html.indexOf(`data-section="${name}"`)
  if (at === -1) return ''
  const next = html.indexOf('data-section=', at + 1)
  return html.slice(at, next === -1 ? undefined : next)
}

describe('candidatesNotInPlan·pickableCandidates (부록 M.5.7)', () => {
  it('계획의 planned·in_progress·done·suggested 후보만 뺀다', () => {
    const items = [
      item({ id: 1, candidate_id: 'a', status: 'planned' }),
      item({ id: 2, candidate_id: 'b', status: 'in_progress' }),
      item({ id: 3, candidate_id: 'c', status: 'done' }),
      item({ id: 4, candidate_id: 'd', status: 'suggested' }),
      item({ id: 5, candidate_id: 'e', status: 'dropped' }),
      item({ id: 6, candidate_id: 'f', status: 'deferred' }),
      item({ id: 7, candidate_id: 'g', status: 'dismissed' })
    ]
    const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => cand({ id }))
    expect(candidatesNotInPlan(all, items).map((c) => c.id)).toEqual(['e', 'f', 'g', 'h'])
  })

  it('후보 더 보기 목록은 계속 제외한 후보를 뺀다', () => {
    expect(pickableCandidates(CANDIDATES, ITEMS).map((c) => c.id)).toEqual(['task:4', 'todo:9'])
  })

  it('candidateOfExclusion 은 id 또는 Jira 키로 후보를 찾는다', () => {
    expect(candidateOfExclusion(EXCLUSIONS[0], CANDIDATES)?.id).toBe('task:77')
    expect(candidateOfExclusion(EXCLUSIONS[1], CANDIDATES)?.id).toBe('jira:P-88')
    expect(candidateOfExclusion(excl({ candidate_id: 'jira:X-1', jira_key: 'X-1' }), CANDIDATES)).toBeNull()
  })
})

describe('CandidatesCard (부록 M.5.7)', () => {
  it('루트 id 는 today-inbox 이고 1개다', () => {
    const html = render()
    expect(html.startsWith('<section id="today-inbox"')).toBe(true)
    expect(html.split('id="today-inbox"')).toHaveLength(2)
  })

  it('머리에 후보 제목, 제안 건수 필, 제외 건수를 쓴다', () => {
    const html = render()
    expect(html).toContain('>후보</h3>')
    expect(html).toMatch(/<span data-suggestion-count=""[^>]*bg-amber-100 text-amber-700[^>]*>제안 2<\/span>/)
    expect(html).toContain('>제외 2<')
  })

  it('제안과 제외가 0건이면 머리 건수와 구역 1·3이 없다', () => {
    const html = render({ items: [item({ id: 1 })], exclusions: [] })
    expect(html).not.toContain('data-suggestion-count')
    expect(html).not.toContain('제외 ')
    expect(section(html, 'suggestions')).toBe('')
    expect(section(html, 'excluded')).toBe('')
    expect(section(html, 'candidates')).toContain('후보 더 보기')
  })

  it('구역 1은 InboxSection 을 머리 없이 그린다', () => {
    const s1 = section(render(), 'suggestions')
    expect(s1).toContain('새로 들어온 제안')
    expect(s1).toContain('제안 A')
    expect(s1).toContain('제안 B')
    expect(s1).toContain('계획에 추가')
    expect(s1).not.toContain('새로 들어온 일')
  })

  it('구역 2는 기본으로 접혀 있고 목록이 없다', () => {
    const s2 = section(render(), 'candidates')
    expect(s2).toContain('aria-expanded="false"')
    expect(s2).toContain('후보 불러오기')
    expect(s2).not.toContain('남은 할일')
  })

  it('구역 2를 펼치면 계획에 없고 계속 제외하지 않은 후보만 보인다', () => {
    const s2 = section(render({ candidatesOpen: true }), 'candidates')
    expect(s2).toContain('aria-expanded="true"')
    expect(s2).toContain('남은 할일')
    // 오늘만 제외한 항목은 다시 추가할 수 있다
    expect(s2).toContain('오늘 제외한 작업')
    expect(s2).not.toContain('계획에 있는 작업')
    expect(s2).not.toContain('늘 열린 에픽')
    expect(s2).not.toContain('다른 제외 티켓')
    expect(s2).toContain('>추가</button>')
  })

  it('구역 3은 기본으로 접혀 있고 머리에 건수를 쓴다', () => {
    const s3 = section(render(), 'excluded')
    expect(s3).toContain('계속 제외한 항목 2건')
    expect(s3).toContain('aria-expanded="false"')
    expect(s3).not.toContain('다시 추가')
  })

  it('구역 3을 펼치면 행마다 출처 배지, 제목, 다시 추가·제외 해제 버튼이 있다', () => {
    const s3 = section(render({ excludedOpen: true }), 'excluded')
    expect(s3).toContain('늘 열린 에픽')
    expect(s3).toContain('다른 제외 티켓')
    expect(s3).toContain('Jira')
    expect(s3.split('>다시 추가</button>')).toHaveLength(3)
    expect(s3.split('>제외 해제</button>')).toHaveLength(3)
    expect(s3).not.toMatch(/<button[^>]*disabled=""[^>]*>다시 추가/)
  })

  it('불러온 후보의 마감이 오늘·지남이면 마감 글자를 빨강으로 쓴다', () => {
    const s3 = section(render({ excludedOpen: true }), 'excluded')
    expect(s3).toMatch(/text-red-600 font-medium[^"]*">마감 오늘</)
  })

  it('후보를 불러오지 않았으면 제외 행에 마감이 없다', () => {
    const s3 = section(render({ excludedOpen: true, candidates: [] }), 'excluded')
    expect(s3).not.toContain('마감')
  })

  it('readOnly 면 다시 추가가 비활성이고 제외 해제는 활성이다', () => {
    const html = render({ excludedOpen: true, readOnly: true })
    const s3 = section(html, 'excluded')
    expect(s3.split(/<button[^>]*disabled=""[^>]*>다시 추가<\/button>/)).toHaveLength(3)
    expect(s3).not.toMatch(/<button[^>]*disabled=""[^>]*>제외 해제/)
    // 닫힌 날은 후보 더 보기를 그리지 않는다. 제안 버튼도 숨는다
    expect(section(html, 'candidates')).toBe('')
    expect(html).not.toContain('계획에 추가')
  })

  it('10px·11px 임의 글자 크기를 쓰지 않는다', () => {
    const html = render({ candidatesOpen: true, excludedOpen: true })
    expect(html).not.toMatch(/text-\[1[01]px\]/)
  })
})

describe('InboxSection embedded (부록 M.5.7)', () => {
  it('embedded 면 Card 와 머리를 그리지 않는다', () => {
    const html = renderToStaticMarkup(
      <InboxSection items={ITEMS} busy={false} onAccept={() => {}} onDismiss={() => {}} embedded />
    )
    expect(html).not.toContain('id="today-inbox"')
    expect(html).not.toContain('새로 들어온 일')
    expect(html).toContain('제안 A')
  })

  it('embedded 가 없으면 지금 모양 그대로다', () => {
    const html = renderToStaticMarkup(
      <InboxSection items={ITEMS} busy={false} onAccept={() => {}} onDismiss={() => {}} />
    )
    expect(html).toContain('id="today-inbox"')
    expect(html).toContain('새로 들어온 일')
  })
})
