import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SettingsSectionId } from './settingsCatalog'

// 설정 화면의 레이아웃과 섹션별 내용을 고정한다.
// zustand v5 는 서버 렌더에서 초기 상태만 돌려주므로 설정 스토어 훅을 모킹한다 (BackupModal.test.tsx 와 같은 방식).

const fake = {
  section: 'integrations' as SettingsSectionId,
  statuses: {
    google: { connected: false, hasCredentials: false },
    jira: {
      connected: true,
      siteUrl: 'https://x.atlassian.net',
      accountName: '홍길동',
      expiresAt: '2027-01-01',
      expiringSoon: false,
      expired: false,
      defaultProjectKey: 'ICA',
      email: 'a@b.com'
    },
    bitbucket: { connected: false, email: null },
    notion: { connected: true }
  },
  claude: { available: false, error: 'Claude Code 를 찾지 못했습니다' } as {
    available: boolean
    error?: string
  },
  statusErrors: {},
  refreshing: false,
  verifyResults: {},
  verifying: {},
  open: vi.fn(),
  setSection: vi.fn(),
  refreshStatuses: vi.fn(async () => {}),
  refreshClaude: vi.fn(async () => {}),
  verify: vi.fn(),
  verifyAll: vi.fn(async () => {}),
  clearVerify: vi.fn()
}

vi.mock('../../stores/settingsStore', () => ({
  INTEGRATION_IDS: ['google', 'jira', 'bitbucket', 'notion'],
  useSettingsStore: (sel: (s: typeof fake) => unknown) => sel(fake)
}))

const { default: SettingsView } = await import('./SettingsView')

const render = (section: SettingsSectionId): string => {
  fake.section = section
  return renderToStaticMarkup(<SettingsView />)
}

beforeEach(() => {
  fake.section = 'integrations'
})

describe('SettingsView', () => {
  it('왼쪽에 섹션 5개, 오른쪽에 선택한 섹션을 그린다', () => {
    const html = render('assistant')
    const sections = [...html.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1])
    expect(sections).toEqual(['integrations', 'ai', 'assistant', 'recording', 'data'])
    for (const label of ['연동', 'AI', '비서', '회의 녹음', '데이터']) expect(html).toContain(label)
    expect(html).toContain('data-settings-panel="assistant"')
    expect(html).toMatch(/data-section="assistant" aria-current="page"/)
    // 비서 섹션 내용: 즉시 저장 안내와 그룹 3개
    expect(html).toContain('바꾸는 즉시 저장됩니다')
    for (const g of ['동작', '시간', '알림']) expect(html).toContain(g)
    expect(html).toContain('회의 전 알림(분)')
    // 부록 O: 하루 계획용 칸은 없다
    expect(html).not.toContain('캘린더 확인 주기 (분)')
  })

  it('연동 섹션은 Google·Jira·Bitbucket·Notion 카드 4개를 그린다', () => {
    const html = render('integrations')
    expect(html).toContain('data-settings-panel="integrations"')
    for (const title of ['Google 캘린더', 'Jira', 'Bitbucket', 'Notion']) {
      expect(html).toContain(`<h4 class="text-sm font-semibold text-gray-900">${title}</h4>`)
    }
    expect(html.match(/<h4 class="text-sm font-semibold text-gray-900">/g)?.length).toBe(4)
    expect(html).toContain('모두 다시 확인')
    // 상태별 배지와 버튼
    expect(html).toContain('설정 필요')
    expect(html).toContain('연결됨')
    expect(html).toContain('홍길동')
    expect(html).toContain('연결 테스트')
    // Jira 가 연결돼 있으면 카드 안에 기본 프로젝트 선택이 있다
    expect(html).toContain('기본 Jira 프로젝트')
  })

  it('AI 섹션은 Claude Code 상태와 AI 대화 모델·비서 AI 설정을 그린다', () => {
    const html = render('ai')
    expect(html).toContain('Claude Code')
    expect(html).toContain('사용할 수 없음')
    expect(html).toContain('Claude Code 를 찾지 못했습니다')
    expect(html).toContain('다시 확인')
    expect(html).toContain('AI 대화 모델')
    expect(html).toContain('비서 AI')
    expect(html).toContain('AI 브리핑')
    expect(html).toContain('비서 요약 모델')
    expect(html).toContain('<option value="sonnet"')
  })

  it('데이터 섹션은 백업·복원 열기 버튼을 그린다', () => {
    const html = render('data')
    expect(html).toContain('data-settings-panel="data"')
    expect(html).toContain('백업·복원 열기')
  })
})
