import { describe, it, expect } from 'vitest'
import type { JiraBoardIssue } from '../../types'
import {
  DEFAULT_FILTER,
  EMPTY_FILTER,
  NO_EPIC_ID,
  ORPHAN_SUBTASKS_ID,
  ancestorIds,
  assigneeSummary,
  autoExpandIds,
  buildIssueForest,
  compareIssueKeys,
  deriveFacets,
  effectiveExpanded,
  expandableIds,
  filterForest,
  findIssue,
  forestOptions,
  isPastDone,
  isRecentDone,
  detailTarget,
  flattenVisible,
  isFilterActive,
  isRevealable,
  revealFilter,
  syncResultText,
  NO_RELEASE,
  isTreeRowTarget,
  issueTypeKind,
  matchesFilter,
  missingEpicId,
  nextFocus,
  priorityMarks,
  resolveFocus,
  rollupChildren,
  shortDate,
  sortChildren,
  sortGroups,
  statusVisual,
  summaryTiles,
  treeKeyAction,
  type BoardFilter,
  type BoardForest
} from './boardModel'
import { releaseItemStatus } from '../ui/tokens'

// Jira 계층 보드 순수 모델의 규칙을 잠근다 (docs/PROJECT_BOARD.md).

const TODAY = '2026-11-18'
const ME = 'acc-me'

let seq = 0
const issue = (over: Partial<JiraBoardIssue> = {}): JiraBoardIssue => ({
  key: `PROJ-${++seq}`,
  summary: '제목',
  issueType: '작업',
  level: 'standard',
  status: '진행 중',
  statusCategory: 'indeterminate',
  inScope: true,
  priority: null,
  parentKey: null,
  parentSummary: null,
  assigneeAccountId: null,
  assigneeName: null,
  duedate: null,
  updated: '2026-11-10T09:00:00.000Z',
  resolvedAt: null,
  labels: [],
  excerpt: null,
  fixVersions: [],
  links: [],
  ...over
})
const epic = (key: string, over: Partial<JiraBoardIssue> = {}): JiraBoardIssue =>
  issue({ key, level: 'epic', issueType: '에픽', summary: `에픽 ${key}`, ...over })
const child = (key: string, parentKey: string | null, over: Partial<JiraBoardIssue> = {}): JiraBoardIssue =>
  issue({ key, parentKey, ...over })
const sub = (key: string, parentKey: string | null, over: Partial<JiraBoardIssue> = {}): JiraBoardIssue =>
  issue({ key, parentKey, level: 'subtask', issueType: '하위 작업', ...over })

const groupIds = (f: BoardForest): string[] => f.groups.map((g) => g.id)
const childKeys = (f: BoardForest, id: string): string[] =>
  f.groups.find((g) => g.id === id)?.children.map((c) => c.issue.key) ?? []

describe('compareIssueKeys', () => {
  it('키를 숫자 순으로 비교한다 — PROJ-9 < PROJ-10', () => {
    expect(compareIssueKeys('PROJ-9', 'PROJ-10')).toBeLessThan(0)
    expect(['PROJ-10', 'PROJ-2', 'PROJ-9'].sort(compareIssueKeys)).toEqual(['PROJ-2', 'PROJ-9', 'PROJ-10'])
  })
  it('프로젝트 접두사가 다르면 접두사 순이다', () => {
    expect(compareIssueKeys('ABC-100', 'PROJ-1')).toBeLessThan(0)
  })
})

