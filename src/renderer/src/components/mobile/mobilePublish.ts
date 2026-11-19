// 오늘 대시보드를 휴대폰용 스냅샷으로 만들어 메인에 올리는 로직 (docs/MOBILE_VIEW.md).
// 조립은 오늘 화면(TodayView)과 같은 입력·같은 순수 함수(todayModel)로 한다.
// 이 파일은 React 를 쓰지 않는다. 시계·타이머·발행·스토어 구독은 deps 로 받아 테스트가 바꿔 끼운다.
import type { MobileTodaySnapshot } from '../../mobile/contract'
import { buildTodayDashboard, type TodayDashboard, type TodayModelInput } from '../today/todayModel'
import { dateHeading } from '../today/TodayView'

/** 스토어가 바뀐 뒤 발행까지 기다리는 시간 */
export const PUBLISH_DEBOUNCE_MS = 500
/** 내용이 같아도 다시 발행하는 간격. 일정의 timing·'n분 뒤' 가 시간에 따라 바뀐다 */
export const PUBLISH_TICK_MS = 60_000
/** 휴대폰 요청으로 오늘 데이터를 다시 불러오는 최소 간격. 이보다 잦으면 현재 상태만 발행한다 */
export const RELOAD_MIN_INTERVAL_MS = 30_000

/** 오늘 화면이 쓰는 스토어 값 묶음 (TodayView 의 입력과 같다) */
export interface MobileTodayInputs extends Omit<TodayModelInput, 'now'> {
  /** 오늘 스토어가 불러오는 중 */
  loading: boolean
  /** 오늘 스토어가 한 번이라도 불러오기를 마쳤는가(lastSyncedAt !== null) */
  synced: boolean
}

/** 규칙 문구 그대로의 대시보드. 계약 밖의 선택 필드(facts)는 크기를 줄이려고 뺀다 */
export function mobileDashboard(d: TodayDashboard): TodayDashboard {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { facts, ...rest } = d
  return { ...rest, hiddenSignals: d.hiddenSignals ?? [] }
}

export function buildMobileSnapshot(inputs: MobileTodayInputs, now: Date): MobileTodaySnapshot {
  const { loading, synced, ...model } = inputs
  const dashboard = mobileDashboard(buildTodayDashboard({ ...model, now }))
  return {
    v: 1,
    publishedAt: now.toISOString(),
    date: dashboard.date,
    heading: dateHeading(now),
    dashboard,
    // 첫 로드 전(스토어가 비어 있음)도 불러오는 중으로 보인다
    loading: loading || !synced
  }
}

/** 발행 시각을 뺀 비교용 문자열. 내용이 같으면 다시 올리지 않는다 */
export function snapshotKey(s: MobileTodaySnapshot): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { publishedAt, ...rest } = s
  return JSON.stringify(rest)
}

export interface MobilePublisherDeps {
  readInputs: () => MobileTodayInputs
  publish: (snapshot: MobileTodaySnapshot) => Promise<unknown>
  /** 메인의 재발행 요청 구독. 해제 함수를 돌려준다 */
  onPublishRequested: (cb: () => void) => () => void
  /** 오늘 스토어들의 변경 구독. 해제 함수를 돌려준다 */
  subscribeStores: (cb: () => void) => () => void
  /** 오늘 데이터를 캐시 허용으로 다시 불러온다(refresh 가 아니다) */
  reload: () => Promise<void>
  now?: () => Date
}

export interface MobilePublisher {
  stop: () => void
}

/**
 * 켜진 동안 오늘 대시보드를 발행한다.
 * (a) 시작 직후 1회 (b) 스토어가 바뀌면 500ms 뒤, 내용이 다를 때만 (c) 60초마다 (d) 메인의 재발행 요청 때.
 * headline·신호 문구는 오늘 화면과 같은 규칙 문구다(LLM 으로 다듬지 않는다).
 */
export function startMobilePublisher(deps: MobilePublisherDeps): MobilePublisher {
  const now = deps.now ?? (() => new Date())
  let stopped = false
  let lastKey: string | null = null
  let lastDate: string | null = null
  let lastReloadAt = Number.NEGATIVE_INFINITY
  let reloading: Promise<void> | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null

  const reload = (): Promise<void> => {
    if (reloading) return reloading
    lastReloadAt = now().getTime()
    reloading = deps
      .reload()
      .catch(() => undefined)
      .finally(() => {
        reloading = null
      })
    return reloading
  }

  const publishNow = (force: boolean): void => {
    if (stopped) return
    let snapshot: MobileTodaySnapshot
    try {
      snapshot = buildMobileSnapshot(deps.readInputs(), now())
    } catch {
      return
    }
    // 자정을 넘기면 오늘 범위의 일정을 다시 받는다(캐시 허용). 받은 뒤 스토어 변경으로 다시 발행된다
    if (lastDate !== null && snapshot.date !== lastDate) void reload()
    lastDate = snapshot.date
    const key = snapshotKey(snapshot)
    if (!force && key === lastKey) return
    lastKey = key
    deps.publish(snapshot).catch(() => undefined)
  }

  const schedule = (): void => {
    if (stopped) return
    if (debounce !== null) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      publishNow(false)
    }, PUBLISH_DEBOUNCE_MS)
  }

  const onRequested = async (): Promise<void> => {
    if (stopped) return
    const inputs = deps.readInputs()
    if (!inputs.loading && now().getTime() - lastReloadAt >= RELOAD_MIN_INTERVAL_MS) await reload()
    publishNow(true)
  }

  const unsubStores = deps.subscribeStores(schedule)
  const unsubRequested = deps.onPublishRequested(() => void onRequested())
  const tick = setInterval(() => publishNow(true), PUBLISH_TICK_MS)

  publishNow(true)
  // 오늘 화면을 아직 열지 않아 스토어가 비어 있으면 한 번 불러온다
  const first = deps.readInputs()
  if (!first.synced && !first.loading) void reload()

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      if (debounce !== null) clearTimeout(debounce)
      debounce = null
      clearInterval(tick)
      unsubStores()
      unsubRequested()
    }
  }
}
