// 아침 자동 동기화 실행기 (docs/ASSISTANT.md A54, docs/PROJECT_SYNC.md R11, docs/RELEASE_NOTES.md §1).
// 스케줄러 틱의 onTick 으로 돈다. 새 타이머를 만들지 않는다.
// 하루 1회는 assistant_events 의 morning_sync:<날짜> 행 1개로 보장한다. 부분 상태는 payload 에 둔다.
// A13: 이 모듈의 실행기는 throw 하지 않는다. 부분마다 try/catch 로 실패를 격리한다.
// 이름에 assistant- 를 붙이지 않는다. 이유: A2 grep 대상은 원본 테이블을 쓰면 안 되는데, 싱크업은 projects 를 쓴다.
import { BrowserWindow, net } from 'electron'
import { getDatabase } from '../db/database'
import { logicalDate, toLocalDateTime } from './assistant-day'
import { decideMorningSync } from './assistant-schedule'
import {
  findEventByKey,
  findLatestEventByKind,
  insertEvent,
  readAssistantSettings,
  updateEventPayload
} from './assistant-store'
import type {
  AssistantSettings,
  MorningSyncPart,
  MorningSyncPartName,
  MorningSyncPartStatus,
  MorningSyncPayload,
  MorningSyncStatus
} from './assistant-types'
import { getDefaultJiraProjectKey, isJiraConnected } from './jira'
import { refreshAllJiraProjects, runAutoProjectSync } from './project-sync'
import { syncAllReleases } from './release-note-sync'

const PART_STATUSES: readonly MorningSyncPartStatus[] = ['running', 'ok', 'skipped', 'failed', 'deferred']
const NOT_CONNECTED_TEXT = 'Jira 에 연결되어 있지 않습니다.'
const NO_DEFAULT_KEY_TEXT = 'Jira 기본 프로젝트가 설정되지 않았습니다.'
const INTERRUPTED_TEXT = '동기화가 중단되었습니다.'

// 실행기는 동시에 1개만 돈다. 틱과 wake 가 겹쳐도 두 번째는 바로 돌아간다
let inFlight = false

type Db = ReturnType<typeof getDatabase>

/** 실행 결과에서 시각·시도 수를 뺀 부분이다. */
type PartOutcome = Pick<
  MorningSyncPart,
  'status' | 'error' | 'newCount' | 'updatedCount' | 'reviewCount' | 'failedCount'
>

interface Claimed {
  eventId: number
  payload: MorningSyncPayload
  parts: MorningSyncPartName[]
  prevAttempts: Record<MorningSyncPartName, number>
}

function logError(where: string, err: unknown): void {
  console.error(`[morning-sync] ${where}`, err)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function morningSyncEventKey(date: string): string {
  return `morning_sync:${date}`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function intOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

function strOf(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function parsePart(v: unknown): MorningSyncPart | null {
  if (!isRecord(v)) return null
  const status = v.status as MorningSyncPartStatus
  if (!PART_STATUSES.includes(status)) return null
  return {
    status,
    attempts: intOf(v.attempts),
    startedAt: strOf(v.startedAt),
    finishedAt: strOf(v.finishedAt),
    error: strOf(v.error),
    newCount: intOf(v.newCount),
    updatedCount: intOf(v.updatedCount),
    reviewCount: intOf(v.reviewCount),
    failedCount: intOf(v.failedCount)
  }
}

/** payload 문자열을 읽는다. 형식이 틀리면 null 이다. */
export function parseMorningSyncPayload(raw: string | null | undefined, date: string): MorningSyncPayload | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (!isRecord(v)) return null
    return {
      date: typeof v.date === 'string' ? v.date : date,
      release: parsePart(v.release),
      project: parsePart(v.project)
    }
  } catch {
    return null
  }
}

function runningPart(prev: MorningSyncPart | null, at: string): MorningSyncPart {
  return {
    status: 'running',
    attempts: (prev?.attempts ?? 0) + 1,
    startedAt: at,
    finishedAt: null,
    error: null,
    newCount: 0,
    updatedCount: 0,
    reviewCount: 0,
    failedCount: 0
  }
}

function emptyOutcome(status: MorningSyncPartStatus, error: string | null = null): PartOutcome {
  return { status, error, newCount: 0, updatedCount: 0, reviewCount: 0, failedCount: 0 }
}

// 오프라인은 시도가 아니다 (D8). 판정할 수 없으면 온라인으로 본다
function isOnline(): boolean {
  try {
    return net.isOnline()
  } catch (err) {
    logError('isOnline', err)
    return true
  }
}

/** 열린 창이 상태 줄을 다시 읽게 한다. 렌더러는 sync_status 를 받으면 아침 동기화 상태를 다시 읽는다. */
function notifySyncStatus(): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('ai:dataChanged', { entity: 'sync_status' })
    }
  } catch (err) {
    logError('notify', err)
  }
}