describe('buildIssueForest', () => {
  it('에픽 아래 자식, 자식 아래 하위작업을 단다', () => {
    const f = buildIssueForest(
      [epic('PROJ-1'), child('PROJ-2', 'PROJ-1'), sub('PROJ-3', 'PROJ-2')],
      TODAY
    )
    expect(groupIds(f)).toEqual(['PROJ-1'])
    expect(childKeys(f, 'PROJ-1')).toEqual(['PROJ-2'])
    expect(f.groups[0].children[0].children.map((s) => s.issue.key)).toEqual(['PROJ-3'])
  })

  it('에픽 없는 자식은 "에픽 없음" 가상 그룹에 넣는다', () => {
    const f = buildIssueForest([child('PROJ-5', null)], TODAY)
    expect(groupIds(f)).toEqual([NO_EPIC_ID])
    expect(f.groups[0].kind).toBe('noEpic')
  })

  it('부모 에픽이 스냅샷에 없고 parentSummary 가 있으면 부모별 가상 에픽 그룹으로 묶는다', () => {
    const f = buildIssueForest(
      [
        child('PROJ-5', 'PROJ-88', { parentSummary: '앱 성능' }),
        child('PROJ-6', 'PROJ-88', { parentSummary: '앱 성능' })
      ],
      TODAY
    )
    expect(groupIds(f)).toEqual([missingEpicId('PROJ-88')])
    expect(f.groups[0]).toMatchObject({ kind: 'missingEpic', epicKey: 'PROJ-88', title: '앱 성능' })
    expect(childKeys(f, missingEpicId('PROJ-88'))).toEqual(['PROJ-5', 'PROJ-6'])
  })

  it('부모가 없고 parentSummary 도 없으면 "에픽 없음"으로 보낸다', () => {
    const f = buildIssueForest([child('PROJ-5', 'PROJ-88')], TODAY)
    expect(groupIds(f)).toEqual([NO_EPIC_ID])
  })

  it('상위가 스냅샷에 없는 하위작업은 고아 하위작업 그룹으로 간다', () => {
    const f = buildIssueForest([sub('PROJ-7', 'PROJ-70')], TODAY)
    expect(groupIds(f)).toEqual([ORPHAN_SUBTASKS_ID])
  })

  it('에픽에 바로 붙은 하위작업은 에픽의 자식으로 둔다', () => {
    const f = buildIssueForest([epic('PROJ-1'), sub('PROJ-2', 'PROJ-1')], TODAY)
    expect(childKeys(f, 'PROJ-1')).toEqual(['PROJ-2'])
  })

  it('자기 참조 parent 는 부모 없음으로 다룬다', () => {
    const f = buildIssueForest([child('PROJ-5', 'PROJ-5', { parentSummary: '나' })], TODAY)
    expect(groupIds(f)).toEqual([NO_EPIC_ID])
  })

  it('순환 parent 체인(표준 ↔ 표준)도 무한 루프 없이 최상위로 처리한다', () => {
    const f = buildIssueForest([child('PROJ-5', 'PROJ-6'), child('PROJ-6', 'PROJ-5')], TODAY)
    expect(groupIds(f)).toEqual([NO_EPIC_ID])
    expect(childKeys(f, NO_EPIC_ID).sort()).toEqual(['PROJ-5', 'PROJ-6'])
  })

  it('하위작업 순환(하위작업 → 하위작업)도 고아로 처리한다', () => {
    const f = buildIssueForest([sub('PROJ-7', 'PROJ-8'), sub('PROJ-8', 'PROJ-7')], TODAY)
    expect(groupIds(f)).toEqual([ORPHAN_SUBTASKS_ID])
  })

  it('중복 키는 처음 것만 쓴다', () => {
    const f = buildIssueForest(
      [epic('PROJ-1'), child('PROJ-2', 'PROJ-1', { summary: '처음' }), child('PROJ-2', 'PROJ-1', { summary: '나중' })],
      TODAY
    )
    expect(f.groups[0].children).toHaveLength(1)
    expect(f.groups[0].children[0].issue.summary).toBe('처음')
  })

  it('범위 밖 잎(백로그 자식)은 숨기고 backlogCount 로만 센다', () => {
    const f = buildIssueForest(
      [epic('PROJ-1'), child('PROJ-2', 'PROJ-1'), child('PROJ-3', 'PROJ-1', { inScope: false, statusCategory: 'new' })],
      TODAY
    )
    expect(childKeys(f, 'PROJ-1')).toEqual(['PROJ-2'])
    expect(f.groups[0].backlogCount).toBe(1)
  })

  it('범위 밖 조상은 범위 안 자손이 있을 때만 그린다', () => {
    const out = epic('PROJ-1', { inScope: false, statusCategory: 'new' })
    const shown = buildIssueForest([out, child('PROJ-2', 'PROJ-1')], TODAY)
    expect(groupIds(shown)).toEqual(['PROJ-1'])
    const hidden = buildIssueForest([out, child('PROJ-2', 'PROJ-1', { inScope: false })], TODAY)
    expect(groupIds(hidden)).toEqual([])
  })

  it('범위 밖 표준 이슈도 범위 안 하위작업이 있으면 남는다', () => {
    const f = buildIssueForest(
      [epic('PROJ-1'), child('PROJ-2', 'PROJ-1', { inScope: false }), sub('PROJ-3', 'PROJ-2')],
      TODAY
    )
    expect(childKeys(f, 'PROJ-1')).toEqual(['PROJ-2'])
    expect(f.groups[0].backlogCount).toBe(0)
  })

  it('범위 안 에픽은 자식이 없어도 그린다', () => {
    const f = buildIssueForest([epic('PROJ-1')], TODAY)
    expect(groupIds(f)).toEqual(['PROJ-1'])
    expect(f.groups[0].rollup.total).toBe(0)
  })

  it('표준 이슈의 하위 진행(하위 2/3)을 센다', () => {
    const f = buildIssueForest(
      [
        child('PROJ-2', null),
        sub('PROJ-3', 'PROJ-2', { statusCategory: 'done' }),
        sub('PROJ-4', 'PROJ-2', { statusCategory: 'done' }),
        sub('PROJ-5', 'PROJ-2', { statusCategory: 'new' })
      ],
      TODAY
    )
    expect(f.groups[0].children[0].rollup).toMatchObject({ total: 3, done: 2 })
  })

  it('findIssue·ancestorIds 가 행 id 로 이슈와 조상을 찾는다', () => {
    const f = buildIssueForest([epic('PROJ-1'), child('PROJ-2', 'PROJ-1'), sub('PROJ-3', 'PROJ-2')], TODAY)
    expect(findIssue(f, 'PROJ-3')?.key).toBe('PROJ-3')
    expect(findIssue(f, 'PROJ-1')?.key).toBe('PROJ-1')
    expect(findIssue(f, 'NOPE-1')).toBeNull()
    expect(ancestorIds(f, 'PROJ-3')).toEqual(['PROJ-2', 'PROJ-1'])
    expect(ancestorIds(f, 'PROJ-1')).toEqual([])
  })
})

describe('rollupChildren', () => {
  it('분모는 범위 안 직계 자식, 분자는 완료 카테고리', () => {
    const r = rollupChildren(
      [
        issue({ statusCategory: 'done' }),
        issue({ statusCategory: 'indeterminate' }),
        issue({ statusCategory: 'new' }),
        issue({ statusCategory: 'new', inScope: false })
      ],
      TODAY
    )
    expect(r).toEqual({ total: 3, done: 1, indeterminate: 1, new: 1, overdue: 0 })
  })

  it('에픽 롤업에 하위작업(손자)은 들어가지 않는다', () => {
    const f = buildIssueForest(
      [
        epic('PROJ-1'),
        child('PROJ-2', 'PROJ-1', { statusCategory: 'done' }),
        sub('PROJ-3', 'PROJ-2', { statusCategory: 'new' }),
        sub('PROJ-4', 'PROJ-2', { statusCategory: 'new' })
      ],
      TODAY
    )
    expect(f.groups[0].rollup).toMatchObject({ total: 1, done: 1, new: 0 })
  })

  it('0건이면 모두 0', () => {
    expect(rollupChildren([], TODAY)).toEqual({ total: 0, done: 0, indeterminate: 0, new: 0, overdue: 0 })
  })

  it('기한 지난 미완료만 overdue 로 센다 — 완료 항목은 제외', () => {
    const r = rollupChildren(
      [
        issue({ duedate: '2026-11-01', statusCategory: 'new' }),
        issue({ duedate: '2026-11-01', statusCategory: 'done' }),
        issue({ duedate: TODAY, statusCategory: 'new' })
      ],
      TODAY
    )
    expect(r.overdue).toBe(1)
  })
})

