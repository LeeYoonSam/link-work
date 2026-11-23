import { describe, it, expect } from 'vitest'
import type { JiraBoardIssue, JiraIssueLink } from '../../types'
import { NO_EPIC_ID, buildIssueForest, detailTarget } from './boardModel'
import {
  EMPTY_DOCS_FILTER,
  buildDocsView,
  docSource,
  formatSize,
  isDocGroupOpen,
  isDocsSearching,
  matchesDoc,
  mergeLinks,
  relatedDocs,
  type DocsFilter
} from './docsModel'

// 문서 탭·상세 "관련 문서"의 묶기·중복 합치기·필터 규칙을 잠근다 (docs/PROJECT_BOARD.md).

const TODAY = '2026-11-18'
const ME = 'acc-me'

const issue = (over: Partial<JiraBoardIssue>): JiraBoardIssue => ({
  key: 'PROJ-1',
  summary: '제목',
  issueType: '작업',
  level: 'standard',
  status: '진행 중',
  statusCategory: 'indeterminate',
  inScope: true,
  priority: null,
  parentKey: null,
  parentSummary: null,
  assigneeAccountId: ME,
  assigneeName: '나',
  duedate: null,
  updated: '2026-11-10T00:00:00Z',
  resolvedAt: null,
  labels: [],
  excerpt: null,
  fixVersions: [],
  links: [],
  ...over
})

const web = (url: string, title = url, source = 'Confluence'): JiraIssueLink => ({ kind: 'web', title, url, source })
const desc = (url: string, source = 'Figma'): JiraIssueLink => ({ kind: 'description', title: url, url, source })
const att = (url: string, size = 2048): JiraIssueLink => ({
  kind: 'attachment',
  title: 'spec.pdf',
  url,
  source: 'Jira',
  mimeType: 'application/pdf',
  size
})
const rel = (key: string, relation: string, status = '진행 중'): JiraIssueLink => ({
  kind: 'issue',
  title: `${key} 제목`,
  url: `https://acme.atlassian.net/browse/${key}`,
  source: 'Jira',
  issueKey: key,
  relation,
  issueStatus: status
})

const ISSUES: JiraBoardIssue[] = [
  issue({ key: 'PROJ-1', level: 'epic', issueType: '에픽', summary: '결제 개편', links: [web('https://wiki/plan', '기획서')] }),
  issue({
    key: 'PROJ-2',
    parentKey: 'PROJ-1',
    summary: 'API',
    links: [rel('OTHER-9', '선행 작업'), web('https://wiki/plan', '기획서'), desc('https://figma.com/x')]
  }),
  issue({
    key: 'PROJ-3',
    parentKey: 'PROJ-1',
    summary: '메일',
    assigneeAccountId: 'other',
    links: [att('https://acme.atlassian.net/att/1'), rel('OTHER-1', '관심')]
  }),
  issue({ key: 'PROJ-4', parentKey: 'PROJ-2', level: 'subtask', issueType: '하위 작업', links: [web('https://docs.google.com/d', 'QA 시트', 'Google 문서')] }),
  // 오래전 완료 잎: 보드에 안 보이므로 문서 탭에도 안 나온다
  issue({
    key: 'PROJ-5',
    parentKey: 'PROJ-1',
    statusCategory: 'done',
    resolvedAt: '2026-08-01T00:00:00Z',
    links: [web('https://old/doc', '옛 문서')]
  }),
  // 백로그 잎도 제외
  issue({ key: 'PROJ-6', parentKey: 'PROJ-1', inScope: false, statusCategory: 'new', links: [web('https://backlog/doc')] }),
  issue({ key: 'PROJ-9', summary: '에픽 없는 작업', links: [rel('OTHER-2', '관심')] })
]

const forest = buildIssueForest(ISSUES, TODAY, { recentDoneDays: 14 })
const viewOf = (f: Partial<DocsFilter> = {}, mineOn = false) =>
  buildDocsView(forest, { ...EMPTY_DOCS_FILTER, ...f }, { on: mineOn, myAccountId: ME })
const urls = (entries: { url: string }[]): string[] => entries.map((e) => e.url)

