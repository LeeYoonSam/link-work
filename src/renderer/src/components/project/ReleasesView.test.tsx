import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReleaseNoteSummary, SyncAllResult } from '../../types'

// 사이드바 Releases 화면의 분기와 프로젝트별 그룹핑을 마크업으로 잠근다.
// 릴리스 한 건의 표시 규칙은 ReleaseNoteRow.test.tsx가 담당한다.

const note = (over: Partial<ReleaseNoteSummary> = {}): ReleaseNoteSummary => ({
  id: 1,
  project_id: 1,
  jira_project_key: 'ICA',
  jira_version_id: '10042',
  version_name: 'v1.2.0',
  description: null,
  released: 0,
  archived: 0,
  release_date: null,
  start_date: null,
  last_synced_at: '2026-08-19 10:30:00',
  last_sync_error: null,
  created_at: '2026-08-01 09:00:00',
  updated_at: '2026-08-19 10:30:00',
  item_count: 0,
  project_name: '검색 개편',
  ...over
})

interface MockState {
  allNotes: ReleaseNoteSummary[]
  jiraStatus: unknown
  allLoading: boolean
  syncAllRunning: boolean
  syncAllResult: SyncAllResult | null
  syncAllError: string
}

const BASE: MockState = {
  allNotes: [],
  jiraStatus: null,
  allLoading: false,
  syncAllRunning: false,
  syncAllResult: null,
  syncAllError: ''
}
const noop = async (): Promise<void> => {}
let state: MockState = BASE

vi.mock('../../stores/releaseNoteStore', () => ({
  useReleaseNoteStore: () => ({
    ...state,
    notes: [],
    details: {},
    loading: false,
    syncingId: null,
    syncResults: {},
    syncErrors: {},
    fetchJiraStatus: noop,
    fetchReleaseNotes: noop,
    fetchAllReleaseNotes: noop,
    fetchDetail: async () => null,
    linkNote: async () => ({ success: true }),
    unlinkNote: noop,
    syncNote: async () => ({ success: true }),
    syncAll: noop,
    clearSyncAllResult: () => {}
  })
}))

const mod = await import('./ReleasesView')
const ReleasesView = mod.default
const { groupNotesByProject } = mod

const renderView = (over: Partial<MockState>): string => {
  state = { ...BASE, ...over }
  return renderToStaticMarkup(<ReleasesView />)
}

const CONNECTED = {
  connected: true,
  siteUrl: 'https://acme.atlassian.net',
  accountName: '이윤삼',
  expiresAt: '2027-01-01',
  expiringSoon: false,
  expired: false,
  defaultProjectKey: 'ICA'
}

// 전체 동기화 버튼 <button …>전체 동기화</button> 의 여는 태그를 뽑는다
const syncAllButtons = (html: string): string[] =>
  [...html.matchAll(/<button([^>]*)>(?:전체 동기화|동기화 중…)<\/button>/g)].map((m) => m[1])

// `disabled:opacity-40` 같은 Tailwind 클래스에도 'disabled'가 들어 있어 속성만 정확히 본다
const isDisabled = (attrs: string): boolean => /\sdisabled=""/.test(attrs)

// 프로젝트 헤딩(SectionTitle) 텍스트를 문서 순서대로
const headings = (html: string): string[] =>
  [...html.matchAll(/<h3 class="text-sm font-semibold text-gray-700[^"]*">([^<]*)<\/h3>/g)].map(
    (m) => m[1]
  )

describe('groupNotesByProject', () => {
  it('목록 순서를 유지한 채 프로젝트별로 묶는다', () => {
    const groups = groupNotesByProject([
      note({ id: 1, project_id: 7, project_name: '검색 개편' }),
      note({ id: 2, project_id: 3, project_name: '결제 개선' }),
      note({ id: 3, project_id: 7, project_name: '검색 개편' })
    ])
    expect(groups.map((g) => [g.projectName, g.notes.length])).toEqual([
      ['검색 개편', 2],
      ['결제 개선', 1]
    ])
  })

  it('이름이 같아도 프로젝트가 다르면 합치지 않는다', () => {
    const groups = groupNotesByProject([
      note({ id: 1, project_id: 1, project_name: '개편' }),
      note({ id: 2, project_id: 2, project_name: '개편' })
    ])
    expect(groups).toHaveLength(2)
  })

  it('project_name이 비어도 undefined가 제목에 새지 않는다', () => {
    const groups = groupNotesByProject([note({ project_name: '' })])
    expect(groups[0].projectName).toBe('이름 없는 프로젝트')
  })
})

