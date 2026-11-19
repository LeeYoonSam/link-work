import { app } from 'electron'
import { getDatabase } from '../db/database'
import { getTodayEvents, isOwnCalendarEvent } from './google-calendar'
import { isConnected as isCalendarConnected } from './google-auth'
import { isHeadlessAvailable, runLlmSerialized } from './ai-headless'
import { collectMeetingContext, toMeetingRef } from './assistant-sources'
import { requestLlmMeetingBriefing, type MeetingLlmInput } from './assistant-briefing'
import { logicalDate, toLocalDateTime } from './assistant-day'
import { computeDueMeetingBriefings } from './assistant-schedule'
import { buildMeetingBriefing, hasMeetingContext, meetingNoticeText } from './assistant-meeting'
import {
  getEventById,
  insertEvent,
  listEventsByDate,
  readAssistantSettings,
  updateEventPayload,
  writeAssistantSettings
} from './assistant-store'
import type {
  AssistantChangedEvent,
  AssistantSettings,
  MeetingBriefingPayload,
  MeetingRef,
  SentMeetingNotice,
  TodayPayload
} from './assistant-types'

// 비서 흐름 조정 모듈이다. IPC 와 스케줄러가 이 파일만 부른다.
// A2: 이 파일은 비서 테이블과 assistant_* 설정만 쓴다. 원본(todos·meetings 등)은 쓰지 않는다.
// 부록 O(오늘 대시보드 개편, 2026-11-19): 하루 시작·퇴근·계획 항목 조작·후보·최신화·맥락 복구·명령 입력은
// 제거됐다. 2026-11-19 에 과거 계획 읽기·지난 계획 닫기도 뺐다(새 계획이 생기지 않는다. 테이블과 과거 행은 남는다).
// 남은 일: 오늘 화면 페이로드(getToday: 비서 이벤트·설정·연결 상태), 회의 전 브리핑, 설정.
// LLM 직렬화 줄은 ai-headless.ts(runLlmSerialized)에 있다.

type Db = ReturnType<typeof getDatabase>

let changedListener: ((e: AssistantChangedEvent) => void) | null = null
// 회의 브리핑 쓰기는 한 줄로 처리한다 (A15)
let writeChain: Promise<unknown> = Promise.resolve()

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn)
  writeChain = run.catch(() => undefined)
  return run
}
const backgroundTasks = new Set<Promise<void>>()

export function setAssistantChangedListener(fn: ((e: AssistantChangedEvent) => void) | null): void {
  changedListener = fn
}