describe('statusVisual', () => {
  it('카테고리만으로 배지 색과 도트 모양을 정한다', () => {
    expect(statusVisual('new')).toMatchObject({ badge: releaseItemStatus.todo, shape: '○' })
    expect(statusVisual('indeterminate')).toMatchObject({ badge: releaseItemStatus.progress, shape: '◐' })
    expect(statusVisual('done')).toMatchObject({ badge: releaseItemStatus.done, shape: '●' })
  })
  it('알 수 없는 값은 new 로 본다', () => {
    expect(statusVisual('weird')).toEqual(statusVisual('new'))
  })
})

describe('matchesFilter', () => {
  const f = (over: Partial<BoardFilter>): BoardFilter => ({ ...EMPTY_FILTER, ...over })
  const it1 = issue({ key: 'PROJ-42', summary: 'Payment API 연동', assigneeAccountId: ME, status: 'In Review' })

  it('키·제목을 대소문자 없이 찾고, 토큰은 모두 맞아야 한다', () => {
    expect(matchesFilter(it1, f({ query: 'payment' }), ME)).toBe(true)
    expect(matchesFilter(it1, f({ query: 'proj-42' }), ME)).toBe(true)
    expect(matchesFilter(it1, f({ query: 'payment 연동' }), ME)).toBe(true)
    expect(matchesFilter(it1, f({ query: 'payment 영수증' }), ME)).toBe(false)
  })
  it('내 담당만', () => {
    expect(matchesFilter(it1, f({ mineOnly: true }), ME)).toBe(true)
    expect(matchesFilter(it1, f({ mineOnly: true }), 'acc-other')).toBe(false)
  })
  it('내 계정 id 를 모르면 내 담당만을 무시한다', () => {
    expect(matchesFilter(it1, f({ mineOnly: true }), null)).toBe(true)
    expect(isFilterActive(f({ mineOnly: true }), null)).toBe(false)
  })
  it('완료 숨김', () => {
    expect(matchesFilter(issue({ statusCategory: 'done' }), f({ hideDone: true }), ME)).toBe(false)
  })
  it('카테고리·세부 상태명·유형', () => {
    expect(matchesFilter(it1, f({ categories: ['indeterminate'] }), ME)).toBe(true)
    expect(matchesFilter(it1, f({ categories: ['new'] }), ME)).toBe(false)
    expect(matchesFilter(it1, f({ statuses: ['In Review'] }), ME)).toBe(true)
    expect(matchesFilter(it1, f({ statuses: ['QA'] }), ME)).toBe(false)
    expect(matchesFilter(it1, f({ types: ['작업'] }), ME)).toBe(true)
    expect(matchesFilter(it1, f({ types: ['버그'] }), ME)).toBe(false)
  })
  it('기본 필터는 내 담당만이 켜져 있다', () => {
    expect(DEFAULT_FILTER.mineOnly).toBe(true)
    expect(isFilterActive(DEFAULT_FILTER, ME)).toBe(true)
    expect(isFilterActive(EMPTY_FILTER, ME)).toBe(false)
  })
})

describe('filterForest', () => {
  const forest = buildIssueForest(
    [
      epic('PROJ-1', { assigneeAccountId: 'other' }),
      child('PROJ-2', 'PROJ-1', { assigneeAccountId: 'other' }),
      sub('PROJ-3', 'PROJ-2', { assigneeAccountId: ME }),
      child('PROJ-4', 'PROJ-1', { assigneeAccountId: 'other', statusCategory: 'done' }),
      epic('PROJ-10', { assigneeAccountId: 'other' }),
      child('PROJ-11', 'PROJ-10', { assigneeAccountId: 'other' })
    ],
    TODAY
  )
  const mine: BoardFilter = { ...EMPTY_FILTER, mineOnly: true }

  it('맞은 항목의 조상은 남기고 matched=false 로 표시한다', () => {
    const out = filterForest(forest, mine, ME)
    expect(groupIds(out)).toEqual(['PROJ-1'])
    const g = out.groups[0]
    expect(g.matched).toBe(false)
    expect(g.children.map((c) => [c.issue.key, c.matched])).toEqual([['PROJ-2', false]])
    expect(g.children[0].children.map((s) => [s.issue.key, s.matched])).toEqual([['PROJ-3', true]])
  })

  it('맞은 것이 없는 그룹은 뺀다', () => {
    expect(filterForest(forest, { ...EMPTY_FILTER, query: '없는말' }, ME).groups).toEqual([])
  })

  it('롤업은 필터 전 값을 유지한다', () => {
    const out = filterForest(forest, mine, ME)
    expect(out.groups[0].rollup).toEqual(forest.groups.find((g) => g.id === 'PROJ-1')!.rollup)
  })

  it('범위 밖 조상은 자기가 맞아도 matched 가 아니다', () => {
    const f = buildIssueForest(
      [epic('PROJ-1', { inScope: false, assigneeAccountId: ME }), child('PROJ-2', 'PROJ-1', { assigneeAccountId: ME })],
      TODAY
    )
    const out = filterForest(f, mine, ME)
    expect(out.groups[0].matched).toBe(false)
    expect(out.groups[0].children[0].matched).toBe(true)
  })

  it('autoExpandIds 는 흐린 조상을 펼치고, 검색 중에는 맞은 항목의 조상도 펼친다', () => {
    const out = filterForest(forest, mine, ME)
    expect([...autoExpandIds(out, '')].sort()).toEqual(['PROJ-1', 'PROJ-2'])
    const q = filterForest(forest, { ...EMPTY_FILTER, query: 'PROJ-11' }, ME)
    expect([...autoExpandIds(q, 'PROJ-11')]).toEqual(['PROJ-10'])
    // 검색이 아니고 조상도 맞았으면 펼치지 않는다
    const all = filterForest(forest, EMPTY_FILTER, ME)
    expect(autoExpandIds(all, '').size).toBe(0)
  })

  it('effectiveExpanded: 검색 중엔 자동 펼침이 이기고, 아니면 사용자 값이 이긴다', () => {
    const auto = new Set(['PROJ-1'])
    expect(effectiveExpanded({ 'PROJ-1': false }, auto, 'x')['PROJ-1']).toBe(true)
    expect(effectiveExpanded({ 'PROJ-1': false }, auto, '')['PROJ-1']).toBe(false)
    expect(effectiveExpanded({}, auto, '')['PROJ-1']).toBe(true)
  })
})

