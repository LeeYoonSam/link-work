import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { JiraBoardIssue, JiraBoardSnapshot } from '../../types'
import type { JiraBoardState } from '../../stores/jiraBoardStore'
import { EMPTY_FILTER } from './boardModel'
import { EMPTY_DOCS_FILTER } from './docsModel'

// 문서 탭 화면 분기와 묶음 마크업을 잠근다. 묶기 규칙 자체는 docsModel.test.ts 가 맡는다.

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
  assigneeAccountId: 'acc-me',
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

const ISSUES = [
  issue({ key: 'PROJ-1', level: 'epic', issueType: '에픽', summary: '결제 개편', links: [{ kind: 'web', title: '기획서', url: 'https://wiki/plan', source: 'Confluence' }] }),
  issue({
    key: 'PROJ-2',
    parentKey: 'PROJ-1',
    links: [
      { kind: 'web', title: '기획서', url: 'https://wiki/plan', source: 'Confluence' },
      { kind: 'issue', title: '서버 작업', url: 'https://x/browse/PAY-1', source: 'Jira', issueKey: 'PAY-1', relation: '관심', issueStatus: '완료' }
    ]
  })
]

const snapshot = (over: Partial<JiraBoardSnapshot> = {}): JiraBoardSnapshot => ({
  projectKey: 'PROJ',
  myAccountId: 'acc-me',
  issues: ISSUES,
  truncated: false,
  recentDoneDays: 14,
  fetchedAt: '2026-11-18T01:42:00.000Z',
  lastFullSyncAt: null,
  ...over
})

const noop = (): void => {}
const BASE: Partial<JiraBoardState> = {
  snapshot: null,
  loading: false,
  lastSync: null,
  error: null,
  errorCode: null,
  filter: EMPTY_FILTER,
  docsFilter: EMPTY_DOCS_FILTER,
  docsCollapsed: {}
}
let state: Partial<JiraBoardState> = BASE

vi.mock('../../stores/jiraBoardStore', () => ({
  useJiraBoardStore: () => ({
    ...state,
    load: async () => {},
    sync: async () => {},
    setFilter: noop,
    setDocsFilter: noop,
    setDocsCollapsed: noop,
    setAllDocsCollapsed: noop,
    dismissError: noop
  })
}))
vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: (sel: (s: { setView: () => void }) => unknown) => sel({ setView: noop })
}))

const { default: DocsTab } = await import('./DocsTab')
const render = (over: Partial<JiraBoardState>): string => {
  state = { ...BASE, ...over }
  return renderToStaticMarkup(<DocsTab />)
}

describe('DocsTab', () => {
  it('미연결이면 연결 안내', () => {
    expect(render({ errorCode: 'not_connected', error: 'x' })).toContain('설정에서 연결')
  })

  it('스냅샷 전에는 불러오는 중', () => {
    expect(render({ loading: true })).toContain('Jira 티켓을 불러오는 중…')
  })

  it('에픽 그룹으로 묶고 같은 URL 은 합쳐 "n개 티켓에서 연결"로 보인다', () => {
    const html = render({ snapshot: snapshot() })
    expect(html).toContain('data-doc-group="PROJ-1"')
    expect(html.split('>기획서<')).toHaveLength(2)
    expect(html).toContain('2개 티켓에서 연결')
    expect(html).toContain('연결 이슈 1')
    expect(html).toContain('관심')
  })

  it('상단에 종류별 건수를 보인다', () => {
    const html = render({ snapshot: snapshot() })
    expect(html).toMatch(/data-kind-count="web"[^>]*>웹링크 <span[^>]*>1</)
    expect(html).toMatch(/data-kind-count="issue"[^>]*>연결 이슈 <span[^>]*>1</)
  })

  it('링크가 없으면 안내 문구', () => {
    const html = render({ snapshot: snapshot({ issues: [issue({ key: 'PROJ-9' })] }) })
    expect(html).toContain('연결된 문서가 없어요')
  })

  it('내 담당만 때문에 비면 끄는 버튼을 준다', () => {
    const html = render({
      snapshot: snapshot({ issues: ISSUES.map((i) => ({ ...i, assigneeAccountId: 'other' })) }),
      filter: { ...EMPTY_FILTER, mineOnly: true }
    })
    expect(html).toContain('내 담당만 끄기')
  })

  it('필터 0건이면 필터 지우기', () => {
    const html = render({ snapshot: snapshot(), docsFilter: { ...EMPTY_DOCS_FILTER, query: '없는말' } })
    expect(html).toContain('조건에 맞는 문서가 없어요')
    expect(html).toContain('필터 지우기')
  })

  describe('그룹 접기', () => {
    const groupHtml = (html: string, id: string): string => {
      const start = html.indexOf(`data-doc-group="${id}"`)
      const end = html.indexOf('</section>', start)
      return html.slice(start, end)
    }

    it('기본은 펼침: aria-expanded="true" 이고 항목이 보이며 "모두 접기"를 준다', () => {
      const html = render({ snapshot: snapshot() })
      const g = groupHtml(html, 'PROJ-1')
      expect(g).toContain('aria-expanded="true"')
      expect(g).toContain('aria-label="결제 개편 접기"')
      expect(g).toContain('>기획서<')
      expect(html).toContain('모두 접기')
      expect(html).not.toContain('모두 펴기')
    })

    it('접힌 그룹은 헤더·건수만 남고 문서·연결 이슈 목록이 없다', () => {
      const html = render({ snapshot: snapshot(), docsCollapsed: { 'PROJ-1': true } })
      const g = groupHtml(html, 'PROJ-1')
      expect(g).toContain('aria-expanded="false"')
      expect(g).toContain('aria-label="결제 개편 펴기"')
      expect(g).toContain('결제 개편')
      expect(g).toMatch(/>2<\/span>/)
      expect(g).toContain('>PROJ-1<')
      expect(g).not.toContain('>기획서<')
      expect(g).not.toContain('연결 이슈 1')
      // 보이는 그룹이 전부 접혀 있으면 "모두 펴기"
      expect(html).toContain('모두 펴기')
    })

    it('검색어가 있으면 저장된 접힘을 무시하고 펼치며 토글은 막는다', () => {
      const html = render({
        snapshot: snapshot(),
        docsCollapsed: { 'PROJ-1': true },
        docsFilter: { ...EMPTY_DOCS_FILTER, query: '기획' }
      })
      const g = groupHtml(html, 'PROJ-1')
      expect(g).toContain('aria-expanded="true"')
      expect(g).toContain('>기획서<')
      expect(g).toMatch(/<button[^>]*aria-expanded="true"[^>]*disabled=""/)
      expect(html).toMatch(/<button[^>]*data-docs-collapse-all[^>]*disabled=""[^>]*title="검색 중에는 모두 펼쳐 보여요"/)
    })

    it('종류 필터만 있으면 접힘을 그대로 따른다', () => {
      const html = render({
        snapshot: snapshot(),
        docsCollapsed: { 'PROJ-1': true },
        docsFilter: { ...EMPTY_DOCS_FILTER, kinds: ['web'] }
      })
      expect(groupHtml(html, 'PROJ-1')).toContain('aria-expanded="false"')
    })
  })
})
