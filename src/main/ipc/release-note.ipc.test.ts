import { beforeEach, describe, expect, it, vi } from 'vitest'

// ipcMain.handle로 등록된 핸들러를 모아 직접 호출한다.
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
  shell: { openExternal: vi.fn() }
}))

const jira = vi.hoisted(() => ({
  disconnectJira: vi.fn(),
  getJiraIssueUrl: vi.fn(),
  getJiraStatus: vi.fn(),
  listJiraProjects: vi.fn(),
  saveJiraCredentials: vi.fn(),
  setDefaultJiraProjectKey: vi.fn()
}))
vi.mock('../services/jira', () => jira)
vi.mock('../services/release-note-sync', () => ({
  getReleaseNote: vi.fn(),
  listReleaseNotes: vi.fn(),
  syncAllReleases: vi.fn(),
  syncReleaseNote: vi.fn()
}))
const jiraBoard = vi.hoisted(() => ({ clearJiraBoardCache: vi.fn() }))
vi.mock('../services/jira-board', () => jiraBoard)

import { registerReleaseNoteIpc } from './release-note.ipc'

function invoke(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`핸들러 없음: ${channel}`)
  return fn({}, ...args)
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  registerReleaseNoteIpc()
})

describe('Jira 연결이 바뀌면 프로젝트 보드 캐시를 버린다', () => {
  it('연결 해제', () => {
    invoke('jira:disconnect')
    expect(jiraBoard.clearJiraBoardCache).toHaveBeenCalledTimes(1)
  })

  it('자격 증명 저장: 저장 전과 저장 성공 뒤에 한 번씩 비운다', async () => {
    jira.saveJiraCredentials.mockResolvedValue({ accountName: '홍길동' })
    await invoke('jira:saveCredentials', {})
    expect(jiraBoard.clearJiraBoardCache).toHaveBeenCalledTimes(2)
    const [before, after] = jiraBoard.clearJiraBoardCache.mock.invocationCallOrder
    const saved = jira.saveJiraCredentials.mock.invocationCallOrder[0]
    expect(before).toBeLessThan(saved)
    expect(after).toBeGreaterThan(saved)
  })

  it('자격 증명 저장이 실패하면 저장 전에만 비운다', async () => {
    jira.saveJiraCredentials.mockRejectedValue(new Error('401'))
    expect(await invoke('jira:saveCredentials', {})).toMatchObject({ success: false })
    expect(jiraBoard.clearJiraBoardCache).toHaveBeenCalledTimes(1)
  })

  it('기본 프로젝트 키 변경', () => {
    invoke('jira:setDefaultProject', 'PROJ')
    expect(jiraBoard.clearJiraBoardCache).toHaveBeenCalledTimes(1)
  })
})
