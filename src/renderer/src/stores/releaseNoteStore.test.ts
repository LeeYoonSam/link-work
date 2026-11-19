import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReleaseChangeSyncResult, ReleaseNoteWithItems, SyncAllResult } from '../types'
import { describeChangeSync, useReleaseNoteStore } from './releaseNoteStore'

// 릴리스 변경분 동기화(plan3 3절)의 store 동작을 고정한다.
// main 구현과 무관하게 window.api.releaseNote.syncChanges 를 mock 한다.

type SyncChangesResponse =
  | { success: true; result: ReleaseChangeSyncResult }
  | { success: false; error: string }

const result = (over: Partial<ReleaseChangeSyncResult> = {}): ReleaseChangeSyncResult => ({
  mode: 'incremental',
  changed: [],
  linked: 0,
  metaUpdated: 0,
  ...over
})

const FULL: SyncAllResult = {
  projectKey: 'PROJ',
  linked: 1,
  synced: [],
  metaOnly: [],
  failed: []
} as unknown as SyncAllResult

const api = {
  syncChanges: vi.fn(
    async (_force?: boolean): Promise<SyncChangesResponse> => ({ success: true, result: result() })
  ),
  syncAll: vi.fn(async () => ({ success: true, result: FULL })),
  list: vi.fn(async () => []),
  get: vi.fn(async (id: number) => ({ id }) as unknown as ReleaseNoteWithItems)
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = { api: { releaseNote: api } }
  useReleaseNoteStore.setState({
    details: {},
    allLoaded: true,
    syncAllRunning: false,
    syncAllResult: null,
    syncAllError: '',
    changeSyncRunning: false,
    changeSyncResult: null,
    changeSyncError: ''
  })
})

