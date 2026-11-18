import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BackupGroupId } from '../types'

// 백업 스토어의 상태 전이를 고정한다 (docs/DATA_BACKUP.md §3).
// window.api 를 가짜로 꽂고 실제 zustand 스토어를 돌린다 — 노드 환경에서 window 만 흉내 낸다.

type Api = {
  backup: {
    stats: ReturnType<typeof vi.fn>
    exportToFile: ReturnType<typeof vi.fn>
    pickBackup: ReturnType<typeof vi.fn>
    importBackup: ReturnType<typeof vi.fn>
    restart: ReturnType<typeof vi.fn>
    onProgress: ReturnType<typeof vi.fn>
  }
}

let api: Api

function makeApi(): Api {
  return {
    backup: {
      stats: vi.fn(async () => ({ success: true, groups: [] })),
      exportToFile: vi.fn(async () => ({ success: false, canceled: true })),
      pickBackup: vi.fn(async () => ({ success: false, canceled: true })),
      importBackup: vi.fn(async () => ({ success: true, warnings: [], restartPending: false })),
      restart: vi.fn(async () => ({ success: true })),
      onProgress: vi.fn(() => () => {})
    }
  }
}

const { useBackupStore } = await import('./backupStore')

const initial = (): Partial<ReturnType<typeof useBackupStore.getState>> => ({
  exporting: false,
  importing: false,
  progress: null,
  lastExport: null,
  pickedSummary: null,
  stats: null,
  importWarnings: [],
  restartPending: false,
  error: null
})

beforeEach(() => {
  api = makeApi()
  vi.stubGlobal('window', { api })
  useBackupStore.setState(initial())
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('backupStore (docs/DATA_BACKUP.md §3)', () => {
  it('R6 경고가 있는 복원은 restartPending 으로 남고 importing 을 유지한다(버튼 잠금·재시작 대기)', async () => {
    api.backup.importBackup.mockResolvedValueOnce({
      success: true,
      groups: ['settings'],
      warnings: ['Jira 연동 계정이 백업과 달라 현재 연결을 지웠습니다. 다시 연결하세요.'],
      restartPending: true
    })

    await useBackupStore.getState().importBackup('/a.zip', ['settings'])

    const s = useBackupStore.getState()
    expect(s.restartPending).toBe(true)
    expect(s.importing).toBe(true)
    expect(s.importWarnings).toHaveLength(1)
    expect(s.error).toBeNull()
  })

  it('R7 경고 없는 복원은 restartPending 이 아니다(main 이 1초 뒤 자동 재시작)', async () => {
    api.backup.importBackup.mockResolvedValueOnce({ success: true, warnings: [], restartPending: false })

    await useBackupStore.getState().importBackup('/a.zip', ['work'])

    expect(useBackupStore.getState().restartPending).toBe(false)
    expect(useBackupStore.getState().importing).toBe(true)
  })

  it('R8 복원 실패는 importing 을 풀고 사유를 남긴다(재시작 대기가 아니다)', async () => {
    api.backup.importBackup.mockResolvedValueOnce({ success: false, error: '백업 DB 스키마가 더 새 버전입니다' })

    await useBackupStore.getState().importBackup('/a.zip', ['work'])

    const s = useBackupStore.getState()
    expect(s.importing).toBe(false)
    expect(s.restartPending).toBe(false)
    expect(s.error).toBe('백업 DB 스키마가 더 새 버전입니다')
  })

  it('R9 restart 가 실패하면 사유를 보여주고 restartPending 을 유지해 다시 누를 수 있게 한다', async () => {
    useBackupStore.setState({ restartPending: true, importing: true })
    api.backup.restart.mockRejectedValueOnce(new Error('IPC 끊김'))

    await useBackupStore.getState().restart()

    const s = useBackupStore.getState()
    expect(s.error).toBe('IPC 끊김')
    expect(s.restartPending).toBe(true)
    expect(s.importing).toBe(true)
  })

  it('R9 reset 은 재시작 대기 중이면 아무것도 지우지 않고, 평소에는 지운다', () => {
    useBackupStore.setState({ restartPending: true, importing: true, error: '남은 오류' })
    useBackupStore.getState().reset()
    expect(useBackupStore.getState().restartPending).toBe(true)
    expect(useBackupStore.getState().importing).toBe(true)
    expect(useBackupStore.getState().error).toBe('남은 오류')

    useBackupStore.setState({ restartPending: false })
    useBackupStore.getState().reset()
    expect(useBackupStore.getState().importing).toBe(false)
    expect(useBackupStore.getState().error).toBeNull()
  })

  it('R10 stats 가 실패하거나 던져도 stats 만 비고 다른 상태(에러 배너)는 건드리지 않는다', async () => {
    useBackupStore.setState({ error: null })
    api.backup.stats.mockResolvedValueOnce({ success: false, error: 'DB 없음' })
    await useBackupStore.getState().loadStats()
    expect(useBackupStore.getState().stats).toBeNull()
    expect(useBackupStore.getState().error).toBeNull()

    api.backup.stats.mockRejectedValueOnce(new Error('boom'))
    await useBackupStore.getState().loadStats()
    expect(useBackupStore.getState().stats).toBeNull()
    expect(useBackupStore.getState().error).toBeNull()
  })

  it('R11 내보내기는 고른 그룹을 그대로 넘기고, 저장 취소는 실패가 아니다', async () => {
    const groups: BackupGroupId[] = ['meetings', 'ai']
    api.backup.exportToFile.mockResolvedValueOnce({ success: false, canceled: true })

    await useBackupStore.getState().exportToFile(groups)

    expect(api.backup.exportToFile).toHaveBeenCalledWith(groups)
    expect(useBackupStore.getState().error).toBeNull()
    expect(useBackupStore.getState().exporting).toBe(false)
  })
})
