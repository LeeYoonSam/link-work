import { create } from 'zustand'
import type {
  BackupGroupId,
  BackupGroupStat,
  BackupManifest,
  BackupProgress,
  BackupSummary
} from '../types'

// 앱 데이터 백업(내보내기) · 복원(가져오기) 전역 상태.
//
// 백업 한 벌은 .zip 파일 하나다 — 그래서 상태가 들고 다니는 것도 폴더가 아니라 파일 경로(`path`)다.
// 내보내기와 가져오기는 서로 다른 흐름이지만 진행률 이벤트(`backup:progress`)를 공유한다.
// 그래서 진행률은 스토어 한 곳에 두고, 어느 작업의 진행인지는 `exporting`/`importing`으로 구분한다.
//
// 실패는 throw하지 않고 `error`에 담는다 — 모달이 배너 한 곳에서 보여준다.
// **취소(canceled)는 에러가 아니다.** 사용자가 파일 다이얼로그를 닫은 것뿐이므로
// 직전 상태(고른 백업 요약 등)를 그대로 두고 조용히 빠져나온다.
//
// 내보내기·복원은 그룹 단위다(docs/DATA_BACKUP.md §1). 어느 그룹을 골랐는지는 모달이 들고,
// 스토어는 호출할 때 받은 그룹을 그대로 main 에 넘긴다. `stats`(그룹별 현재 건수·파일 용량)는
// 화면 표시용이라 못 받아도 내보내기·복원을 막지 않는다.

interface BackupStore {
  exporting: boolean
  importing: boolean
  /** 마지막으로 받은 진행률 이벤트. 작업이 끝나면 null로 지운다. */
  progress: BackupProgress | null
  /** 이번 세션에서 성공한 내보내기 결과 — `path`는 만들어진 .zip 파일 경로 */
  lastExport: { path: string; manifest: BackupManifest } | null
  /** 복원 대상으로 고른 백업 .zip의 요약. 복원 확인 화면의 원본이다. */
  pickedSummary: BackupSummary | null
  /** 현재 데이터의 그룹별 건수·파일 용량. 아직 못 받았거나 실패하면 null */
  stats: BackupGroupStat[] | null
  /** 복원은 됐지만 알아야 할 것(연동 재연결 등). 재시작 직전까지만 보인다. */
  importWarnings: string[]
  /**
   * 복원은 끝났지만 경고가 있어 main 이 재시작을 멈추고 기다리는 중.
   * 모달은 경고와 [확인 후 재시작]만 보여준다 — 이 시점의 DB 는 이미 바뀌었으므로 다른 조작은 막는다.
   */
  restartPending: boolean
  error: string | null

  loadStats: () => Promise<void>
  exportToFile: (groups: BackupGroupId[]) => Promise<void>
  pickBackup: () => Promise<void>
  importBackup: (path: string, groups: BackupGroupId[]) => Promise<void>
  /** restartPending 상태에서 앱을 재시작한다 */
  restart: () => Promise<void>
  /** 재시작을 기다리는 중(restartPending)이면 아무것도 지우지 않는다 */
  reset: () => void
  /** main→renderer 진행률 구독. 해제 함수를 돌려준다. */
  subscribeProgress: () => () => void
}

const message = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : fallback

export const useBackupStore = create<BackupStore>((set) => ({
  exporting: false,
  importing: false,
  progress: null,
  lastExport: null,
  pickedSummary: null,
  stats: null,
  importWarnings: [],
  restartPending: false,
  error: null,

  loadStats: async () => {
    try {
      const result = await window.api.backup.stats()
      // 숫자는 보조 정보다 — 실패해도 배너로 겁주지 않고 숫자만 비워 둔다
      set({ stats: result.success && result.groups ? result.groups : null })
      if (!result.success) console.error('[backupStore] stats error:', result.error)
    } catch (err) {
      console.error('[backupStore] stats error:', err)
      set({ stats: null })
    }
  },

  exportToFile: async (groups) => {
    set({ exporting: true, error: null, progress: null, lastExport: null })
    try {
      const result = await window.api.backup.exportToFile(groups)
      // 저장 위치 선택을 취소한 것은 실패가 아니다
      if (result.canceled) return
      if (result.success && result.path && result.manifest) {
        set({ lastExport: { path: result.path, manifest: result.manifest }, error: null })
      } else {
        set({ error: result.error ?? '백업 내보내기에 실패했습니다' })
      }
    } catch (err) {
      console.error('[backupStore] exportToFile error:', err)
      set({ error: message(err, '백업 내보내기에 실패했습니다') })
    } finally {
      // 진행 바를 남겨두면 완료 요약과 겹쳐 보인다
      set({ exporting: false, progress: null })
    }
  },

  pickBackup: async () => {
    set({ error: null })
    try {
      const result = await window.api.backup.pickBackup()
      if (result.canceled) return
      if (result.success && result.summary) {
        set({ pickedSummary: result.summary, error: null })
      } else {
        // 고른 파일이 백업이 아니면 직전 선택도 지운다 — 옛 요약을 보고 복원하면 안 된다
        set({ pickedSummary: null, error: result.error ?? '백업 파일을 읽지 못했습니다' })
      }
    } catch (err) {
      console.error('[backupStore] pickBackup error:', err)
      set({ pickedSummary: null, error: message(err, '백업 파일을 읽지 못했습니다') })
    }
  },

  importBackup: async (path, groups) => {
    set({
      importing: true,
      error: null,
      progress: null,
      importWarnings: [],
      restartPending: false
    })
    try {
      const result = await window.api.backup.importBackup(path, groups)
      if (result.success) {
        set({
          importWarnings: result.warnings ?? [],
          restartPending: result.restartPending === true
        })
        // 성공하면 main이 곧 앱을 재시작한다. importing을 유지해 버튼을 잠그고
        // "재시작 중…"을 계속 보여준다 — 여기서 풀면 사용자가 두 번 누를 수 있다.
        return
      }
      set({
        importing: false,
        progress: null,
        error: result.error ?? '복원에 실패했습니다'
      })
    } catch (err) {
      console.error('[backupStore] importBackup error:', err)
      set({
        importing: false,
        progress: null,
        error: message(err, '복원에 실패했습니다')
      })
    }
  },

  restart: async () => {
    try {
      await window.api.backup.restart()
    } catch (err) {
      // 재시작 요청이 실패하면 DB 는 이미 바뀐 상태라 그대로 두면 안 된다 — 사유를 보여주고
      // 버튼을 다시 누를 수 있게 restartPending 은 유지한다
      console.error('[backupStore] restart error:', err)
      set({
        error: message(err, '앱을 다시 시작하지 못했습니다. 앱을 직접 종료한 뒤 다시 여세요.')
      })
    }
  },

  reset: () => {
    // 재시작을 기다리는 중에는 상태를 지우지 않는다 — DB 는 이미 닫혀 바뀌어 있고, 지우면
    // 다시 연 모달이 재시작 안내 없이 정상 화면처럼 보인다
    if (useBackupStore.getState().restartPending) return
    set({
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
  },

  subscribeProgress: () => {
    return window.api.backup.onProgress((p: BackupProgress) => {
      if (p.phase === 'error') {
        set({ progress: null, error: p.message ?? '백업 작업이 실패했습니다' })
        return
      }
      set({ progress: p })
    })
  }
}))