describe('syncChanges', () => {
  it('force 값을 그대로 넘긴다', async () => {
    await useReleaseNoteStore.getState().syncChanges(false)
    await useReleaseNoteStore.getState().syncChanges(true)
    expect(api.syncChanges.mock.calls.map((c) => c[0])).toEqual([false, true])
  })

  it('진행 중이면 다시 부르지 않는다 (StrictMode 이중 마운트)', async () => {
    let release: (v: SyncChangesResponse) => void = () => {}
    api.syncChanges.mockImplementationOnce(() => new Promise((r) => (release = r)))
    const first = useReleaseNoteStore.getState().syncChanges(false)
    expect(useReleaseNoteStore.getState().changeSyncRunning).toBe(true)
    await useReleaseNoteStore.getState().syncChanges(false)
    expect(api.syncChanges).toHaveBeenCalledTimes(1)
    release({ success: true, result: result() })
    await first
    expect(useReleaseNoteStore.getState().changeSyncRunning).toBe(false)
  })

  it('전체 동기화가 도는 중이면 부르지 않는다', async () => {
    useReleaseNoteStore.setState({ syncAllRunning: true })
    await useReleaseNoteStore.getState().syncChanges(true)
    expect(api.syncChanges).not.toHaveBeenCalled()
  })

  it('변경분 동기화가 도는 중이면 전체 동기화를 부르지 않는다', async () => {
    useReleaseNoteStore.setState({ changeSyncRunning: true })
    await useReleaseNoteStore.getState().syncAll()
    expect(api.syncAll).not.toHaveBeenCalled()
  })

  it('skipped 는 결과를 남기지 않고 아무것도 다시 읽지 않는다', async () => {
    useReleaseNoteStore.setState({ details: { 3: { id: 3 } as unknown as ReleaseNoteWithItems } })
    api.syncChanges.mockResolvedValueOnce({ success: true, result: result({ mode: 'skipped' }) })
    await useReleaseNoteStore.getState().syncChanges(false)
    expect(useReleaseNoteStore.getState().changeSyncResult).toBeNull()
    expect(api.get).not.toHaveBeenCalled()
    expect(api.list).not.toHaveBeenCalled()
  })

  it('변경이 있으면 결과를 남기고 펼쳐 둔 상세를 다시 읽는다. 목록은 ai:dataChanged 에 맡긴다', async () => {
    useReleaseNoteStore.setState({ details: { 3: { id: 3 } as unknown as ReleaseNoteWithItems } })
    const r = result({ changed: [{ noteId: 3, version: '4.1.0', upserted: 2, removed: 1 }] })
    api.syncChanges.mockResolvedValueOnce({ success: true, result: r })
    await useReleaseNoteStore.getState().syncChanges(true)
    expect(useReleaseNoteStore.getState().changeSyncResult).toEqual(r)
    expect(api.get).toHaveBeenCalledWith(3)
    expect(api.list).not.toHaveBeenCalled()
  })

  it('변경이 없으면 상세를 다시 읽지 않는다', async () => {
    useReleaseNoteStore.setState({ details: { 3: { id: 3 } as unknown as ReleaseNoteWithItems } })
    await useReleaseNoteStore.getState().syncChanges(false)
    expect(api.get).not.toHaveBeenCalled()
  })

  it('full 이면 전체 동기화 결과로 보이고 목록과 상세를 다시 읽는다', async () => {
    useReleaseNoteStore.setState({ details: { 5: { id: 5 } as unknown as ReleaseNoteWithItems } })
    api.syncChanges.mockResolvedValueOnce({ success: true, result: result({ mode: 'full', full: FULL }) })
    await useReleaseNoteStore.getState().syncChanges(false)
    const s = useReleaseNoteStore.getState()
    expect(s.syncAllResult).toBe(FULL)
    expect(s.changeSyncResult).toBeNull()
    expect(api.list).toHaveBeenCalled()
    expect(api.get).toHaveBeenCalledWith(5)
  })

  it('실패 응답은 오류 문구로 남기고 진행 표시를 끈다', async () => {
    api.syncChanges.mockResolvedValueOnce({ success: false, error: 'Jira 토큰이 만료됐어요' })
    await useReleaseNoteStore.getState().syncChanges(false)
    const s = useReleaseNoteStore.getState()
    expect(s.changeSyncError).toBe('Jira 토큰이 만료됐어요')
    expect(s.changeSyncRunning).toBe(false)
  })

  it('예외도 오류 문구로 바꾼다. 다음 호출은 이전 오류를 지운다', async () => {
    api.syncChanges.mockRejectedValueOnce(new Error('IPC 끊김'))
    await useReleaseNoteStore.getState().syncChanges(false)
    expect(useReleaseNoteStore.getState().changeSyncError).toBe('IPC 끊김')
    await useReleaseNoteStore.getState().syncChanges(true)
    expect(useReleaseNoteStore.getState().changeSyncError).toBe('')
  })

  it('clearChangeSyncError 로 오류 줄을 닫는다', () => {
    useReleaseNoteStore.setState({ changeSyncError: '실패' })
    useReleaseNoteStore.getState().clearChangeSyncError()
    expect(useReleaseNoteStore.getState().changeSyncError).toBe('')
  })
})

describe('describeChangeSync', () => {
  it('항목 갱신·신규 릴리스·메타 갱신을 한 줄로 만든다', () => {
    expect(
      describeChangeSync(
        result({
          changed: [
            { noteId: 1, version: '4.1.0', upserted: 3, removed: 0 },
            { noteId: 2, version: '4.2.0', upserted: 1, removed: 1 }
          ],
          linked: 1,
          metaUpdated: 2
        })
      )
    ).toBe('릴리스 2개에서 5건 갱신 · 신규 릴리스 1개 · 릴리스 정보 2개 갱신')
  })

  it('변경 없음·skipped·full·null 은 줄을 만들지 않는다', () => {
    expect(describeChangeSync(result())).toBeNull()
    expect(describeChangeSync(result({ mode: 'skipped' }))).toBeNull()
    expect(describeChangeSync(result({ mode: 'full', full: FULL, linked: 2 }))).toBeNull()
    expect(describeChangeSync(null)).toBeNull()
  })
})
