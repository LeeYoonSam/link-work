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
const sources = vi.hoisted(() => ({
  collectSources: vi.fn(),
  collectRecovery: vi.fn(),
  resolveVanished: vi.fn(async () => ({})),
  getSourceCheckTimes: vi.fn(() => ({ calendarAt: null as number | null, jiraAt: null as number | null }))
}))
vi.mock('./assistant-sources', () => sources)

const briefing = vi.hoisted(() => ({ requestLlmBriefing: vi.fn(), requestLlmRecovery: vi.fn() }))
vi.mock('./assistant-briefing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assistant-briefing')>()
  return { ...actual, requestLlmBriefing: briefing.requestLlmBriefing, requestLlmRecovery: briefing.requestLlmRecovery }
})

import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import {
  acceptSuggestion,
  closeDay,
  focusItem,
  generateRecovery,
  getRecoveryState,
  getSourceCheckTimes,
  getToday,
  refreshBriefing,
  runAutoRefresh,
  runRefresh,
  saveSettings,
  setAssistantChangedListener,
  setItemStatus,
  startDay,
  waitForAssistantBackground
} from './assistant-service'
import { getPlanByDate } from './assistant-store'
import type {
  AssistantChangedEvent,
  CalendarRef,
  Candidate,
  PlanItem,
  RecoveryContext,
  RecoveryInput,
  TimelineEntry
} from './assistant-types'

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

function collected(
  candidates: Candidate[],
  calendar: CalendarRef[] | null = [],
  errors: string[] = [],
  calendarErrors: string[] = [],
  jiraTruncated = false
): unknown {
  // errors 인자는 Jira 오류로 둔다. 실제 수집처럼 캘린더 오류 다음 Jira 오류 순서로 합친다
  return {
    candidates,
    calendar,
    jira: null,
    busy: [],
    jiraTruncated,
    errors: [...calendarErrors, ...errors],
    calendarErrors,
    jiraErrors: errors,
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
  sources.collectRecovery.mockImplementation(async (_db: unknown, _s: unknown, ctx: RecoveryContext, lastItems: PlanItem[]) =>
    recoveryInput(ctx, lastItems)
  )
  briefing.requestLlmRecovery.mockResolvedValue({ ok: true, markdown: '# AI 복구', model: 'claude-sonnet-5-5' })
})

// 수집 결과 픽스처. 로컬 출처는 마지막 계획 항목만 채운다
function recoveryInput(ctx: RecoveryContext, lastItems: PlanItem[]): RecoveryInput {
  return {
    ctx,
    wrapupNote: null,
    unfinishedItems: lastItems.filter((i) => ['planned', 'in_progress', 'deferred'].includes(i.status)),
    activity: [],
    meetings: [],
    completedTodos: [],
    jira: null,
    jiraConnected: false,
    jiraTruncated: false,
    errors: []
  }
}

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