describe('mergeLinks', () => {
  it('같은 URL 은 한 번만, 걸린 티켓을 모으고, 문서 → 연결 이슈 순서로 둔다', () => {
    const merged = mergeLinks(ISSUES.slice(0, 2))
    expect(urls(merged)).toEqual(['https://wiki/plan', 'https://figma.com/x', 'https://acme.atlassian.net/browse/OTHER-9'])
    expect(merged[0].origins.map((o) => o.key)).toEqual(['PROJ-1', 'PROJ-2'])
  })
  it('url 없는 링크는 버린다', () => {
    expect(mergeLinks([issue({ links: [{ kind: 'web', title: 'x', url: '', source: '' }] })])).toEqual([])
  })
})

describe('buildDocsView', () => {
  it('보드 그룹 규칙대로 에픽 → 티켓으로 묶고, 보드에 안 보이는 이슈(이전 완료·백로그 잎)는 뺀다', () => {
    const v = viewOf()
    expect(v.groups.map((g) => g.id)).toEqual(['PROJ-1', NO_EPIC_ID])
    const epic = v.groups[0]
    // 종류 순(웹링크 → 첨부 → 본문), 같은 종류 안은 보드 순서(에픽 → 자식 → 그 하위작업)대로 첫 등장 순
    expect(urls(epic.docs)).toEqual([
      'https://wiki/plan',
      'https://docs.google.com/d',
      'https://acme.atlassian.net/att/1',
      'https://figma.com/x'
    ])
    expect(urls(epic.docs)).not.toContain('https://old/doc')
    expect(urls(epic.docs)).not.toContain('https://backlog/doc')
  })

  it('같은 그룹 안 같은 URL 은 합쳐 "n개 티켓에서 연결"이 된다', () => {
    const plan = viewOf().groups[0].docs.find((e) => e.url === 'https://wiki/plan')!
    expect(plan.origins.map((o) => o.key)).toEqual(['PROJ-1', 'PROJ-2'])
  })

  it('연결 이슈는 문서와 따로, 관계 이름 순으로 모은다', () => {
    const g = viewOf().groups[0]
    expect(g.issues.map((e) => e.link.relation)).toEqual(['관심', '선행 작업'])
    expect(g.docs.every((e) => e.kind !== 'issue')).toBe(true)
  })

  it('종류별 건수는 종류 필터를 빼고 센다', () => {
    const all = viewOf()
    expect(all.kindCounts).toEqual({ web: 2, attachment: 1, description: 1, issue: 3 })
    const onlyIssue = viewOf({ kinds: ['issue'] })
    expect(onlyIssue.kindCounts).toEqual(all.kindCounts)
    expect(onlyIssue.groups.every((g) => g.docs.length === 0)).toBe(true)
    expect(onlyIssue.groups.flatMap((g) => g.issues)).toHaveLength(3)
  })

  it('검색은 제목·URL·티켓 키·그룹 에픽 키를 본다', () => {
    expect(urls(viewOf({ query: '기획서' }).groups.flatMap((g) => g.docs))).toEqual(['https://wiki/plan'])
    expect(urls(viewOf({ query: 'figma.com' }).groups.flatMap((g) => g.docs))).toEqual(['https://figma.com/x'])
    // 출처 티켓 키
    expect(urls(viewOf({ query: 'PROJ-4' }).groups.flatMap((g) => g.docs))).toEqual(['https://docs.google.com/d'])
    // 에픽 키는 그 그룹 전체
    const byEpic = viewOf({ query: 'PROJ-1' })
    expect(byEpic.groups.map((g) => g.id)).toEqual(['PROJ-1'])
    // 연결 이슈 키
    expect(viewOf({ query: 'OTHER-2' }).groups.map((g) => g.id)).toEqual([NO_EPIC_ID])
  })

  it('출처 필터. 첨부는 출처 "첨부"로 묶인다', () => {
    expect(viewOf().sources).toContain('첨부')
    const v = viewOf({ sources: ['첨부'] })
    expect(urls(v.groups.flatMap((g) => g.docs))).toEqual(['https://acme.atlassian.net/att/1'])
  })

  it('출처를 하나 골라도 다른 출처가 후보에 남는다(종류·출처 필터를 빼고 센다)', () => {
    const all = viewOf().sources
    expect(all.length).toBeGreaterThan(1)
    expect(viewOf({ sources: ['Figma'] }).sources).toEqual(all)
    expect(viewOf({ kinds: ['issue'] }).sources).toEqual(all)
  })

  it('검색어가 고른 출처를 모두 가려도 고른 출처는 후보에 남는다(해제할 수 있게)', () => {
    const v = viewOf({ sources: ['Figma'], query: '기획서' })
    expect(v.sources).toContain('Figma')
    expect(v.groups).toEqual([])
  })

  it('종류 건수는 고른 종류와 무관하게 네 종류 모두 센다', () => {
    expect(Object.keys(viewOf({ kinds: ['web'] }).kindCounts).sort()).toEqual(['attachment', 'description', 'issue', 'web'])
  })

  it('내 담당만이면 내 티켓에서 온 링크만 남긴다', () => {
    const v = viewOf({}, true)
    const all = v.groups.flatMap((g) => [...g.docs, ...g.issues])
    expect(urls(all)).not.toContain('https://acme.atlassian.net/att/1')
    expect(urls(all)).not.toContain('https://acme.atlassian.net/browse/OTHER-1')
    expect(v.total).toBe(all.length)
  })

  it('링크가 하나도 없으면 total 0, 그룹 없음', () => {
    const v = buildDocsView(buildIssueForest([issue({ key: 'PROJ-1' })], TODAY), EMPTY_DOCS_FILTER)
    expect(v).toMatchObject({ total: 0, groups: [] })
  })
})