describe('sortGroups / sortChildren', () => {
  it('자식은 진행 → 할 일 → 완료, 같으면 키 숫자 순', () => {
    const f = buildIssueForest(
      [
        epic('PROJ-1'),
        child('PROJ-10', 'PROJ-1', { statusCategory: 'new' }),
        child('PROJ-9', 'PROJ-1', { statusCategory: 'new' }),
        child('PROJ-20', 'PROJ-1', { statusCategory: 'done' }),
        child('PROJ-30', 'PROJ-1', { statusCategory: 'indeterminate' })
      ],
      TODAY
    )
    expect(sortChildren(f.groups[0].children).map((c) => c.issue.key)).toEqual([
      'PROJ-30',
      'PROJ-9',
      'PROJ-10',
      'PROJ-20'
    ])
  })

  const forest = buildIssueForest(
    [
      child('PROJ-90', null),
      sub('PROJ-91', 'PROJ-999'),
      child('PROJ-80', 'PROJ-888', { parentSummary: '범위 밖' }),
      epic('PROJ-10', { duedate: '2026-12-01', updated: '2026-11-01T00:00:00Z' }),
      child('PROJ-11', 'PROJ-10', { statusCategory: 'indeterminate' }),
      epic('PROJ-9', { duedate: '2026-11-20', updated: '2026-11-15T00:00:00Z' }),
      child('PROJ-12', 'PROJ-9', { statusCategory: 'indeterminate' }),
      child('PROJ-13', 'PROJ-9', { statusCategory: 'indeterminate' }),
      epic('PROJ-2', { updated: '2026-10-01T00:00:00Z' })
    ],
    TODAY
  )
  const order = (s: Parameters<typeof sortGroups>[1]): string[] => groupIds({ groups: sortGroups(forest.groups, s) })
  const tail = [missingEpicId('PROJ-888'), NO_EPIC_ID, ORPHAN_SUBTASKS_ID]

  it('진행 중 많은 순, 동률은 키 숫자 순, 고아 그룹은 늘 마지막', () => {
    expect(order('active')).toEqual(['PROJ-9', 'PROJ-10', 'PROJ-2', ...tail])
  })
  it('키 순', () => {
    expect(order('key')).toEqual(['PROJ-2', 'PROJ-9', 'PROJ-10', ...tail])
  })
  it('최근 업데이트 순', () => {
    expect(order('updated').slice(0, 3)).toEqual(['PROJ-9', 'PROJ-10', 'PROJ-2'])
  })
  it('기한 임박 순(기한 없음은 뒤)', () => {
    expect(order('due').slice(0, 3)).toEqual(['PROJ-9', 'PROJ-10', 'PROJ-2'])
  })
  it('안정 정렬: 같은 입력은 같은 결과', () => {
    expect(order('active')).toEqual(order('active'))
  })
})