describe('runAutoRefresh (부록 E.3·E.6.5)', () => {
  const MON_1000 = new Date(2026, 10, 2, 10, 0, 0)
  const MON_1010 = new Date(2026, 10, 2, 10, 10, 0)
  const review: CalendarRef = { id: 'r1', title: '제품 리뷰', start: '14:00', end: '15:00', allDay: false }
  const sync: CalendarRef = { id: 's1', title: '주간 싱크', start: '16:00', end: '17:00', allDay: false }
  const base = (): Candidate[] => [candidate(1, { dueDate: '2026-11-02' }), candidate(2)]
  const urgent3 = (): Candidate => candidate(3, { dueDate: '2026-11-02' })

  async function start(): Promise<void> {
    headless.isHeadlessAvailable.mockReturnValue(false)
    await startDay(MON_0940)
    changed.length = 0
  }

  async function eventsOf(at: Date): Promise<{ notices: Awaited<ReturnType<typeof getToday>>['events']; records: Awaited<ReturnType<typeof getToday>>['events'] }> {
    const events = (await getToday(at)).events.filter((e) => e.kind === 'plan_update')
    return { notices: events.filter((e) => e.ref_id !== null), records: events.filter((e) => e.ref_id === null) }
  }

  it('근무 중이 아니면 null 이다', async () => {
    expect(await runAutoRefresh('calendar', MON_0940)).toBeNull()
  })

  it('A21: 긴급 제안은 urgent 알림 행을 sent 로 INSERT 하고 변경 기록 행과 분리한다', async () => {
    await start()
    sources.collectSources.mockResolvedValue(collected([...base(), urgent3()]))
    const out = await runAutoRefresh('calendar', MON_1100)

    expect(sources.collectSources).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'calendar', MON_1100)
    const u = out?.notices.find((n) => n.kind === 'urgent')
    expect(u).toMatchObject({
      eventKey: 'plan_update:2026-11-02:urgent:todo:3',
      refId: 'urgent:todo:3',
      title: '새로 들어온 일',
      body: '할 일 3 오늘 마감',
      focus: { kind: 'inbox' }
    })
    expect(typeof u?.eventId).toBe('number')

    const { notices, records } = await eventsOf(MON_1100)
    const row = notices.find((e) => e.ref_id === 'urgent:todo:3')
    expect(row).toMatchObject({ status: 'sent', scheduled_at: '2026-11-02 11:00:00', fired_at: '2026-11-02 11:00:00', id: u?.eventId })
    expect(JSON.parse(row!.payload!)).toEqual({ title: '새로 들어온 일', body: '할 일 3 오늘 마감', focus: { kind: 'inbox' } })
    // 변경 기록 행은 1개다. notified 에 INSERT 에 성공한 종류가 있다 (E.3.3)
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe('logged')
    expect(JSON.parse(records[0].payload!).notified).toContain('urgent')
    expect(changed).toContainEqual({ date: '2026-11-02', reason: 'refresh' })
  })

  it('A21: 지금 블록이 회의로 줄면 slot 알림을 만든다. 같은 30분 버킷의 두 번째 slot 은 INSERT 하지 않는다 (A5)', async () => {
    await start()
    sources.collectSources.mockResolvedValue(collected(base(), [review]))
    const first = await runAutoRefresh('calendar', MON_1000)
    const slot = first?.notices.find((n) => n.kind === 'slot')
    expect(slot).toMatchObject({ eventKey: 'plan_update:2026-11-02:1000', refId: '1000', title: '계획 변경', focus: { kind: 'timeline' } })
    expect(slot?.body.startsWith('14:00 제품 리뷰 추가 · ')).toBe(true)

    sources.collectSources.mockResolvedValue(collected(base(), [review, sync]))
    const second = await runAutoRefresh('calendar', MON_1010)
    expect(second?.notices.filter((n) => n.kind === 'slot')).toEqual([])

    const { notices, records } = await eventsOf(MON_1010)
    expect(notices.filter((e) => e.ref_id === '1000')).toHaveLength(1)
    expect(records).toHaveLength(2)
    expect(JSON.parse(records[0].payload!).notified).toEqual(['slot'])
    expect(JSON.parse(records[1].payload!).notified).toEqual([])
  })

  it('A21: refreshNotify 가 꺼져 있으면 알림 행을 만들지 않고 변경 기록만 남긴다', async () => {
    saveSettings({ refreshNotify: false })
    await start()
    sources.collectSources.mockResolvedValue(collected([...base(), urgent3()]))
    const out = await runAutoRefresh('calendar', MON_1100)
    expect(out?.notices).toEqual([])
    const { notices, records } = await eventsOf(MON_1100)
    expect(notices).toEqual([])
    expect(records).toHaveLength(1)
    expect(JSON.parse(records[0].payload!).notified).toEqual([])
  })

  it('A21: 회의 중이면 알림을 만들지 않는다. 회의 판정은 갱신 후 스냅샷 일정이다', async () => {
    await start()
    const now: CalendarRef = { id: 'm1', title: '진행 중 회의', start: '10:30', end: '11:30', allDay: false }
    sources.collectSources.mockResolvedValue(collected([...base(), urgent3()], [now]))
    const out = await runAutoRefresh('calendar', MON_1100)
    expect(out?.notices).toEqual([])
    expect((await eventsOf(MON_1100)).notices).toEqual([])
  })

  it('E.2.6: 변경이 없으면 assistant:changed 를 보내지 않고 기록도 남기지 않는다', async () => {
    await start()
    const out = await runAutoRefresh('calendar', MON_1100)
    expect(out?.notices).toEqual([])
    expect(out?.today.plan?.status).toBe('active')
    expect(changed).toEqual([])
    expect((await eventsOf(MON_1100)).records).toEqual([])
  })

  it('E.2.6: 수동 full 은 변경이 없어도 assistant:changed 를 보낸다', async () => {
    await start()
    await runRefresh('full', MON_1100)
    expect(changed).toEqual([{ date: '2026-11-02', reason: 'refresh' }])
  })

  it('E.2.7: runRefresh 는 알림 행을 만들지 않는다. 변경 기록의 notified 는 빈 배열이다', async () => {
    await start()
    sources.collectSources.mockResolvedValue(collected([...base(), urgent3()]))
    await runRefresh('full', MON_1100)
    const { notices, records } = await eventsOf(MON_1100)
    expect(notices).toEqual([])
    expect(records).toHaveLength(1)
    expect(JSON.parse(records[0].payload!).notified).toEqual([])
  })

  it("E.2.6: resolveVanished 의 network 는 'full'·'jira' 에서만 true 다", async () => {
    await start()
    // todo:2 가 사라져야 resolveVanished 가 대상 ID 를 받는다. 호출 자체는 mode 와 무관하다
    sources.collectSources.mockResolvedValue(collected([candidate(1, { dueDate: '2026-11-02' })], null))
    const cases: [Parameters<typeof runAutoRefresh>[0], boolean][] = [
      ['calendar', false],
      ['jira', true],
      ['full', true],
      ['local', false]
    ]
    for (const [mode, network] of cases) {
      sources.resolveVanished.mockClear()
      await runAutoRefresh(mode, MON_1100)
      expect((sources.resolveVanished.mock.calls as unknown[][])[0]?.[3]).toEqual({ network })
    }
  })

  it("E.2.6: lastCollected 는 'local' 이 아닌 mode 에서 갱신한다", async () => {
    await start()
    sources.collectSources.mockResolvedValue(collected(base(), null, ['Jira 조회에 실패했습니다.']))
    expect((await runAutoRefresh('jira', MON_1100))?.today.lastErrors).toEqual(['Jira 조회에 실패했습니다.'])

    sources.collectSources.mockResolvedValue(collected(base(), null, []))
    expect((await runRefresh('local', MON_1100))?.lastErrors).toEqual(['Jira 조회에 실패했습니다.'])

    expect((await runAutoRefresh('full', MON_1100))?.today.lastErrors).toEqual([])
  })

  it('jira 실패 뒤 calendar 틱이 와도 Jira 오류 문구가 남는다', async () => {
    await start()
    const JIRA_ERR = 'Jira 조회에 실패했습니다. 네트워크 오류'
    sources.collectSources.mockResolvedValue(collected(base(), null, [JIRA_ERR], [], true))
    await runAutoRefresh('jira', MON_1100)

    // calendar mode 는 Jira 를 보지 않는다. 캘린더 오류만 새 값으로 바꾼다
    const CAL_ERR = 'Google 캘린더 조회에 실패해 오늘 일정을 확인하지 못했습니다. 503'
    sources.collectSources.mockResolvedValue(collected(base(), null, [], [CAL_ERR], false))
    const out = await runAutoRefresh('calendar', MON_1100)
    expect(out?.today.lastErrors).toEqual([CAL_ERR, JIRA_ERR])
    expect(out?.today.jiraTruncated).toBe(true)

    // full 은 통째로 바꾼다
    sources.collectSources.mockResolvedValue(collected(base(), [], []))
    expect((await runRefresh('full', MON_1100))?.lastErrors).toEqual([])
  })

  it('calendar 실패 뒤 jira 틱이 와도 캘린더 오류 문구가 남는다', async () => {
    await start()
    const CAL_ERR = 'Google 캘린더가 연결되어 있지 않아 오늘 일정을 확인하지 못했습니다.'
    sources.collectSources.mockResolvedValue(collected(base(), null, [], [CAL_ERR]))
    await runAutoRefresh('calendar', MON_1100)

    // jira mode 가 성공해도 캘린더 오류는 이전 값을 유지한다
    sources.collectSources.mockResolvedValue(collected(base(), null, []))
    const out = await runAutoRefresh('jira', MON_1100)
    expect(out?.today.lastErrors).toEqual([CAL_ERR])

    // local 은 기준을 바꾸지 않는다
    sources.collectSources.mockResolvedValue(collected(base(), null, ['무시되는 문구']))
    expect((await runRefresh('local', MON_1100))?.lastErrors).toEqual([CAL_ERR])
  })

  it('getSourceCheckTimes 는 assistant-sources 에 위임한다', () => {
    sources.getSourceCheckTimes.mockReturnValue({ calendarAt: 5, jiraAt: 6 })
    expect(getSourceCheckTimes()).toEqual({ calendarAt: 5, jiraAt: 6 })
  })
})

