import { beforeEach, describe, expect, it, vi } from 'vitest'

// ipcMain.handle로 등록된 핸들러를 모아 직접 호출한다.
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))

// 서비스는 DB·Jira 없이 대체하되, 선택 검증만은 실제 함수(순수)를 태운다 —
// IPC가 renderer 입력을 그대로 서비스에 넘기고, 검증 실패를 { success: false }로 감싸는지 본다.
const service = vi.hoisted(() => ({
  previewProjectSync: vi.fn(),
  applyProjectSync: vi.fn()
}))
vi.mock('../services/project-sync', () => service)

import {
  EMPTY_SELECTION_MESSAGE,
  INVALID_SELECTION_MESSAGE,
  parseProjectSyncSelection
} from '../services/project-sync-plan'
import { registerProjectSyncIpc } from './project-sync.ipc'

const RESULT = {
  created: 1,
  updated: 0,
  unchanged: 0,
  tasksAdded: 0,
  tasksUpdated: 0,
  documentsAdded: 1,
  skipped: []
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`핸들러 없음: ${channel}`)
  return Promise.resolve(fn({}, ...args))
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  service.applyProjectSync.mockImplementation(async (selection: unknown) => {
    parseProjectSyncSelection(selection)
    return RESULT
  })
  registerProjectSyncIpc()
})

describe('projectSync:apply 입력 검증', () => {
  it('올바른 선택은 그대로 서비스에 넘기고 결과를 감싼다', async () => {
    const selection = [{ jiraKey: 'PROJ-1855', force: true, projectId: 12 }]
    expect(await invoke('projectSync:apply', selection)).toEqual({ success: true, result: RESULT })
    expect(service.applyProjectSync).toHaveBeenCalledWith(selection)
  })

  it('빈 배열은 선택 요청 오류로 돌려준다', async () => {
    expect(await invoke('projectSync:apply', [])).toEqual({
      success: false,
      error: EMPTY_SELECTION_MESSAGE
    })
  })

  it('배열이 아니거나 키 형식·force 타입이 틀리면 오류로 돌려준다 (throw하지 않는다)', async () => {
    for (const bad of [
      undefined,
      { jiraKey: 'PROJ-1', force: true },
      [{ jiraKey: 'PROJ-1 OR 1=1', force: true }],
      [{ jiraKey: 'PROJ-1', force: 1, projectId: null }],
      // projectId는 미리보기 항목의 값(양의 정수 또는 null)이어야 한다
      [{ jiraKey: 'PROJ-1', force: true }],
      [{ jiraKey: 'PROJ-1', force: true, projectId: '12' }]
    ]) {
      expect(await invoke('projectSync:apply', bad), JSON.stringify(bad)).toEqual({
        success: false,
        error: INVALID_SELECTION_MESSAGE
      })
    }
  })
})
