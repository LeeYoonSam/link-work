import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3 → node:sqlite 교체.
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

// 회의 브리핑이 읽는 5분 캐시다. 테스트가 일정을 넣는다
// isOwnCalendarEvent 는 google-calendar.ts 의 규칙과 같다: calendarId 가 없거나 'primary' 면 기본 캘린더다
const calendar = vi.hoisted(() => ({
  getTodayEvents: vi.fn(async (): Promise<unknown[]> => []),
  isOwnCalendarEvent: (e: { calendarId?: string }): boolean => e.calendarId === undefined || e.calendarId === 'primary'
}))
vi.mock('./google-calendar', () => calendar)

// 연결 여부는 getToday 마다 실제 상태로 읽는다 (M1)
const auth = vi.hoisted(() => ({ isConnected: vi.fn(() => false) }))
vi.mock('./google-auth', () => auth)
const jira = vi.hoisted(() => ({ isJiraConnected: vi.fn(() => false) }))
vi.mock('./jira', () => jira)

const headless = vi.hoisted(() => ({ isHeadlessAvailable: vi.fn(() => true), runHeadlessJson: vi.fn() }))
// LLM 줄(runLlmSerialized)은 실제 구현을 쓴다. 에픽 요약과 같은 줄을 거치는지 본다
vi.mock('./ai-agent', () => ({ findClaudeExecutable: () => undefined }))
vi.mock('./ai-headless', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai-headless')>()
  return { ...actual, ...headless }
})

// 수집 모듈은 네트워크를 쓰므로 픽스처로 답한다
const sources = vi.hoisted(() => ({
  // 회의 브리핑. 변환·수집 규칙은 assistant-sources.test.ts 가 검증한다
  toMeetingRef: vi.fn(),
  collectMeetingContext: vi.fn()
}))
vi.mock('./assistant-sources', () => sources)

const briefing = vi.hoisted(() => ({ requestLlmMeetingBriefing: vi.fn() }))
vi.mock('./assistant-briefing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assistant-briefing')>()
  return { ...actual, requestLlmMeetingBriefing: briefing.requestLlmMeetingBriefing }
})

// 회의 브리핑 판정은 실제 구현을 쓴다. UNIQUE 충돌 테스트만 결과를 고정한다
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
  getToday,
  regenerateMeetingBriefing,
  runDueMeetingBriefings,
  saveSettings,
  setAssistantChangedListener,
  waitForAssistantBackground
} from './assistant-service'
import { runLlmSerialized } from './ai-headless'
import { getEventById, insertEvent } from './assistant-store'
import type {
  AssistantChangedEvent,
  DueMeetingBriefing,
  MeetingBriefingPayload,
  MeetingContext,
  MeetingRef
} from './assistant-types'

// 이 파일은 서비스 기능(오늘 화면 페이로드, 회의 전 브리핑, 설정, LLM 직렬화 줄)만 검증한다.

// 2026-11-02 는 월요일이다
const MON_0940 = new Date(2026, 10, 2, 9, 40, 0)

const changed: AssistantChangedEvent[] = []

beforeEach(() => {
  vi.clearAllMocks()
  initDatabase()
  changed.length = 0
  setAssistantChangedListener((e) => changed.push(e))
  headless.isHeadlessAvailable.mockReturnValue(true)
  auth.isConnected.mockReturnValue(false)
  jira.isJiraConnected.mockReturnValue(false)
})

afterEach(async () => {
  await waitForAssistantBackground()
  setAssistantChangedListener(null)
  closeDatabase()
})

describe('getToday (오늘 화면 페이로드)', () => {
  it('비서 이벤트·설정·AI 사용 가능·캘린더 연결만 담는다. 계획을 만들거나 닫지 않는다', async () => {
    const at = '2026-11-01 09:00:00'
    getDatabase()
      .prepare(
        `INSERT INTO daily_plans (plan_date, status, started_at, source_snapshot, created_at, updated_at)
         VALUES ('2026-11-01', 'active', ?, NULL, ?, ?)`
      )
      .run(at, at, at)
    const today = await getToday(MON_0940)
    expect(Object.keys(today).sort()).toEqual(['aiAvailable', 'calendarConnected', 'events', 'settings'])
    expect(today.events).toEqual([])
    // 옛 active 계획 행은 그대로 남는다(지난 계획 닫기는 제거됐다)
    expect(getDatabase().prepare('SELECT status FROM daily_plans').all()).toEqual([{ status: 'active' }])
  })
})