// ── MVP3 맥락 복구 (부록 F) ──
// 2026-10-29 목, 2026-10-30 금, 2026-11-01 일, 2026-11-02 월, 2026-11-03 화
const THU_0930 = new Date(2026, 9, 29, 9, 30, 0)
const FRI_0930 = new Date(2026, 9, 30, 9, 30, 0)
const SUN_0930 = new Date(2026, 10, 1, 9, 30, 0)
const TUE_1000 = new Date(2026, 10, 3, 10, 0, 0)

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

// 이전 날 계획을 만들고 백그라운드를 비운다. LLM 은 끈다
async function startPrevDay(at: Date): Promise<void> {
  headless.isHeadlessAvailable.mockReturnValue(false)
  await startDay(at)
  await waitForAssistantBackground()
  vi.clearAllMocks()
  changed.length = 0
}

describe('맥락 복구 자동 트리거 (F.2)', () => {
  it('A29: 이전 계획이 없으면 자동 복구를 만들지 않는다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    const today = await startDay(MON_0940)
    expect(today.recovery).toEqual({ inFlight: false, error: null })
    await waitForAssistantBackground()
    expect(sources.collectRecovery).not.toHaveBeenCalled()
    expect(changed.some((e) => e.reason === 'recovery')).toBe(false)
  })

  it('A29: 공백 2일 이상이면 자동 복구를 시작하고 응답의 recovery.inFlight 가 true 다', async () => {
    await startPrevDay(FRI_0930)
    headless.isHeadlessAvailable.mockReturnValue(false)
    const tue = await startDay(TUE_1000)
    expect(tue.recovery).toEqual({ inFlight: true, error: null })
    // 규칙 본문은 백그라운드에서 저장한다
    expect(tue.plan?.recovery_text).toBeNull()

    await waitForAssistantBackground()
    expect(sources.collectRecovery).toHaveBeenCalledTimes(1)
    const [, , ctx, lastItems] = sources.collectRecovery.mock.calls[0] as [unknown, unknown, RecoveryContext, PlanItem[]]
    expect(ctx.today).toBe('2026-11-03')
    expect(ctx.lastPlan?.plan_date).toBe('2026-10-30')
    expect(ctx.gapDays).toBe(4)
    expect(lastItems).toHaveLength(2)

    const after = await getToday(TUE_1000)
    expect(after.recovery).toEqual({ inFlight: false, error: null })
    expect(after.plan?.recovery_source).toBe('rules')
    expect(after.plan?.recovery_text).toContain('맥락 복구')
    expect(after.plan?.recovery_at).toBe('2026-11-03 10:00:00')
    // LLM 이 꺼져 있으면 부르지 않는다
    expect(briefing.requestLlmRecovery).not.toHaveBeenCalled()
    expect(changed.filter((e) => e.reason === 'recovery')).toEqual([
      { date: '2026-11-03', reason: 'recovery' },
      { date: '2026-11-03', reason: 'recovery' }
    ])
  })

  it('A29: 공백 1일이어도 논리 날짜가 월요일이면 자동 복구를 시작한다', async () => {
    await startPrevDay(SUN_0930)
    headless.isHeadlessAvailable.mockReturnValue(false)
    await startDay(MON_0940)
    await waitForAssistantBackground()
    expect(sources.collectRecovery).toHaveBeenCalledTimes(1)
  })

  it('A29: 평일 공백 1일이면 자동 복구를 만들지 않는다', async () => {
    await startPrevDay(MON_0940)
    headless.isHeadlessAvailable.mockReturnValue(false)
    const tue = await startDay(TUE_1000)
    expect(tue.recovery.inFlight).toBe(false)
    await waitForAssistantBackground()
    expect(sources.collectRecovery).not.toHaveBeenCalled()
  })

  it('같은 날 startDay 를 다시 불러도 자동 복구를 다시 만들지 않는다', async () => {
    await startPrevDay(FRI_0930)
    headless.isHeadlessAvailable.mockReturnValue(false)
    await startDay(TUE_1000)
    await waitForAssistantBackground()
    await startDay(TUE_1000)
    await waitForAssistantBackground()
    expect(sources.collectRecovery).toHaveBeenCalledTimes(1)
  })
})