function emitChanged(e: AssistantChangedEvent): void {
  try {
    changedListener?.(e)
  } catch (err) {
    console.error('[assistant] changed listener', err)
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function todayOf(db: Db, now: Date): { settings: AssistantSettings; today: string; at: string } {
  const settings = readAssistantSettings(db)
  const today = logicalDate(now, settings.dayRollover)
  const at = toLocalDateTime(now)
  return { settings, today, at }
}

function safeHeadlessAvailable(): boolean {
  try {
    return isHeadlessAvailable()
  } catch {
    return false
  }
}

// 연결 여부는 부를 때마다 실제 상태로 읽는다. 앱을 켠 뒤 연결·해제해도 바로 맞는다.
// 백업 복원 중 DB 가 닫혀 있으면 throw 하므로 false 로 본다 (A13)
function safeConnected(check: () => boolean): boolean {
  try {
    return check()
  } catch {
    return false
  }
}

// 오늘 화면이 읽는 값만 담는다(회의 브리핑 카드·설정·AI 사용 가능·캘린더 연결)
function buildPayload(db: Db, settings: AssistantSettings, today: string): TodayPayload {
  return {
    events: listEventsByDate(db, today),
    settings,
    aiAvailable: safeHeadlessAvailable(),
    calendarConnected: safeConnected(isCalendarConnected)
  }
}

/** 테스트용: 진행 중인 회의 브리핑 LLM 이 끝날 때까지 기다린다 */
export async function waitForAssistantBackground(): Promise<void> {
  while (backgroundTasks.size > 0) {
    await Promise.allSettled([...backgroundTasks])
  }
}

export async function getToday(now: Date = new Date()): Promise<TodayPayload> {
  const db = getDatabase()
  const { settings, today } = todayOf(db, now)
  return buildPayload(db, settings, today)
}

// ── 회의 전 브리핑 (부록 I) ──

const LLM_OFF_MESSAGE = 'AI 브리핑이 꺼져 있습니다. 비서 설정에서 켜세요.'
const HEADLESS_MISSING_MESSAGE = 'Claude Code 를 찾을 수 없습니다. 설치와 로그인을 확인하세요.'

function parseMeetingPayload(payload: string | null): MeetingBriefingPayload | null {
  if (payload === null) return null
  try {
    const p = JSON.parse(payload) as Partial<MeetingBriefingPayload> | null
    if (p === null || typeof p !== 'object') return null
    if (typeof p.ruleMarkdown !== 'string' || p.meeting === null || typeof p.meeting !== 'object') return null
    return p as MeetingBriefingPayload
  } catch {
    return null
  }
}

// 같은 행의 payload 에 LLM 결과만 덮어쓴다. 규칙 본문과 알림 문구는 그대로다 (A45)
function patchMeetingPayload(eventId: number, patch: Partial<MeetingBriefingPayload>): void {
  const db = getDatabase()
  const ev = getEventById(db, eventId)
  const prev = ev ? parseMeetingPayload(ev.payload) : null
  if (!prev) return
  updateEventPayload(db, eventId, JSON.stringify({ ...prev, ...patch }))
}

// 실패하면 이전 LLM 본문을 비운다. 카드의 배지·본문이 llmStatus 와 어긋나지 않게 한다
function meetingLlmFailed(error: string): Partial<MeetingBriefingPayload> {
  return { llmStatus: 'failed', llmError: error, llmMarkdown: null, llmModel: null, llmAt: null }
}

/**
 * 회의 브리핑 LLM 1회 (I.7). runLlmSerialized 줄(ai-headless) 안에서 부른다 (A32).
 * A45: 이 함수는 throw 하지 않는다. 실패는 payload 의 llmStatus·llmError 로만 남는다.
 */
async function runMeetingLlm(eventId: number, input: MeetingLlmInput, settings: AssistantSettings): Promise<void> {
  try {
    const r = await requestLlmMeetingBriefing(input, settings.llmModel)
    if (r.ok) {
      patchMeetingPayload(eventId, {
        llmStatus: 'done',
        llmMarkdown: r.markdown,
        llmModel: r.model,
        llmAt: toLocalDateTime(new Date()),
        llmError: null
      })
    } else {
      patchMeetingPayload(eventId, meetingLlmFailed(r.error))
    }
  } catch (err) {
    try {
      patchMeetingPayload(eventId, meetingLlmFailed(toMessage(err)))
    } catch {
      // DB 가 닫혔으면 기록을 건너뛴다
    }
  }
}

// A8·A45: 알림을 막지 않는다. 결과를 기다리지 않는다. 끝나면 카드를 다시 그리게 한다
function startBackgroundMeetingLlm(
  eventId: number,
  input: MeetingLlmInput,
  settings: AssistantSettings,
  date: string
): void {
  const task = runLlmSerialized(() => runMeetingLlm(eventId, input, settings)).finally(() => {
    backgroundTasks.delete(task)
    emitChanged({ date, reason: 'meeting' })
  })
  backgroundTasks.add(task)
}

const LOCAL_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

// 'YYYY-MM-DD HH:mm:ss' 의 논리 날짜다. 형식이 틀리면 null 이다
function logicalDateOfDateTime(dateTime: string, rollover: string): string | null {
  const m = LOCAL_DATE_TIME_RE.exec(dateTime)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
  return Number.isNaN(d.getTime()) ? null : logicalDate(d, rollover)
}

// I.3.1: notification.ts 가 데우는 5분 캐시다. 조회 실패는 이전 캐시로 나타난다. 예외도 '일정 없음' 으로 본다.
// 부록 O: 알림성 경로라 기본 캘린더 일정만 본다. 추가로 고른 캘린더(Tech 등)의 회의는
// 내가 참석하지 않는 회의일 수 있어 브리핑 대상·하루 상한 계산에서 뺀다
async function readTodayMeetings(): Promise<MeetingRef[]> {
  try {
    const events = await getTodayEvents()
    return events
      .filter(isOwnCalendarEvent)
      .map(toMeetingRef).filter((m): m is MeetingRef => m !== null)
  } catch (err) {
    console.error('[assistant] meeting calendar', err)
    return []
  }
}

/**
 * 회의 브리핑 판정·INSERT (I.9.1). show() 는 스케줄러가 한다 (A5).
 * 규칙 본문을 INSERT 한 뒤 알림 목록을 돌려주고, LLM 은 그 뒤 백그라운드로 돈다 (A45).
 */
export async function runDueMeetingBriefings(now?: Date): Promise<SentMeetingNotice[]> {
  // 꺼져 있으면 캘린더 캐시도 읽지 않는다
  const settings = readAssistantSettings(getDatabase())
  if (!settings.enabled || !settings.meetingBriefingEnabled) return []
  // 캘린더 조회는 줄 밖에서 한다. 일정이 0건인 날은 캐시가 적중하지 않아 매 틱 네트워크를 쓴다.
  // 줄 안에서 기다리면 사용자 쓰기가 그동안 막힌다
  const meetings = await readTodayMeetings()
  // 시각은 줄 안에서 잡는다. 앞선 최신화가 줄을 오래 잡아도 창 판정이 낡지 않는다 (H.16)
  return serialized(() => runDueMeetingBriefingsImpl(meetings, now ?? new Date()))
}

interface MeetingLlmJob { eventId: number; input: MeetingLlmInput }

async function runDueMeetingBriefingsImpl(meetings: MeetingRef[], now: Date): Promise<SentMeetingNotice[]> {
  const db = getDatabase()
  const { settings, today, at } = todayOf(db, now)
  // getTodayEvents 는 실제 날짜 기준이다. 논리 날짜가 오늘인 회의만 판정한다.
  // 이유: 날짜 경계 직전·직후 틱이 같은 회의를 서로 다른 날짜 키로 두 번 보내지 않게 한다
  const todays = meetings.filter((m) => logicalDateOfDateTime(m.startAt, settings.dayRollover) === today)
  // 줄 밖에서 읽은 뒤 설정이 꺼졌으면 판정이 빈 배열을 돌려준다
  const due = computeDueMeetingBriefings({
    today,
    at,
    settings: {
      enabled: settings.enabled,
      meetingBriefingEnabled: settings.meetingBriefingEnabled,
      meetingLeadMin: settings.meetingLeadMin
    },
    meetings: todays,
    events: listEventsByDate(db, today)
  })
  if (due.length === 0) return []

  const llmReady = settings.llmEnabled && safeHeadlessAvailable()

  const sent: SentMeetingNotice[] = []
  const jobs: MeetingLlmJob[] = []
  for (const d of due) {
    try {
      if (d.action === 'skip') {
        // A47: 창 밖·상한 초과는 skipped 행이다. 다음 틱이 같은 회의를 다시 보지 않는다
        insertEvent(db, {
          event_key: d.eventKey,
          kind: 'meeting_briefing',
          plan_date: today,
          scheduled_at: d.scheduledAt,
          fired_at: null,
          status: 'skipped',
          ref_id: d.meeting.id,
          payload: JSON.stringify({ reason: d.reason })
        })
        continue
      }

      // A46: DB 읽기만 한다. throw 하지 않는다
      const ctx = collectMeetingContext(db, d.meeting)
      const ruleMarkdown = buildMeetingBriefing(ctx)
      const notice = meetingNoticeText(ctx, settings.meetingLeadMin)
      const hasContext = hasMeetingContext(ctx)
      // I-7: 자료가 없으면 LLM 을 부르지 않는다
      const willLlm = hasContext && llmReady
      const payload: MeetingBriefingPayload = {
        meeting: d.meeting,
        title: notice.title,
        body: notice.body,
        hasContext,
        ruleMarkdown,
        llmStatus: willLlm ? 'pending' : 'off',
        llmMarkdown: null,
        llmModel: null,
        llmAt: null,
        llmError: null
      }
      // A45: 규칙 본문을 먼저 저장한다
      const ev = insertEvent(db, {
        event_key: d.eventKey,
        kind: 'meeting_briefing',
        plan_date: today,
        scheduled_at: d.scheduledAt,
        fired_at: at,
        status: d.late ? 'late' : 'sent',
        ref_id: d.meeting.id,
        payload: JSON.stringify(payload)
      })
      // A5: UNIQUE 충돌이면 이미 처리한 회의다. 보내지 않는다
      if (!ev) continue
      sent.push({ eventId: ev.id, title: notice.title, body: notice.body, focus: { kind: 'meeting', id: String(ev.id) } })
      if (willLlm) jobs.push({ eventId: ev.id, input: { ctx, ruleMarkdown } })
    } catch (err) {
      // 회의 1건의 실패가 다음 회의를 막지 않는다
      console.error('[assistant] meeting briefing', err)
    }
  }

  if (sent.length > 0) emitChanged({ date: today, reason: 'meeting' })
  for (const job of jobs) startBackgroundMeetingLlm(job.eventId, job.input, settings, today)
  return sent
}

/**
 * 회의 브리핑 AI 본문 다시 만들기 (I.7, I.11.8). 버튼은 결과를 기다린다.
 * 규칙 본문은 그대로 남는다. 맥락은 지금 DB 로 다시 수집한다.
 */
export async function regenerateMeetingBriefing(eventId: number, now?: Date): Promise<TodayPayload> {
  if (typeof eventId !== 'number' || !Number.isInteger(eventId)) throw new Error('회의 브리핑 ID 가 올바르지 않습니다.')
  const t = now ?? new Date()
  const db = getDatabase()
  const { settings, today } = todayOf(db, t)
  const ev = getEventById(db, eventId)
  if (!ev || ev.kind !== 'meeting_briefing' || ev.status === 'skipped') throw new Error('회의 브리핑을 찾을 수 없습니다.')
  const payload = parseMeetingPayload(ev.payload)
  if (!payload) throw new Error('회의 브리핑 내용을 읽을 수 없습니다.')
  if (!settings.llmEnabled) throw new Error(LLM_OFF_MESSAGE)
  if (!safeHeadlessAvailable()) {
    patchMeetingPayload(eventId, meetingLlmFailed(HEADLESS_MISSING_MESSAGE))
    emitChanged({ date: today, reason: 'meeting' })
    return buildPayload(db, settings, today)
  }

  const ctx = collectMeetingContext(db, payload.meeting)
  // 카드가 진행 상태를 보이게 한다. 이전 본문은 결과가 올 때까지 둔다
  patchMeetingPayload(eventId, { llmStatus: 'pending', llmError: null })
  emitChanged({ date: today, reason: 'meeting' })
  await runLlmSerialized(() => runMeetingLlm(eventId, { ctx, ruleMarkdown: payload.ruleMarkdown }, settings))
  emitChanged({ date: today, reason: 'meeting' })
  return buildPayload(getDatabase(), settings, today)
}

export function getSettings(): AssistantSettings {
  return readAssistantSettings(getDatabase())
}

export function saveSettings(patch: unknown): AssistantSettings {
  const db = getDatabase()
  const before = readAssistantSettings(db)
  const after = writeAssistantSettings(db, patch)
  if (before.openAtLogin !== after.openAtLogin) {
    try {
      app.setLoginItemSettings({ openAtLogin: after.openAtLogin })
    } catch (err) {
      console.error('[assistant] setLoginItemSettings', err)
    }
  }
  return after
}