describe('getToday 연결 상태 (M1)', () => {
  it('Google 연결 여부를 부를 때마다 실제 상태로 읽는다. 앱을 켠 뒤 연결·해제해도 바로 맞는다', async () => {
    expect(await getToday(MON_0940)).toMatchObject({ calendarConnected: false })
    auth.isConnected.mockReturnValue(true)
    expect(await getToday(MON_0940)).toMatchObject({ calendarConnected: true })
    auth.isConnected.mockReturnValue(false)
    expect(await getToday(MON_0940)).toMatchObject({ calendarConnected: false })
    expect(auth.isConnected).toHaveBeenCalledTimes(3)
  })

  it('연결 확인이 throw 하면 미연결로 보고 getToday 는 실패하지 않는다', async () => {
    auth.isConnected.mockImplementation(() => {
      throw new Error('Database not initialized')
    })
    expect(await getToday(MON_0940)).toMatchObject({ calendarConnected: false })
  })
})

describe('saveSettings', () => {
  it('openAtLogin 이 바뀔 때만 setLoginItemSettings 를 부른다', () => {
    saveSettings({ openAtLogin: true })
    expect(electron.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
    electron.setLoginItemSettings.mockClear()
    saveSettings({ meetingLeadMin: 10 })
    expect(electron.setLoginItemSettings).not.toHaveBeenCalled()
    expect(getDatabase()).toBeTruthy()
  })
})

describe('회의 전 브리핑', () => {
  // 10:15 회의, lead 15분이면 창은 [10:00, 10:15) 다
  const MON_0955 = new Date(2026, 10, 2, 9, 55, 0)
  const MON_1001 = new Date(2026, 10, 2, 10, 1, 0)
  const MON_1003 = new Date(2026, 10, 2, 10, 3, 0)
  const MON_1002 = new Date(2026, 10, 2, 10, 2, 0)
  const MON_1020 = new Date(2026, 10, 2, 10, 20, 0)

  interface FakeCalendarEvent { id: string; summary: string; start: string; end: string; allDay: boolean; calendarId?: string }

  function calEvent(id: string, start: string, over: Partial<FakeCalendarEvent> = {}): FakeCalendarEvent {
    return { id, summary: `회의 ${id}`, start: `2026-11-02 ${start}:00`, end: `2026-11-02 ${start.slice(0, 2)}:59:00`, allDay: false, ...over }
  }

  function ctxOf(meeting: MeetingRef, over: Partial<MeetingContext> = {}): MeetingContext {
    return {
      meeting,
      pastMeetings: [],
      openActionItems: ['API 문서 정리'],
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

  describe('runDueMeetingBriefings', () => {
    it('M2: 추가 캘린더(Tech 등) 일정은 브리핑 대상과 하루 상한 계산에서 뺀다. 기본 캘린더 일정만 보낸다', async () => {
      const TECH = 'c_tech@group.calendar.google.com'
      // 추가 캘린더 회의 6건이 먼저 시작한다. 거르지 않으면 상한(6)을 다 써서 기본 캘린더 회의가 밀린다
      const techs = ['10:05', '10:06', '10:07', '10:08', '10:09', '10:10'].map((t, i) =>
        calEvent(`t${i}`, t, { calendarId: TECH })
      )
      calendar.getTodayEvents.mockImplementation(async () => [
        ...techs,
        calEvent('mine', '10:14', { calendarId: 'primary' }),
        calEvent('legacy', '10:12')
      ])
      headless.isHeadlessAvailable.mockReturnValue(false)
      const notices = await runDueMeetingBriefings(MON_1001)
      expect(notices).toHaveLength(2)
      const rows = meetingRows()
      expect(rows.map((r) => r.ref_id).sort()).toEqual(['legacy', 'mine'])
      // 상한에 밀린 skipped(cap) 행이 없다
      expect(rows.every((r) => r.status === 'sent' || r.status === 'late')).toBe(true)
      expect(sources.collectMeetingContext.mock.calls.map((c) => (c[1] as MeetingRef).id).sort()).toEqual(['legacy', 'mine'])
    })

    it('창 안이면 규칙 본문을 INSERT 하고 알림을 돌려준다. LLM 은 그 뒤 같은 행에 쓴다', async () => {
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
      expect(n.body).toBe('미완료 액션 1건')

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
      expect(before).not.toHaveProperty('projects')
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

    it('LLM 이 실패해도 알림은 그대로 나가고 payload 에 failed 와 오류만 남는다', async () => {
      briefing.requestLlmMeetingBriefing.mockResolvedValue({ ok: false, error: 'Claude Code 로그인이 필요합니다.' })
      const notices = await runDueMeetingBriefings(MON_1001)
      expect(notices).toHaveLength(1)
      await waitForAssistantBackground()
      const p = payloadOf(notices[0].eventId)
      expect(p).toMatchObject({ llmStatus: 'failed', llmError: 'Claude Code 로그인이 필요합니다.', llmMarkdown: null })
      expect(p.ruleMarkdown.length).toBeGreaterThan(0)
      expect(getEventById(getDatabase(), notices[0].eventId)?.status).toBe('sent')
    })

    it('LLM 이 reject 해도 throw 하지 않고 failed 로 남긴다', async () => {
      briefing.requestLlmMeetingBriefing.mockRejectedValue(new Error('boom'))
      const notices = await runDueMeetingBriefings(MON_1001)
      await waitForAssistantBackground()
      expect(payloadOf(notices[0].eventId)).toMatchObject({ llmStatus: 'failed', llmError: 'boom' })
    })

    it('hasContext 가 false 면 LLM 을 부르지 않고 llmStatus 는 off 다', async () => {
      sources.collectMeetingContext.mockImplementation((_db: unknown, meeting: MeetingRef) =>
        ctxOf(meeting, { openActionItems: [] })
      )
      const notices = await runDueMeetingBriefings(MON_1001)
      await waitForAssistantBackground()
      expect(notices[0].body).toBe('미완료 액션 0건')
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

    it('계획이 없어도 보낸다. 수집에는 회의만 넘긴다', async () => {
      const notices = await runDueMeetingBriefings(MON_1001)
      expect(notices).toHaveLength(1)
      expect(sources.collectMeetingContext.mock.calls[0]).toHaveLength(2)
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

    it('창이 지났으면 skipped 행을 fired_at null 로 남기고 알리지 않는다', async () => {
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

    it('하루 6건을 넘는 회의는 cap 으로 skipped 다', async () => {
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

    it('같은 회의의 두 번째 틱은 행을 더 만들지 않고 빈 목록이다', async () => {
      expect(await runDueMeetingBriefings(MON_1001)).toHaveLength(1)
      expect(await runDueMeetingBriefings(MON_1002)).toEqual([])
      expect(meetingRows()).toHaveLength(1)
    })

    it('판정이 같은 키를 다시 돌려줘도 UNIQUE 충돌이면 알림 목록에 넣지 않고 LLM 을 부르지 않는다', async () => {
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

    it('캘린더는 getTodayEvents 캐시만 쓰고, 조회가 reject 해도 throw 하지 않는다', async () => {
      calendar.getTodayEvents.mockRejectedValueOnce(new Error('network'))
      await expect(runDueMeetingBriefings(MON_1001)).resolves.toEqual([])
      expect(calendar.getTodayEvents).toHaveBeenCalledWith()
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

    it('시각을 넘기지 않으면 줄 안에서 현재 시각을 잡는다', async () => {
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

  describe('LLM 직렬화', () => {
    it('회의 LLM 은 runLlmSerialized 줄에서 앞 작업이 끝난 뒤 실행된다', async () => {
      const gate = deferred()
      const log: string[] = []
      briefing.requestLlmMeetingBriefing.mockImplementation(async () => {
        log.push('meeting:start')
        return { ok: true, markdown: '# AI 회의 브리핑', model: 'claude-sonnet-5-5' }
      })

      // 다른 헤드리스 작업(에픽 요약 등)처럼 같은 줄에 먼저 선 작업
      const earlier = runLlmSerialized(async () => {
        log.push('today:start')
        await gate.promise
        log.push('today:end')
      })
      const notices = await runDueMeetingBriefings(MON_1001)
      // 알림은 LLM 을 기다리지 않는다
      expect(notices).toHaveLength(1)
      expect(payloadOf(notices[0].eventId).llmStatus).toBe('pending')
      await new Promise((r) => setTimeout(r, 5))
      expect(log).toEqual(['today:start'])

      gate.resolve()
      await earlier
      await waitForAssistantBackground()
      expect(log).toEqual(['today:start', 'today:end', 'meeting:start'])
      expect(payloadOf(notices[0].eventId).llmStatus).toBe('done')
    })

    it('회의 브리핑 다시 만들기도 같은 줄을 거친다. 앞 작업이 reject 해도 실행된다', async () => {
      headless.isHeadlessAvailable.mockReturnValue(false)
      const [n] = await runDueMeetingBriefings(MON_1001)
      headless.isHeadlessAvailable.mockReturnValue(true)
      const gate = deferred()
      const log: string[] = []
      briefing.requestLlmMeetingBriefing.mockImplementation(async () => {
        log.push('meeting:start')
        return { ok: true, markdown: '# 다시 만든 회의 브리핑', model: 'claude-sonnet-5-5' }
      })

      const earlier = runLlmSerialized(async () => {
        log.push('today:start')
        await gate.promise
        log.push('today:reject')
        throw new Error('오늘 브리핑 실패')
      })
      const regenerated = regenerateMeetingBriefing(n.eventId, MON_1002)
      await new Promise((r) => setTimeout(r, 5))
      expect(log).toEqual(['today:start'])
      gate.resolve()
      await expect(earlier).rejects.toThrow('오늘 브리핑 실패')
      await regenerated
      expect(log).toEqual(['today:start', 'today:reject', 'meeting:start'])
      expect(payloadOf(n.eventId).llmStatus).toBe('done')
    })
  })

  describe('regenerateMeetingBriefing', () => {
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
