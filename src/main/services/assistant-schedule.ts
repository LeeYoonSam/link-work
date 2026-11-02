// 자동 최신화 틱 판정 (docs/ASSISTANT.md 부록 E.2)과 작업 경계 체크인 판정 (부록 H). 순수 모듈이다 (A3).
import { isInMeeting } from './assistant-refresh'
import { buildTimeline, fromMinutes, MIN_ASSIGN_MIN, toMinutes } from './assistant-slots'
import type {
  CheckinDecisionInput,
  DueCheckin,
  RefreshDecisionInput,
  RefreshMode,
  TimelineEntry
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

// ── MVP4 작업 경계 체크인 (부록 H) ──

/** 블록 끝보다 몇 분 앞에 묻는지 (H.2.1). */
export const CHECKIN_LEAD_MIN = 5
/** 이 시간 안에 항목 상태가 바뀌었으면 묻지 않는다 (H.3 조건 8, A44). */
export const CHECKIN_RECENT_STATUS_MIN = 15
/** 예정 시각보다 이만큼 늦으면 status 가 late 다 (H.2.2). */
export const LATE_AFTER_MIN = 2
/** 알림 제목에 넣는 항목 제목의 최대 글자 수 (H.6.1). */
export const CHECKIN_TITLE_MAX = 30
const CHECKIN_BODY = '지금까지 어떻게 됐나요? 답장하거나 눌러서 고르세요.'
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/

type BlockEntry = Extract<TimelineEntry, { kind: 'block' }>

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

/** 'checkin:<date>:<HHmm>'. 키에 항목 id 를 넣지 않는다 (H.4). */
export function checkinEventKey(today: string, blockEnd: string): string {
  return `checkin:${today}:${blockEnd.replace(':', '')}`
}

/** 알림 제목·본문 (H.6.1). 제목의 항목 제목은 30자를 넘으면 자르고 '…' 를 붙인다. */
export function checkinNoticeText(itemTitle: string): { title: string; body: string } {
  const flat = itemTitle.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  const clipped = chars.length > CHECKIN_TITLE_MAX ? `${chars.slice(0, CHECKIN_TITLE_MAX).join('')}…` : flat
  return { title: `체크인: ${clipped}`, body: CHECKIN_BODY }
}

function findBlock(entries: TimelineEntry[], pred: (b: BlockEntry) => boolean): BlockEntry | null {
  for (const e of entries) {
    if (e.kind === 'block' && pred(e)) return e
  }
  return null
}

/**
 * H.3 의 9단계로 이번 틱의 체크인을 판정한다. 보낼 것이 없으면 null.
 * 창 밖이면 null 이고 skipped 행을 만들지 않는다 (A41). 입력을 바꾸지 않는다 (A14).
 */
export function computeDueCheckin(input: CheckinDecisionInput): DueCheckin | null {
  const { today, nowHHmm, at, settings, items, events, calendar } = input

  // 1·2. 비서·체크인 켜짐, 근무 중 계획
  if (!settings.enabled || !settings.checkinEnabled) return null
  if (!input.planActive) return null

  // 3. 창 안의 current 블록과 대상 항목 (H.2.3)
  const now = toMinutes(nowHHmm)
  if (now === null) return null
  const base = { calendar, dayStart: input.dayStart, workEnd: input.workEnd, items, today, closed: false }
  const t0 = buildTimeline({ ...base, nowHHmm })
  const current = findBlock(t0.entries, (b) => b.state === 'current')
  if (!current) return null
  const end = toMinutes(current.end) as number
  const left = end - now
  if (left <= 0 || left > CHECKIN_LEAD_MIN) return null

  // 블록 끝 5분 전에는 남은 길이가 30분 미만이라 itemId 가 null 이다. 블록 끝 − 30분 시점의 배정을 쓴다.
  // 이 배정이 블록 진행 중 화면에 보인 항목이다.
  const t1 = buildTimeline({ ...base, nowHHmm: fromMinutes(end - MIN_ASSIGN_MIN) })
  const target = findBlock(t1.entries, (b) => b.end === current.end)
  if (!target || target.itemId === null) return null
  const itemId = target.itemId
  const item = items.find((it) => it.id === itemId)
  if (!item) return null

  // 4. 활성 항목만 묻는다
  if (item.status !== 'planned' && item.status !== 'in_progress') return null

  // 5. 회의 중이면 보내지 않는다 (A7)
  if (isInMeeting(calendar, nowHHmm)) return null

  // 6·7. 하루 상한과 최소 간격 (A7)
  const sent = events.filter(
    (e) => e.kind === 'checkin' && e.plan_date === today && (e.status === 'sent' || e.status === 'late')
  )
  if (sent.length >= settings.checkinDailyCap) return null
  let lastFired: string | null = null
  for (const e of sent) {
    if (parseLocalDateTime(e.fired_at) === null) continue
    if (lastFired === null || (e.fired_at as string) > lastFired) lastFired = e.fired_at
  }
  if (lastFired !== null) {
    const gap = minutesBetween(lastFired, at)
    if (!(gap >= settings.checkinMinGap)) return null
  }

  // 8. 최근 상태 변경이 있으면 보내지 않는다 (A44)
  for (const it of items) {
    if (parseLocalDateTime(it.status_at) === null) continue
    if (minutesBetween(it.status_at as string, at) < CHECKIN_RECENT_STATUS_MIN) return null
  }

  // 9. 같은 키의 행이 이미 있으면 보내지 않는다 (H.4)
  const eventKey = checkinEventKey(today, current.end)
  if (events.some((e) => e.event_key === eventKey)) return null

  const scheduledAt = `${today} ${fromMinutes(end - CHECKIN_LEAD_MIN)}:00`
  const late = minutesBetween(scheduledAt, at) >= LATE_AFTER_MIN
  const { title, body } = checkinNoticeText(item.title)
  return {
    eventKey,
    refId: String(itemId),
    scheduledAt,
    late,
    title,
    body,
    payload: {
      itemId,
      candidateId: item.candidate_id,
      itemTitle: item.title,
      blockStart: current.start,
      blockEnd: current.end,
      title,
      body
    }
  }
}