describe('맥락 복구 실패 규칙 (A30)', () => {
  it('A30: 복구 수집이 throw 해도 startDay 는 계획을 돌려주고 오류는 recovery.error 에만 남는다', async () => {
    await startPrevDay(THU_0930)
    headless.isHeadlessAvailable.mockReturnValue(false)
    sources.collectRecovery.mockRejectedValue(new Error('수집 폭발'))

    const mon = await startDay(MON_0940)
    expect(mon.plan?.status).toBe('active')
    expect(mon.recovery.inFlight).toBe(true)

    await waitForAssistantBackground()
    expect(getRecoveryState()).toEqual({ inFlight: false, error: '수집 폭발' })
    const after = await getToday(MON_0940)
    expect(after.plan?.recovery_text).toBeNull()
    expect(after.recovery).toEqual({ inFlight: false, error: '수집 폭발' })
    // 실패 뒤에도 화면이 다시 읽도록 알린다
    expect(changed).toContainEqual({ date: '2026-11-02', reason: 'recovery' })
  })

  it('A30: 규칙 본문을 LLM 호출 전에 저장한다. LLM 실패는 recovery.error 에만 남고 규칙 본문이 남는다', async () => {
    await startPrevDay(THU_0930)
    headless.isHeadlessAvailable.mockReturnValue(true)
    briefing.requestLlmBriefing.mockResolvedValue({ ok: false, error: 'x' })
    let seenAtLlm: { source: string | null; text: string | null } | null = null
    let recoveryEventsAtLlm = 0
    briefing.requestLlmRecovery.mockImplementation(async () => {
      const p = getPlanByDate(getDatabase(), '2026-11-02')
      seenAtLlm = { source: p?.recovery_source ?? null, text: p?.recovery_text ?? null }
      recoveryEventsAtLlm = changed.filter((e) => e.reason === 'recovery').length
      return { ok: false, error: 'Claude Code 로그인이 필요합니다.' }
    })

    await startDay(MON_0940)
    await waitForAssistantBackground()

    expect(seenAtLlm).not.toBeNull()
    expect(seenAtLlm!.source).toBe('rules')
    expect(seenAtLlm!.text).toContain('맥락 복구')
    // 규칙 저장 알림이 LLM 전에 나간다
    expect(recoveryEventsAtLlm).toBe(1)

    const after = await getToday(MON_0940)
    expect(after.plan?.recovery_source).toBe('rules')
    expect(after.plan?.recovery_text).toBe(seenAtLlm!.text)
    expect(after.recovery).toEqual({ inFlight: false, error: 'Claude Code 로그인이 필요합니다.' })
  })

  it('A30: LLM 호출이 reject 해도 job 이 오류를 잡는다', async () => {
    await startPrevDay(THU_0930)
    headless.isHeadlessAvailable.mockReturnValue(true)
    briefing.requestLlmBriefing.mockResolvedValue({ ok: false, error: 'x' })
    briefing.requestLlmRecovery.mockRejectedValue(new Error('boom'))
    await expect(startDay(MON_0940)).resolves.toBeTruthy()
    await waitForAssistantBackground()
    const after = await getToday(MON_0940)
    expect(after.plan?.recovery_source).toBe('rules')
    expect(after.recovery.error).toBe('boom')
  })

  it('LLM 이 성공하면 복구 본문을 llm 으로 바꾼다', async () => {
    await startPrevDay(THU_0930)
    headless.isHeadlessAvailable.mockReturnValue(true)
    briefing.requestLlmBriefing.mockResolvedValue({ ok: false, error: 'x' })
    await startDay(MON_0940)
    await waitForAssistantBackground()
    const after = await getToday(MON_0940)
    expect(after.plan?.recovery_source).toBe('llm')
    expect(after.plan?.recovery_text).toBe('# AI 복구')
    expect(after.recovery).toEqual({ inFlight: false, error: null })
  })
})

