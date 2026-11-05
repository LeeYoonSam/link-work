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

    // better-sqlite3 처럼 중첩 호출은 SAVEPOINT 로 처리한다. 트랜잭션 안에서 다른 트랜잭션 함수를 부를 수 있다
    private depth = 0

    transaction<T>(fn: (...args: Args) => T): (...args: Args) => T {
      return (...args: Args): T => {
        const sp = this.depth > 0 ? `sp${this.depth}` : null
        this.db.exec(sp ? `SAVEPOINT ${sp}` : 'BEGIN')
        this.depth++
        try {
          const result = fn(...args)
          this.depth--
          this.db.exec(sp ? `RELEASE ${sp}` : 'COMMIT')
          return result
        } catch (e) {
          this.depth--
          this.db.exec(sp ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK')
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

// 회의 브리핑이 읽는 5분 캐시다 (I.3.1). 테스트가 일정을 넣는다
const calendar = vi.hoisted(() => ({ getTodayEvents: vi.fn(async (): Promise<unknown[]> => []) }))
vi.mock('./google-calendar', () => calendar)

const headless = vi.hoisted(() => ({ isHeadlessAvailable: vi.fn(() => true), runHeadlessJson: vi.fn() }))
vi.mock('./ai-headless', () => headless)

// 수집 모듈은 네트워크를 쓰므로 픽스처로 답한다
const sources = vi.hoisted(() => ({
  collectSources: vi.fn(),
  collectRecovery: vi.fn(),
  resolveVanished: vi.fn(async () => ({})),
  getSourceCheckTimes: vi.fn(() => ({ calendarAt: null as number | null, jiraAt: null as number | null })),
  // 회의 브리핑 (부록 I.5). 변환·수집 규칙은 assistant-sources.test.ts 가 검증한다
  toMeetingRef: vi.fn(),
  collectMeetingContext: vi.fn()
}))
vi.mock('./assistant-sources', () => sources)

const briefing = vi.hoisted(() => ({
  requestLlmBriefing: vi.fn(),
  requestLlmRecovery: vi.fn(),
  requestLlmMeetingBriefing: vi.fn()
}))
vi.mock('./assistant-briefing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assistant-briefing')>()
  return {
    ...actual,
    requestLlmBriefing: briefing.requestLlmBriefing,
    requestLlmRecovery: briefing.requestLlmRecovery,
    requestLlmMeetingBriefing: briefing.requestLlmMeetingBriefing
  }
})

// 명령 LLM 은 픽스처로 답한다. assistant-command.ts 는 실제 구현을 쓴다 (G.11.5)
const commandLlm = vi.hoisted(() => ({ requestLlmCommand: vi.fn() }))
vi.mock('./assistant-command-llm', () => commandLlm)

// 회의 브리핑 판정은 실제 구현을 쓴다. UNIQUE 충돌 테스트만 결과를 고정한다 (부록 I)
const schedule = vi.hoisted(() => ({ computeDueMeetingBriefings: vi.fn() }))
vi.mock('./assistant-schedule', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assistant-schedule')>()
  schedule.computeDueMeetingBriefings.mockImplementation(actual.computeDueMeetingBriefings)
  return {
    ...actual,
    computeDueMeetingBriefings: schedule.computeDueMeetingBriefings
  }
})

import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import {
  acceptSuggestion,
  addItem,
  applyCommand,
  closeDay,
  dismissSuggestion,
  focusItem,
  generateRecovery,
  getRecoveryState,
  getSourceCheckTimes,
  getToday,
  interpretCommand,
  refreshBriefing,
  regenerateMeetingBriefing,
  runAutoRefresh,
  runDueMeetingBriefings,
  runRefresh,
  saveSettings,
  setAssistantChangedListener,
  setItemStatus,
  startDay,
  waitForAssistantBackground
} from './assistant-service'
import { getEventById, getPlanByDate, getPlanItem, insertEvent, listPlanItems } from './assistant-store'
import type {
  AssistantChangedEvent,
  CalendarRef,
  Candidate,
  CommandOp,
  DueMeetingBriefing,
  MeetingBriefingPayload,
  MeetingContext,
  MeetingRef,
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
    link: `linkwork://todo/${id}`,
    parentKey: null,
    groupName: null,
    workType: 'etc',
    workVersion: null,
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

describe('A49: 묶음 항목 (부록 J.4)', () => {
  const epic = (): Candidate =>
    candidate(8054, {
      id: 'jira:ICA-8054', source: 'jira', jiraKey: 'ICA-8054', title: '안드로이드QA-2026',
      priority: 'high', jiraPriority: 'Highest', workType: 'qa', link: null
    })
  const child = (): Candidate =>
    candidate(8971, {
      id: 'jira:ICA-8971', source: 'jira', jiraKey: 'ICA-8971', title: '안드로이드 구매자 앱 v4.174.0 QA',
      parentKey: 'ICA-8054', groupName: '안드로이드QA-2026', workType: 'qa', workVersion: '4.174.0', link: null
    })

  it('A49: 하루 시작은 묶음 후보를 빼고, 직접 넣은 묶음 항목은 rank null 이며 집중할 수 없다', async () => {
    headless.isHeadlessAvailable.mockReturnValue(false)
    sources.collectSources.mockResolvedValue(collected([epic(), child(), candidate(1)]))
    const started = await startDay(MON_0940)
    expect(started.items.map((i) => i.candidate_id).sort()).toEqual(['jira:ICA-8971', 'todo:1'])
    const kid = started.items.find((i) => i.candidate_id === 'jira:ICA-8971')
    expect(kid).toMatchObject({ work_type: 'qa', work_version: '4.174.0', parent_key: 'ICA-8054', group_name: '안드로이드QA-2026' })

    // 후보 더 보기로 에픽을 직접 넣을 수 있다 (J.4-7). 넣으면 rank null 이다
    const added = await addItem('jira:ICA-8054', MON_1100)
    const group = added.items.find((i) => i.candidate_id === 'jira:ICA-8054')
    expect(group).toMatchObject({ status: 'planned', rank: null, work_type: 'qa' })
    expect(added.timeline.focusItemId).not.toBe(group!.id)
    await expect(focusItem(group!.id, MON_1100)).rejects.toThrow('묶음 항목은 집중 작업이 될 수 없어요.')
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

describe('명령 입력 (부록 G)', () => {
  const MON_1105 = new Date(2026, 10, 2, 11, 5, 0)
  const keyed = (): Candidate[] => [
    candidate(1, { jiraKey: 'PROJ-1', dueDate: '2026-11-02' }),
    candidate(2, { jiraKey: 'PROJ-2' })
  ]

  // LLM 없이 하루를 시작한다. 명령 테스트는 그 뒤 헤드리스 가용 여부를 정한다
  async function startKeyed(): Promise<PlanItem[]> {
    headless.isHeadlessAvailable.mockReturnValue(false)
    sources.collectSources.mockResolvedValue(collected(keyed()))
    const started = await startDay(MON_0940)
    return started.items
  }

  function itemOf(items: PlanItem[], candidateId: string): PlanItem {
    const found = items.find((i) => i.candidate_id === candidateId)
    if (!found) throw new Error(`no item ${candidateId}`)
    return found
  }

  function countRows(table: string): number {
    return (getDatabase().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  }

  function planItemsNow(): PlanItem[] {
    const plan = getPlanByDate(getDatabase(), '2026-11-02')
    return plan ? listPlanItems(getDatabase(), plan.id) : []
  }

  it('A34: interpretCommand 는 plan_items·assistant_events·daily_plans 를 쓰지 않는다', async () => {
    await startKeyed()
    const beforeItems = planItemsNow()
    const beforeEvents = countRows('assistant_events')
    const beforePlan = getPlanByDate(getDatabase(), '2026-11-02')

    const r = await interpretCommand('PROJ-1 끝났어', undefined, MON_1100)
    expect(r.source).toBe('rules')
    expect(r.ops).toHaveLength(1)
    expect(r.ops[0].op).toMatchObject({ kind: 'set_status', status: 'done' })
    expect(r.ops[0].executable).toBe(true)

    expect(planItemsNow()).toEqual(beforeItems)
    expect(countRows('assistant_events')).toBe(beforeEvents)
    expect(getPlanByDate(getDatabase(), '2026-11-02')).toEqual(beforePlan)
  })

  it('A34·A40: unsupported 조작은 적용에서 실행하지 않고 ok:false 로 남긴다', async () => {
    const items = await startKeyed()
    const before = planItemsNow()
    const out = await applyCommand(
      [{ kind: 'unsupported', reason: '캘린더에서 바꿔 주세요.' }],
      '3시 회의 취소됐어',
      MON_1100
    )
    expect(out.results).toEqual([
      {
        op: { kind: 'unsupported', reason: '캘린더에서 바꿔 주세요.' },
        label: '지원하지 않음: 캘린더에서 바꿔 주세요.',
        ok: false,
        error: '지원하지 않는 조작입니다.'
      }
    ])
    expect(out.applied).toBe(0)
    expect(out.failed).toBe(1)
    expect(planItemsNow()).toEqual(before)
    expect(items.length).toBeGreaterThan(0)
  })

  it('A36: LLM 이 실패하면 규칙 해석으로 폴백하고 source rules 와 error 를 돌려준다', async () => {
    await startKeyed()
    headless.isHeadlessAvailable.mockReturnValue(true)
    commandLlm.requestLlmCommand.mockResolvedValue({ ok: false, error: '명령 해석 시간이 초과했습니다.' })

    const r = await interpretCommand('  PROJ-1   끝났어 ', undefined, MON_1100)
    expect(commandLlm.requestLlmCommand).toHaveBeenCalledTimes(1)
    const [input, model] = commandLlm.requestLlmCommand.mock.calls[0] as [{ text: string; ctx: { items: unknown[] } }, string]
    expect(input.text).toBe('PROJ-1 끝났어')
    expect(input.ctx.items).toHaveLength(2)
    expect(model).toBe('sonnet')
    expect(r.text).toBe('PROJ-1 끝났어')
    expect(r.source).toBe('rules')
    expect(r.error).toBe('명령 해석 시간이 초과했습니다.')
    expect(r.ops[0].op).toMatchObject({ kind: 'set_status', status: 'done' })
  })

  it('A36: llmEnabled 가 false 면 requestLlmCommand 를 부르지 않는다. error 는 null 이다', async () => {
    await startKeyed()
    saveSettings({ llmEnabled: false })
    headless.isHeadlessAvailable.mockReturnValue(true)

    const r = await interpretCommand('PROJ-2 내일 할게', undefined, MON_1100)
    expect(commandLlm.requestLlmCommand).not.toHaveBeenCalled()
    expect(r.source).toBe('rules')
    expect(r.error).toBeNull()
    expect(r.ops[0].op).toMatchObject({ kind: 'set_status', status: 'deferred' })
  })

  it('A35·A36: LLM 출력은 normalizeCommandOps 를 거친다. 계획에 없는 itemId 는 dropped 로 센다', async () => {
    const items = await startKeyed()
    const item2 = itemOf(items, 'todo:2')
    headless.isHeadlessAvailable.mockReturnValue(true)
    commandLlm.requestLlmCommand.mockResolvedValue({
      ok: true,
      model: 'claude-sonnet-5-5',
      raw: [
        { kind: 'set_status', itemId: 99999, status: 'done', note: null },
        { kind: 'focus', itemId: item2.id },
        { kind: 'focus', itemId: String(item2.id) }
      ]
    })

    const r = await interpretCommand('결제 작업에 집중할래', undefined, MON_1100)
    expect(r.source).toBe('llm')
    expect(r.error).toBeNull()
    expect(r.ops.map((o) => o.op)).toEqual([{ kind: 'focus', itemId: item2.id }])
    expect(r.dropped).toBe(2)
  })

  it('A32·A36: 명령 LLM 은 llmSerialized 줄에서 앞 브리핑 LLM 이 끝난 뒤 실행된다', async () => {
    await startKeyed()
    headless.isHeadlessAvailable.mockReturnValue(true)
    let release: (v: unknown) => void = () => undefined
    briefing.requestLlmBriefing.mockImplementation(() => new Promise((r) => (release = r)))
    commandLlm.requestLlmCommand.mockResolvedValue({ ok: true, model: 'm', raw: [] })

    const briefingRun = refreshBriefing(MON_1100)
    const interpreting = interpretCommand('PROJ-1 끝났어', undefined, MON_1100)
    await new Promise((r) => setTimeout(r, 0))
    expect(commandLlm.requestLlmCommand).not.toHaveBeenCalled()

    release({ ok: false, error: 'x' })
    await briefingRun
    const r = await interpreting
    expect(commandLlm.requestLlmCommand).toHaveBeenCalledTimes(1)
    expect(r.source).toBe('llm')
    expect(r.ops).toEqual([])
  })

  it('scope 모드는 범위 항목 1개만 규칙 답장 해석으로 다룬다', async () => {
    const items = await startKeyed()
    const item1 = itemOf(items, 'todo:1')
    const r = await interpretCommand('반쯤 했어', item1.id, MON_1100)
    expect(r.scopeItemId).toBe(item1.id)
    expect(r.ops.map((o) => o.op)).toEqual([
      { kind: 'set_status', itemId: item1.id, status: 'in_progress', note: '반쯤 했어' }
    ])
    expect(sources.collectSources).toHaveBeenCalledTimes(1)
  })

  it('입력 검증: 빈 문장·잘못된 scopeItemId·근무 중이 아님은 throw 한다', async () => {
    await expect(interpretCommand('PROJ-1 끝', undefined, MON_1100)).rejects.toThrow('근무 중')
    await startKeyed()
    await expect(interpretCommand('   ', undefined, MON_1100)).rejects.toThrow()
    await expect(interpretCommand('x'.repeat(501), undefined, MON_1100)).rejects.toThrow()
    await expect(interpretCommand('완료', 0, MON_1100)).rejects.toThrow('범위 항목')
    await expect(interpretCommand('완료', '3', MON_1100)).rejects.toThrow('범위 항목')
    await expect(interpretCommand('완료', 99999, MON_1100)).rejects.toThrow('오늘 계획의 항목')
  })

  it('applyCommand 는 형식이 틀리거나 10개를 넘는 ops 를 거부한다', async () => {
    const items = await startKeyed()
    const id = itemOf(items, 'todo:1').id
    await expect(applyCommand([{ kind: 'set_status', itemId: String(id), status: 'done', note: null }], '끝', MON_1100))
      .rejects.toThrow('조작 형식')
    const many: CommandOp[] = Array.from({ length: 11 }, () => ({ kind: 'focus', itemId: id }))
    await expect(applyCommand(many, '많이', MON_1100)).rejects.toThrow('조작 형식')
    await expect(applyCommand('nope', '끝', MON_1100)).rejects.toThrow('조작 형식')
    expect(countRows('assistant_events')).toBe(0)
  })

  it('A35: 해석 뒤 바뀌거나 계획에 없는 항목의 조작은 적용에서 실패로 기록한다', async () => {
    await startKeyed()
    sources.collectSources.mockResolvedValue(collected([...keyed(), candidate(3, { jiraKey: 'PROJ-3' })]))
    const refreshed = await runRefresh('local', MON_1100)
    const suggested = itemOf(refreshed?.items ?? [], 'todo:3')
    expect(suggested.status).toBe('suggested')

    const interp = await interpretCommand('PROJ-3 넣어줘', undefined, MON_1100)
    expect(interp.ops.map((o) => o.op)).toEqual([{ kind: 'accept_suggestion', itemId: suggested.id }])

    // 해석과 적용 사이에 사용자가 제안을 무시한다
    await dismissSuggestion(suggested.id, MON_1105)
    const ops: CommandOp[] = [...interp.ops.map((o) => o.op), { kind: 'set_status', itemId: 99999, status: 'done', note: null }]
    const out = await applyCommand(ops, interp.text, MON_1105)
    expect(out.results.map((r) => [r.ok, r.error])).toEqual([
      [false, '제안 항목이 아닙니다.'],
      [false, '오늘 계획의 항목이 아닙니다.']
    ])
    expect(out.applied).toBe(0)
    expect(out.failed).toBe(2)
    expect(out.today.items.find((i) => i.id === suggested.id)?.status).toBe('dismissed')
  })

  it("A37: add_manual 은 plan_items 에 source='manual' 1행만 넣고 todos·tasks 행 수는 그대로다", async () => {
    await startKeyed()
    const plan = getPlanByDate(getDatabase(), '2026-11-02')!
    const todosBefore = countRows('todos')
    const tasksBefore = countRows('tasks')
    const itemsBefore = planItemsNow().length

    const out = await applyCommand(
      [{ kind: 'add_manual', title: '  견적서   보내기 ', dueDate: '2026-11-03' }],
      '내일까지 견적서 보내기 추가',
      MON_1100
    )
    expect(out.results).toHaveLength(1)
    expect(out.results[0]).toMatchObject({ ok: true, error: null, label: "'견적서 보내기' 임시 항목으로 추가 · 마감 2026-11-03" })
    const manual = out.today.items.filter((i) => i.source === 'manual')
    expect(manual).toHaveLength(1)
    expect(manual[0]).toMatchObject({
      candidate_id: `manual:${plan.id}:1`,
      title: '견적서 보내기',
      link: null,
      jira_issue_key: null,
      project_id: null,
      due_date: '2026-11-03',
      added_by: 'user',
      status: 'planned'
    })
    // 삽입 뒤 applyRerank 가 rank 를 매긴다
    expect(manual[0].rank).not.toBeNull()
    expect(planItemsNow()).toHaveLength(itemsBefore + 1)
    expect(countRows('todos')).toBe(todosBefore)
    expect(countRows('tasks')).toBe(tasksBefore)

    const again = await applyCommand([{ kind: 'add_manual', title: '회의록 정리', dueDate: null }], '회의록 정리 추가', MON_1105)
    expect(again.today.items.filter((i) => i.source === 'manual').map((i) => i.candidate_id).sort()).toEqual([
      `manual:${plan.id}:1`,
      `manual:${plan.id}:2`
    ])
  })

  it('A37·G.3.3: 적용은 공백 정리 뒤 길이 상한을 다시 적용한다. 120자 초과 제목은 실패, note 는 200자로 자른다', async () => {
    const items = await startKeyed()
    const item1 = itemOf(items, 'todo:1')
    const itemsBefore = planItemsNow().length

    const out = await applyCommand(
      [
        { kind: 'add_manual', title: '가'.repeat(121), dueDate: null },
        { kind: 'add_manual', title: `  ${'나'.repeat(60)}     ${'다'.repeat(59)}  `, dueDate: null },
        { kind: 'set_status', itemId: item1.id, status: 'in_progress', note: `  ${'메'.repeat(250)}  ` }
      ],
      '긴 항목 추가',
      MON_1100
    )
    expect(out.results.map((r) => r.ok)).toEqual([false, true, true])
    expect(out.results[0].error).toContain('120자')
    // 공백 정리 뒤 120자인 제목은 들어간다
    const manual = out.today.items.filter((i) => i.source === 'manual')
    expect(manual.map((i) => i.title)).toEqual([`${'나'.repeat(60)} ${'다'.repeat(59)}`])
    expect(planItemsNow()).toHaveLength(itemsBefore + 1)
    expect(out.today.items.find((i) => i.id === item1.id)?.status_note).toBe('메'.repeat(200))
  })

  it('A39: 2번째 조작이 실패해도 3번째 조작을 실행한다. 공개 함수 줄에서 교착하지 않는다', async () => {
    const items = await startKeyed()
    const item1 = itemOf(items, 'todo:1')
    const item2 = itemOf(items, 'todo:2')

    const out = await applyCommand(
      [
        { kind: 'set_status', itemId: item1.id, status: 'done', note: null },
        { kind: 'set_status', itemId: 99999, status: 'done', note: null },
        { kind: 'focus', itemId: item2.id }
      ],
      'PROJ-1 끝, 결제 집중',
      MON_1100
    )
    expect(out.results.map((r) => r.ok)).toEqual([true, false, true])
    expect(out.applied).toBe(2)
    expect(out.failed).toBe(1)
    expect(out.today.items.find((i) => i.id === item1.id)?.status).toBe('done')
    const focused = out.today.items.find((i) => i.id === item2.id)
    expect(focused).toMatchObject({ status: 'in_progress', rank: 1 })

    // 같은 쓰기 줄의 다음 공개 함수도 끝난다
    const after = await setItemStatus(item2.id, 'done', null, MON_1105)
    expect(after.items.find((i) => i.id === item2.id)?.status).toBe('done')
  })

  it("A39: 적용은 command 이벤트 1건을 logged 로 기록하고 reason 'command' 를 보낸다. 같은 초는 접미어로 나눈다", async () => {
    const items = await startKeyed()
    const item1 = itemOf(items, 'todo:1')
    changed.length = 0

    const out = await applyCommand(
      [
        { kind: 'set_status', itemId: item1.id, status: 'deferred', note: '자료 대기' },
        { kind: 'unsupported', reason: 'Jira 에서 바꿔 주세요.' }
      ],
      'PROJ-1 미뤄',
      MON_1100
    )
    const commands = out.today.events.filter((e) => e.kind === 'command')
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      event_key: 'command:2026-11-02:2026-11-02 11:00:00',
      fired_at: '2026-11-02 11:00:00',
      status: 'logged',
      ref_id: null,
      plan_date: '2026-11-02'
    })
    expect(JSON.parse(commands[0].payload ?? '{}')).toEqual({
      text: 'PROJ-1 미뤄',
      applied: 1,
      failed: 1,
      results: [
        { kind: 'set_status', label: `'할 일 1' 미룸 · 메모: 자료 대기`, ok: true, error: null },
        { kind: 'unsupported', label: '지원하지 않음: Jira 에서 바꿔 주세요.', ok: false, error: '지원하지 않는 조작입니다.' }
      ]
    })
    expect(changed).toContainEqual({ date: '2026-11-02', reason: 'command' })

    const second = await applyCommand([], '아무것도', MON_1100)
    const keys = second.today.events.filter((e) => e.kind === 'command').map((e) => e.event_key).sort()
    expect(keys).toEqual(['command:2026-11-02:2026-11-02 11:00:00', 'command:2026-11-02:2026-11-02 11:00:00:1'])
  })

  it('A38·G.7.4: regenerate_briefing 은 지시를 저장하고 규칙 브리핑에 방침을 넣은 뒤 LLM 브리핑을 백그라운드로 만든다', async () => {
    await startKeyed()
    headless.isHeadlessAvailable.mockReturnValue(true)
    briefing.requestLlmBriefing.mockResolvedValue({ ok: true, markdown: '# AI 브리핑', model: 'claude-sonnet-5-5' })

    const out = await applyCommand(
      [{ kind: 'regenerate_briefing', instruction: '배포 준비 위주로' }],
      '오늘은 배포 준비 위주로 정리해줘',
      MON_1100
    )
    expect(out.results[0]).toMatchObject({ ok: true, error: null })
    expect(out.today.plan?.briefing_instruction).toBe('배포 준비 위주로')
    // 적용 응답은 LLM 을 기다리지 않는다. 규칙 브리핑이 먼저다
    expect(out.today.plan?.briefing_source).toBe('rules')
    expect(out.today.plan?.briefing_text).toContain('오늘 방침')
    expect(out.today.plan?.briefing_text).toContain('배포 준비 위주로')

    await waitForAssistantBackground()
    const input = briefing.requestLlmBriefing.mock.calls[0][0] as { instruction: string | null }
    expect(input.instruction).toBe('배포 준비 위주로')
    expect((await getToday(MON_1105)).plan?.briefing_source).toBe('llm')
    expect(changed).toContainEqual({ date: '2026-11-02', reason: 'briefing' })

    // instruction 이 null 이면 기존 지시를 유지한다. 수동 다시 생성도 저장된 지시를 쓴다
    await applyCommand([{ kind: 'regenerate_briefing', instruction: null }], '브리핑 다시 만들어줘', MON_1105)
    await waitForAssistantBackground()
    expect(getPlanByDate(getDatabase(), '2026-11-02')?.briefing_instruction).toBe('배포 준비 위주로')
    briefing.requestLlmBriefing.mockClear()
    await refreshBriefing(MON_1105)
    const manual = briefing.requestLlmBriefing.mock.calls[0][0] as { instruction: string | null }
    expect(manual.instruction).toBe('배포 준비 위주로')
  })
})

describe('회의 전 브리핑 (부록 I)', () => {
  // 10:15 회의, lead 15분이면 창은 [10:00, 10:15) 다
  const MON_0955 = new Date(2026, 10, 2, 9, 55, 0)
  const MON_1001 = new Date(2026, 10, 2, 10, 1, 0)
  const MON_1003 = new Date(2026, 10, 2, 10, 3, 0)
  const MON_1002 = new Date(2026, 10, 2, 10, 2, 0)
  const MON_1020 = new Date(2026, 10, 2, 10, 20, 0)

  interface FakeCalendarEvent { id: string; summary: string; start: string; end: string; allDay: boolean }

  function calEvent(id: string, start: string, over: Partial<FakeCalendarEvent> = {}): FakeCalendarEvent {
    return { id, summary: `회의 ${id}`, start: `2026-11-02 ${start}:00`, end: `2026-11-02 ${start.slice(0, 2)}:59:00`, allDay: false, ...over }
  }

  function ctxOf(meeting: MeetingRef, over: Partial<MeetingContext> = {}): MeetingContext {
    return {
      meeting,
      projects: [{ id: 1, name: '링크워크' }],
      pastMeetings: [],
      openActionItems: ['API 문서 정리'],
      relatedItems: [],
      errors: [],
      ...over
    }
  }

  function meetingRows(): { id: number; event_key: string; status: string; fired_at: string | null; scheduled_at: string; ref_id: string | null; payload: string | null }[] {
    return getDatabase()
      .prepare("SELECT id, event_key, status, fired_at, scheduled_at, ref_id, payload FROM assistant_events WHERE kind = 'meeting_briefing' ORDER BY id")
      .all() as never
  }

  function payloadOf(eventId: number): MeetingBriefingPayload {
    return JSON.parse(getEventById(getDatabase(), eventId)!.payload!) as MeetingBriefingPayload
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => undefined
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }

  beforeEach(() => {
    calendar.getTodayEvents.mockImplementation(async () => [calEvent('m1', '10:15')])
    sources.toMeetingRef.mockImplementation((e: FakeCalendarEvent): MeetingRef | null =>
      e.allDay ? null : { id: e.id, title: e.summary, startAt: e.start, endAt: e.end }
    )
    sources.collectMeetingContext.mockImplementation((_db: unknown, meeting: MeetingRef) => ctxOf(meeting))
    briefing.requestLlmMeetingBriefing.mockResolvedValue({ ok: true, markdown: '# AI 회의 브리핑', model: 'claude-sonnet-5-5' })
  })

  describe('runDueMeetingBriefings (I.9.1)', () => {
    it('A45: 창 안이면 규칙 본문을 INSERT 하고 알림을 돌려준다. LLM 은 그 뒤 같은 행에 쓴다', async () => {
      let rowAtLlm: MeetingBriefingPayload | null = null
      const gate = deferred()
      briefing.requestLlmMeetingBriefing.mockImplementation(async () => {
        // LLM 이 시작할 때 규칙 본문이 이미 저장되어 있다
        rowAtLlm = payloadOf(meetingRows()[0].id)
        await gate.promise
        return { ok: true, markdown: '# AI 회의 브리핑', model: 'claude-sonnet-5-5' }
      })

      const notices = await runDueMeetingBriefings(MON_1001)
      expect(notices).toHaveLength(1)
      const n = notices[0]
      expect(n.focus).toEqual({ kind: 'meeting', id: String(n.eventId) })
      expect(n.title).toBe('회의 m1 15분 전')
      expect(n.body).toBe('링크워크 · 미완료 액션 1건')

      const row = getEventById(getDatabase(), n.eventId)
      expect(row).toMatchObject({
        event_key: 'meeting_briefing:2026-11-02:m1',
        kind: 'meeting_briefing',
        plan_date: '2026-11-02',
        scheduled_at: '2026-11-02 10:00:00',
        fired_at: '2026-11-02 10:01:00',
        status: 'sent',
        ref_id: 'm1'
      })
      const before = payloadOf(n.eventId)
      expect(before.ruleMarkdown).toContain('회의 m1')
      expect(before).toMatchObject({ hasContext: true, llmStatus: 'pending', llmMarkdown: null, title: n.title, body: n.body })
      expect(before.projects).toEqual([{ id: 1, name: '링크워크' }])
      expect(changed).toContainEqual({ date: '2026-11-02', reason: 'meeting' })

      gate.resolve()
      await waitForAssistantBackground()
      expect(rowAtLlm!.ruleMarkdown).toBe(before.ruleMarkdown)
      expect(rowAtLlm!.llmStatus).toBe('pending')
      const after = payloadOf(n.eventId)
      expect(after).toMatchObject({ llmStatus: 'done', llmMarkdown: '# AI 회의 브리핑', llmModel: 'claude-sonnet-5-5', llmError: null })
      expect(after.llmAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      expect(after.ruleMarkdown).toBe(before.ruleMarkdown)
      // LLM 입력은 수집 맥락과 규칙 본문이다
      expect(briefing.requestLlmMeetingBriefing.mock.calls[0][0]).toEqual({
        ctx: ctxOf({ id: 'm1', title: '회의 m1', startAt: '2026-11-02 10:15:00', endAt: '2026-11-02 10:59:00' }),
        ruleMarkdown: before.ruleMarkdown
      })
    })

    it('A45: LLM 이 실패해도 알림은 그대로 나가고 payload 에 failed 와 오류만 남는다', async () => {
      briefing.requestLlmMeetingBriefing.mockResolvedValue({ ok: false, error: 'Claude Code 로그인이 필요합니다.' })
      const notices = await runDueMeetingBriefings(MON_1001)
      expect(notices).toHaveLength(1)
      await waitForAssistantBackground()
      const p = payloadOf(notices[0].eventId)
      expect(p).toMatchObject({ llmStatus: 'failed', llmError: 'Claude Code 로그인이 필요합니다.', llmMarkdown: null })
      expect(p.ruleMarkdown.length).toBeGreaterThan(0)
      expect(getEventById(getDatabase(), notices[0].eventId)?.status).toBe('sent')
    })

    it('A45: LLM 이 reject 해도 throw 하지 않고 failed 로 남긴다', async () => {
      briefing.requestLlmMeetingBriefing.mockRejectedValue(new Error('boom'))
      const notices = await runDueMeetingBriefings(MON_1001)
      await waitForAssistantBackground()
      expect(payloadOf(notices[0].eventId)).toMatchObject({ llmStatus: 'failed', llmError: 'boom' })
    })

    it('A45: hasContext 가 false 면 LLM 을 부르지 않고 llmStatus 는 off 다', async () => {
      sources.collectMeetingContext.mockImplementation((_db: unknown, meeting: MeetingRef) =>
        ctxOf(meeting, { projects: [], openActionItems: [] })
      )
      const notices = await runDueMeetingBriefings(MON_1001)
      await waitForAssistantBackground()
      expect(notices[0].body).toBe('관련 프로젝트 없음 · 미완료 액션 0건')
      expect(payloadOf(notices[0].eventId)).toMatchObject({ hasContext: false, llmStatus: 'off' })
      expect(briefing.requestLlmMeetingBriefing).not.toHaveBeenCalled()
    })

    it('AI 브리핑이 꺼져 있거나 Claude CLI 가 없으면 LLM 을 부르지 않고 off 다', async () => {
      saveSettings({ llmEnabled: false })
      const a = await runDueMeetingBriefings(MON_1001)
      calendar.getTodayEvents.mockImplementation(async () => [calEvent('m2', '10:30')])
      saveSettings({ llmEnabled: true })
      headless.isHeadlessAvailable.mockReturnValue(false)
      const b = await runDueMeetingBriefings(new Date(2026, 10, 2, 10, 16, 0))
      await waitForAssistantBackground()
      expect(payloadOf(a[0].eventId).llmStatus).toBe('off')
      expect(payloadOf(b[0].eventId).llmStatus).toBe('off')
      expect(briefing.requestLlmMeetingBriefing).not.toHaveBeenCalled()
    })

    it('계획이 없어도 보낸다. 관련 항목 수집에 빈 목록을 넘긴다', async () => {
      const notices = await runDueMeetingBriefings(MON_1001)
      expect(notices).toHaveLength(1)
      expect(sources.collectMeetingContext.mock.calls[0][2]).toEqual([])
    })

    it('계획이 있으면 오늘 계획 항목을 수집에 넘긴다', async () => {
      headless.isHeadlessAvailable.mockReturnValue(false)
      const started = await startDay(MON_0940)
      await runDueMeetingBriefings(MON_1001)
      expect((sources.collectMeetingContext.mock.calls[0][2] as PlanItem[]).map((i) => i.id)).toEqual(started.items.map((i) => i.id))
    })

    it('예정 시각보다 2분 이상 늦으면 status 는 late 다', async () => {
      const notices = await runDueMeetingBriefings(MON_1003)
      expect(getEventById(getDatabase(), notices[0].eventId)?.status).toBe('late')
      const ok = await runDueMeetingBriefings(MON_1002)
      expect(ok).toEqual([])
    })

    it('창 전에는 행을 만들지 않고 알리지 않는다', async () => {
      expect(await runDueMeetingBriefings(MON_0955)).toEqual([])
      expect(meetingRows()).toHaveLength(0)
      expect(changed.filter((e) => e.reason === 'meeting')).toHaveLength(0)
    })

    it('A47: 창이 지났으면 skipped 행을 fired_at null 로 남기고 알리지 않는다', async () => {
      expect(await runDueMeetingBriefings(MON_1020)).toEqual([])
      expect(meetingRows()).toEqual([
        expect.objectContaining({
          event_key: 'meeting_briefing:2026-11-02:m1',
          status: 'skipped',
          fired_at: null,
          scheduled_at: '2026-11-02 10:00:00',
          payload: JSON.stringify({ reason: 'window' })
        })
      ])
      expect(sources.collectMeetingContext).not.toHaveBeenCalled()
      expect(changed.filter((e) => e.reason === 'meeting')).toHaveLength(0)
      // 다음 틱은 같은 회의를 다시 보지 않는다
      expect(await runDueMeetingBriefings(new Date(2026, 10, 2, 10, 21, 0))).toEqual([])
      expect(meetingRows()).toHaveLength(1)
    })

    it('A47: 하루 6건을 넘는 회의는 cap 으로 skipped 다', async () => {
      headless.isHeadlessAvailable.mockReturnValue(false)
      calendar.getTodayEvents.mockImplementation(async () =>
        ['10:02', '10:03', '10:04', '10:05', '10:06', '10:07', '10:08'].map((t, i) => calEvent(`c${i}`, t))
      )
      const notices = await runDueMeetingBriefings(MON_1001)
      expect(notices).toHaveLength(6)
      const rows = meetingRows()
      expect(rows.filter((r) => r.status === 'sent' || r.status === 'late')).toHaveLength(6)
      expect(rows.find((r) => r.event_key.endsWith(':c6'))).toMatchObject({ status: 'skipped', fired_at: null, payload: JSON.stringify({ reason: 'cap' }) })
    })

    it('A5: 같은 회의의 두 번째 틱은 행을 더 만들지 않고 빈 목록이다', async () => {
      expect(await runDueMeetingBriefings(MON_1001)).toHaveLength(1)
      expect(await runDueMeetingBriefings(MON_1002)).toEqual([])
      expect(meetingRows()).toHaveLength(1)
    })

    it('A5: 판정이 같은 키를 다시 돌려줘도 UNIQUE 충돌이면 알림 목록에 넣지 않고 LLM 을 부르지 않는다', async () => {
      const meeting: MeetingRef = { id: 'm1', title: '회의 m1', startAt: '2026-11-02 10:15:00', endAt: '2026-11-02 10:59:00' }
      const due: DueMeetingBriefing = { action: 'send', meeting, eventKey: 'meeting_briefing:2026-11-02:m1', scheduledAt: '2026-11-02 10:00:00', late: false }
      schedule.computeDueMeetingBriefings.mockReturnValueOnce([due]).mockReturnValueOnce([due])
      expect(await runDueMeetingBriefings(MON_1001)).toHaveLength(1)
      await waitForAssistantBackground()
      changed.length = 0
      briefing.requestLlmMeetingBriefing.mockClear()
      expect(await runDueMeetingBriefings(MON_1002)).toEqual([])
      await waitForAssistantBackground()
      expect(meetingRows()).toHaveLength(1)
      expect(changed).toEqual([])
      expect(briefing.requestLlmMeetingBriefing).not.toHaveBeenCalled()
    })

    it('여러 회의가 창 안이면 시작 오름차순으로 모두 보낸다', async () => {
      headless.isHeadlessAvailable.mockReturnValue(false)
      calendar.getTodayEvents.mockImplementation(async () => [calEvent('b', '10:14'), calEvent('a', '10:10')])
      const notices = await runDueMeetingBriefings(MON_1001)
      expect(notices.map((n) => n.title)).toEqual(['회의 a 15분 전', '회의 b 15분 전'])
      expect(changed.filter((e) => e.reason === 'meeting')).toHaveLength(1)
    })

    it('종일 일정은 판정하지 않는다', async () => {
      calendar.getTodayEvents.mockImplementation(async () => [calEvent('all', '10:15', { allDay: true })])
      expect(await runDueMeetingBriefings(MON_1001)).toEqual([])
      expect(meetingRows()).toHaveLength(0)
    })

    it('회의 브리핑이 꺼져 있으면 캘린더를 읽지 않는다', async () => {
      saveSettings({ meetingBriefingEnabled: false })
      expect(await runDueMeetingBriefings(MON_1001)).toEqual([])
      expect(calendar.getTodayEvents).not.toHaveBeenCalled()
      saveSettings({ meetingBriefingEnabled: true, enabled: false })
      expect(await runDueMeetingBriefings(MON_1001)).toEqual([])
      expect(calendar.getTodayEvents).not.toHaveBeenCalled()
    })

    it('A46: 캘린더는 getTodayEvents 캐시만 쓰고, 조회가 reject 해도 throw 하지 않는다', async () => {
      calendar.getTodayEvents.mockRejectedValueOnce(new Error('network'))
      await expect(runDueMeetingBriefings(MON_1001)).resolves.toEqual([])
      expect(calendar.getTodayEvents).toHaveBeenCalledWith()
      expect(sources.collectSources).not.toHaveBeenCalled()
    })

    it('수집이 throw 해도 그 회의만 건너뛰고 다음 회의는 보낸다', async () => {
      calendar.getTodayEvents.mockImplementation(async () => [calEvent('a', '10:10'), calEvent('b', '10:14')])
      sources.collectMeetingContext.mockImplementationOnce(() => {
        throw new Error('db')
      })
      const notices = await runDueMeetingBriefings(MON_1001)
      expect(notices.map((n) => n.title)).toEqual(['회의 b 15분 전'])
    })

    it('날짜 경계 직전·직후 틱이 같은 회의를 다른 날짜 키로 두 번 보내지 않는다', async () => {
      // 경계 04:00, lead 15분, 11-03 04:10 회의. 03:56 은 논리 날짜 11-02, 04:00 은 11-03 이다
      headless.isHeadlessAvailable.mockReturnValue(false)
      calendar.getTodayEvents.mockImplementation(async () => [
        { id: 'dawn', summary: '새벽 회의', start: '2026-11-03 04:10:00', end: '2026-11-03 04:40:00', allDay: false }
      ])
      expect(await runDueMeetingBriefings(new Date(2026, 10, 3, 3, 56, 0))).toEqual([])
      expect(meetingRows()).toHaveLength(0)
      const notices = await runDueMeetingBriefings(new Date(2026, 10, 3, 4, 0, 0))
      expect(notices).toHaveLength(1)
      expect(meetingRows().map((r) => r.event_key)).toEqual(['meeting_briefing:2026-11-03:dawn'])
      expect(await runDueMeetingBriefings(new Date(2026, 10, 3, 4, 1, 0))).toEqual([])
      expect(meetingRows()).toHaveLength(1)
    })

    it('캘린더 조회는 serialized 줄 밖이다. 조회를 기다리는 동안 사용자 쓰기가 막히지 않는다', async () => {
      headless.isHeadlessAvailable.mockReturnValue(false)
      const started = await startDay(MON_0940)
      const gate = deferred()
      calendar.getTodayEvents.mockImplementation(async () => {
        await gate.promise
        return [calEvent('m1', '10:15')]
      })
      const pending = runDueMeetingBriefings(MON_1001)
      await vi.waitFor(() => expect(calendar.getTodayEvents).toHaveBeenCalledTimes(1))
      // 조회가 끝나지 않았어도 사용자 쓰기는 완료된다
      const written = await setItemStatus(started.items[0].id, 'in_progress', null, MON_1001)
      expect(written.items.find((i) => i.id === started.items[0].id)?.status).toBe('in_progress')
      gate.resolve()
      expect(await pending).toHaveLength(1)
    })

    it('시각을 넘기지 않으면 줄 안에서 현재 시각을 잡는다 (H.16)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(MON_1001)
        const notices = await runDueMeetingBriefings()
        expect(getEventById(getDatabase(), notices[0].eventId)?.fired_at).toBe('2026-11-02 10:01:00')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('LLM 직렬화 (A32)', () => {
    it('A32: 회의 LLM 은 llmSerialized 줄에서 앞 브리핑 LLM 이 끝난 뒤 실행된다', async () => {
      const gate = deferred()
      const log: string[] = []
      briefing.requestLlmBriefing.mockImplementation(async () => {
        log.push('briefing:start')
        await gate.promise
        log.push('briefing:end')
        return { ok: true, markdown: '# 오늘', model: 'claude-sonnet-5-5' }
      })
      briefing.requestLlmMeetingBriefing.mockImplementation(async () => {
        log.push('meeting:start')
        return { ok: true, markdown: '# AI 회의 브리핑', model: 'claude-sonnet-5-5' }
      })

      await startDay(MON_0940)
      const notices = await runDueMeetingBriefings(MON_1001)
      // 알림은 LLM 을 기다리지 않는다
      expect(notices).toHaveLength(1)
      expect(payloadOf(notices[0].eventId).llmStatus).toBe('pending')
      await new Promise((r) => setTimeout(r, 5))
      expect(log).toEqual(['briefing:start'])

      gate.resolve()
      await waitForAssistantBackground()
      expect(log).toEqual(['briefing:start', 'briefing:end', 'meeting:start'])
      expect(payloadOf(notices[0].eventId).llmStatus).toBe('done')
    })

    it('A32: 회의 브리핑 다시 만들기도 같은 줄을 거친다', async () => {
      headless.isHeadlessAvailable.mockReturnValue(false)
      const [n] = await runDueMeetingBriefings(MON_1001)
      await startDay(MON_0940)
      headless.isHeadlessAvailable.mockReturnValue(true)
      const gate = deferred()
      const log: string[] = []
      briefing.requestLlmBriefing.mockImplementation(async () => {
        log.push('briefing:start')
        await gate.promise
        log.push('briefing:end')
        return { ok: true, markdown: '# 오늘', model: 'claude-sonnet-5-5' }
      })
      briefing.requestLlmMeetingBriefing.mockImplementation(async () => {
        log.push('meeting:start')
        return { ok: true, markdown: '# 다시 만든 회의 브리핑', model: 'claude-sonnet-5-5' }
      })

      const refreshed = refreshBriefing(MON_1002)
      const regenerated = regenerateMeetingBriefing(n.eventId, MON_1002)
      await new Promise((r) => setTimeout(r, 5))
      expect(log).toEqual(['briefing:start'])
      gate.resolve()
      await Promise.all([refreshed, regenerated])
      expect(log).toEqual(['briefing:start', 'briefing:end', 'meeting:start'])
    })
  })

  describe('regenerateMeetingBriefing (I.11.8)', () => {
    async function sentBriefing(): Promise<number> {
      headless.isHeadlessAvailable.mockReturnValue(false)
      const [n] = await runDueMeetingBriefings(MON_1001)
      headless.isHeadlessAvailable.mockReturnValue(true)
      return n.eventId
    }

    it('LLM 결과를 기다려 같은 행에 쓰고 규칙 본문은 그대로 둔다. 맥락은 다시 수집한다', async () => {
      const id = await sentBriefing()
      const before = payloadOf(id)
      expect(before.llmStatus).toBe('off')
      sources.collectMeetingContext.mockClear()
      briefing.requestLlmMeetingBriefing.mockResolvedValue({ ok: true, markdown: '# 다시 만든 회의 브리핑', model: 'claude-sonnet-5-5' })

      const today = await regenerateMeetingBriefing(id, MON_1002)
      const after = payloadOf(id)
      expect(after).toMatchObject({ llmStatus: 'done', llmMarkdown: '# 다시 만든 회의 브리핑', ruleMarkdown: before.ruleMarkdown, title: before.title })
      expect(sources.collectMeetingContext).toHaveBeenCalledTimes(1)
      expect(sources.collectMeetingContext.mock.calls[0][1]).toEqual(before.meeting)
      expect(changed).toContainEqual({ date: '2026-11-02', reason: 'meeting' })
      expect(JSON.parse(today.events.find((e) => e.id === id)!.payload!).llmStatus).toBe('done')
    })

    it('LLM 호출 전에 payload 를 pending 으로 바꾸고 meeting 변경을 알린다', async () => {
      const id = await sentBriefing()
      changed.length = 0
      let atLlm: { status: string; changed: number } | null = null
      briefing.requestLlmMeetingBriefing.mockImplementation(async () => {
        atLlm = { status: payloadOf(id).llmStatus, changed: changed.filter((e) => e.reason === 'meeting').length }
        return { ok: true, markdown: '# 다시 만든 회의 브리핑', model: 'claude-sonnet-5-5' }
      })
      await regenerateMeetingBriefing(id, MON_1002)
      expect(atLlm).toEqual({ status: 'pending', changed: 1 })
      expect(payloadOf(id).llmStatus).toBe('done')
    })

    it('LLM 이 실패하면 failed 와 오류를 쓰고 이전 AI 본문을 비운다', async () => {
      const id = await sentBriefing()
      await regenerateMeetingBriefing(id, MON_1002)
      expect(payloadOf(id).llmStatus).toBe('done')
      briefing.requestLlmMeetingBriefing.mockResolvedValue({ ok: false, error: 'BUSY' })
      await regenerateMeetingBriefing(id, MON_1002)
      expect(payloadOf(id)).toMatchObject({ llmStatus: 'failed', llmError: 'BUSY', llmMarkdown: null, llmModel: null })
    })

    it('Claude CLI 가 없으면 LLM 을 부르지 않고 failed 와 안내 문구를 쓴다', async () => {
      const id = await sentBriefing()
      headless.isHeadlessAvailable.mockReturnValue(false)
      await regenerateMeetingBriefing(id, MON_1002)
      expect(payloadOf(id)).toMatchObject({ llmStatus: 'failed', llmError: 'Claude Code 를 찾을 수 없습니다. 설치와 로그인을 확인하세요.' })
      expect(briefing.requestLlmMeetingBriefing).not.toHaveBeenCalled()
    })

    it('AI 브리핑이 꺼져 있으면 throw 한다', async () => {
      const id = await sentBriefing()
      saveSettings({ llmEnabled: false })
      await expect(regenerateMeetingBriefing(id, MON_1002)).rejects.toThrow('AI 브리핑이 꺼져 있습니다')
      expect(briefing.requestLlmMeetingBriefing).not.toHaveBeenCalled()
    })

    it('행이 없거나, skipped 거나, 회의 브리핑이 아니면 throw 한다', async () => {
      await expect(regenerateMeetingBriefing(999, MON_1002)).rejects.toThrow('회의 브리핑을 찾을 수 없습니다')
      await runDueMeetingBriefings(MON_1020)
      const skipped = meetingRows()[0]
      expect(skipped.status).toBe('skipped')
      await expect(regenerateMeetingBriefing(skipped.id, MON_1020)).rejects.toThrow('회의 브리핑을 찾을 수 없습니다')
      const other = insertEvent(getDatabase(), {
        event_key: 'start_nudge:2026-11-02', kind: 'start_nudge', plan_date: '2026-11-02',
        scheduled_at: '2026-11-02 10:55:00', fired_at: '2026-11-02 10:56:00', status: 'sent', ref_id: '1', payload: '{}'
      })
      await expect(regenerateMeetingBriefing(other!.id, MON_1020)).rejects.toThrow('회의 브리핑을 찾을 수 없습니다')
      await expect(regenerateMeetingBriefing(1.5 as never, MON_1020)).rejects.toThrow('회의 브리핑 ID 가 올바르지 않습니다')
      expect(briefing.requestLlmMeetingBriefing).not.toHaveBeenCalled()
    })
  })
})
