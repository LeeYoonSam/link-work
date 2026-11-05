// 자동 최신화 틱 판정 (docs/ASSISTANT.md 부록 E.2), 회의 전 브리핑 판정 (부록 I),
// 아침 자동 동기화 판정 (A54). 순수 모듈이다 (A3). 작업 경계 체크인은 제거됐다 (부록 L).
import { toMinutes } from './assistant-slots'
import type {
  DueMeetingBriefing,
  MeetingDecisionInput,
  MeetingRef,
  MorningSyncDecisionInput,
  MorningSyncPart,
  MorningSyncPartName,
  RefreshDecisionInput,
  RefreshMode
} from './assistant-types'

export const TICK_MS = 60_000
/** 깨어남이 캘린더 확인을 앞당기는 최소 간격. */
export const WAKE_MIN_GAP_MS = 120_000

function elapsed(nowMs: number, at: number | null, gapMs: number): boolean {
  return at === null || nowMs - at >= gapMs
}

/** A25. E.2.3 순서로 이번 틱의 mode 를 정한다. 할 일이 없으면 null. */
export function decideRefresh(input: RefreshDecisionInput): RefreshMode | null {
  const { nowMs, settings, times } = input
  if (!settings.enabled) return null
  if (!input.hasActivePlan) return null
  if (input.inFlight) return null

  let calendarDue = elapsed(nowMs, times.calendarAt, settings.refreshCalendarMin * 60_000)
  if (input.wake && elapsed(nowMs, times.calendarAt, WAKE_MIN_GAP_MS)) calendarDue = true
  // 깨어남은 Jira 주기를 앞당기지 않는다 (E.9)
  const jiraDue = elapsed(nowMs, times.jiraAt, settings.refreshJiraMin * 60_000)

  if (calendarDue && jiraDue) return 'full'
  if (calendarDue) return 'calendar'
  if (jiraDue) return 'jira'
  return null
}

// ── 공용 시각 계산 ──

/** 예정 시각보다 이만큼 늦으면 status 가 late 다 (H.2.2). */
export const LATE_AFTER_MIN = 2
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/

/** 'YYYY-MM-DD HH:mm:ss' → 로컬 epoch ms. 형식이 아니면 null. */
function parseLocalDateTime(text: string | null | undefined): number | null {
  if (!text) return null
  const m = DATE_TIME_RE.exec(text.trim())
  if (!m) return null
  const ms = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? '0')
  ).getTime()
  return Number.isFinite(ms) ? ms : null
}

/** 두 로컬 일시의 분 차이 (to − from). 소수가 나올 수 있다. 형식이 틀리면 NaN. */
export function minutesBetween(fromDateTime: string, toDateTime: string): number {
  const a = parseLocalDateTime(fromDateTime)
  const b = parseLocalDateTime(toDateTime)
  if (a === null || b === null) return Number.NaN
  return (b - a) / 60_000
}

// ── MVP5 회의 전 브리핑 (부록 I) ──

/** 하루에 보내는 회의 브리핑 수의 상한 (I.3.2). 설정으로 노출하지 않는다. */
export const MEETING_BRIEFING_DAILY_CAP = 6

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 로컬 epoch ms → 'YYYY-MM-DD HH:mm:ss'. */
function formatLocalDateTime(ms: number): string {
  const d = new Date(ms)
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  )
}

/** 'meeting_briefing:<date>:<id>'. 키는 캘린더 일정 id 다 (I.3.3). */
export function meetingEventKey(today: string, calendarEventId: string): string {
  return `meeting_briefing:${today}:${calendarEventId}`
}

/**
 * I.4 의 순서로 이번 틱의 회의 브리핑을 판정한다 (A47).
 * 창은 [시작 − lead, 시작) 이다. 창 뒤와 상한 초과는 skip 결과다. 창 전은 결과에 넣지 않는다.
 * 회의 중 여부를 보지 않는다. 입력을 바꾸지 않는다 (A14).
 */