describe('LLM 직렬화 (A32)', () => {
  // 실행 구간을 기록한다. 겹치면 ai-headless 잠금처럼 BUSY 로 실패한다
  function trackLlm(log: string[]): { active: () => number } {
    let active = 0
    const run = async <T>(name: string, ok: T): Promise<T | { ok: false; error: string }> => {
      if (active > 0) {
        log.push(`${name}:busy`)
        return { ok: false, error: 'BUSY' }
      }
      active++
      log.push(`${name}:start`)
      await new Promise((r) => setTimeout(r, 5))
      log.push(`${name}:end`)
      active--
      return ok
    }
    briefing.requestLlmBriefing.mockImplementation(() =>
      run('briefing', { ok: true, markdown: '# AI 브리핑', model: 'claude-sonnet-5-5' })
    )
    briefing.requestLlmRecovery.mockImplementation(() =>
      run('recovery', { ok: true, markdown: '# AI 복구', model: 'claude-sonnet-5-5' })
    )
    return { active: () => active }
  }

  it('A32: 하루 시작 때 브리핑 LLM 다음 복구 LLM 이 순서대로 실행되고 겹치지 않는다', async () => {
    await startPrevDay(THU_0930)
    headless.isHeadlessAvailable.mockReturnValue(true)
    const log: string[] = []
    trackLlm(log)

    await startDay(MON_0940)
    await waitForAssistantBackground()

    expect(log).toEqual(['briefing:start', 'briefing:end', 'recovery:start', 'recovery:end'])
    const after = await getToday(MON_0940)
    expect(after.plan?.briefing_source).toBe('llm')
    expect(after.plan?.recovery_source).toBe('llm')
    expect(after.recovery.error).toBeNull()
  })

  it('A32: 수동 브리핑 다시 만들기와 수동 맥락 복구도 같은 줄을 거친다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    await startDay(MON_0940)
    await waitForAssistantBackground()
    headless.isHeadlessAvailable.mockReturnValue(true)
    const log: string[] = []
    trackLlm(log)

    await Promise.all([refreshBriefing(MON_1100), generateRecovery(MON_1100)])
    expect(log).toEqual(['briefing:start', 'briefing:end', 'recovery:start', 'recovery:end'])
  })
})

