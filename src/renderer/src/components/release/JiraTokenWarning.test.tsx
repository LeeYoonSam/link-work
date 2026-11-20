import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import JiraTokenWarning, { resolveOpenSettings } from './JiraTokenWarning'
import { useSettingsStore } from '../../stores/settingsStore'
import type { JiraConnectionStatus } from '../../types'

// Jira 토큰 경고의 [설정 열기] 는 작업 흐름을 끊지 않는다

describe('JiraTokenWarning 설정 열기', () => {
  it('설정 열기는 그 자리 콜백이 있으면 그것을 부르고 없을 때만 설정 화면으로 이동한다', () => {
    const open = vi.fn()
    const original = useSettingsStore.getState().open
    useSettingsStore.setState({ open })
    try {
      const inline = vi.fn()
      resolveOpenSettings(inline)()
      expect(inline).toHaveBeenCalledTimes(1)
      expect(open).not.toHaveBeenCalled()

      resolveOpenSettings(undefined)()
      expect(open).toHaveBeenCalledWith('integrations')
    } finally {
      useSettingsStore.setState({ open: original })
    }
  })

  it('만료·만료 임박 문구 끝에 설정 열기 버튼을 그린다', () => {
    const base = { connected: true, expiresAt: '2026-12-01' } as JiraConnectionStatus
    const expired = renderToStaticMarkup(<JiraTokenWarning status={{ ...base, expired: true }} />)
    expect(expired).toContain('Jira 토큰이 만료됐습니다 (2026-12-01)')
    expect(expired).toContain('설정 열기')
    const soon = renderToStaticMarkup(
      <JiraTokenWarning status={{ ...base, expired: false, expiringSoon: true }} onOpenSettings={() => {}} />
    )
    expect(soon).toContain('곧 만료됩니다')
    expect(soon).toContain('설정 열기')
    expect(renderToStaticMarkup(<JiraTokenWarning status={{ ...base, expired: false, expiringSoon: false }} />)).toBe('')
  })
})
