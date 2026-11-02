import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3 → node:sqlite 교체. 선례는 project-sync.test.ts 다.
// initDatabase() 의 실제 스키마(ASSISTANT_SCHEMA 포함)와 실제 저장소·순수 모듈로 흐름을 검증한다.
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  type Args = unknown[]

  class BetterSqlite3Shim {
    private readonly db: InstanceType<typeof DatabaseSync>

    constructor() {
      this.db = new DatabaseSync(':memory:')
    }

    pragma(statement: string): void {
      this.db.exec(`PRAGMA ${statement}`)
    }

    exec(sql: string): void {
      this.db.exec(sql)
    }

    prepare(sql: string): unknown {
      return this.db.prepare(sql)
    }

    transaction<T>(fn: (...args: Args) => T): (...args: Args) => T {
      return (...args: Args): T => {
        this.db.exec('BEGIN')
        try {
          const result = fn(...args)
          this.db.exec('COMMIT')
          return result
        } catch (e) {
          this.db.exec('ROLLBACK')
          throw e
        }
      }
    }

    close(): void {
      this.db.close()
    }
  }

  return { default: BetterSqlite3Shim }
})

const electron = vi.hoisted(() => ({ setLoginItemSettings: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/linkwork-test', setLoginItemSettings: electron.setLoginItemSettings, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('./google-calendar', () => ({ getTodayEvents: vi.fn(async () => []) }))

const headless = vi.hoisted(() => ({ isHeadlessAvailable: vi.fn(() => true), runHeadlessJson: vi.fn() }))
vi.mock('./ai-headless', () => headless)

// 수집 모듈은 네트워크를 쓰므로 픽스처로 답한다
const sources = vi.hoisted(() => ({ collectSources: vi.fn(), resolveVanished: vi.fn(async () => ({})) }))
vi.mock('./assistant-sources', () => sources)

const briefing = vi.hoisted(() => ({ requestLlmBriefing: vi.fn() }))
vi.mock('./assistant-briefing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assistant-briefing')>()
  return { ...actual, requestLlmBriefing: briefing.requestLlmBriefing }
})

import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import {
  acceptSuggestion,
  closeDay,
  focusItem,
  getToday,
  runRefresh,
  saveSettings,
  setAssistantChangedListener,
  setItemStatus,
  startDay,
  waitForAssistantBackground
} from './assistant-service'
import type { AssistantChangedEvent, CalendarRef, Candidate, TimelineEntry } from './assistant-types'

// 2026-11-02 는 월요일이다
const MON_0940 = new Date(2026, 10, 2, 9, 40, 0)
const MON_1100 = new Date(2026, 10, 2, 11, 0, 0)
const TUE_0930 = new Date(2026, 10, 3, 9, 30, 0)

function candidate(id: number, over: Partial<Candidate> = {}): Candidate {
  return {
    id: `todo:${id}`,
    source: 'todo',
    title: `할 일 ${id}`,
    jiraKey: null,
    projectId: null,
    projectName: null,
    dueDate: null,
    dueTime: null,
    inProgress: false,
    priority: 'medium',
    jiraPriority: null,
    lastTouchedAt: null,
    link: 'linkwork://view/todos',
    ...over
  }
}

function collected(candidates: Candidate[], calendar: CalendarRef[] = []): unknown {
  return {
    candidates,
    calendar,
    jira: null,
    busy: [],
    jiraTruncated: false,
    errors: [],
    jiraConnected: false,
    calendarConnected: true
  }
}

const changed: AssistantChangedEvent[] = []

beforeEach(() => {
  vi.clearAllMocks()
  initDatabase()
  changed.length = 0
  setAssistantChangedListener((e) => changed.push(e))
  headless.isHeadlessAvailable.mockReturnValue(true)
  sources.collectSources.mockResolvedValue(collected([candidate(1, { dueDate: '2026-11-02' }), candidate(2)]))
  sources.resolveVanished.mockResolvedValue({})
})

afterEach(async () => {
  await waitForAssistantBackground()
  setAssistantChangedListener(null)
  closeDatabase()
})

describe('startDay', () => {
  it('A8: LLM 브리핑이 실패해도 계획과 규칙 브리핑을 돌려주고 briefing_error 만 기록한다', async () => {
    briefing.requestLlmBriefing.mockResolvedValue({ ok: false, error: 'Claude Code 로그인이 필요합니다.' })

    const today = await startDay(MON_0940)
    expect(today.logicalDate).toBe('2026-11-02')
    expect(today.plan?.status).toBe('active')
    expect(today.plan?.briefing_source).toBe('rules')
    expect(today.plan?.briefing_text).toBeTruthy()
    expect(today.items.map((i) => i.candidate_id).sort()).toEqual(['todo:1', 'todo:2'])
    expect(today.items.every((i) => i.added_by === 'start' && i.status === 'planned')).toBe(true)
    expect(today.plan?.source_snapshot?.seenCandidateIds.sort()).toEqual(['todo:1', 'todo:2'])

    await waitForAssistantBackground()
    const after = await getToday(MON_0940)
    expect(after.plan?.briefing_source).toBe('rules')
    expect(after.plan?.briefing_error).toBe('Claude Code 로그인이 필요합니다.')
    expect(changed).toContainEqual({ date: '2026-11-02', reason: 'briefing' })
  })

  it('A8: LLM 호출이 reject 해도 startDay 는 계획을 돌려준다', async () => {
    briefing.requestLlmBriefing.mockRejectedValue(new Error('boom'))
    const today = await startDay(MON_0940)
    expect(today.plan).not.toBeNull()
    await waitForAssistantBackground()
    expect((await getToday(MON_0940)).plan?.briefing_error).toBe('boom')
  })

  it('A8: Claude CLI 가 없으면 LLM 을 부르지 않는다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    const today = await startDay(MON_0940)
    expect(today.plan?.briefing_source).toBe('rules')
    expect(briefing.requestLlmBriefing).not.toHaveBeenCalled()
  })

  it('LLM 이 성공하면 브리핑을 llm 으로 바꾼다', async () => {
    briefing.requestLlmBriefing.mockResolvedValue({ ok: true, markdown: '# 오늘', model: 'claude-sonnet-5-5' })
    await startDay(MON_0940)
    await waitForAssistantBackground()
    const after = await getToday(MON_0940)
    expect(after.plan?.briefing_source).toBe('llm')
    expect(after.plan?.briefing_text).toBe('# 오늘')
    expect(after.plan?.briefing_error).toBeNull()
  })

  it('동시에 두 번 눌러도 계획을 하나만 만든다', async () => {
    briefing.requestLlmBriefing.mockResolvedValue({ ok: false, error: 'x' })
    const [a, b] = await Promise.all([startDay(MON_0940), startDay(MON_0940)])
    expect(a.plan?.id).toBe(b.plan?.id)
    expect(sources.collectSources).toHaveBeenCalledTimes(1)
  })

  it('퇴근한 날은 다시 시작하지 않는다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    await startDay(MON_0940)
    await closeDay('정리 완료', MON_1100)
    await expect(startDay(MON_1100)).rejects.toThrow('다시 열기')
  })

  it('A18: 다음 날 시작하면 전날 계획을 자동으로 닫고 missingWrapupDate 를 채운다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    await startDay(MON_0940)
    const tue = await startDay(TUE_0930)
    expect(tue.logicalDate).toBe('2026-11-03')
    expect(tue.plan?.status).toBe('active')
    expect(tue.missingWrapupDate).toBe('2026-11-02')
  })
})

