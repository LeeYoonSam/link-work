import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import BitbucketWorkspaceInput from './BitbucketWorkspaceInput'

const noop = (): void => {}

describe('BitbucketWorkspaceInput (Bitbucket 카드의 리뷰 요청 워크스페이스)', () => {
  it('연결되지 않았으면 그리지 않는다', () => {
    expect(renderToStaticMarkup(<BitbucketWorkspaceInput status={{ connected: false, email: null }} onChanged={noop} />)).toBe('')
    expect(renderToStaticMarkup(<BitbucketWorkspaceInput status={null} onChanged={noop} />)).toBe('')
  })

  it('연결됐고 워크스페이스가 없으면 입력 칸과 안내를 보인다', () => {
    const html = renderToStaticMarkup(
      <BitbucketWorkspaceInput status={{ connected: true, email: 'a@b.c', workspace: null }} onChanged={noop} />
    )
    expect(html).toContain('리뷰 요청 워크스페이스')
    expect(html).toContain('정하지 않으면 리뷰 요청을 모으지 않습니다')
  })

  it('워크스페이스가 정해져 있으면 그 값을 보이고 안내는 없다', () => {
    const html = renderToStaticMarkup(
      <BitbucketWorkspaceInput status={{ connected: true, email: 'a@b.c', workspace: 'backpackr' }} onChanged={noop} />
    )
    expect(html).toContain('value="backpackr"')
    expect(html).not.toContain('정하지 않으면')
  })
})
