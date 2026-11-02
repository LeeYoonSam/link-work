// 논리 날짜·자동 닫기 대상·시작 알림 판정 (docs/ASSISTANT.md §6).
// 순수 모듈이다 (A3). 날짜·시각 형식은 A12 를 따른다.
import type { AssistantSettings, DailyPlan } from './assistant-types'

export type NudgeTrigger = 'unlock-screen' | 'resume' | 'focus'

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DEFAULT_ROLLOVER = '04:00'
const DAY_MS = 24 * 60 * 60 * 1000

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// 'YYYY-MM-DD' → UTC 자정 ms. 형식이 틀리면 throw 한다.
function dateToUtcMs(date: string): number {
  const m = DATE_RE.exec(date)
  if (!m) throw new Error(`날짜 형식이 올바르지 않습니다: ${date}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

export function toLocalDateTime(d: Date): string {
  return `${toLocalDate(d)} ${toHHmm(d)}:${pad2(d.getSeconds())}`
}

export function toHHmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// 현재 시각이 날짜 경계보다 이르면 전날이다. 경계 형식이 틀리면 04:00 을 쓴다.
export function logicalDate(now: Date, rollover: string): string {
  const boundary = TIME_RE.test(rollover) ? rollover : DEFAULT_ROLLOVER
  const today = toLocalDate(now)
  return toHHmm(now) < boundary ? addDays(today, -1) : today
}

// 시간대가 붙은 ISO 문자열 → 로컬 'YYYY-MM-DD HH:mm:ss'. 해석할 수 없으면 null 이다.
export function isoToLocalDateTime(iso: string): string | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null
  // Jira 는 '+0900' 처럼 콜론 없는 오프셋을 쓴다. Date 가 읽도록 '+09:00' 으로 바꾼다.
  const normalized = iso.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
  const ms = Date.parse(normalized)
  if (Number.isNaN(ms)) return null
  return toLocalDateTime(new Date(ms))
}

export function addDays(date: string, n: number): string {
  const d = new Date(dateToUtcMs(date) + n * DAY_MS)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

// to − from 의 일수. to 가 이르면 음수다.
export function daysBetween(from: string, to: string): number {
  return Math.round((dateToUtcMs(to) - dateToUtcMs(from)) / DAY_MS)
}

// A18: 논리 날짜가 지난 active 계획의 id. 날짜·id 오름차순이다.
export function plansToAutoClose(
  plans: Pick<DailyPlan, 'id' | 'plan_date' | 'status'>[],
  today: string
): number[] {
  return plans
    .filter((p) => p.status === 'active' && p.plan_date < today)
    .slice()
    .sort((a, b) => (a.plan_date === b.plan_date ? a.id - b.id : a.plan_date < b.plan_date ? -1 : 1))
    .map((p) => p.id)
}

const NUDGE_TRIGGERS: readonly NudgeTrigger[] = ['unlock-screen', 'resume', 'focus']

// A22: §6.5 조건이 모두 참일 때만 참이다.
export function shouldSendStartNudge(input: {
  settings: AssistantSettings
  today: string
  weekday: number // 0=일 … 6=토
  hasPlanToday: boolean
  nudgeSentToday: boolean
  trigger: NudgeTrigger
}): boolean {
  const { settings, weekday, hasPlanToday, nudgeSentToday, trigger } = input
  if (!settings.enabled || !settings.startNudge) return false
  if (hasPlanToday || nudgeSentToday) return false
  if (weekday === 0 || weekday === 6) return false
  return NUDGE_TRIGGERS.includes(trigger)
}