type Block = Extract<TimelineEntry, { kind: 'block' }>
function blocksOf(entries: TimelineEntry[]): Block[] {
  return entries.filter((e): e is Block => e.kind === 'block')
}

describe('timeline', () => {
  const lunch: CalendarRef = { id: 'e1', title: '점심 회의', start: '12:00', end: '13:00', allDay: false }

  it('계획이 없으면 빈 타임라인을 돌려준다', async () => {
    const today = await getToday(MON_0940)
    expect(today.plan).toBeNull()
    expect(today.timeline).toEqual({ entries: [], freeMinutesLeft: 0, focusItemId: null, unplacedDeadlineItemIds: [] })
  })

  it('A23: 모든 payload 가 스냅샷 일정과 started_at 으로 만든 타임라인을 갖는다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    sources.collectSources.mockResolvedValue(collected([candidate(1, { dueDate: '2026-11-02' }), candidate(2)], [lunch]))

    const started = await startDay(MON_0940)
    const entries = started.timeline.entries
    // 09:40 시작은 09:45 로 올린다. 09:40 은 첫 블록 전이므로 future 다. 블록은 근무 종료 18:00 까지다
    expect(entries[0]).toMatchObject({ kind: 'block', start: '09:45', end: '12:00', state: 'future' })
    expect(entries).toContainEqual({ kind: 'meeting', start: '12:00', end: '13:00', title: '점심 회의' })
    expect(entries[entries.length - 1]).toMatchObject({ kind: 'block', start: '13:00', end: '18:00' })
    // 작업에 시간을 붙이지 않는다. 새 항목의 슬롯은 비어 있다 (B.6)
    expect(started.items.every((i) => i.slot_start === null && i.slot_end === null && !i.pinned)).toBe(true)
    const first = [...started.items].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0]
    expect(started.timeline.focusItemId).toBe(first.id)
    expect(started.timeline.freeMinutesLeft).toBeGreaterThan(0)

    // 캘린더를 새로 조회하지 않는 getToday 도 스냅샷 일정으로 같은 타임라인을 만든다
    sources.collectSources.mockResolvedValue(collected([candidate(1, { dueDate: '2026-11-02' }), candidate(2)]))
    const later = await getToday(MON_1100)
    expect(later.timeline.entries).toContainEqual({ kind: 'meeting', start: '12:00', end: '13:00', title: '점심 회의' })
    expect(blocksOf(later.timeline.entries)[0]).toMatchObject({ start: '09:45', state: 'current' })
  })

  it('A23: 퇴근한 날은 모든 블록이 past 다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    await startDay(MON_0940)
    const closed = await closeDay(null, MON_1100)
    const blocks = blocksOf(closed.timeline.entries)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every((b) => b.state === 'past')).toBe(true)
  })

  it('A23: 날짜 경계 전 새벽에는 전날 블록이 모두 past 다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    await startDay(MON_0940)
    const dawn = await getToday(new Date(2026, 10, 3, 2, 30, 0))
    expect(dawn.logicalDate).toBe('2026-11-02')
    const blocks = blocksOf(dawn.timeline.entries)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every((b) => b.state === 'past')).toBe(true)
    expect(dawn.timeline.freeMinutesLeft).toBe(0)
  })
})