describe('flattenVisible', () => {
  const forest = buildIssueForest(
    [
      epic('PROJ-1'),
      child('PROJ-2', 'PROJ-1'),
      sub('PROJ-3', 'PROJ-2'),
      sub('PROJ-4', 'PROJ-2'),
      child('PROJ-5', 'PROJ-1'),
      epic('PROJ-6')
    ],
    TODAY
  )

  it('기본값: 에픽은 펼침, 하위작업은 접힘', () => {
    const rows = flattenVisible(forest, {})
    expect(rows.map((r) => r.id)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-5', 'PROJ-6'])
  })

  it('aria level·posinset·setsize 가 정확하다', () => {
    const rows = flattenVisible(forest, { 'PROJ-2': true })
    expect(rows.map((r) => [r.id, r.level, r.posinset, r.setsize])).toEqual([
      ['PROJ-1', 1, 1, 2],
      ['PROJ-2', 2, 1, 2],
      ['PROJ-3', 3, 1, 2],
      ['PROJ-4', 3, 2, 2],
      ['PROJ-5', 2, 2, 2],
      ['PROJ-6', 1, 2, 2]
    ])
    expect(rows.find((r) => r.id === 'PROJ-2')).toMatchObject({ hasChildren: true, expanded: true })
    // 자식 없는 에픽은 펼침 상태를 갖지 않는다
    expect(rows.find((r) => r.id === 'PROJ-6')).toMatchObject({ hasChildren: false, expanded: false })
  })

  it('접힌 그룹의 자식은 뺀다', () => {
    expect(flattenVisible(forest, { 'PROJ-1': false }).map((r) => r.id)).toEqual(['PROJ-1', 'PROJ-6'])
  })

  it('expandableIds 는 자식 있는 행만', () => {
    expect(expandableIds(forest)).toEqual(['PROJ-1', 'PROJ-2'])
  })
})

describe('nextFocus / resolveFocus', () => {
  const forest = buildIssueForest(
    [epic('PROJ-1'), child('PROJ-2', 'PROJ-1'), sub('PROJ-3', 'PROJ-2'), epic('PROJ-6')],
    TODAY
  )
  const collapsed = flattenVisible(forest, {}) // PROJ-1, PROJ-2, PROJ-6
  const open = flattenVisible(forest, { 'PROJ-2': true }) // PROJ-1, PROJ-2, PROJ-3, PROJ-6

  it('↑/↓ 는 보이는 행을 옮기고 끝에서 멈춘다', () => {
    expect(nextFocus(collapsed, 'PROJ-1', 'ArrowDown')).toEqual({ focusId: 'PROJ-2' })
    expect(nextFocus(collapsed, 'PROJ-6', 'ArrowDown')).toEqual({ focusId: 'PROJ-6' })
    expect(nextFocus(collapsed, 'PROJ-1', 'ArrowUp')).toEqual({ focusId: 'PROJ-1' })
  })
  it('Home/End', () => {
    expect(nextFocus(open, 'PROJ-3', 'Home')).toEqual({ focusId: 'PROJ-1' })
    expect(nextFocus(open, 'PROJ-1', 'End')).toEqual({ focusId: 'PROJ-6' })
  })
  it('→ 접힌 행은 펼치고, 펼친 행은 첫 자식으로', () => {
    expect(nextFocus(collapsed, 'PROJ-2', 'ArrowRight')).toEqual({
      focusId: 'PROJ-2',
      toggle: { id: 'PROJ-2', expanded: true }
    })
    expect(nextFocus(open, 'PROJ-2', 'ArrowRight')).toEqual({ focusId: 'PROJ-3' })
    expect(nextFocus(open, 'PROJ-3', 'ArrowRight')).toEqual({ focusId: 'PROJ-3' })
  })
  it('← 펼친 행은 접고, 아니면 부모로', () => {
    expect(nextFocus(open, 'PROJ-2', 'ArrowLeft')).toEqual({
      focusId: 'PROJ-2',
      toggle: { id: 'PROJ-2', expanded: false }
    })
    expect(nextFocus(open, 'PROJ-3', 'ArrowLeft')).toEqual({ focusId: 'PROJ-2' })
    expect(nextFocus(open, 'PROJ-6', 'ArrowLeft')).toEqual({ focusId: 'PROJ-6' })
  })
  it('다루지 않는 키는 null, 현재 행이 없으면 첫 행', () => {
    expect(nextFocus(open, 'PROJ-1', 'a')).toBeNull()
    expect(nextFocus(open, null, 'ArrowDown')).toEqual({ focusId: 'PROJ-1' })
  })
  it('포커스 행이 사라지면 남은 가장 가까운 조상으로 옮긴다', () => {
    expect(resolveFocus(collapsed, 'PROJ-3', forest)).toBe('PROJ-2')
    const groupClosed = flattenVisible(forest, { 'PROJ-1': false })
    expect(resolveFocus(groupClosed, 'PROJ-3', forest)).toBe('PROJ-1')
    expect(resolveFocus(groupClosed, 'NOPE-1', forest)).toBe('PROJ-1')
    expect(resolveFocus([], 'PROJ-1', forest)).toBeNull()
  })
})

describe('treeKeyAction / isTreeRowTarget', () => {
  const forest = buildIssueForest([epic('PROJ-1'), child('PROJ-2', 'PROJ-1')], TODAY)
  const rows = flattenVisible(forest, {})

  it('행이 아닌 곳(버튼 등)에서 온 키는 어떤 것도 처리하지 않는다', () => {
    for (const key of ['Enter', 'o', 'ArrowDown', 'ArrowLeft', 'Home']) {
      expect(treeKeyAction(rows, 'PROJ-2', { key }, false)).toBeNull()
    }
  })
  it('행에서 Enter 는 선택, o·⌘Enter 는 Jira 열기, 화살표는 이동', () => {
    expect(treeKeyAction(rows, 'PROJ-2', { key: 'Enter' }, true)).toEqual({ kind: 'select', id: 'PROJ-2' })
    expect(treeKeyAction(rows, 'PROJ-2', { key: 'o' }, true)).toEqual({ kind: 'open', key: 'PROJ-2' })
    expect(treeKeyAction(rows, 'PROJ-1', { key: 'Enter', metaKey: true }, true)).toEqual({ kind: 'open', key: 'PROJ-1' })
    expect(treeKeyAction(rows, 'PROJ-2', { key: 'ArrowUp' }, true)).toEqual({ kind: 'move', move: { focusId: 'PROJ-1' } })
  })
  it('⌘O 같은 앱 단축키는 건드리지 않는다', () => {
    expect(treeKeyAction(rows, 'PROJ-2', { key: 'o', metaKey: true }, true)).toBeNull()
  })
  it('isTreeRowTarget 은 role=row 요소만 참이다', () => {
    const el = (role: string | null) => ({ getAttribute: (n: string) => (n === 'role' ? role : null) })
    expect(isTreeRowTarget(el('row'))).toBe(true)
    expect(isTreeRowTarget(el('gridcell'))).toBe(false)
    expect(isTreeRowTarget(el(null))).toBe(false)
    expect(isTreeRowTarget(null)).toBe(false)
  })
})

describe('summaryTiles', () => {
  const issues = [
    epic('PROJ-1'),
    child('PROJ-2', 'PROJ-1', { assigneeAccountId: ME }),
    child('PROJ-3', 'PROJ-1', { status: 'In Review' }),
    child('PROJ-4', 'PROJ-1', { status: 'QA' }),
    child('PROJ-5', 'PROJ-1', { statusCategory: 'new', status: '할 일', duedate: '2026-11-01' }),
    child('PROJ-6', 'PROJ-1', { statusCategory: 'new', inScope: false }),
    child('PROJ-7', 'PROJ-1', { statusCategory: 'done', status: '완료', duedate: '2026-11-01' })
  ]

  it('진행 중·리뷰QA·할 일·최근 완료를 센다(에픽·범위 밖 제외)', () => {
    const tiles = summaryTiles(issues, TODAY, ME, 14)
    expect(tiles.map((t) => [t.key, t.value])).toEqual([
      ['progress', '1건'],
      ['review', '2건'],
      ['todo', '1건'],
      ['done', '1건']
    ])
    expect(tiles.find((t) => t.key === 'done')!.label).toBe('완료(최근 14일)')
    expect(tiles.find((t) => t.key === 'progress')!.sub).toBe('내 담당 1')
  })

  it('마감 지남은 해당 타일에만 붙고, 완료는 세지 않는다', () => {
    const tiles = summaryTiles(issues, TODAY, ME, 14)
    expect(tiles.find((t) => t.key === 'todo')!.alert).toBe('마감 지남 1')
    expect(tiles.find((t) => t.key === 'done')!.alert).toBeNull()
  })

  it('리뷰·QA 가 0건이면 타일을 숨긴다', () => {
    const tiles = summaryTiles([child('PROJ-2', null)], TODAY, ME, 14)
    expect(tiles.map((t) => t.key)).toEqual(['progress', 'todo', 'done'])
  })

  it('내 계정 id 를 모르면 보조 줄을 비운다', () => {
    expect(summaryTiles(issues, TODAY, null, 14)[0].sub).toBeNull()
  })
})

describe('deriveFacets', () => {
  it('등장한 범위 안 세부 상태명·유형만, 카테고리 순 → 이름 순', () => {
    const facets = deriveFacets([
      issue({ status: '완료', statusCategory: 'done', issueType: '버그' }),
      issue({ status: '할 일', statusCategory: 'new', issueType: '작업' }),
      issue({ status: 'QA', statusCategory: 'indeterminate', issueType: '작업' }),
      issue({ status: '백로그', statusCategory: 'new', inScope: false, issueType: '스토리' })
    ])
    expect(facets.statuses.map((s) => s.name)).toEqual(['QA', '할 일', '완료'])
    expect(facets.types).toEqual(['버그', '작업'])
  })
})

describe('priorityMarks / issueTypeKind / 기타', () => {
  it('우선순위 이름을 점 개수로 바꾼다(영·한)', () => {
    expect(priorityMarks('Highest')).toBe('●●●')
    expect(priorityMarks('High')).toBe('●●●')
    expect(priorityMarks('높음')).toBe('●●●')
    expect(priorityMarks('Medium')).toBe('●●')
    expect(priorityMarks('보통')).toBe('●●')
    expect(priorityMarks('Low')).toBe('●')
    expect(priorityMarks('Lowest')).toBe('●')
    expect(priorityMarks('낮음')).toBe('●')
    expect(priorityMarks(null)).toBeNull()
    expect(priorityMarks('알수없음')).toBeNull()
  })

  it('유형 아이콘은 level 우선, 세부 유형은 이름으로', () => {
    expect(issueTypeKind('epic', 'Task')).toBe('epic')
    expect(issueTypeKind('subtask', '하위 작업')).toBe('subtask')
    expect(issueTypeKind('standard', '스토리')).toBe('story')
    expect(issueTypeKind('standard', 'Bug')).toBe('bug')
    expect(issueTypeKind('standard', '작업')).toBe('task')
    expect(issueTypeKind('standard', '개선')).toBe('other')
  })

  it('담당자 요약은 최다 1명 + 외 n', () => {
    const f = buildIssueForest(
      [
        child('PROJ-1', null, { assigneeName: '홍길동' }),
        child('PROJ-2', null, { assigneeName: '홍길동' }),
        child('PROJ-3', null, { assigneeName: '김철수' }),
        child('PROJ-4', null)
      ],
      TODAY
    )
    expect(assigneeSummary(f.groups[0].children)).toBe('홍길동 외 1')
    expect(assigneeSummary([])).toBeNull()
  })

  it('shortDate', () => {
    expect(shortDate('2026-11-05')).toBe('11/5')
  })
})

describe('최근 완료 / 이전 완료', () => {
  // TODAY 2026-11-18, 기간 14일 → 2026-11-04 이후 완료가 '최근'
  const OLD = '2026-09-01T03:00:00.000Z'
  const RECENT = '2026-11-15T03:00:00.000Z'
  const done = (key: string, parentKey: string | null, at: { resolvedAt?: string | null; updated?: string }, over: Partial<JiraBoardIssue> = {}) =>
    child(key, parentKey, { statusCategory: 'done', status: '완료', resolvedAt: at.resolvedAt ?? null, updated: at.updated ?? '2026-11-10T00:00:00Z', ...over })

  it('isRecentDone/isPastDone: resolvedAt 기준, 없으면 updated 로 대신한다', () => {
    expect(isRecentDone(done('A-1', null, { resolvedAt: RECENT }), TODAY, 14)).toBe(true)
    expect(isPastDone(done('A-2', null, { resolvedAt: OLD }), TODAY, 14)).toBe(true)
    expect(isRecentDone(done('A-3', null, { resolvedAt: null, updated: RECENT }), TODAY, 14)).toBe(true)
    expect(isPastDone(done('A-4', null, { resolvedAt: null, updated: OLD }), TODAY, 14)).toBe(true)
    // 경계: 정확히 14일 전 날짜는 최근에 든다
    expect(isRecentDone(done('A-5', null, { resolvedAt: '2026-11-04T12:00:00' }), TODAY, 14)).toBe(true)
    expect(isPastDone(done('A-6', null, { resolvedAt: '2026-11-03T12:00:00' }), TODAY, 14)).toBe(true)
    // 완료가 아니면 둘 다 아니다
    expect(isRecentDone(issue({ resolvedAt: RECENT }), TODAY, 14)).toBe(false)
    expect(isPastDone(issue({ updated: OLD }), TODAY, 14)).toBe(false)
  })

  it('요약 타일 "완료"는 최근 완료만 센다(updated 대체 포함), 내 담당도 같은 기준', () => {
    const tiles = summaryTiles(
      [
        done('P-1', null, { resolvedAt: RECENT }, { assigneeAccountId: ME }),
        done('P-2', null, { resolvedAt: null, updated: RECENT }),
        done('P-3', null, { resolvedAt: OLD }, { assigneeAccountId: ME }),
        done('P-4', null, { resolvedAt: null, updated: OLD }, { assigneeAccountId: ME })
      ],
      TODAY,
      ME,
      14
    )
    const t = tiles.find((x) => x.key === 'done')!
    expect(t.value).toBe('2건')
    expect(t.sub).toBe('내 담당 1')
  })

  const issues = [
    epic('PROJ-1'),
    child('PROJ-2', 'PROJ-1'),
    done('PROJ-3', 'PROJ-1', { resolvedAt: RECENT }),
    done('PROJ-4', 'PROJ-1', { resolvedAt: OLD }),
    done('PROJ-5', 'PROJ-1', { resolvedAt: OLD }),
    child('PROJ-6', 'PROJ-1', { inScope: false, statusCategory: 'new' }),
    // 이전 완료 작업이지만 보이는 하위작업이 있어 조상으로 남는다
    done('PROJ-7', 'PROJ-1', { resolvedAt: OLD }),
    sub('PROJ-8', 'PROJ-7'),
    sub('PROJ-9', 'PROJ-7', { statusCategory: 'done', resolvedAt: OLD })
  ]

  it('이전 완료 잎은 기본 숨기고 부모에 센다, 보이는 자손이 있으면 조상으로 남는다', () => {
    const f = buildIssueForest(issues, TODAY, { recentDoneDays: 14 })
    expect(childKeys(f, 'PROJ-1')).toEqual(['PROJ-2', 'PROJ-3', 'PROJ-7'])
    expect(f.groups[0]).toMatchObject({ pastDoneCount: 2, backlogCount: 1 })
    const p7 = f.groups[0].children.find((c) => c.issue.key === 'PROJ-7')!
    expect(p7.children.map((c) => c.issue.key)).toEqual(['PROJ-8'])
    expect(p7.pastDoneCount).toBe(1)
  })

  it('롤업(막대·하위 n/m)은 이전 완료를 포함해 그대로다', () => {
    const hidden = buildIssueForest(issues, TODAY, { recentDoneDays: 14 })
    const shown = buildIssueForest(issues, TODAY, { recentDoneDays: 14, showPastDone: true })
    expect(hidden.groups[0].rollup).toEqual(shown.groups[0].rollup)
    expect(hidden.groups[0].rollup).toMatchObject({ total: 5, done: 4 })
    const p7 = hidden.groups[0].children.find((c) => c.issue.key === 'PROJ-7')!
    expect(p7.rollup).toMatchObject({ total: 2, done: 1 })
  })

  it('"이전 완료 보기"를 켜면 이전 완료 잎도 보이고 건수는 0', () => {
    const f = buildIssueForest(issues, TODAY, { recentDoneDays: 14, showPastDone: true })
    expect(childKeys(f, 'PROJ-1')).toEqual(['PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-5', 'PROJ-7'])
    expect(f.groups[0].pastDoneCount).toBe(0)
    expect(f.groups[0].children.find((c) => c.issue.key === 'PROJ-7')!.children).toHaveLength(2)
  })

  it('보일 자식이 없는 에픽: 에픽이 살아 있으면 행만 남고, 에픽도 이전 완료면 숨긴다', () => {
    const alive = buildIssueForest([epic('PROJ-1'), done('PROJ-2', 'PROJ-1', { resolvedAt: OLD })], TODAY)
    expect(groupIds(alive)).toEqual(['PROJ-1'])
    expect(alive.groups[0]).toMatchObject({ children: [], pastDoneCount: 1 })
    const oldEpic = epic('PROJ-1', { statusCategory: 'done', resolvedAt: OLD })
    expect(groupIds(buildIssueForest([oldEpic, done('PROJ-2', 'PROJ-1', { resolvedAt: OLD })], TODAY))).toEqual([])
    // 보이는 자손이 있으면 이전 완료 에픽도 남는다
    expect(groupIds(buildIssueForest([oldEpic, child('PROJ-3', 'PROJ-1')], TODAY))).toEqual(['PROJ-1'])
    // 토글을 켜면 이전 완료 에픽도 보인다
    expect(groupIds(buildIssueForest([oldEpic], TODAY, { showPastDone: true }))).toEqual(['PROJ-1'])
  })

  it('가상 그룹(에픽 없음·고아 하위작업)에도 같은 규칙', () => {
    const f = buildIssueForest(
      [child('PROJ-2', null), done('PROJ-3', null, { resolvedAt: OLD }), sub('PROJ-4', 'X-1'), sub('PROJ-5', 'X-1', { statusCategory: 'done', resolvedAt: OLD })],
      TODAY
    )
    expect(childKeys(f, NO_EPIC_ID)).toEqual(['PROJ-2'])
    expect(f.groups.find((g) => g.id === NO_EPIC_ID)!.pastDoneCount).toBe(1)
    expect(childKeys(f, ORPHAN_SUBTASKS_ID)).toEqual(['PROJ-4'])
    expect(f.groups.find((g) => g.id === ORPHAN_SUBTASKS_ID)!.pastDoneCount).toBe(1)
    // 이전 완료만 있는 가상 그룹은 사라진다
    expect(groupIds(buildIssueForest([done('PROJ-3', null, { resolvedAt: OLD })], TODAY))).toEqual([])
  })

  it('완료 모두 숨김이 켜지면 이전 완료 보기를 무시하고, 필터가 최근 완료까지 숨긴다', () => {
    const on: BoardFilter = { ...EMPTY_FILTER, showPastDone: true }
    expect(forestOptions(on, 14)).toEqual({ recentDoneDays: 14, showPastDone: true })
    const both: BoardFilter = { ...on, hideDone: true }
    expect(forestOptions(both, 14)).toEqual({ recentDoneDays: 14, showPastDone: false })
    const out = filterForest(buildIssueForest(issues, TODAY, forestOptions(both, 14)), both, ME)
    // 완료는 모두 빠지고, 완료 작업 PROJ-7 은 열린 하위작업 때문에 흐린 조상으로만 남는다
    expect(childKeys(out, 'PROJ-1')).toEqual(['PROJ-2', 'PROJ-7'])
    expect(out.groups[0].children.find((c) => c.issue.key === 'PROJ-7')!.matched).toBe(false)
    // 이전 완료 보기는 필터 활성 판정에 들지 않는다
    expect(isFilterActive(on, ME)).toBe(false)
  })

  it('상세 하위 목록도 같은 규칙이고 숨긴 건수를 준다', () => {
    const f = buildIssueForest(issues, TODAY, { recentDoneDays: 14 })
    const epicT = detailTarget(f, 'PROJ-1')!
    expect(epicT.children.map((c) => c.issue.key)).toEqual(['PROJ-2', 'PROJ-3', 'PROJ-7'])
    expect(epicT).toMatchObject({ hiddenBacklog: 1, hiddenPastDone: 2 })
    expect(detailTarget(f, 'PROJ-7')).toMatchObject({ hiddenPastDone: 1 })
  })
})

describe('릴리스(fixVersion) 필터와 노출 판정', () => {
  const v = (id: string, name: string) => ({ id, name })
  const a = issue({ key: 'R-1', fixVersions: [v('10', '4.164.0')] })
  const b = issue({ key: 'R-2', fixVersions: [v('9', '4.9.0'), v('10', '4.164.0')] })
  const c = issue({ key: 'R-3', fixVersions: [] })
  const f = (releases: string[]): BoardFilter => ({ ...EMPTY_FILTER, releases })

  it('고른 릴리스 중 하나라도 있으면 맞는다. "릴리스 없음"은 fixVersion 이 없는 이슈', () => {
    expect([a, b, c].filter((i) => matchesFilter(i, f(['4.164.0']), ME)).map((i) => i.key)).toEqual(['R-1', 'R-2'])
    expect([a, b, c].filter((i) => matchesFilter(i, f(['4.9.0']), ME)).map((i) => i.key)).toEqual(['R-2'])
    expect([a, b, c].filter((i) => matchesFilter(i, f([NO_RELEASE]), ME)).map((i) => i.key)).toEqual(['R-3'])
    expect([a, b, c].filter((i) => matchesFilter(i, f([NO_RELEASE, '4.9.0']), ME)).map((i) => i.key)).toEqual(['R-2', 'R-3'])
    expect(isFilterActive(f(['4.9.0']), ME)).toBe(true)
  })

  it('deriveFacets 는 등장한 릴리스를 버전 큰 순으로, 릴리스 없음 후보 여부를 준다', () => {
    const facets = deriveFacets([a, b, c])
    expect(facets.releases).toEqual(['4.164.0', '4.9.0'])
    expect(facets.hasNoRelease).toBe(true)
    expect(deriveFacets([a]).hasNoRelease).toBe(false)
  })

  it('isRevealable: 스냅샷에 있고 범위 안이거나 범위 안 자손이 있어야 한다', () => {
    const issues = [
      epic('E-1', { inScope: false }),
      child('E-2', 'E-1'),
      child('E-3', null, { inScope: false }),
      epic('E-4', { inScope: false }),
      child('E-5', 'E-4', { inScope: false }),
      sub('E-6', 'E-5')
    ]
    expect(isRevealable(issues, 'E-2')).toBe(true)
    expect(isRevealable(issues, 'E-1')).toBe(true)
    expect(isRevealable(issues, 'E-3')).toBe(false)
    expect(isRevealable(issues, 'E-4')).toBe(true)
    expect(isRevealable(issues, 'NOPE-1')).toBe(false)
  })
})

describe('revealFilter — 보드에서 보기가 푸는 조건', () => {
  const target = issue({ key: 'PROJ-42', summary: '결제', assigneeAccountId: 'other', issueType: '작업' })
  it('그 이슈를 가리는 조건만 끄고 나머지는 둔다', () => {
    const f: BoardFilter = { ...EMPTY_FILTER, mineOnly: true, types: ['작업'], hideDone: true, query: '결제' }
    const r = revealFilter(target, f, ME)
    expect(r.filter).toEqual({ ...f, mineOnly: false })
    expect(r.cleared).toEqual(['내 담당만'])
  })
  it('여러 조건이 가리면 모두 끈다', () => {
    const f: BoardFilter = { ...EMPTY_FILTER, mineOnly: true, query: '없는말', categories: ['done'] }
    const r = revealFilter(target, f, ME)
    expect(r.filter).toEqual(EMPTY_FILTER)
    expect(r.cleared).toEqual(['검색', '상태 분류', '내 담당만'])
    expect(matchesFilter(target, r.filter, ME)).toBe(true)
  })
})

describe('syncResultText', () => {
  it('실제로 돈 방식을 말한다', () => {
    expect(syncResultText({ mode: 'incremental', changed: 3 })).toBe('3건 갱신')
    expect(syncResultText({ mode: 'incremental', changed: 0 })).toBe('변경 없음')
    expect(syncResultText({ mode: 'full', changed: 9 }, 'full')).toBe('전체 동기화')
    expect(syncResultText({ mode: 'cache', changed: 0 }, 'auto')).toBeNull()
    expect(syncResultText(null)).toBeNull()
  })
  it('전체 다시 받기를 요청했는데 전체가 안 돌았으면 그 사실을 붙인다', () => {
    expect(syncResultText({ mode: 'incremental', changed: 3 }, 'full')).toBe(
      '3건 갱신 · 전체 다시 받기가 끝나지 않았어요. 다시 시도해 주세요'
    )
    expect(syncResultText({ mode: 'cache', changed: 0 }, 'full')).toBe('전체 다시 받기가 끝나지 않았어요. 다시 시도해 주세요')
  })
})
