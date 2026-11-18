import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronShell = vi.hoisted(() => ({ openExternal: vi.fn(async () => undefined) }))
// ipcMain.handle로 등록된 핸들러를 모아 직접 호출한다.
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
  shell: electronShell
}))

const service = vi.hoisted(() => ({
  cachedJiraBoard: vi.fn(() => ({ success: true, snapshot: null })),
  isKnownJiraBoardLink: vi.fn((url: unknown) => url === 'https://www.figma.com/design/abc'),
  fetchJiraBoard: vi.fn(async () => ({ success: true })),
  summarizeJiraEpic: vi.fn(async () => ({ success: true }))
}))
vi.mock('../services/jira-board', () => service)

import { registerJiraBoardIpc } from './jira-board.ipc'

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`핸들러 없음: ${channel}`)
  return Promise.resolve(fn({}, ...args))
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerJiraBoardIpc()
})

describe('jiraBoard IPC', () => {
  it('fetch: mode 가 없으면 auto, 목록에 있는 값은 그대로 넘긴다', async () => {
    await invoke('jiraBoard:fetch')
    await invoke('jiraBoard:fetch', 'auto')
    await invoke('jiraBoard:fetch', 'incremental')
    await invoke('jiraBoard:fetch', 'full')
    expect(service.fetchJiraBoard.mock.calls).toEqual([['auto'], ['auto'], ['incremental'], ['full']])
  })

  it('fetch: 모르는 mode 는 서비스를 부르지 않고 오류로 돌려준다', async () => {
    for (const bad of [true, 'FULL', 'cache', 1, null, {}]) {
      expect(await invoke('jiraBoard:fetch', bad)).toEqual({ success: false, error: '잘못된 동기화 방식입니다.' })
    }
    expect(service.fetchJiraBoard).not.toHaveBeenCalled()
  })

  it('cached: 서비스의 저장본 읽기를 그대로 돌려준다', async () => {
    expect(await invoke('jiraBoard:cached')).toEqual({ success: true, snapshot: null })
    expect(service.cachedJiraBoard).toHaveBeenCalledTimes(1)
  })

  it('summarizeEpic은 키를 그대로 서비스 검증에 넘긴다', async () => {
    await invoke('jiraBoard:summarizeEpic', 'PROJ-1')
    expect(service.summarizeJiraEpic).toHaveBeenCalledWith('PROJ-1')
  })

  it('openLink: 저장된 스냅샷 링크인 http(s)만 브라우저로 연다', async () => {
    expect(await invoke('jiraBoard:openLink', 'https://www.figma.com/design/abc')).toEqual({ success: true })
    expect(electronShell.openExternal).toHaveBeenCalledWith('https://www.figma.com/design/abc')
  })

  it('openLink: 스냅샷에 없는 URL·http(s)가 아닌 값·문자열이 아닌 값은 거부하고 열지 않는다', async () => {
    for (const bad of [
      'https://evil.example/x',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'mailto:a@b.c',
      '',
      42,
      null
    ]) {
      const r = (await invoke('jiraBoard:openLink', bad)) as { success: boolean }
      expect(r.success, String(bad)).toBe(false)
    }
    expect(electronShell.openExternal).not.toHaveBeenCalled()
  })
})
