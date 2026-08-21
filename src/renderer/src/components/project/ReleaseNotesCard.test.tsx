import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReleaseNoteSummary } from '../../types'

// 카드 단위의 분기(미연결 / 배포 버전 없음 / 빈 목록 / 토큰 경고)를 마크업으로 잠근다.
// 릴리스 한 건의 표시 규칙은 ReleaseNoteRow.test.tsx가 담당한다.
//
// 카드는 zustand 스토어를 직접 구독하는데 zustand v5는 서버 렌더에서 초기 상태만 돌려줘
// setState로 주입되지 않는다. TaskList.test.tsx와 같이 훅을 모킹한다.

const note = (over: Partial<ReleaseNoteSummary> = {}): ReleaseNoteSummary => ({
  id: 1,
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
    syncNote: async () => ({ success: true })
  })
}))

const ReleaseNotesCard = (await import('./ReleaseNotesCard')).default

const renderCard = (over: Partial<MockState>, deployVersion: string | null = '4.164.0'): string => {
  state = { ...BASE, ...over }
  return renderToStaticMarkup(<ReleaseNotesCard deployVersion={deployVersion} />)
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
  it('Jira 미연결이면 연동 설정만 안내한다', () => {
    const html = renderCard({ jiraStatus: { ...CONNECTED, connected: false } })
    expect(html).toContain('Jira 연동 설정')
  })

  it('릴리스를 연결하거나 끊는 조작은 없다 — 프로젝트와 저장된 연결이 없기 때문이다', () => {
    const html = renderCard({ jiraStatus: CONNECTED, notes: [note()] })
    expect(html).not.toContain('릴리스 연결')
    expect(html).not.toContain('연결 해제')
  })

  it('배포 버전이 비어 있으면 무엇을 채워야 하는지 알려준다', () => {
    // 배포 버전이 릴리스를 찾는 유일한 단서다
    const html = renderCard({ jiraStatus: CONNECTED }, null)
    expect(html).toContain('배포 버전이 비어 있습니다')
    expect(html).toContain('프로젝트 수정에서 배포 버전을 채우면')
  })

  it('이름이 같은 릴리스가 없으면 어떤 버전을 찾았는지 밝힌다', () => {
    const html = renderCard({ jiraStatus: CONNECTED })
    expect(html).toContain('배포 버전 4.164.0과 이름이 같은 Jira 릴리스가 없습니다')
  })

  it('릴리스가 있으면 버전명을 행으로 낸다', () => {
    const html = renderCard({ jiraStatus: CONNECTED, notes: [note()] })
    expect(html).toContain('v1.2.0')
    expect(html).not.toContain('이름이 같은 Jira 릴리스가 없습니다')
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
