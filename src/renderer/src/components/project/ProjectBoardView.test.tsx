import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { JiraBoardIssue, JiraBoardSnapshot, JiraEpicAiSummary } from '../../types'
import type { JiraBoardState } from '../../stores/jiraBoardStore'
import { CLOSED_SECTION_ID, DEFAULT_FILTER, EMPTY_FILTER, doneFoldId } from './boardModel'

// 프로젝트 화면 루트의 상태 분기와 트리·상세 마크업을 잠근다.
// zustand v5 는 서버 렌더에서 setState 가 반영되지 않으므로 스토어 훅을 모킹한다.

let n = 0
const issue = (over: Partial<JiraBoardIssue> = {}): JiraBoardIssue => ({
  key: `PROJ-${++n}`,
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
  assigneeName: '홍길동',
  duedate: null,
  updated: '2026-11-10T09:00:00.000Z',
  resolvedAt: null,
  labels: [],
  excerpt: null,
  fixVersions: [],
  links: [],
  ...over
})

const ISSUES: JiraBoardIssue[] = [
  issue({ key: 'PROJ-120', level: 'epic', issueType: '에픽', summary: '결제 개편', assigneeAccountId: 'other' }),
  issue({
    key: 'PROJ-131',
    parentKey: 'PROJ-120',
    summary: '결제수단 API',
    status: 'In Review',
    priority: 'High',
    fixVersions: [{ id: '10042', name: '4.164.0' }],
    links: [
      { kind: 'web', title: 'API 설계서', url: 'https://wiki/api', source: 'Confluence' },
      { kind: 'issue', title: '결제 서버', url: 'https://x/browse/PAY-1', source: 'Jira', issueKey: 'PAY-1', relation: '선행 작업', issueStatus: '진행 중' }
    ]
  }),
  issue({ key: 'PROJ-132', parentKey: 'PROJ-120', summary: '영수증 메일', status: '완료', statusCategory: 'done' }),
  issue({ key: 'PROJ-133', parentKey: 'PROJ-120', summary: '백로그 일', status: '백로그', statusCategory: 'new', inScope: false }),
  issue({ key: 'PROJ-141', parentKey: 'PROJ-131', level: 'subtask', issueType: '하위 작업', summary: '재현 스크립트' }),
  issue({ key: 'PROJ-90', summary: '에픽 없는 작업', assigneeAccountId: 'other', excerpt: '설명 본문입니다' })
]

const snapshot = (over: Partial<JiraBoardSnapshot> = {}): JiraBoardSnapshot => ({
  projectKey: 'PROJ',
  myAccountId: 'acc-me',
  issues: ISSUES,
  truncated: false,
  recentDoneDays: 14,
  fetchedAt: '2026-11-18T01:42:00.000Z',
  lastFullSyncAt: '2026-11-18T00:10:00.000Z',
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
  sort: 'active',
  expanded: {},
  selectedKey: null,
  aiSummaries: {},
  aiLoading: {},
  aiErrors: {}
}
let state: Partial<JiraBoardState> = BASE

vi.mock('../../stores/jiraBoardStore', () => ({
  useJiraBoardStore: () => ({
    ...state,
    load: async () => {},
    sync: async () => {},
    summarizeEpic: async () => {},
    setFilter: noop,
    clearFilter: noop,
    setSort: noop,
    setExpanded: noop,
    setAllExpanded: noop,
    select: noop,
    dismissError: noop
  })
}))
vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: (sel: (s: { view: string; setView: () => void }) => unknown) =>
    sel({ view: 'projects', setView: noop })
}))

const { default: ProjectBoardView } = await import('./ProjectBoardView')

const render = (over: Partial<JiraBoardState>): string => {
  state = { ...BASE, ...over }
  return renderToStaticMarkup(<ProjectBoardView />)
}

// 행 여는 태그를 id 로 뽑는다
const rowTag = (html: string, id: string): string | undefined =>
  html.match(new RegExp(`<div[^>]*id="board-row-${id}"[^>]*>`))?.[0]