describe('matchesDoc / docSource / formatSize', () => {
  it('matchesDoc 은 종류·출처·검색을 모두 만족해야 한다', () => {
    const [e] = mergeLinks([issue({ key: 'PROJ-2', links: [web('https://wiki/a', '설계', 'Confluence')] })])
    expect(matchesDoc(e, { query: '설계', kinds: ['web'], sources: ['Confluence'] })).toBe(true)
    expect(matchesDoc(e, { query: '설계', kinds: ['issue'], sources: [] })).toBe(false)
    expect(matchesDoc(e, { query: '', kinds: [], sources: ['Figma'] })).toBe(false)
  })
  it('docSource: 첨부는 첨부, 빈 출처는 기타', () => {
    expect(docSource(att('https://x'))).toBe('첨부')
    expect(docSource({ kind: 'web', title: '', url: 'https://x', source: ' ' })).toBe('기타')
  })
  it('formatSize', () => {
    expect(formatSize(512)).toBe('512B')
    expect(formatSize(2048)).toBe('2KB')
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0MB')
    expect(formatSize(null)).toBeNull()
  })
})

describe('relatedDocs (상세 패널)', () => {
  it('에픽이면 보이는 자손 것까지 합쳐 중복 제거한다', () => {
    const r = relatedDocs(detailTarget(forest, 'PROJ-1'), 10)
    expect(r.total).toBe(6)
    expect(r.items.filter((e) => e.url === 'https://wiki/plan')).toHaveLength(1)
    expect(urls(r.items)).not.toContain('https://old/doc')
  })
  it('표준 이슈면 자신과 하위작업의 링크', () => {
    const r = relatedDocs(detailTarget(forest, 'PROJ-2'), 10)
    expect(urls(r.items).sort()).toEqual(
      ['https://wiki/plan', 'https://figma.com/x', 'https://acme.atlassian.net/browse/OTHER-9', 'https://docs.google.com/d'].sort()
    )
  })
  it('상한만큼만 주고 전체 수를 알려 준다', () => {
    const r = relatedDocs(detailTarget(forest, 'PROJ-1'), 2)
    expect(r.items).toHaveLength(2)
    expect(r.total).toBe(6)
  })
  it('대상이 없으면 빈 결과', () => {
    expect(relatedDocs(null)).toEqual({ items: [], total: 0 })
  })
})

describe('isDocGroupOpen', () => {
  it('기본은 펼침', () => {
    expect(isDocGroupOpen({}, 'PROJ-1', '')).toBe(true)
    expect(isDocGroupOpen({ 'PROJ-1': false }, 'PROJ-1', '')).toBe(true)
  })

  it('저장된 접힘을 따른다', () => {
    expect(isDocGroupOpen({ 'PROJ-1': true }, 'PROJ-1', '')).toBe(false)
    expect(isDocGroupOpen({ 'PROJ-1': true }, 'PROJ-2', '')).toBe(true)
  })

  it('검색어가 있으면 접힘을 무시하고 펼친다', () => {
    expect(isDocGroupOpen({ 'PROJ-1': true }, 'PROJ-1', '기획')).toBe(true)
  })

  it('공백만 있는 검색어는 검색이 아니다', () => {
    expect(isDocsSearching('   ')).toBe(false)
    expect(isDocsSearching(' a ')).toBe(true)
    expect(isDocGroupOpen({ 'PROJ-1': true }, 'PROJ-1', '  ')).toBe(false)
  })
})