interface DayContext {
  settings: AssistantSettings
  today: string
  at: string
}

function dayContext(db: Db, now: Date): DayContext {
  const settings = readAssistantSettings(db)
  return { settings, today: logicalDate(now, settings.dayRollover), at: toLocalDateTime(now) }
}

function decide(ctx: DayContext, payload: MorningSyncPayload | null): MorningSyncPartName[] {
  return decideMorningSync({
    today: ctx.today,
    calendarDate: ctx.at.slice(0, 10),
    nowHHmm: ctx.at.slice(11, 16),
    at: ctx.at,
    settings: ctx.settings,
    // 호출자가 inFlight 를 먼저 확인한다. 판정 시점에는 늘 false 다
    inFlight: false,
    payload
  })
}

/**
 * 오늘 행을 선점한다. 행이 없으면 INSERT 하고, 충돌이면 null 이다 (A5).
 * 행이 있으면 같은 트랜잭션 안에서 다시 판정한 뒤 고른 부분을 running 으로 바꾼다.
 */
function claim(db: Db, ctx: DayContext): Claimed | null {
  return db.transaction((): Claimed | null => {
    const key = morningSyncEventKey(ctx.today)
    const ev = findEventByKey(db, key)
    const prev = ev ? parseMorningSyncPayload(ev.payload, ctx.today) : null
    const current = prev && prev.date === ctx.today ? prev : null
    const parts = decide(ctx, current)
    if (parts.length === 0) return null

    const payload: MorningSyncPayload = {
      date: ctx.today,
      release: current?.release ?? null,
      project: current?.project ?? null
    }
    const prevAttempts: Record<MorningSyncPartName, number> = {
      release: payload.release?.attempts ?? 0,
      project: payload.project?.attempts ?? 0
    }
    for (const name of parts) payload[name] = runningPart(payload[name], ctx.at)

    if (!ev) {
      const row = insertEvent(db, {
        event_key: key,
        kind: 'morning_sync',
        plan_date: ctx.today,
        scheduled_at: `${ctx.today} ${ctx.settings.morningSyncTime}:00`,
        fired_at: ctx.at,
        status: 'logged',
        ref_id: null,
        payload: JSON.stringify(payload)
      })
      // 같은 키를 다른 경로가 먼저 만들었다. 실행하지 않는다
      if (!row) return null
      return { eventId: row.id, payload, parts, prevAttempts }
    }
    updateEventPayload(db, ev.id, JSON.stringify(payload))
    return { eventId: ev.id, payload, parts, prevAttempts }
  })()
}

function skipReason(): string | null {
  if (!isJiraConnected()) return NOT_CONNECTED_TEXT
  if (!getDefaultJiraProjectKey()) return NO_DEFAULT_KEY_TEXT
  return null
}

async function runReleasePart(): Promise<PartOutcome> {
  const skip = skipReason()
  if (skip) return emptyOutcome('skipped', skip)
  const r = await syncAllReleases()
  // linked 는 이번 동기화가 새로 만든 릴리스 수다
  const linked = intOf(r.linked)
  const ok = r.synced.length + r.metaOnly.length
  // 받은 릴리스가 하나도 없고 실패만 있으면 이번 시도는 실패다
  if (ok === 0 && r.failed.length > 0) {
    return { ...emptyOutcome('failed', r.failed[0].error), failedCount: r.failed.length }
  }
  return {
    status: 'ok',
    error: null,
    newCount: linked,
    updatedCount: r.synced.length,
    reviewCount: 0,
    failedCount: r.failed.length
  }
}

/**
 * R11 자동 싱크업 결과(AutoProjectSyncOutcome)를 부분 결과로 바꾼다.
 * deferred 이면 deferred 다. applied 이면 result 의 created·updated 와 needsReview 를 센다.
 * 다른 모듈의 결과라 형식을 믿지 않는다. 틀린 값은 0 으로 센다.
 */
export function toProjectOutcome(r: unknown): PartOutcome {
  if (!isRecord(r)) return emptyOutcome('ok')
  if (r.status === 'deferred' || r.deferred === true) return emptyOutcome('deferred')
  const nested = r.result
  const result = isRecord(nested) ? nested : r
  const needsReview = r.needsReview
  const review = Array.isArray(needsReview) ? needsReview.length : intOf(needsReview)
  return {
    status: 'ok',
    error: null,
    newCount: intOf(result.created),
    updatedCount: intOf(result.updated),
    reviewCount: review,
    failedCount: 0
  }
}