export function computeDueMeetingBriefings(input: MeetingDecisionInput): DueMeetingBriefing[] {
  const { today, at, settings, meetings, events } = input

  // 1. 비서와 회의 브리핑이 모두 켜져 있다
  if (!settings.enabled || !settings.meetingBriefingEnabled) return []
  const nowMs = parseLocalDateTime(at)
  if (nowMs === null) return []

  // 2. startAt 오름차순. 시작 시각을 읽지 못하는 회의는 판정하지 않는다
  const sorted = meetings
    .map((meeting) => ({ meeting, startMs: parseLocalDateTime(meeting.startAt) }))
    .filter((m): m is { meeting: MeetingRef; startMs: number } => m.startMs !== null)
    .sort((a, b) => a.startMs - b.startMs)

  const existingKeys = new Set(events.map((e) => e.event_key))
  const sentToday = events.filter(
    (e) =>
      e.kind === 'meeting_briefing' && e.plan_date === today && (e.status === 'sent' || e.status === 'late')
  ).length

  const out: DueMeetingBriefing[] = []
  const seenKeys = new Set<string>()
  let sendCount = 0
  for (const { meeting, startMs } of sorted) {
    // 3. 같은 키의 행이 있으면 건너뛴다. 같은 id 가 입력에 두 번 있어도 1건만 판정한다
    const eventKey = meetingEventKey(today, meeting.id)
    if (existingKeys.has(eventKey) || seenKeys.has(eventKey)) continue
    seenKeys.add(eventKey)

    const scheduledMs = startMs - settings.meetingLeadMin * 60_000
    const scheduledAt = formatLocalDateTime(scheduledMs)

    // 4. 창이 지났다
    if (nowMs >= startMs) {
      out.push({ action: 'skip', meeting, eventKey, scheduledAt, reason: 'window' })
      continue
    }
    // 5. 창 전이다. 행을 만들지 않는다
    if (nowMs < scheduledMs) continue

    // 6. 하루 상한
    if (sentToday + sendCount >= MEETING_BRIEFING_DAILY_CAP) {
      out.push({ action: 'skip', meeting, eventKey, scheduledAt, reason: 'cap' })
      continue
    }

    // 7. 보낸다. 예정 시각보다 2분 이상 늦으면 late 다
    const late = (nowMs - scheduledMs) / 60_000 >= LATE_AFTER_MIN
    out.push({ action: 'send', meeting, eventKey, scheduledAt, late })
    sendCount += 1
  }
  return out
}

// ── 아침 자동 동기화 (A54) ──

/** failed 부분을 다시 시도하는 최소 간격(분). deferred 도 이 간격으로 다시 본다. */
export const MORNING_SYNC_RETRY_MIN = 30
/** 하루에 센 시도의 상한. 오프라인·deferred 는 세지 않는다. */
export const MORNING_SYNC_MAX_ATTEMPTS = 3
/** running 이 이보다 오래되면 failed 로 본다. 앱이 동기화 중에 꺼진 경우다. */
export const MORNING_SYNC_STALE_MIN = 15
/** 판정 순서다. 실행기도 이 순서로 실행한다. */
export const MORNING_SYNC_PARTS: readonly MorningSyncPartName[] = ['release', 'project']

// 마지막 시도 뒤 간격이 지났는지. 시각을 읽지 못하면 지났다고 본다
function retryGapPassed(part: MorningSyncPart, at: string): boolean {
  const last = part.finishedAt ?? part.startedAt
  if (!last) return true
  const gap = minutesBetween(last, at)
  return Number.isNaN(gap) || gap >= MORNING_SYNC_RETRY_MIN
}

function partDue(part: MorningSyncPart | null, at: string): boolean {
  if (part === null) return true
  switch (part.status) {
    case 'ok':
    case 'skipped':
      return false
    case 'deferred':
      return retryGapPassed(part, at)
    case 'running': {
      // 시작 시각을 읽지 못하는 running 도 낡은 것으로 본다
      const startedAt = part.startedAt
      const age = startedAt ? minutesBetween(startedAt, at) : Number.NaN
      const stale = Number.isNaN(age) || age >= MORNING_SYNC_STALE_MIN
      if (!stale) return false
      return part.attempts < MORNING_SYNC_MAX_ATTEMPTS && retryGapPassed(part, at)
    }
    case 'failed':
      return part.attempts < MORNING_SYNC_MAX_ATTEMPTS && retryGapPassed(part, at)
  }
}

/**
 * A54. 이번 틱에 실행할 아침 동기화 부분을 고른다. 없으면 빈 배열이다.
 * 꺼짐·진행 중·설정 시각 이전·새벽 논리 날짜이면 실행하지 않는다.
 * ok·skipped 는 다시 실행하지 않는다. failed 는 30분 간격으로 하루 3회까지 다시 한다.
 * 15분 넘은 running 은 failed 로 본다. 입력을 바꾸지 않는다 (A14).
 */
export function decideMorningSync(input: MorningSyncDecisionInput): MorningSyncPartName[] {
  const { settings, payload, at } = input
  if (!settings.morningSyncEnabled) return []
  if (input.inFlight) return []
  // 날짜 경계 전의 새벽은 전날이다. 전날 키로 실행하지 않는다
  if (input.today !== input.calendarDate) return []
  const now = toMinutes(input.nowHHmm)
  const start = toMinutes(settings.morningSyncTime)
  if (now === null || start === null || now < start) return []

  const parts = payload && payload.date === input.today ? payload : null
  return MORNING_SYNC_PARTS.filter((name) => partDue(parts ? parts[name] : null, at))
}