describe('ProjectBoardView 상태 분기', () => {
  it('Jira 미연결이면 설정으로 보내는 안내만 보인다(툴바·타일 없음)', () => {
    const html = render({ errorCode: 'not_connected', error: 'Jira 미연결' })
    expect(html).toContain('Jira가 연결되지 않았어요')
    expect(html).toContain('설정에서 연결')
    expect(html).not.toContain('role="treegrid"')
    expect(html).not.toContain('data-tile=')
  })

  it('기본 프로젝트가 없으면 같은 버튼으로 설정에 보낸다', () => {
    const html = render({ errorCode: 'no_default_project', error: '없음' })
    expect(html).toContain('기본 Jira 프로젝트가 정해지지 않았어요')
    expect(html).toContain('설정에서 연결')
  })

  it('첫 로딩은 불러오는 중 안내', () => {
    expect(render({ loading: true })).toContain('Jira 티켓을 불러오는 중…')
    // 아직 load 결과가 오기 전(첫 렌더)도 같다
    expect(render({})).toContain('Jira 티켓을 불러오는 중…')
  })

  it('스냅샷 없이 실패하면 오류 배너와 다시 시도', () => {
    const html = render({ error: '네트워크 오류' })
    expect(html).toContain('티켓을 불러오지 못했어요 — 네트워크 오류')
    expect(html).toContain('다시 시도')
  })

  it('스냅샷이 있는데 재조회가 실패하면 목록을 유지하고 마지막 성공 시각을 보인다', () => {
    const html = render({ snapshot: snapshot(), error: '시간 초과' })
    expect(html).toContain('시간 초과')
    expect(html).toContain('마지막 성공')
    expect(html).toContain('role="treegrid"')
  })

  it('재조회 중에는 목록을 유지하고 갱신 중을 표시한다', () => {
    const html = render({ snapshot: snapshot(), loading: true })
    expect(html).toContain('갱신 중…')
    expect(html).toContain('role="treegrid"')
  })

  it('0건이면 할 일 이상 티켓이 없다고 한다', () => {
    expect(render({ snapshot: snapshot({ issues: [] }) })).toContain('할 일 이상 상태의 티켓이 없어요')
  })

  it('필터 0건이면 필터 지우기를 준다', () => {
    const html = render({ snapshot: snapshot(), filter: { ...EMPTY_FILTER, query: '없는검색어' } })
    expect(html).toContain('조건에 맞는 티켓이 없어요')
    expect(html).toContain('필터 지우기')
  })

  it('truncated 면 상한 안내를 띄운다', () => {
    expect(render({ snapshot: snapshot({ truncated: true }) })).toContain('일부만 가져왔어요')
    expect(render({ snapshot: snapshot() })).not.toContain('일부만 가져왔어요')
  })

  it('요약 타일과 프로젝트 키를 보인다', () => {
    const html = render({ snapshot: snapshot() })
    expect(html).toContain('data-tile="progress"')
    expect(html).toContain('data-tile="review"')
    expect(html).toContain('완료(최근 14일)')
    expect(html).toContain('Jira PROJ')
  })
})

describe('ProjectBoardView 저장본·동기화 표시', () => {
  it('저장본을 띄운 채 동기화 중이면 첫 로딩 문구 없이 트리와 갱신 중만 보인다', () => {
    const html = render({ snapshot: snapshot(), loading: true })
    expect(html).not.toContain('Jira 티켓을 불러오는 중…')
    expect(html).toContain('role="treegrid"')
    expect(html).toContain('갱신 중…')
    expect(html).not.toMatch(/마지막 동기화 \d/)
  })

  it('동기화 결과를 마지막 동기화 시각 옆에 한 줄로 알린다', () => {
    const at = (sync: JiraBoardState['lastSync']): string => render({ snapshot: snapshot(), lastSync: sync })
    expect(at({ mode: 'incremental', changed: 3 })).toContain(' · 3건 갱신')
    expect(at({ mode: 'incremental', changed: 0 })).toContain(' · 변경 없음')
    expect(at({ mode: 'full', changed: 120 })).toContain(' · 전체 동기화')
    // 저장본만 돌려준 경우와 결과가 없을 때는 알리지 않는다
    expect(at({ mode: 'cache', changed: 0 })).not.toContain('data-sync-result')
    expect(at(null)).not.toContain('data-sync-result')
    expect(at(null)).toMatch(/마지막 동기화 \d{2}:\d{2}/)
  })

  it('새로고침 버튼과 전체 다시 받기 메뉴 트리거가 있다', () => {
    const html = render({ snapshot: snapshot() })
    expect(html).toContain('새로고침')
    expect(html).toContain('aria-label="동기화 옵션"')
  })
})