/**
 * R11 자동 싱크업 뒤에 R12 Jira 연결 작업 새로고침을 한다.
 * R11 이 deferred 여도 R12 는 돈다. R12 는 미리보기 캐시를 건드리지 않는다.
 * 부분 결과의 수는 R11 결과로만 센다.
 * R12 가 throw 하면 이 부분은 failed 다. 이때도 R11 의 수는 남긴다. R11 은 이미 적용되었기 때문이다.
 * R11 이 throw 하면 R12 를 부르지 않는다. 호출자가 failed 로 기록한다.
 */
async function runProjectPart(): Promise<PartOutcome> {
  const skip = skipReason()
  if (skip) return emptyOutcome('skipped', skip)
  const r11 = toProjectOutcome(await runAutoProjectSync())
  try {
    await refreshAllJiraProjects()
  } catch (err) {
    logError('project R12', err)
    return { ...r11, status: 'failed', error: messageOf(err) }
  }
  return r11
}

function writePayload(eventId: number, payload: MorningSyncPayload): void {
  try {
    // 동기화를 기다리는 사이 DB 가 바뀌었을 수 있다. 다시 연결해 기록한다
    updateEventPayload(getDatabase(), eventId, JSON.stringify(payload))
  } catch (err) {
    logError('write payload', err)
  }
}

async function runClaimed(claimed: Claimed, clock: () => Date): Promise<void> {
  const { payload } = claimed
  for (const name of claimed.parts) {
    let outcome: PartOutcome
    try {
      outcome = name === 'release' ? await runReleasePart() : await runProjectPart()
    } catch (err) {
      // 토큰 만료·네트워크 오류는 failed 다 (D8)
      logError(name, err)
      outcome = emptyOutcome('failed', messageOf(err))
    }
    const started = payload[name]
    payload[name] = {
      ...outcome,
      // deferred 는 시도로 세지 않는다
      attempts: outcome.status === 'deferred' ? claimed.prevAttempts[name] : (started?.attempts ?? 1),
      startedAt: started?.startedAt ?? null,
      finishedAt: toLocalDateTime(clock())
    }
    writePayload(claimed.eventId, payload)
    notifySyncStatus()
  }
}

/**
 * 틱·wake 마다 부른다 (onTick). 할 일이 없으면 바로 돌아간다.
 * 순서: 진행 중 확인 → 판정 → 온라인 확인 → 선점 → 부분별 실행 → payload 기록 → sync_status 발송.
 * now 는 테스트가 주입하는 시각이다. 이 함수는 throw 하지 않는다 (A13).
 */
export async function runMorningSyncIfDue(wake: boolean = false, now?: Date): Promise<void> {
  if (inFlight) return
  const clock = (): Date => now ?? new Date()
  try {
    const db = getDatabase()
    const ctx = dayContext(db, clock())
    const ev = findEventByKey(db, morningSyncEventKey(ctx.today))
    const parts = decide(ctx, ev ? parseMorningSyncPayload(ev.payload, ctx.today) : null)
    if (parts.length === 0) return
    // 오프라인이면 선점하지 않는다. 시도 수가 늘지 않는다
    if (!isOnline()) return

    inFlight = true
    try {
      const claimed = claim(db, ctx)
      if (!claimed) return
      notifySyncStatus()
      await runClaimed(claimed, clock)
    } finally {
      inFlight = false
    }
  } catch (err) {
    logError(`run${wake ? '(wake)' : ''}`, err)
  }
}

/**
 * 화면 상태 줄이 읽는 마지막 아침 동기화 상태다. 읽기 전용이다.
 * 이 프로세스가 실행 중이 아닌데 running 이면 앱이 동기화 중에 꺼졌다. 화면에는 failed 로 보여 준다.
 */
export function getMorningSyncStatus(): MorningSyncStatus {
  const db = getDatabase()
  const settings = readAssistantSettings(db)
  const ev = findLatestEventByKind(db, 'morning_sync')
  const payload = ev ? parseMorningSyncPayload(ev.payload, ev.plan_date) : null
  const view = (p: MorningSyncPart | null): MorningSyncPart | null =>
    p && p.status === 'running' && !inFlight ? { ...p, status: 'failed', error: INTERRUPTED_TEXT } : p
  return {
    enabled: settings.morningSyncEnabled,
    at: settings.morningSyncTime,
    inFlight,
    date: ev ? ev.plan_date : null,
    release: view(payload?.release ?? null),
    project: view(payload?.project ?? null)
  }
}