describe('LLM 줄의 reject 처리 (A32)', () => {
  it('A32: 앞 LLM 작업이 reject 해도 줄에서 기다리던 다음 작업은 실행되고 결과가 저장된다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    await startDay(MON_0940)
    await waitForAssistantBackground()
    headless.isHeadlessAvailable.mockReturnValue(true)

    // 복구 LLM 은 잠시 뒤 reject 한다. 그 사이 브리핑 LLM 이 줄 뒤에 선다
    const order: string[] = []
    briefing.requestLlmRecovery.mockImplementation(async () => {
      order.push('recovery:start')
      await new Promise((r) => setTimeout(r, 5))
      order.push('recovery:reject')
      throw new Error('복구 LLM 폭발')
    })
    briefing.requestLlmBriefing.mockImplementation(async () => {
      order.push('briefing:start')
      return { ok: true, markdown: '# 다시 만든 브리핑', model: 'claude-sonnet-5-5' }
    })

    const manual = generateRecovery(MON_1100)
    while (briefing.requestLlmRecovery.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 1))
    const refreshed = refreshBriefing(MON_1100)
    const [rec, brief] = await Promise.all([manual, refreshed])

    expect(order).toEqual(['recovery:start', 'recovery:reject', 'briefing:start'])
    expect(rec.recovery).toEqual({ inFlight: false, error: '복구 LLM 폭발' })
    expect(rec.plan?.recovery_source).toBe('rules')
    expect(brief.plan?.briefing_source).toBe('llm')
    expect(brief.plan?.briefing_text).toBe('# 다시 만든 브리핑')
  })
})

