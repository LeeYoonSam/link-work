import { beforeEach, describe, expect, it, vi } from 'vitest'

// ipcMain.handle로 등록된 핸들러를 모아 직접 호출한다.
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))

const service = vi.hoisted(() => ({
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
  it('force는 true일 때만 켠다', async () => {
    await invoke('jiraBoard:fetch', true)
    await invoke('jiraBoard:fetch')
    await invoke('jiraBoard:fetch', 'true')
    await invoke('jiraBoard:fetch', 1)
    expect(service.fetchJiraBoard.mock.calls).toEqual([[true], [false], [false], [false]])
  })

  it('summarizeEpic은 키를 그대로 서비스 검증에 넘긴다', async () => {
    await invoke('jiraBoard:summarizeEpic', 'PROJ-1')
    expect(service.summarizeJiraEpic).toHaveBeenCalledWith('PROJ-1')
  })
})
