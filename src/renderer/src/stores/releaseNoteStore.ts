import { create } from 'zustand'
import type {
  JiraConnectionStatus,
  ReleaseChangeSyncResult,
  ReleaseNoteSummary,
  ReleaseNoteWithItems,
  SyncAllResult
} from '../types'

/** 방금 끝난 동기화 결과. 0건도 정상이라 실패와 반드시 구분해 보여줘야 한다 */
export interface SyncOutcome {
  itemCount: number
  truncated: boolean
}

interface ActionResult {
  success: boolean
  error?: string
}

interface ReleaseNoteStore {
  /** 프로젝트 상세 카드용 — 그 프로젝트의 배포 버전과 이름이 같은 릴리스만 */
  notes: ReleaseNoteSummary[]
  /** Releases 화면용 — 전체 릴리스. 두 화면이 동시에 살아 있어 서로 덮어쓰면 안 된다 */
  allNotes: ReleaseNoteSummary[]
  /** 펼친 릴리스만 채운다 — 항목 전체를 목록과 함께 들고 있을 이유가 없다 */
  details: Record<number, ReleaseNoteWithItems>
  jiraStatus: JiraConnectionStatus | null
  loading: boolean
  allLoading: boolean
  /** 동기화 중인 릴리스 노트 id. 행 단위로 버튼을 잠근다 */
  syncingId: number | null
  syncResults: Record<number, SyncOutcome>
  /** 이번 세션에서 난 동기화 실패. last_sync_error가 없어도 사용자에게 보여야 한다 */
  syncErrors: Record<number, string>
  /** 마지막으로 조회한 배포 버전 — 변경 후 재조회할 대상 */
  deployVersion: string | null
  /** 전체 목록을 한 번이라도 읽었는지. 안 읽은 목록까지 갱신할 이유는 없다 */
  allLoaded: boolean
  /** 전체 동기화 진행 중. 릴리스를 순차 처리해 수십 초 걸릴 수 있다 */
  syncAllRunning: boolean
  /** 마지막 전체 동기화 결과. 다음 전체 동기화 전까지 화면에 남긴다 */
  syncAllResult: SyncAllResult | null
  syncAllError: string
  /** 변경분 동기화 진행 중. 화면 진입 자동 갱신과 새로고침 버튼이 같이 쓴다 */
  changeSyncRunning: boolean
  /** 마지막 변경분 동기화 결과. skipped·full 은 담지 않는다(full 은 syncAllResult 로 보인다) */
  changeSyncResult: ReleaseChangeSyncResult | null
  changeSyncError: string

  fetchJiraStatus: () => Promise<void>
  fetchReleaseNotes: (deployVersion: string) => Promise<void>
  fetchAllReleaseNotes: () => Promise<void>
  /** 내보내기처럼 즉시 항목이 필요한 호출부를 위해 받아온 상세를 그대로 돌려준다 */
  fetchDetail: (id: number) => Promise<ReleaseNoteWithItems | null>
  syncNote: (id: number) => Promise<ActionResult>
  syncAll: () => Promise<void>
  clearSyncAllResult: () => void
  /** 마지막 동기화 이후 바뀐 이슈만 반영한다. force 가 아니면 main 이 10분 이내 재호출을 건너뛴다 */
  syncChanges: (force: boolean) => Promise<void>
  clearChangeSyncError: () => void
}

