import { beforeEach, describe, expect, it, vi } from 'vitest'

// A54 아침 자동 동기화 실행기. 판정 규칙은 assistant-schedule.test.ts 가 검증한다.
// 여기서는 선점·격리·건너뜀·오프라인·발송을 본다. 사용자 DB 를 쓰지 않는다. 저장소는 메모리 Map 이다.

const electron = vi.hoisted(() => {
  const sent: { channel: string; payload: unknown }[] = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) }
  }
  return {
    sent,
    windows: [win] as unknown[],
    net: { isOnline: vi.fn(() => true) }
  }
})
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => electron.windows },
  net: electron.net
}))

const fakeDb = vi.hoisted(() => ({
  transaction: <T>(fn: () => T) => (): T => fn()
}))
const database = vi.hoisted(() => ({ getDatabase: vi.fn(() => fakeDb as unknown) }))
vi.mock('../db/database', () => database)

interface Row {
  id: number; event_key: string; kind: string; plan_date: string; scheduled_at: string
  fired_at: string | null; status: string; ref_id: string | null; payload: string | null
}
const store = vi.hoisted(() => {
  const rows = new Map<string, Row>()
  const state = { nextId: 1, settings: {} as Record<string, unknown>, insertConflict: false }
  return {
    rows,
    state,
    readAssistantSettings: vi.fn(() => ({
      dayRollover: '04:00',
      morningSyncEnabled: true,
      morningSyncTime: '08:00',
      ...state.settings
    })),
    findEventByKey: vi.fn((_db: unknown, key: string) => rows.get(key) ?? null),
    findLatestEventByKind: vi.fn((_db: unknown, kind: string) => {
      const list = [...rows.values()].filter((r) => r.kind === kind)
      list.sort((a, b) => (a.plan_date < b.plan_date ? 1 : -1))
      return list[0] ?? null
    }),
    insertEvent: vi.fn((_db: unknown, ev: Omit<Row, 'id'>) => {
      if (state.insertConflict || rows.has(ev.event_key)) return null
      const row = { id: state.nextId++, ...ev }
      rows.set(ev.event_key, row)
      return row
    }),
    updateEventPayload: vi.fn((_db: unknown, id: number, payload: string) => {
      for (const r of rows.values()) if (r.id === id) r.payload = payload
    })
  }
})
vi.mock('./assistant-store', () => store)

const jira = vi.hoisted(() => ({
  isJiraConnected: vi.fn(() => true),
  getDefaultJiraProjectKey: vi.fn((): string | null => 'APP')
}))
vi.mock('./jira', () => jira)

const release = vi.hoisted(() => ({ syncAllReleases: vi.fn() }))
vi.mock('./release-note-sync', () => release)

const projectSync = vi.hoisted(() => ({ runAutoProjectSync: vi.fn() }))
vi.mock('./project-sync', () => projectSync)

import { getMorningSyncStatus, morningSyncEventKey, runMorningSyncIfDue, toProjectOutcome } from './morning-sync'

const NOW = new Date(2026, 10, 5, 8, 10, 0)
const KEY = 'morning_sync:2026-11-05'

function payloadOf(key = KEY): Record<string, Record<string, unknown> | null> {
  const row = store.rows.get(key)
  return JSON.parse(row?.payload ?? 'null')
}

function releaseOk(): void {
  release.syncAllReleases.mockResolvedValue({
    synced: [{ noteId: 1, version: 'v1.2.0', itemCount: 3 }, { noteId: 2, version: 'v1.1.0', itemCount: 1 }],
    metaOnly: [],
    failed: [],
    linked: 1
  })
}

function projectOk(): void {
  projectSync.runAutoProjectSync.mockResolvedValue({
    status: 'applied',
    result: { created: 2, updated: 1 },
    needsReview: 1
  })
}

function syncStatusSends(): number {
  return electron.sent.filter((s) => s.channel === 'ai:dataChanged' && (s.payload as { entity: string }).entity === 'sync_status').length
}

