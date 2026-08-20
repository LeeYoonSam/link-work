import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReleaseNoteSummary } from '../../types'

// 카드 단위의 분기(미연결 / 빈 목록 / 토큰 경고)를 마크업으로 잠근다.
// 릴리스 한 건의 표시 규칙은 ReleaseNoteRow.test.tsx가 담당한다.
//
// 카드는 zustand 스토어를 직접 구독하는데 zustand v5는 서버 렌더에서 초기 상태만 돌려줘
// setState로 주입되지 않는다. TaskList.test.tsx와 같이 훅을 모킹한다.

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
  notes: ReleaseNoteSummary[]
  jiraStatus: unknown
  loading: boolean
}

const BASE: MockState = { notes: [], jiraStatus: null, loading: false }
const noop = async (): Promise<void> => {}
let state: MockState = BASE

vi.mock('../../stores/releaseNoteStore', () => ({
  useReleaseNoteStore: () => ({
    ...state,
    allNotes: [],
    details: {},
    allLoading: false,
    syncingId: null,
    syncResults: {},
    syncErrors: {},
    fetchJiraStatus: noop,
    fetchReleaseNotes: noop,
    fetchAllReleaseNotes: noop,
    fetchDetail: async () => null,
    linkNote: async () => ({ success: true }),
    unlinkNote: noop,
    syncNote: async () => ({ success: true })
  })
}))

const ReleaseNotesCard = (await import('./ReleaseNotesCard')).default

const renderCard = (over: Partial<MockState>): string => {
  state = { ...BASE, ...over }
  return renderToStaticMarkup(<ReleaseNotesCard projectId={1} projectName="검색 개편" />)
}

const CONNECTED = {
  connected: true,
  siteUrl: 'https://acme.atlassian.net',
  accountName: '이윤삼',
  expiresAt: '2027-01-01',
  expiringSoon: false,
  expired: false
}

describe('ReleaseNotesCard 분기', () => {
  it('Jira 미연결이면 연동 설정만 안내하고 릴리스 연결 버튼은 내지 않는다', () => {
    const html = renderCard({ jiraStatus: { ...CONNECTED, connected: false } })
    expect(html).toContain('Jira 연동 설정')
    expect(html).not.toContain('+ 릴리스 연결')
  })

  it('연결됐지만 릴리스가 없으면 연결을 유도한다', () => {
    const html = renderCard({ jiraStatus: CONNECTED })
    expect(html).toContain('연결된 Jira 릴리스가 없습니다')
    expect(html).toContain('+ 릴리스 연결')
  })

  it('릴리스가 있으면 버전명을 행으로 낸다', () => {
    const html = renderCard({ jiraStatus: CONNECTED, notes: [note()] })
    expect(html).toContain('v1.2.0')
    expect(html).not.toContain('연결된 Jira 릴리스가 없습니다')
  })

  it('토큰이 만료되면 경고 배너를 띄운다', () => {
    const html = renderCard({
      jiraStatus: { ...CONNECTED, expired: true, expiresAt: '2026-08-01' }
    })
    expect(html).toContain('Jira 토큰이 만료됐습니다 (2026-08-01)')
  })

  it('만료 임박은 만료됨과 중복해 띄우지 않는다', () => {
    const expiring = renderCard({
      jiraStatus: { ...CONNECTED, expiringSoon: true, expiresAt: '2026-09-01' }
    })
    expect(expiring).toContain('Jira 토큰이 곧 만료됩니다 (2026-09-01)')

    const both = renderCard({
      jiraStatus: { ...CONNECTED, expiringSoon: true, expired: true, expiresAt: '2026-08-01' }
    })
    expect(both).toContain('만료됐습니다')
    expect(both).not.toContain('곧 만료됩니다')
  })
})