describe('ProjectBoardView 트리', () => {
  it('에픽은 기본 펼침, 하위작업은 기본 접힘이고 aria 속성을 단다', () => {
    const html = render({ snapshot: snapshot() })
    const epicRow = rowTag(html, 'PROJ-120')!
    expect(epicRow).toContain('aria-level="1"')
    expect(epicRow).toContain('aria-expanded="true"')
    const child = rowTag(html, 'PROJ-131')!
    expect(child).toContain('aria-level="2"')
    expect(child).toContain('aria-expanded="false"')
    expect(rowTag(html, 'PROJ-141')).toBeUndefined()
  })

  it('펼친 자식 아래 하위작업이 level 3 으로 나온다', () => {
    const html = render({ snapshot: snapshot(), expanded: { 'PROJ-131': true } })
    const s = rowTag(html, 'PROJ-141')!
    expect(s).toContain('aria-level="3"')
    expect(s).toContain('aria-posinset="1"')
    expect(s).toContain('aria-setsize="1"')
  })

  it('접힌 에픽의 자식은 DOM 에서 뺀다', () => {
    const html = render({ snapshot: snapshot(), expanded: { 'PROJ-120': false } })
    expect(rowTag(html, 'PROJ-131')).toBeUndefined()
    expect(rowTag(html, 'PROJ-120')).toContain('aria-expanded="false"')
  })

  it('백로그 자식은 숨기고 에픽 메타에 건수만 센다, 롤업은 범위 안 직계 자식 기준', () => {
    const html = render({ snapshot: snapshot() })
    expect(rowTag(html, 'PROJ-133')).toBeUndefined()
    expect(html).toContain('백로그 1건')
    expect(html).toContain('1/2 완료 · 진행 1 · 할 일 0')
    expect(html).toContain('2건 중 1건 완료, 진행 1, 할 일 0')
  })

  it('에픽 없는 작업은 "에픽 없음" 그룹으로 맨 아래', () => {
    const html = render({ snapshot: snapshot() })
    expect(html).toContain('에픽 없음')
    expect(html.indexOf('board-row-group:no-epic')).toBeGreaterThan(html.indexOf('board-row-PROJ-120'))
  })

  it('roving tabindex: 탭 정지점은 하나다', () => {
    const html = render({ snapshot: snapshot() })
    expect(html.match(/role="row"[^>]*tabindex="0"/g)).toHaveLength(1)
  })

  it('내 담당만이면 맞지 않은 조상은 흐리게 남긴다', () => {
    const html = render({ snapshot: snapshot(), filter: DEFAULT_FILTER })
    // 에픽(담당 다른 사람)은 남되 흐림, 에픽 없는 남의 작업은 사라진다
    expect(rowTag(html, 'PROJ-120')).toBeDefined()
    expect(html).toMatch(/id="board-row-PROJ-120"[^>]*>\s*<div role="gridcell" class="min-w-0 opacity-60"/)
    expect(rowTag(html, 'PROJ-90')).toBeUndefined()
    expect(html).toContain('내 담당만')
  })
})