export const useReleaseNoteStore = create<ReleaseNoteStore>((set, get) => ({
  notes: [],
  allNotes: [],
  details: {},
  jiraStatus: null,
  loading: false,
  allLoading: false,
  syncingId: null,
  syncResults: {},
  syncErrors: {},
  deployVersion: null,
  allLoaded: false,
  syncAllRunning: false,
  syncAllResult: null,
  syncAllError: '',
  changeSyncRunning: false,
  changeSyncResult: null,
  changeSyncError: '',

  fetchJiraStatus: async () => {
    const jiraStatus = await window.api.jira.status()
    set({ jiraStatus })
  },

  fetchReleaseNotes: async (deployVersion) => {
    set({ loading: true, deployVersion })
    const notes = await window.api.releaseNote.list(deployVersion)
    set({ notes, loading: false })
  },

  fetchAllReleaseNotes: async () => {
    set({ allLoading: true })
    const allNotes = await window.api.releaseNote.list()
    set({ allNotes, allLoading: false, allLoaded: true })
  },

  fetchDetail: async (id) => {
    const detail = await window.api.releaseNote.get(id)
    if (!detail) return null
    set((state) => ({ details: { ...state.details, [id]: detail } }))
    return detail
  },

  syncNote: async (id) => {
    set({ syncingId: id })
    try {
      const result = await window.api.releaseNote.sync(id)
      if (!result.success) {
        const error = result.error ?? '동기화에 실패했습니다'
        set((state) => ({ syncErrors: { ...state.syncErrors, [id]: error } }))
        // 실패해도 목록은 다시 읽는다 — main이 기록한 last_sync_error를 반영하기 위해서다
        await refreshLists(get)
        return { success: false, error }
      }
      set((state) => {
        const syncErrors = { ...state.syncErrors }
        delete syncErrors[id]
        return {
          syncErrors,
          syncResults: {
            ...state.syncResults,
            [id]: { itemCount: result.itemCount ?? 0, truncated: result.truncated ?? false }
          }
        }
      })
      await refreshLists(get)
      // 펼쳐 둔 릴리스는 화면에 항목이 보이는 중이라 함께 갱신해야 한다
      if (get().details[id]) await get().fetchDetail(id)
      return { success: true }
    } finally {
      set({ syncingId: null })
    }
  },

  syncAll: async () => {
    // 변경분 동기화와 겹치지 않게 한다. main 도 막지만 버튼 상태가 어긋나지 않게 여기서도 거른다
    if (get().syncAllRunning || get().changeSyncRunning) return
    // 직전 결과를 먼저 지운다 — 새로 도는 동안 옛 요약이 남아 있으면 방금 결과로 오해한다
    set({ syncAllRunning: true, syncAllError: '', syncAllResult: null })
    try {
      const result = await window.api.releaseNote.syncAll()
      if (result.success) {
        set({ syncAllResult: result.result ?? null })
      } else {
        set({ syncAllError: result.error ?? '전체 동기화에 실패했습니다' })
      }
    } catch (e) {
      set({ syncAllError: e instanceof Error ? e.message : '전체 동기화에 실패했습니다' })
    } finally {
      set({ syncAllRunning: false })
      // 일부만 성공했어도 그만큼은 반영해야 한다
      await refreshLists(get)
    }
  },

  clearSyncAllResult: () => set({ syncAllResult: null, syncAllError: '' }),

  syncChanges: async (force) => {
    // 진행 중이면 다시 부르지 않는다. StrictMode 이중 마운트로 자동 호출이 두 번 나가도 1번만 돈다
    if (get().changeSyncRunning || get().syncAllRunning) return
    set({ changeSyncRunning: true, changeSyncError: '' })
    try {
      const res = await window.api.releaseNote.syncChanges(force)
      if (!res.success) {
        set({ changeSyncError: res.error || '변경분 갱신에 실패했습니다' })
        return
      }
      const result = res.result
      if (result.mode === 'skipped') return
      if (result.mode === 'full') {
        // 전체 동기화로 넘어갔다. 결과는 기존 전체 동기화 요약으로 보인다
        set({ syncAllResult: result.full ?? null, changeSyncResult: null })
        await refreshLists(get)
        await refreshOpenDetails(get)
        return
      }
      set({ changeSyncResult: result })
      // 목록은 main 의 ai:dataChanged 알림으로 다시 읽힌다. 펼쳐 둔 상세만 여기서 다시 읽는다
      if (hasChanges(result)) await refreshOpenDetails(get)
    } catch (e) {
      set({ changeSyncError: e instanceof Error && e.message ? e.message : '변경분 갱신에 실패했습니다' })
    } finally {
      set({ changeSyncRunning: false })
    }
  },

  clearChangeSyncError: () => set({ changeSyncError: '' })
}))

function hasChanges(result: ReleaseChangeSyncResult): boolean {
  return result.changed.length > 0 || result.linked > 0 || result.metaUpdated > 0
}

// 변경분 결과 한 줄. 예: '릴리스 2개에서 5건 갱신 · 신규 릴리스 1개'.
// 변경이 없으면 null 이다. 이유: 화면을 열 때마다 '변경 없음'이 아침 동기화 줄을 가린다
export function describeChangeSync(result: ReleaseChangeSyncResult | null): string | null {
  if (!result || result.mode !== 'incremental') return null
  const parts: string[] = []
  if (result.changed.length > 0) {
    const n = result.changed.reduce((sum, c) => sum + c.upserted + c.removed, 0)
    parts.push(`릴리스 ${result.changed.length}개에서 ${n}건 갱신`)
  }
  if (result.linked > 0) parts.push(`신규 릴리스 ${result.linked}개`)
  if (result.metaUpdated > 0) parts.push(`릴리스 정보 ${result.metaUpdated}개 갱신`)
  return parts.length > 0 ? parts.join(' · ') : null
}

// 펼쳐 둔 릴리스의 상세를 다시 읽는다. 화면에 항목이 보이는 중이라 옛 항목이 남으면 안 된다
async function refreshOpenDetails(get: () => ReleaseNoteStore): Promise<void> {
  const ids = Object.keys(get().details).map(Number)
  await Promise.all(ids.map((id) => get().fetchDetail(id).catch(() => null)))
}

// 프로젝트 상세 목록과 전체 목록 중 이미 읽은 것만 다시 읽는다.
// 두 화면이 동시에 떠 있을 수 있어 한쪽만 갱신하면 다른 쪽이 옛 항목 수를 계속 보여준다.
async function refreshLists(get: () => ReleaseNoteStore): Promise<void> {
  const { deployVersion, allLoaded } = get()
  await Promise.all([
    deployVersion !== null ? get().fetchReleaseNotes(deployVersion) : Promise.resolve(),
    allLoaded ? get().fetchAllReleaseNotes() : Promise.resolve()
  ])
}