describe('focusItem', () => {
  it('B.4: 대상을 rank 1·in_progress 로 바꾸고 다른 활성 항목은 순서를 유지해 2부터 매긴다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    sources.collectSources.mockResolvedValue(
      collected([candidate(1, { dueDate: '2026-11-02' }), candidate(2), candidate(3)])
    )
    const started = await startDay(MON_0940)
    const byRank = [...started.items].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    const target = byRank[byRank.length - 1]
    expect(target.rank).not.toBe(1)

    const after = await focusItem(target.id, MON_1100)
    const focused = after.items.find((i) => i.id === target.id)
    expect(focused?.rank).toBe(1)
    expect(focused?.status).toBe('in_progress')
    expect(after.timeline.focusItemId).toBe(target.id)
    const others = byRank.filter((i) => i.id !== target.id).map((i) => after.items.find((x) => x.id === i.id)?.rank)
    expect(others).toEqual([2, 3])
  })

  it('활성이 아닌 항목은 집중 작업으로 정할 수 없다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    const started = await startDay(MON_0940)
    const item = started.items[0]
    await setItemStatus(item.id, 'done', null, MON_1100)
    await expect(focusItem(item.id, MON_1100)).rejects.toThrow('지금 집중')

    sources.collectSources.mockResolvedValue(
      collected([candidate(1, { dueDate: '2026-11-02' }), candidate(2), candidate(3)])
    )
    const refreshed = await runRefresh('local', MON_1100)
    const suggested = refreshed?.items.find((i) => i.status === 'suggested')
    expect(suggested).toBeDefined()
    await expect(focusItem(suggested!.id, MON_1100)).rejects.toThrow('지금 집중')
  })
})