describe('ProjectBoardView 릴리스 연계·관련 문서', () => {
  it('티켓 행에 fixVersion 칩을 보이고, 트리 안에서는 탭 정지점을 만들지 않는다', () => {
    const html = render({ snapshot: snapshot() })
    const chip = html.match(/<button[^>]*data-fix-version="10042"[^>]*>/)?.[0]
    expect(chip).toBeDefined()
    expect(chip).toContain('tabindex="-1"')
    expect(html).toContain('4.164.0')
  })

  it('툴바에 릴리스 필터가 있고, 적용하면 칩으로 보인다', () => {
    expect(render({ snapshot: snapshot() })).toContain('>릴리스')
    const html = render({ snapshot: snapshot(), filter: { ...EMPTY_FILTER, releases: ['4.164.0'] } })
    expect(html).toContain('릴리스 4.164.0')
    expect(rowTag(html, 'PROJ-90')).toBeUndefined()
  })

  it('상세에 릴리스 칩과 관련 문서(문서 먼저, 연결 이슈는 관계·상태와 함께)를 보인다', () => {
    const html = render({ snapshot: snapshot(), selectedKey: 'PROJ-131' })
    expect(html).toContain('관련 문서 2')
    expect(html).toContain('API 설계서')
    expect(html).toContain('선행 작업')
    expect(html.indexOf('API 설계서')).toBeLessThan(html.indexOf('결제 서버'))
    expect(html).toMatch(/data-fix-version="10042"(?![^>]*tabindex="-1")/)
  })

  it('에픽 상세의 관련 문서는 자손 것을 합친다', () => {
    const html = render({ snapshot: snapshot(), selectedKey: 'PROJ-120' })
    expect(html).toContain('관련 문서 2')
    expect(html).toContain('하위 티켓 포함')
  })

  it('관련 문서가 없으면 절을 그리지 않는다', () => {
    expect(render({ snapshot: snapshot(), selectedKey: 'PROJ-90' })).not.toContain('관련 문서')
  })
})

describe('ProjectBoardView 선택·상세', () => {
  it('선택이 없으면 상세 패널은 안내만', () => {
    expect(render({ snapshot: snapshot() })).toContain('행을 고르면 상세가 여기에 보여요')
  })

  it('선택한 행은 aria-selected 이고 상세에 메타·설명·Jira 열기가 나온다', () => {
    const html = render({ snapshot: snapshot(), selectedKey: 'PROJ-90' })
    expect(rowTag(html, 'group:no-epic')).toBeDefined()
    expect(rowTag(html, 'PROJ-90')).toContain('aria-selected="true"')
    expect(html).toContain('설명 본문입니다')
    expect(html).toContain('Jira에서 열기')
    // 넓은 창 패널 + 좁은 창 인라인 두 곳에 같은 상세가 있다
    expect(html.split('설명 본문입니다')).toHaveLength(3)
  })

  it('표준 이슈 상세는 상위 에픽과 하위작업 목록을 보인다', () => {
    const html = render({ snapshot: snapshot(), selectedKey: 'PROJ-131' })
    expect(html).toContain('상위')
    expect(html).toContain('결제 개편')
    expect(html).toContain('하위작업 1')
    expect(html).toContain('재현 스크립트')
  })

  it('에픽 상세에는 AI 요약 버튼이 있고, 결과는 생성 시각과 함께 보인다', () => {
    const before = render({ snapshot: snapshot(), selectedKey: 'PROJ-120' })
    expect(before).toContain('>AI 요약</button>')
    const summary: JiraEpicAiSummary = {
      epicKey: 'PROJ-120',
      headline: '절반쯤 왔어요',
      bullets: ['리뷰 1건 대기', '메일 완료'],
      generatedAt: '2026-11-18T01:42:00.000Z'
    }
    const after = render({ snapshot: snapshot(), selectedKey: 'PROJ-120', aiSummaries: { 'PROJ-120': summary } })
    expect(after).toContain('절반쯤 왔어요')
    expect(after).toContain('리뷰 1건 대기')
    expect(after).toContain('AI 요약 · ')
    expect(after).toContain('다시 요약')
  })

  it('AI 요약 생성 중·실패를 보인다', () => {
    expect(render({ snapshot: snapshot(), selectedKey: 'PROJ-120', aiLoading: { 'PROJ-120': true } })).toContain(
      '요약 중…'
    )
    expect(render({ snapshot: snapshot(), selectedKey: 'PROJ-120', aiErrors: { 'PROJ-120': 'AI 실패' } })).toContain(
      'AI 실패'
    )
  })

  it('에픽이 아닌 행에는 AI 요약 버튼이 없다', () => {
    expect(render({ snapshot: snapshot(), selectedKey: 'PROJ-131' })).not.toContain('>AI 요약</button>')
  })
})

