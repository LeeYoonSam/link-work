import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { JiraConnectionStatus } from '../../types'
import BitbucketConnectDialog from './integrations/BitbucketConnectDialog'
import JiraConnectDialog from './integrations/JiraConnectDialog'
import NotionConnectDialog from './integrations/NotionConnectDialog'
import GoogleCalendarConnectDialog from './integrations/GoogleCalendarConnectDialog'
import { STORAGE_NOTICE } from './ConnectDialog'

// 토큰 등록 팝업 하나에 용도·필요 권한·발급 페이지·입력·저장 안내가 함께 그려지는지 고정한다.

const noop = (): void => {}
const ATLASSIAN = 'https://id.atlassian.com/manage-profile/security/api-tokens'

const jiraOff: JiraConnectionStatus = {
  connected: false,
  siteUrl: null,
  accountName: null,
  expiresAt: null,
  expiringSoon: false,
  expired: false,
  defaultProjectKey: null,
  email: null
}

const bitbucket = (suggestedEmail?: string | null): string =>
  renderToStaticMarkup(
    <BitbucketConnectDialog
      status={{ connected: false, email: null }}
      onClose={noop}
      onChanged={noop}
      suggestedEmail={suggestedEmail}
    />
  )
const jira = (): string =>
  renderToStaticMarkup(<JiraConnectDialog status={jiraOff} onClose={noop} onChanged={noop} />)
const notion = (): string =>
  renderToStaticMarkup(<NotionConnectDialog connected={false} onClose={noop} onChanged={noop} />)
const google = (): string =>
  renderToStaticMarkup(<GoogleCalendarConnectDialog onClose={noop} onConnected={noop} />)

describe('ConnectDialogs', () => {
  it('Bitbucket 팝업은 용도·필요 권한 3개·발급 페이지 링크·입력 칸을 한 화면에 그린다', () => {
    const html = bitbucket()
    expect(html).toContain('Bitbucket 저장소의 파일과 폴더를 읽고, 오늘 화면이 나에게 온 리뷰 요청을 모읍니다')
    expect(html).toContain('필요한 권한')
    for (const scope of ['read:repository:bitbucket', 'read:pullrequest:bitbucket', 'read:user:bitbucket']) {
      expect(html).toContain(scope)
    }
    expect(html.match(/<dt>/g)?.length).toBe(3)
    expect(html).toContain('쓰기(write) 범위는 필요 없습니다')
    expect(html).toContain(`href="${ATLASSIAN}"`)
    expect(html).toContain('발급 페이지 열기')
    expect(html).toContain('type="email"')
    expect(html).toContain('type="password"')
    expect(html).toContain('확인 후 저장')
  })

  it('Bitbucket 팝업은 Atlassian 이메일을 미리 채운다', () => {
    expect(bitbucket('dev@company.com')).toContain('value="dev@company.com"')
    // 저장된 Bitbucket 이메일이 있으면 그것이 우선이다
    const html = renderToStaticMarkup(
      <BitbucketConnectDialog
        status={{ connected: true, email: 'saved@company.com' }}
        onClose={noop}
        onChanged={noop}
        suggestedEmail="dev@company.com"
      />
    )
    expect(html).toContain('value="saved@company.com"')
    expect(html).not.toContain('value="dev@company.com"')
  })

  it('Jira 팝업은 사이트 URL·이메일·token·만료일 입력과 발급 링크를 그린다', () => {
    const html = jira()
    expect(html).toContain('사이트 URL')
    expect(html).toContain('https://your-site.atlassian.net')
    expect(html).toContain('type="email"')
    expect(html).toContain('type="password"')
    expect(html).toContain('type="date"')
    expect(html).toContain('토큰 만료일')
    expect(html).toContain(`href="${ATLASSIAN}"`)
    // Bitbucket 쪽 이메일을 미리 채운다
    const filled = renderToStaticMarkup(
      <JiraConnectDialog status={jiraOff} onClose={noop} onChanged={noop} suggestedEmail="dev@company.com" />
    )
    expect(filled).toContain('value="dev@company.com"')
  })

  it('Notion 팝업은 커넥터 안내와 토큰 입력을 그린다', () => {
    const html = notion()
    expect(html).toContain('Notion 커넥터')
    expect(html).toContain('https://claude.ai/settings/connectors')
    expect(html).toContain('콘텐츠 읽기')
    expect(html).toContain('href="https://www.notion.so/my-integrations"')
    expect(html).toContain('type="password"')
    expect(html).toContain('ntn_ 으로 시작하는 토큰')
  })

  it('Google 팝업은 연결 순서를 번호 목록 6단계로 안내한다', () => {
    const html = google()
    expect(html).toContain('연결 순서')
    expect(html.match(/<li>/g)?.length).toBe(6)
    expect(html).toContain('Google Calendar API')
    expect(html).toContain('웹 애플리케이션')
    expect(html).toContain('승인된 리디렉션 URI')
    expect(html).toContain('기본 캘린더만 읽습니다')
  })

  it('Google 팝업은 redirect URI 와 calendar.readonly 권한을 보여 준다', () => {
    const html = google()
    expect(html).toContain('http://localhost:8945/callback')
    expect(html).toContain('복사')
    expect(html).toContain('calendar.readonly')
    expect(html).toContain('href="https://console.cloud.google.com/apis/credentials"')
    expect(html).toContain('Client ID')
    expect(html).toContain('Client Secret')
  })

  it('모든 팝업은 백업에 포함되지 않는다는 저장 안내를 그린다', () => {
    expect(STORAGE_NOTICE).toContain('데이터 백업에 포함되지 않습니다')
    for (const html of [bitbucket(), jira(), notion(), google()]) {
      expect(html).toContain(STORAGE_NOTICE)
    }
  })
})
