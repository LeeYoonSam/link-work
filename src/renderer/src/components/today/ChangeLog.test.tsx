import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AssistantEvent, MorningSyncPart, MorningSyncStatus } from '../../types'

// 아침 동기화 줄의 위치·시각·중단 표시를 검증한다 (ASSISTANT A54 K.3, PROJECT_SYNC R11).
// zustand v5 는 서버 렌더에서 초기 상태만 돌려준다. 그래서 스토어 훅을 모킹한다
const store: { status: MorningSyncStatus | null } = { status: null }
vi.mock('../../stores/morningSyncStore', () => {
  const useMorningSyncStore = Object.assign(
    <T,>(selector: (s: typeof store) => T): T => selector(store),
    { getState: () => store }
  )
  return { useMorningSyncStore }
})

const ChangeLog = (await import('./ChangeLog')).default
const { describeMorningSync, morningSyncTime, resolveMorningPart, parseMorningPart, MORNING_INTERRUPTED_TEXT } =
  await import('./ChangeLog')

// 문자열을 거쳐 바꾼다. 이유: 이전 타입 정의에도 컴파일된다
const MORNING = 'morning_sync' as string as AssistantEvent['kind']

const event = (over: Partial<AssistantEvent> & Pick<AssistantEvent, 'id'>): AssistantEvent => ({
  event_key: `plan_update:2026-11-02:${over.id}`,
  kind: 'plan_update',
  plan_date: '2026-11-02',
  scheduled_at: '2026-11-02 10:42:00',
  fired_at: null,
  status: 'logged',
  ref_id: null,
  payload: null,
  response: null,
  responded_at: null,
  created_at: '2026-11-02 10:42:00',
  ...over
})

const part = (over: Partial<MorningSyncPart> = {}): MorningSyncPart => ({
  status: 'ok',
  attempts: 1,
  startedAt: '2026-11-02 08:01:00',
  finishedAt: '2026-11-02 08:01:40',
  error: null,
  newCount: 0,
  updatedCount: 0,
  reviewCount: 0,
  failedCount: 0,
  ...over
})

const morning = (body: Partial<Record<'release' | 'project', MorningSyncPart>>): AssistantEvent =>
  event({
    id: 50,
    event_key: 'morning_sync:2026-11-02',
    kind: MORNING,
    scheduled_at: '2026-11-02 08:00:00',
    fired_at: '2026-11-02 08:01:10',
    payload: JSON.stringify(body)
  })

const status = (over: Partial<MorningSyncStatus> = {}): MorningSyncStatus => ({
  enabled: true,
  at: '08:00',
  inFlight: false,
  date: '2026-11-02',
  release: null,
  project: null,
  ...over
})

const RUNNING = part({ status: 'running', startedAt: '2026-11-02 08:01:00', finishedAt: null })

beforeEach(() => {
  store.status = null
})

describe('아침 동기화 줄 위치와 시각 (A54 K.3)', () => {
  it('ChangeLog: 아침 동기화 줄은 더 이른 기록보다도 맨 위에 있다', () => {
    const html = renderToStaticMarkup(
      <ChangeLog
        events={[
          event({ id: 1, fired_at: '2026-11-02 07:30:00', payload: JSON.stringify({ calendarAdded: 1 }) }),
          event({ id: 2, kind: 'command', fired_at: '2026-11-02 07:40:00', payload: JSON.stringify({ text: '끝', applied: 1 }) }),
          morning({ release: part({ newCount: 2 }) })
        ]}
      />
    )
    const items = [...html.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map((m) => m[1])
    expect(items).toHaveLength(3)
    expect(items[0]).toContain('아침 동기화')
    expect(items[1]).toContain('07:30')
    expect(items[2]).toContain('07:40')
  })

  it('morningSyncTime: 부분 finishedAt 중 가장 늦은 값을 쓴다. 없으면 fired_at 이다', () => {
    // 재시도가 09:01 에 성공했다. fired_at 은 첫 선점 시각 08:01 이다
    const retried = morning({
      release: part({ finishedAt: '2026-11-02 08:01:40' }),
      project: part({ attempts: 2, startedAt: '2026-11-02 09:00:30', finishedAt: '2026-11-02 09:01:05' })
    })
    expect(morningSyncTime(retried)).toBe('2026-11-02 09:01:05')
    expect(describeMorningSync(retried)).toBe('09:01 아침 동기화 · 릴리스 변경 없음 · 프로젝트 변경 없음')
    expect(morningSyncTime(morning({ release: RUNNING }))).toBe('2026-11-02 08:01:10')
    expect(morningSyncTime({ ...morning({}), payload: '{깨짐' })).toBe('2026-11-02 08:01:10')
  })
})

describe('중단된 아침 동기화 표시 (A54, R11)', () => {
  it('ChangeLog: inFlight 가 false 인데 running 이면 실패(중단)로 보인다', () => {
    store.status = status({ release: { ...RUNNING, status: 'failed', error: MORNING_INTERRUPTED_TEXT } })
    const html = renderToStaticMarkup(<ChangeLog events={[morning({ release: RUNNING })]} />)
    expect(html).toContain('08:01 아침 동기화 · 릴리스 실패 (동기화가 중단되었습니다.)')
    expect(html).not.toContain('진행 중')
  })

  it('ChangeLog: inFlight 가 true 이거나 스토어 상태를 모르면 진행 중이다', () => {
    const events = [morning({ release: RUNNING })]
    store.status = status({ inFlight: true, release: RUNNING })
    expect(renderToStaticMarkup(<ChangeLog events={events} />)).toContain('릴리스 진행 중')
    store.status = null
    expect(renderToStaticMarkup(<ChangeLog events={events} />)).toContain('릴리스 진행 중')
  })

  it('resolveMorningPart: 스토어가 다른 시도를 가리키면 낡은 inFlight 로 판정하지 않는다', () => {
    const view = parseMorningPart(RUNNING)!
    // 스토어가 이 시도 전에 읽혔다. 같은 부분의 startedAt 이 다르다
    const stale = status({ release: part({ status: 'failed', startedAt: '2026-11-01 08:01:00' }) })
    expect(resolveMorningPart('release', view, stale).status).toBe('running')
    expect(resolveMorningPart('release', view, status()).status).toBe('running')
    // 같은 시도를 가리키면 실패로 바꾼다
    const same = status({ release: { ...RUNNING, status: 'failed', error: MORNING_INTERRUPTED_TEXT } })
    expect(resolveMorningPart('release', view, same)).toMatchObject({
      status: 'failed',
      error: MORNING_INTERRUPTED_TEXT
    })
    // running 이 아니면 그대로다
    const ok = parseMorningPart(part())!
    expect(resolveMorningPart('release', ok, same)).toBe(ok)
  })
})