describe('ProjectBoardView 닫힘 묶음', () => {
  const done = { status: '완료', statusCategory: 'done' as const }
  // 열린 에픽(열린 자식 1 + 닫힌 자식 2)과 닫힌 에픽(닫힌 자식 1)
  const MIXED: JiraBoardIssue[] = [
    issue({ key: 'PROJ-200', level: 'epic', issueType: '에픽', summary: '진행 에픽' }),
    issue({ key: 'PROJ-201', parentKey: 'PROJ-200', summary: '열린 일' }),
    issue({ key: 'PROJ-202', parentKey: 'PROJ-200', summary: '닫힌 일 A', ...done }),
    issue({ key: 'PROJ-203', parentKey: 'PROJ-200', summary: '닫힌 일 B', ...done }),
    issue({ key: 'PROJ-300', level: 'epic', issueType: '에픽', summary: '끝난 에픽', ...done }),
    issue({ key: 'PROJ-301', parentKey: 'PROJ-300', summary: '끝난 에픽의 일', ...done })
  ]
  const mixed = (over: Partial<JiraBoardState> = {}): string => render({ snapshot: snapshot({ issues: MIXED }), ...over })

  it('열린 에픽과 닫힌 에픽이 섞이면 닫힌 상위 티켓 섹션이 열린 그룹 뒤에 접힌 채 온다', () => {
    const html = mixed()
    const section = rowTag(html, CLOSED_SECTION_ID)!
    expect(section).toContain('data-row-kind="fold"')
    expect(section).toContain('aria-expanded="false"')
    expect(section).not.toContain('aria-selected')
    expect(html).toContain('닫힌 상위 티켓 1건')
    expect(rowTag(html, 'PROJ-300')).toBeUndefined()
    expect(html.indexOf(`board-row-${CLOSED_SECTION_ID}`)).toBeGreaterThan(html.indexOf('board-row-PROJ-200'))
  })

  it('섹션을 펼치면 닫힌 에픽이 level 1 로 보인다(에픽 자체는 접힘)', () => {
    const html = mixed({ expanded: { [CLOSED_SECTION_ID]: true } })
    expect(rowTag(html, CLOSED_SECTION_ID)).toContain('aria-expanded="true"')
    const epic = rowTag(html, 'PROJ-300')!
    expect(epic).toContain('aria-level="1"')
    expect(epic).toContain('aria-expanded="false"')
    expect(rowTag(html, 'PROJ-301')).toBeUndefined()
  })

  it('열린 자식 1 + 닫힌 자식 2 면 닫힘 2건 묶음이 열린 자식 뒤에 오고 닫힌 자식은 접혀 있다', () => {
    const html = mixed()
    const fold = rowTag(html, doneFoldId('PROJ-200'))!
    expect(fold).toContain('aria-level="2"')
    expect(fold).toContain('aria-expanded="false"')
    expect(html).toContain('닫힘 2건')
    expect(rowTag(html, 'PROJ-201')).toBeDefined()
    expect(rowTag(html, 'PROJ-202')).toBeUndefined()
    expect(rowTag(html, 'PROJ-203')).toBeUndefined()
    expect(html.indexOf(`board-row-${doneFoldId('PROJ-200')}`)).toBeGreaterThan(html.indexOf('board-row-PROJ-201'))
  })

  it('묶음을 펼치면 닫힌 자식이 같은 level 로 보인다', () => {
    const html = mixed({ expanded: { [doneFoldId('PROJ-200')]: true } })
    expect(rowTag(html, 'PROJ-202')).toContain('aria-level="2"')
    expect(rowTag(html, 'PROJ-203')).toBeDefined()
  })

  it('검색어가 있으면 묶지 않는다', () => {
    const html = mixed({ filter: { ...EMPTY_FILTER, query: '일' } })
    expect(html).not.toContain('data-row-kind="fold"')
    expect(html).not.toContain('닫힘 2건')
    expect(rowTag(html, 'PROJ-202')).toBeDefined()
  })

  it('묶음 행이 있어도 탭 정지점은 하나다', () => {
    expect(mixed().match(/role="row"[^>]*tabindex="0"/g)).toHaveLength(1)
  })
})