beforeEach(() => {
  vi.clearAllMocks()
  store.rows.clear()
  store.state.nextId = 1
  store.state.settings = {}
  store.state.insertConflict = false
  electron.sent.length = 0
  electron.net.isOnline.mockReturnValue(true)
  database.getDatabase.mockImplementation(() => fakeDb as unknown)
  jira.isJiraConnected.mockReturnValue(true)
  jira.getDefaultJiraProjectKey.mockReturnValue('APP')
  releaseOk()
  projectOk()
})

describe('A54: 아침 자동 동기화 실행기', () => {
  it('A54: 행 키는 morning_sync:<논리 날짜> 다', () => {
    expect(morningSyncEventKey('2026-11-05')).toBe(KEY)
  })

  it('A54: 설정 시각이 지나면 행 1개를 만들고 두 부분을 실행해 payload 에 기록한다', async () => {
    await runMorningSyncIfDue(false, NOW)
    expect(release.syncAllReleases).toHaveBeenCalledTimes(1)
    expect(projectSync.runAutoProjectSync).toHaveBeenCalledTimes(1)
    const row = store.rows.get(KEY)
    expect(row).toMatchObject({ kind: 'morning_sync', plan_date: '2026-11-05', status: 'logged' })
    const p = payloadOf()
    expect(p.release).toMatchObject({ status: 'ok', attempts: 1, newCount: 1, updatedCount: 2, error: null })
    expect(p.project).toMatchObject({ status: 'ok', attempts: 1, newCount: 2, updatedCount: 1, reviewCount: 1 })
    expect(p.release?.finishedAt).toBe('2026-11-05 08:10:00')
  })

  it('A54: 이미 ok 인 날은 다시 실행하지 않는다', async () => {
    await runMorningSyncIfDue(false, NOW)
    await runMorningSyncIfDue(false, new Date(2026, 10, 5, 9, 0, 0))
    expect(release.syncAllReleases).toHaveBeenCalledTimes(1)
    expect(projectSync.runAutoProjectSync).toHaveBeenCalledTimes(1)
  })

  it('A54: 설정 시각 이전이면 행을 만들지 않는다', async () => {
    await runMorningSyncIfDue(false, new Date(2026, 10, 5, 7, 59, 0))
    expect(store.insertEvent).not.toHaveBeenCalled()
    expect(release.syncAllReleases).not.toHaveBeenCalled()
  })

  it('A54: 꺼져 있으면 실행하지 않는다', async () => {
    store.state.settings = { morningSyncEnabled: false }
    await runMorningSyncIfDue(false, NOW)
    expect(store.insertEvent).not.toHaveBeenCalled()
    expect(release.syncAllReleases).not.toHaveBeenCalled()
  })

  it('A54·A5: 선점 INSERT 가 충돌하면 실행하지 않는다', async () => {
    store.state.insertConflict = true
    await runMorningSyncIfDue(false, NOW)
    expect(store.insertEvent).toHaveBeenCalledTimes(1)
    expect(release.syncAllReleases).not.toHaveBeenCalled()
    expect(projectSync.runAutoProjectSync).not.toHaveBeenCalled()
    expect(syncStatusSends()).toBe(0)
  })

  it('A54: 진행 중이면 두 번째 호출은 바로 돌아간다', async () => {
    let resolve: (v: unknown) => void = () => undefined
    release.syncAllReleases.mockImplementation(() => new Promise((r) => (resolve = r)))
    const first = runMorningSyncIfDue(false, NOW)
    await vi.waitFor(() => expect(release.syncAllReleases).toHaveBeenCalledTimes(1))
    await runMorningSyncIfDue(true, NOW)
    expect(release.syncAllReleases).toHaveBeenCalledTimes(1)
    expect(store.insertEvent).toHaveBeenCalledTimes(1)
    expect(getMorningSyncStatus().inFlight).toBe(true)
    resolve({ synced: [], metaOnly: [], failed: [], linked: 0 })
    await first
    expect(getMorningSyncStatus().inFlight).toBe(false)
  })

  it('A54: 릴리스 부분이 throw 해도 싱크업 부분은 실행한다', async () => {
    release.syncAllReleases.mockRejectedValue(new Error('Jira 토큰이 만료되었습니다.'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(runMorningSyncIfDue(false, NOW)).resolves.toBeUndefined()
    errSpy.mockRestore()
    expect(projectSync.runAutoProjectSync).toHaveBeenCalledTimes(1)
    const p = payloadOf()
    expect(p.release).toMatchObject({ status: 'failed', attempts: 1, error: 'Jira 토큰이 만료되었습니다.' })
    expect(p.project).toMatchObject({ status: 'ok' })
  })

  it('A54: 싱크업 부분이 throw 해도 릴리스 결과는 남는다', async () => {
    projectSync.runAutoProjectSync.mockRejectedValue(new Error('network'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await runMorningSyncIfDue(false, NOW)
    errSpy.mockRestore()
    const p = payloadOf()
    expect(p.release).toMatchObject({ status: 'ok' })
    expect(p.project).toMatchObject({ status: 'failed', error: 'network' })
  })

  it('A54: 실패한 부분만 30분 뒤에 다시 하고 시도 수를 센다', async () => {
    release.syncAllReleases.mockRejectedValueOnce(new Error('timeout'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await runMorningSyncIfDue(false, NOW)
    errSpy.mockRestore()
    await runMorningSyncIfDue(false, new Date(2026, 10, 5, 8, 20, 0))
    expect(release.syncAllReleases).toHaveBeenCalledTimes(1)
    await runMorningSyncIfDue(false, new Date(2026, 10, 5, 8, 40, 0))
    expect(release.syncAllReleases).toHaveBeenCalledTimes(2)
    expect(projectSync.runAutoProjectSync).toHaveBeenCalledTimes(1)
    expect(payloadOf().release).toMatchObject({ status: 'ok', attempts: 2 })
  })

  it('A54: 릴리스가 모두 실패하면 failed, 일부만 실패하면 ok 에 실패 수를 남긴다', async () => {
    release.syncAllReleases.mockResolvedValueOnce({
      synced: [],
      metaOnly: [],
      failed: [{ version: 'v1', error: '권한 없음' }],
      linked: 0
    })
    await runMorningSyncIfDue(false, NOW)
    expect(payloadOf().release).toMatchObject({ status: 'failed', error: '권한 없음', failedCount: 1 })

    store.rows.clear()
    release.syncAllReleases.mockResolvedValueOnce({
      synced: [{ noteId: 1, version: 'v2', itemCount: 1 }],
      metaOnly: [],
      failed: [{ version: 'v1', error: '권한 없음' }],
      linked: 0
    })
    await runMorningSyncIfDue(false, NOW)
    expect(payloadOf().release).toMatchObject({ status: 'ok', failedCount: 1, updatedCount: 1 })
  })

  it('A54: Jira 미연결이면 두 부분이 skipped 이고 동기화를 부르지 않는다', async () => {
    jira.isJiraConnected.mockReturnValue(false)
    await runMorningSyncIfDue(false, NOW)
    expect(release.syncAllReleases).not.toHaveBeenCalled()
    expect(projectSync.runAutoProjectSync).not.toHaveBeenCalled()
    const p = payloadOf()
    expect(p.release).toMatchObject({ status: 'skipped' })
    expect(p.project).toMatchObject({ status: 'skipped' })
    // skipped 는 그날 다시 하지 않는다
    jira.isJiraConnected.mockReturnValue(true)
    await runMorningSyncIfDue(false, new Date(2026, 10, 5, 12, 0, 0))
    expect(release.syncAllReleases).not.toHaveBeenCalled()
  })

  it('A54: 기본 프로젝트 키가 없으면 skipped 다', async () => {
    jira.getDefaultJiraProjectKey.mockReturnValue(null)
    await runMorningSyncIfDue(false, NOW)
    expect(release.syncAllReleases).not.toHaveBeenCalled()
    expect(payloadOf().release).toMatchObject({ status: 'skipped', error: 'Jira 기본 프로젝트가 설정되지 않았습니다.' })
  })

  it('A54·D8: 오프라인이면 행을 만들지 않고 시도로 세지 않는다', async () => {
    electron.net.isOnline.mockReturnValue(false)
    await runMorningSyncIfDue(false, NOW)
    expect(store.insertEvent).not.toHaveBeenCalled()
    expect(release.syncAllReleases).not.toHaveBeenCalled()
    expect(store.rows.size).toBe(0)

    electron.net.isOnline.mockReturnValue(true)
    await runMorningSyncIfDue(false, new Date(2026, 10, 5, 8, 11, 0))
    expect(payloadOf().release).toMatchObject({ status: 'ok', attempts: 1 })
  })

  it('A54: deferred 는 시도로 세지 않는다', async () => {
    projectSync.runAutoProjectSync.mockResolvedValueOnce({ status: 'deferred' })
    await runMorningSyncIfDue(false, NOW)
    expect(payloadOf().project).toMatchObject({ status: 'deferred', attempts: 0 })
    await runMorningSyncIfDue(false, new Date(2026, 10, 5, 8, 41, 0))
    expect(projectSync.runAutoProjectSync).toHaveBeenCalledTimes(2)
    expect(payloadOf().project).toMatchObject({ status: 'ok', attempts: 1 })
  })

  it('A54: 선점 뒤와 부분마다 ai:dataChanged sync_status 를 보낸다', async () => {
    await runMorningSyncIfDue(false, NOW)
    // 선점 1회 + 부분 2회
    expect(syncStatusSends()).toBe(3)
  })

  it('A13: getDatabase 가 throw 해도 throw 하지 않는다', async () => {
    database.getDatabase.mockImplementation(() => {
      throw new Error('Database not initialized')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(runMorningSyncIfDue(false, NOW)).resolves.toBeUndefined()
    errSpy.mockRestore()
    expect(release.syncAllReleases).not.toHaveBeenCalled()
  })

  it('A13: 창 발송이 throw 해도 throw 하지 않는다', async () => {
    const broken = { isDestroyed: () => false, webContents: { send: () => { throw new Error('gone') } } }
    electron.windows.push(broken)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(runMorningSyncIfDue(false, NOW)).resolves.toBeUndefined()
    errSpy.mockRestore()
    electron.windows.pop()
    expect(payloadOf().project).toMatchObject({ status: 'ok' })
  })

  it('A54: 상태 조회는 마지막 행과 설정을 돌려준다. 행이 없으면 부분이 null 이다', async () => {
    expect(getMorningSyncStatus()).toEqual({
      enabled: true, at: '08:00', inFlight: false, date: null, release: null, project: null
    })
    await runMorningSyncIfDue(false, NOW)
    const s = getMorningSyncStatus()
    expect(s.date).toBe('2026-11-05')
    expect(s.release).toMatchObject({ status: 'ok', newCount: 1 })
    expect(s.project).toMatchObject({ status: 'ok', newCount: 2 })
  })

  it('A54: 실행 중이 아닌데 남은 running 은 상태 조회에서 failed 로 보여 준다', () => {
    store.rows.set(KEY, {
      id: 9, event_key: KEY, kind: 'morning_sync', plan_date: '2026-11-05',
      scheduled_at: '2026-11-05 08:00:00', fired_at: '2026-11-05 08:00:00', status: 'logged', ref_id: null,
      payload: JSON.stringify({
        date: '2026-11-05',
        release: { status: 'running', attempts: 1, startedAt: '2026-11-05 08:00:00', finishedAt: null },
        project: null
      })
    })
    expect(getMorningSyncStatus().release).toMatchObject({ status: 'failed', error: '동기화가 중단되었습니다.' })
  })
})

describe('R11 결과 변환 (toProjectOutcome)', () => {
  it('deferred 를 알아본다', () => {
    expect(toProjectOutcome({ status: 'deferred' }).status).toBe('deferred')
  })

  it('result 의 created·updated 와 needsReview 를 센다', () => {
    expect(toProjectOutcome({ status: 'applied', result: { created: 3, updated: 4 }, needsReview: 2 })).toMatchObject({
      status: 'ok', newCount: 3, updatedCount: 4, reviewCount: 2
    })
    expect(toProjectOutcome({ status: 'noop', result: null, needsReview: [{}, {}] })).toMatchObject({
      status: 'ok', newCount: 0, updatedCount: 0, reviewCount: 2
    })
  })

  it('형식이 틀린 값은 0 으로 센다', () => {
    expect(toProjectOutcome(null)).toMatchObject({ status: 'ok', newCount: 0 })
    expect(toProjectOutcome({ result: { created: -1, updated: 'x' } })).toMatchObject({ newCount: 0, updatedCount: 0 })
  })
})