describe('runRefresh', () => {
  it('근무 중이 아니면 null 이다', async () => {
    expect(await runRefresh('local', MON_0940)).toBeNull()
  })

  it('A19: 새 후보는 suggested 로 넣고 plan_update 를 logged 로 남긴다. 변화가 없으면 이벤트를 남기지 않는다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    await startDay(MON_0940)
    sources.collectSources.mockResolvedValue(
      collected([candidate(1, { dueDate: '2026-11-02' }), candidate(2), candidate(3)])
    )

    const r1 = await runRefresh('local', MON_1100)
    const suggested = r1?.items.filter((i) => i.status === 'suggested') ?? []
    expect(suggested.map((i) => i.candidate_id)).toEqual(['todo:3'])
    const updates = r1?.events.filter((e) => e.kind === 'plan_update') ?? []
    expect(updates).toHaveLength(1)
    expect(updates[0].status).toBe('logged')
    // local 최신화는 사라진 항목 확인에 네트워크를 쓰지 않는다
    for (const call of sources.resolveVanished.mock.calls as unknown[][]) {
      expect(call[3]).toEqual({ network: false })
    }
    expect(changed).toContainEqual({ date: '2026-11-02', reason: 'refresh' })

    // 스냅샷 takenAt 은 실제 로컬 시각이다 (A12)
    expect(r1?.plan?.source_snapshot?.takenAt).toBe('2026-11-02 11:00:00')

    const r2 = await runRefresh('local', new Date(2026, 10, 2, 11, 5, 0))
    expect(r2?.events.filter((e) => e.kind === 'plan_update')).toHaveLength(1)

    // 제안 수락 후 계획 항목이 된다
    const accepted = await acceptSuggestion(suggested[0].id, new Date(2026, 10, 2, 11, 10, 0))
    const item = accepted.items.find((i) => i.candidate_id === 'todo:3')
    expect(item?.status).toBe('planned')
    expect(item?.rank).not.toBeNull()
  })
})

describe('최신화와 사용자 쓰기 직렬화', () => {
  it('A15: 최신화가 resolveVanished 를 기다리는 사이 사용자가 바꾼 상태를 덮지 않는다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    const started = await startDay(MON_0940)
    const item2 = started.items.find((i) => i.candidate_id === 'todo:2')
    expect(item2).toBeDefined()

    // todo:2 가 후보에서 사라진다. 해석(dropped)은 사용자가 상태를 바꾼 뒤에 돌아온다
    sources.collectSources.mockResolvedValue(collected([candidate(1, { dueDate: '2026-11-02' })]))
    let release: (v: Record<string, unknown>) => void = () => undefined
    sources.resolveVanished.mockImplementation(
      () => new Promise((r) => (release = r as (v: Record<string, unknown>) => void))
    )

    const refreshing = runRefresh('local', MON_1100)
    await new Promise((r) => setTimeout(r, 0))
    const userWrite = setItemStatus(item2!.id, 'done', null, MON_1100)
    await new Promise((r) => setTimeout(r, 0))
    release({ 'todo:2': { kind: 'dropped', note: '삭제됨' } })

    await Promise.all([refreshing, userWrite])
    // 사용자 쓰기가 최신화 뒤에 실행되므로 사용자 결정이 남는다
    const final = await getToday(MON_1100)
    expect(final.items.find((i) => i.id === item2!.id)?.status).toBe('done')
  })
})

describe('runRefresh 날짜 경계', () => {
  it('A12: 날짜 경계 전 새벽 최신화는 스냅샷 takenAt 에 실제 날짜를 쓴다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    await startDay(new Date(2026, 10, 2, 23, 0, 0))
    const r = await runRefresh('local', new Date(2026, 10, 3, 2, 30, 0))
    expect(r?.logicalDate).toBe('2026-11-02')
    expect(r?.plan?.source_snapshot?.takenAt).toBe('2026-11-03 02:30:00')
  })
})

describe('saveSettings', () => {
  it('openAtLogin 이 바뀔 때만 setLoginItemSettings 를 부른다', () => {
    saveSettings({ openAtLogin: true })
    expect(electron.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
    electron.setLoginItemSettings.mockClear()
    saveSettings({ planSize: 4 })
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
    expect(getDatabase()).toBeTruthy()
  })
})
