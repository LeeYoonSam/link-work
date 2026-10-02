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
const projectSync = vi.hoisted(() => ({ clearProjectSyncCache: vi.fn() }))
vi.mock('../services/project-sync', () => projectSync)

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

describe('Jira 연결이 바뀌면 싱크업 미리보기 캐시를 버린다', () => {
  it('연결 해제', () => {
    invoke('jira:disconnect')
    expect(projectSync.clearProjectSyncCache).toHaveBeenCalledTimes(1)
  })

  it('자격 증명 저장', async () => {
    jira.saveJiraCredentials.mockResolvedValue({ accountName: '홍길동' })
    await invoke('jira:saveCredentials', {})
    expect(projectSync.clearProjectSyncCache).toHaveBeenCalledTimes(1)
  })

  it('기본 프로젝트 키 변경', () => {
    invoke('jira:setDefaultProject', 'PROJ')
    expect(projectSync.clearProjectSyncCache).toHaveBeenCalledTimes(1)
  })
})