describe('수동 맥락 복구 generateRecovery (F.2)', () => {
  it('오늘 계획이 없으면 실패한다', async () => {
    await expect(generateRecovery(MON_0940)).rejects.toThrow('오늘 계획이 없습니다')
    expect(sources.collectRecovery).not.toHaveBeenCalled()
  })

  it('조건과 무관하게 만들고 규칙 저장과 LLM 완료까지 기다린다. 이전 계획이 없으면 lastPlan 이 null 이다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    await startDay(MON_0940)
    await waitForAssistantBackground()
    headless.isHeadlessAvailable.mockReturnValue(true)

    const r = await generateRecovery(MON_1100)
    expect(sources.collectRecovery).toHaveBeenCalledTimes(1)
    const ctx = (sources.collectRecovery.mock.calls[0] as unknown[])[2] as RecoveryContext
    expect(ctx.lastPlan).toBeNull()
    expect(r.plan?.recovery_source).toBe('llm')
    expect(r.plan?.recovery_text).toBe('# AI 복구')
    expect(r.plan?.recovery_at).toBe('2026-11-02 11:00:00')
    expect(r.recovery).toEqual({ inFlight: false, error: null })
  })

  it('진행 중인 자동 job 이 있으면 새 job 을 만들지 않고 그것을 기다린다', async () => {
    await startPrevDay(THU_0930)
    headless.isHeadlessAvailable.mockReturnValue(false)
    const gate = deferred<RecoveryInput>()
    sources.collectRecovery.mockImplementation(async (_d: unknown, _s: unknown, ctx: RecoveryContext, items: PlanItem[]) => {
      await gate.promise
      return recoveryInput(ctx, items)
    })

    const mon = await startDay(MON_0940)
    expect(mon.recovery.inFlight).toBe(true)
    expect(getRecoveryState().inFlight).toBe(true)

    let done = false
    const manual = generateRecovery(MON_1100).then((p) => {
      done = true
      return p
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(done).toBe(false)

    gate.resolve(undefined as unknown as RecoveryInput)
    const r = await manual
    expect(sources.collectRecovery).toHaveBeenCalledTimes(1)
    expect(r.plan?.recovery_source).toBe('rules')
    expect(r.recovery).toEqual({ inFlight: false, error: null })
  })

  it('하루를 닫은 뒤에도 다시 만들 수 있다 (F.12)', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    await startDay(MON_0940)
    await closeDay(null, MON_1100)
    const r = await generateRecovery(MON_1100)
    expect(r.plan?.status).toBe('closed')
    expect(r.plan?.recovery_source).toBe('rules')
  })

  it('payload.recovery 는 다른 날짜의 상태를 보이지 않는다', async () => {
    await startPrevDay(THU_0930)
    headless.isHeadlessAvailable.mockReturnValue(false)
    sources.collectRecovery.mockRejectedValue(new Error('수집 폭발'))
    await startDay(MON_0940)
    await waitForAssistantBackground()
    expect((await getToday(MON_0940)).recovery.error).toBe('수집 폭발')
    expect((await getToday(TUE_1000)).recovery).toEqual({ inFlight: false, error: null })
  })
})