describe('ReleasesView 분기', () => {
  it('Jira 미연결이면 연동을 먼저 하도록 안내한다', () => {
    const html = renderView({ jiraStatus: { ...CONNECTED, connected: false } })
    expect(html).toContain('Jira 미연결')
    expect(html).toContain('Jira를 연동하면')
  })

  it('연결된 릴리스가 0건이어도 전체 동기화 버튼이 보인다', () => {
    // 이 화면의 원래 문제 — 동기화 버튼이 행 안에만 있어 연결 0건이면 버튼도 사라졌다
    const html = renderView({ jiraStatus: CONNECTED })
    const buttons = syncAllButtons(html)
    expect(buttons.length).toBeGreaterThanOrEqual(1)
    // 헤더와 빈 상태 양쪽 모두 눌리는 상태여야 한다
    for (const b of buttons) expect(isDisabled(b)).toBe(false)
  })

  it('빈 상태 문구는 막다른 안내가 아니라 전체 동기화가 무엇을 하는지 알려준다', () => {
    const html = renderView({ jiraStatus: CONNECTED })
    expect(html).toContain('아직 연결된 릴리스가 없습니다')
    expect(html).toContain('배포 버전과 이름이 같은 Jira 릴리스를 자동으로 찾아')
    expect(html).not.toContain('프로젝트 상세에서 Jira 릴리스를 연결하세요')
  })

  it('기본 프로젝트가 없으면 전체 동기화를 막고 먼저 고르도록 유도한다', () => {
    const html = renderView({ jiraStatus: { ...CONNECTED, defaultProjectKey: null } })
    expect(html).toContain('기본 프로젝트 선택')
    for (const b of syncAllButtons(html)) expect(isDisabled(b)).toBe(true)
  })

  it('기본 프로젝트 키를 상단에 보여준다', () => {
    expect(renderView({ jiraStatus: CONNECTED })).toContain('기본 프로젝트 ICA')
  })

  it('동기화 중에는 버튼을 잠그고 오래 걸릴 수 있음을 알린다', () => {
    const html = renderView({ jiraStatus: CONNECTED, syncAllRunning: true })
    expect(html).toContain('수십 초가 걸릴 수 있습니다')
    for (const b of syncAllButtons(html)) expect(isDisabled(b)).toBe(true)
  })

  it('전체 동기화 실패 메시지를 그대로 낸다', () => {
    const html = renderView({ jiraStatus: CONNECTED, syncAllError: '기본 Jira 프로젝트가 없습니다' })
    expect(html).toContain('전체 동기화 실패 — 기본 Jira 프로젝트가 없습니다')
  })

  it('연결 상태와 계정명을 상단에 보여준다', () => {
    expect(renderView({ jiraStatus: CONNECTED })).toContain('Jira 연결됨 — 이윤삼')
  })

  it('릴리스를 프로젝트별 헤딩 아래로 묶어 낸다', () => {
    const html = renderView({
      jiraStatus: CONNECTED,
      allNotes: [
        note({ id: 1, project_id: 7, project_name: '검색 개편', version_name: 'v1.2.0' }),
        note({ id: 2, project_id: 3, project_name: '결제 개선', version_name: 'v2.0.0' }),
        note({ id: 3, project_id: 7, project_name: '검색 개편', version_name: 'v1.3.0' })
      ]
    })
    expect(headings(html)).toEqual(['검색 개편', '결제 개선'])
    for (const v of ['v1.2.0', 'v1.3.0', 'v2.0.0']) expect(html).toContain(v)
    // 그룹별 릴리스 수를 함께 낸다
    expect(html).toContain('(2)')
    expect(html).toContain('(1)')
  })

  it('토큰 만료 경고는 이 화면에도 뜬다', () => {
    const html = renderView({
      jiraStatus: { ...CONNECTED, expired: true, expiresAt: '2026-08-01' }
    })
    expect(html).toContain('Jira 토큰이 만료됐습니다 (2026-08-01)')
  })
})
