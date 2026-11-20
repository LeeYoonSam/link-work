import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  Tray: class {},
  BrowserWindow: class {},
  nativeImage: {},
  screen: {},
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  app: {}
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

const db = vi.hoisted(() => ({ all: vi.fn((): unknown[] => []) }))
vi.mock('../db/database', () => ({
  getDatabase: () => ({ prepare: () => ({ all: db.all }) })
}))

const calendar = vi.hoisted(() => ({ getTodayEvents: vi.fn(async (): Promise<unknown[]> => []) }))
vi.mock('./google-calendar', () => calendar)

// 오늘 계획 요약(assistant-service.getToday)은 더 부르지 않는다. 불리면 테스트가 실패하도록 둔다
const service = vi.hoisted(() => ({ getToday: vi.fn(() => Promise.reject(new Error('must not be called'))) }))
vi.mock('./assistant-service', () => service)
vi.mock('./assistant-scheduler', () => ({ navigateToToday: vi.fn() }))

import { getTrayData } from './tray-widget'

describe('트레이 데이터', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.all.mockReturnValue([])
  })

  it('assistant 필드 없이 일정만 돌려준다', async () => {
    calendar.getTodayEvents.mockResolvedValue([
      { id: 'a', summary: '스크럼', start: '2026-11-19T10:00:00', end: '2026-11-19T10:15:00', allDay: false },
      { id: 'b', summary: '[QA] Release Train', start: '2026-11-19', end: '2026-11-24', allDay: true }
    ])
    const data = await getTrayData()
    expect(Object.keys(data)).toEqual(['events'])
    expect('assistant' in data).toBe(false)
    expect(data.events.map((e) => e.summary)).toEqual(['[QA] Release Train', '스크럼'])
    expect(service.getToday).not.toHaveBeenCalled()
  })
})
