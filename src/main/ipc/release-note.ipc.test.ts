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
const releases = vi.hoisted(() => ({
  clearReleaseSyncCheckpoint: vi.fn(),
  getReleaseNote: vi.fn(),
  listReleaseNotes: vi.fn(),
  syncAllReleases: vi.fn(),
  syncReleaseChanges: vi.fn(),
  syncReleaseNote: vi.fn()
}))
vi.mock('../services/release-note-sync', () => releases)
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

describe('Jira 계정이 바뀌면 프로젝트 보드 저장본을 버린다', () => {
  it('연결 해제', () => {
    invoke('jira:disconnect')
    expect(jiraBoard.clearJiraBoardCache).toHaveBeenCalledTimes(1)
  })

  it('자격 증명 저장: 저장 성공 뒤에 한 번 비운다', async () => {
    jira.saveJiraCredentials.mockResolvedValue({ accountName: '홍길동' })
    await invoke('jira:saveCredentials', {})
    expect(jiraBoard.clearJiraBoardCache).toHaveBeenCalledTimes(1)
    const [cleared] = jiraBoard.clearJiraBoardCache.mock.invocationCallOrder
    expect(cleared).toBeGreaterThan(jira.saveJiraCredentials.mock.invocationCallOrder[0])
  })

  it('자격 증명 저장이 실패하면 비우지 않는다 (기존 계정의 저장본이 유효하다)', async () => {
    jira.saveJiraCredentials.mockRejectedValue(new Error('401'))
    expect(await invoke('jira:saveCredentials', {})).toMatchObject({ success: false })
    expect(jiraBoard.clearJiraBoardCache).not.toHaveBeenCalled()
  })

  it('기본 프로젝트 키만 바뀌면 비우지 않는다 (저장본이 프로젝트 키로 나뉜다)', () => {
    invoke('jira:setDefaultProject', 'PROJ')
    expect(jira.setDefaultJiraProjectKey).toHaveBeenCalledWith('PROJ')
    expect(jiraBoard.clearJiraBoardCache).not.toHaveBeenCalled()
  })
})

describe('릴리스 변경분 동기화 releaseNote:syncChanges', () => {
  it('force 는 true 일 때만 켜고 결과를 감싼다', async () => {
    const result = { mode: 'incremental', changed: [], linked: 0, metaUpdated: 0 }
    releases.syncReleaseChanges.mockResolvedValue(result)
    expect(await invoke('releaseNote:syncChanges', true)).toEqual({ success: true, result })
    await invoke('releaseNote:syncChanges')
    await invoke('releaseNote:syncChanges', 'true')
    expect(releases.syncReleaseChanges.mock.calls).toEqual([[{ force: true }], [{ force: false }], [{ force: false }]])
  })

  it('실패는 throw 하지 않고 { success: false } 로 돌려준다', async () => {
    releases.syncReleaseChanges.mockRejectedValue(new Error('Jira API 오류 (500)'))
    expect(await invoke('releaseNote:syncChanges', false)).toEqual({ success: false, error: 'Jira API 오류 (500)' })
  })

  it('변경분 기준은 자격 증명 저장 성공·연결 해제·기본 프로젝트 변경 때 지운다', async () => {
    jira.saveJiraCredentials.mockResolvedValue({ accountName: '홍길동' })
    await invoke('jira:saveCredentials', {})
    invoke('jira:disconnect')
    invoke('jira:setDefaultProject', 'PROJ')
    expect(releases.clearReleaseSyncCheckpoint).toHaveBeenCalledTimes(3)

    releases.clearReleaseSyncCheckpoint.mockClear()
    jira.saveJiraCredentials.mockRejectedValue(new Error('401'))
    await invoke('jira:saveCredentials', {})
    jira.setDefaultJiraProjectKey.mockImplementation(() => {
      throw new Error('잘못된 Jira 프로젝트 키입니다.')
    })
    invoke('jira:setDefaultProject', 'bad')
    expect(releases.clearReleaseSyncCheckpoint).not.toHaveBeenCalled()
  })
})
