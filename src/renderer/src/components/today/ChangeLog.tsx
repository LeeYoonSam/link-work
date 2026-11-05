import type {
  AssistantEvent,
  MorningSyncPart,
  MorningSyncPartName,
  MorningSyncStatus,
  RefreshSummary
} from '../../types'
import { Card, SectionTitle } from '../ui'
import { hhmmOf } from './PlanItemRow'
import { useMorningSyncStore } from '../../stores/morningSyncStore'

// payload 에서 변경 요약을 꺼낸다. main 은 RefreshSummary 를 그대로 저장한다. { summary } 감싼 형태도 받는다
export function parseSummary(payload: string | null): Partial<RefreshSummary> | null {
  if (!payload) return null
  try {
    const raw = JSON.parse(payload) as unknown
    if (!raw || typeof raw !== 'object') return null
    const obj = raw as Record<string, unknown>
    const s = obj.summary && typeof obj.summary === 'object' ? obj.summary : obj
    return s as Partial<RefreshSummary>
  } catch {
    return null
  }
}

// 받침이 있고 ㄹ 받침이 아니면 '으로', 아니면 '로'
function withRo(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00
  if (code < 0 || code > 11171) return `${word}로`
  const jong = code % 28
  return jong === 0 || jong === 8 ? `${word}로` : `${word}으로`
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// plan_update 이벤트 1건을 규칙 문장으로 바꾼다. 예: '10:42 회의 1건 추가로 시간표 갱신'
export function describePlanUpdate(ev: Pick<AssistantEvent, 'scheduled_at' | 'fired_at' | 'payload'>): string {
  const time = hhmmOf(ev.fired_at ?? ev.scheduled_at)
  const s = parseSummary(ev.payload)
  if (!s) return `${time} 계획 최신화`.trim()

  const calendar: string[] = []
  if (n(s.calendarAdded) > 0) calendar.push(`회의 ${n(s.calendarAdded)}건 추가`)
  if (n(s.calendarChanged) > 0) calendar.push(`회의 ${n(s.calendarChanged)}건 변경`)
  if (n(s.calendarRemoved) > 0) calendar.push(`회의 ${n(s.calendarRemoved)}건 취소`)

  const parts: string[] = []
  const timelineChanged = s.timelineChanged === true
  if (calendar.length > 0 && timelineChanged) {
    const head = calendar.slice(0, -1)
    const last = calendar[calendar.length - 1]
    parts.push([...head, `${withRo(last)} 시간표 갱신`].join(' · '))
  } else {
    parts.push(...calendar)
    if (timelineChanged) parts.push('시간표 갱신')
  }
  if (s.currentOrNextChanged === true) parts.push('지금·다음 블록 변경')

  const suggested = n(s.suggested)
  const urgent = Array.isArray(s.urgentSuggestedIds) ? s.urgentSuggestedIds.length : 0
  if (suggested > 0) {
    parts.push(urgent > 0 ? `새로 들어온 일 ${suggested}건 (긴급 ${urgent}건)` : `새로 들어온 일 ${suggested}건`)
  }
  if (n(s.completed) > 0) parts.push(`${n(s.completed)}건 완료 반영`)
  if (n(s.dropped) > 0) parts.push(`${n(s.dropped)}건 제외`)
  if (n(s.replaced) > 0) parts.push(`액션아이템 ${n(s.replaced)}건 TODO 로 교체`)

  const body = parts.length > 0 ? parts.join(' · ') : '변경 없음'
  // 알림 행 INSERT 에 성공한 종류가 있으면 표시한다 (부록 E.3.3)
  const notified = Array.isArray(s.notified) && s.notified.length > 0 ? ' · 알림 보냄' : ''
  return `${time} ${body}${notified}`.trim()
}

// 이벤트를 시각 순으로 정렬한다. 시각이 같으면 id 순이다
const byTime = (a: AssistantEvent, b: AssistantEvent): number => {
  const ta = a.fired_at ?? a.scheduled_at
  const tb = b.fired_at ?? b.scheduled_at
  return ta < tb ? -1 : ta > tb ? 1 : a.id - b.id
}

// 변경 기록 행만 고른다. 알림 행은 ref_id 가 있다 (부록 E.3.3)
export function planUpdateEvents(events: AssistantEvent[]): AssistantEvent[] {
  return events.filter((e) => e.kind === 'plan_update' && e.ref_id === null).sort(byTime)
}

// 명령 적용 기록 행만 시각 순으로 고른다 (부록 G.10.4)
export function commandEvents(events: AssistantEvent[]): AssistantEvent[] {
  return events.filter((e) => e.kind === 'command').sort(byTime)
}

const COMMAND_TEXT_SHOWN = 30

// command 이벤트 1건을 문장으로 바꾼다. 예: "10:42 명령 'PROJ-12 끝났어' · 1건 적용"
export function describeCommand(ev: Pick<AssistantEvent, 'scheduled_at' | 'fired_at' | 'payload'>): string {
  const time = hhmmOf(ev.fired_at ?? ev.scheduled_at)
  let obj: Record<string, unknown> = {}
  try {
    const raw = ev.payload ? (JSON.parse(ev.payload) as unknown) : null
    if (raw && typeof raw === 'object') obj = raw as Record<string, unknown>
  } catch {
    // payload 가 깨졌으면 건수 0 으로 보인다
  }
  const text = typeof obj.text === 'string' ? obj.text : ''
  const shown =
    text.length > COMMAND_TEXT_SHOWN ? `${text.slice(0, COMMAND_TEXT_SHOWN)}…` : text
  const failed = n(obj.failed)
  const tail = failed > 0 ? ` · ${failed}건 실패` : ''
  return `${time} 명령 '${shown}' · ${n(obj.applied)}건 적용${tail}`.trim()
}

// ── 아침 자동 동기화 (ASSISTANT A54, PROJECT_SYNC R11) ──
// kind 는 morning_sync 다. 하루 1행이고, 부분 상태는 payload 의 release·project 에 있다.
// kind 비교에 문자열을 쓴다. 이유: 이전 타입 정의에도 컴파일된다
export const MORNING_SYNC_KIND = 'morning_sync'

export type MorningPartKey = MorningSyncPartName

// payload 의 부분 상태 1개. 공유 타입 MorningSyncPart 를 따른다 (ASSISTANT A54).
// status 는 모르는 값도 받는다. 이유: 새 상태가 생겨도 화면이 그 값을 그대로 보인다
export type MorningPartView = Omit<MorningSyncPart, 'status'> & {
  status: MorningSyncPart['status'] | (string & {})
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

// 부분 상태 1개를 읽는다. 모양이 틀리면 null 이다
export function parseMorningPart(raw: unknown): MorningPartView | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const status = str(o.status)
  if (!status) return null
  return {
    status,
    attempts: n(o.attempts),
    startedAt: str(o.startedAt),
    finishedAt: str(o.finishedAt),
    error: str(o.error),
    newCount: n(o.newCount),
    updatedCount: n(o.updatedCount),
    reviewCount: n(o.reviewCount),
    failedCount: n(o.failedCount)
  }
}

// morning_sync payload 를 읽는다. 깨졌으면 null 이다
export function parseMorningSync(
  payload: string | null
): Record<MorningPartKey, MorningPartView | null> | null {
  if (!payload) return null
  try {
    const raw = JSON.parse(payload) as unknown
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    return { release: parseMorningPart(o.release), project: parseMorningPart(o.project) }
  } catch {
    return null
  }
}

// 미룸 사유. main 은 deferred 에 문구를 두지 않는다
const DEFERRED_TEXT = '검토 중인 미리보기 있음'

// main 의 getMorningSyncStatus 와 같은 문구다 (morning-sync.ts INTERRUPTED_TEXT)
export const MORNING_INTERRUPTED_TEXT = '동기화가 중단되었습니다.'

// 앱이 동기화 중에 꺼진 running 부분을 실패로 바꾼다. main 의 getMorningSyncStatus 와 같은 규칙이다.
// status 는 스토어의 상태다. null 이면 아직 모르므로 그대로 둔다.
// 스토어의 같은 부분이 같은 시도를 가리킬 때만 바꾼다. 이유: 스토어가 이 시도 전에 읽혔으면 inFlight 가 낡았다
export function resolveMorningPart(
  key: MorningPartKey,
  part: MorningPartView,
  status: MorningSyncStatus | null
): MorningPartView {
  if (part.status !== 'running' || !status || status.inFlight) return part
  const live = status[key]
  if (!live || live.startedAt !== part.startedAt) return part
  return { ...part, status: 'failed', error: MORNING_INTERRUPTED_TEXT }
}

// 줄의 시각이다. 부분의 finishedAt 중 가장 늦은 값을 쓴다. 없으면 fired_at 이다.
// 이유: 재시도가 09:01 에 성공해도 fired_at 은 첫 선점 시각 08:01 이다
export function morningSyncTime(
  ev: Pick<AssistantEvent, 'scheduled_at' | 'fired_at' | 'payload'>
): string {
  const p = parseMorningSync(ev.payload)
  const ends = [p?.release?.finishedAt, p?.project?.finishedAt].filter((v): v is string => !!v)
  if (ends.length === 0) return ev.fired_at ?? ev.scheduled_at
  return ends.reduce((a, b) => (b > a ? b : a))
}

// 성공한 부분의 건수 문구. 예: '새 1건 · 갱신 2건 · 확인 필요 1건'.
// 릴리스의 갱신 수는 보이지 않는다. 이유: 매일 거의 모든 릴리스가 갱신으로 세어진다
export function morningCounts(key: MorningPartKey, part: MorningPartView): string {
  const parts: string[] = []
  if (part.newCount > 0) parts.push(`새 ${part.newCount}건`)
  if (key === 'project') {
    if (part.updatedCount > 0) parts.push(`갱신 ${part.updatedCount}건`)
    if (part.reviewCount > 0) parts.push(`확인 필요 ${part.reviewCount}건`)
  } else if (part.failedCount > 0) {
    parts.push(`일부 실패 ${part.failedCount}건`)
  }
  return parts.length > 0 ? parts.join(' · ') : '변경 없음'
}

// 부분 상태를 상태어와 본문으로 나눈다. 상태 줄과 변경 내역이 같은 규칙을 쓴다
function morningPartBody(key: MorningPartKey, part: MorningPartView): { word: string; body: string } {
  switch (part.status) {
    case 'ok':
      return { word: '', body: morningCounts(key, part) }
    case 'failed':
      return { word: '실패', body: part.error ?? '' }
    case 'skipped':
      return { word: '건너뜀', body: part.error ?? '' }
    case 'deferred':
      return { word: '미룸', body: part.error ?? DEFERRED_TEXT }
    case 'running':
      return { word: '진행 중', body: '' }
    default:
      return { word: part.status, body: '' }
  }
}

const PART_LABEL: Record<MorningPartKey, string> = { release: '릴리스', project: '프로젝트' }

// 변경 내역의 부분 1개. 예: '프로젝트 새 1건 · 갱신 2건', '릴리스 실패 (토큰 만료)'
export function describeMorningPart(key: MorningPartKey, part: MorningPartView): string {
  const { word, body } = morningPartBody(key, part)
  const head = word ? `${PART_LABEL[key]} ${word}` : PART_LABEL[key]
  if (!body) return head
  return word ? `${head} (${body})` : `${head} ${body}`
}

// morning_sync 이벤트 1건을 문장으로 바꾼다. 예: '08:01 아침 동기화 · 릴리스 새 2건 · 프로젝트 변경 없음'.
// status 는 스토어의 상태다. 중단된 running 을 실패로 보이는 데 쓴다
export function describeMorningSync(
  ev: Pick<AssistantEvent, 'scheduled_at' | 'fired_at' | 'payload'>,
  status: MorningSyncStatus | null = null
): string {
  const time = hhmmOf(morningSyncTime(ev))
  const p = parseMorningSync(ev.payload)
  const parts: string[] = []
  if (p?.release) parts.push(describeMorningPart('release', resolveMorningPart('release', p.release, status)))
  if (p?.project) parts.push(describeMorningPart('project', resolveMorningPart('project', p.project, status)))
  const body = parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
  return `${time} 아침 동기화${body}`.trim()
}

// 아침 동기화 행만 시각 순으로 고른다
export function morningSyncEvents(events: AssistantEvent[]): AssistantEvent[] {
  return events.filter((e) => (e.kind as string) === MORNING_SYNC_KIND).sort(byTime)
}

// 'YYYY-MM-DD HH:mm:ss' 를 'HH:mm' 으로 줄인다. 오늘이 아니면 'M/D HH:mm' 이다
export function morningStamp(ts: string | null, today: string): string {
  if (!ts) return ''
  const hhmm = hhmmOf(ts)
  const date = ts.slice(0, 10)
  if (date === today || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return hhmm
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} ${hhmm}`.trim()
}

// 상태 줄이 읽는 실행 설정이다. enabled 는 자동 실행 켜짐, at 은 예정 시각 'HH:mm', date 는 마지막 실행 날짜다
export type MorningRunInfo = Pick<MorningSyncStatus, 'enabled' | 'at' | 'date'>

// 화면 상단 상태 줄. 예: '아침 싱크업 08:01 · 새 1건 · 갱신 2건', '아침 동기화 실패 08:01 · 토큰 만료'.
// today 는 로컬 날짜 'YYYY-MM-DD' 다. run 을 생략하면 스토어의 현재 상태를 읽는다.
// run 이 null 이면 실행 설정을 모른다. 그때 part 가 없으면 null 이다.
// 자동 실행이 꺼져 있거나 오늘 실행 전이면 그 사실을 보여 준다 (RELEASE_NOTES §8.1)
export function morningStatusLine(
  label: string,
  key: MorningPartKey,
  part: MorningPartView | null,
  today: string,
  run: MorningRunInfo | null = useMorningSyncStore.getState().status
): string | null {
  const last = part ? morningStamp(part.finishedAt ?? part.startedAt, today) : ''
  if (run && !run.enabled) {
    return last ? `${label} 꺼짐 · 마지막 ${last}` : `${label} 꺼짐`
  }
  if (run && (run.date !== today || !part)) {
    const head = run.at ? `${label} 오늘 실행 전 · ${run.at} 예정` : `${label} 오늘 실행 전`
    return last ? `${head} · 마지막 ${last}` : head
  }
  if (!part) return null
  const { word, body } = morningPartBody(key, part)
  const head = [label, word, last].filter(Boolean).join(' ')
  return body ? `${head} · ${body}` : head
}

export default function ChangeLog({ events }: { events: AssistantEvent[] }): React.ReactNode {
  const morningStatus = useMorningSyncStore((s) => s.status)
  // 아침 동기화 줄은 맨 위에 둔다 (ASSISTANT K.3). 나머지 기록은 시각 순으로 합친다
  const rest = [...planUpdateEvents(events), ...commandEvents(events)].sort(byTime)
  const list = [...morningSyncEvents(events), ...rest]
  if (list.length === 0) return null
  return (
    <Card>
      <SectionTitle variant="page" className="mb-3">변경 내역</SectionTitle>
      <ul className="space-y-1.5">
        {list.map((ev) => (
          <li key={ev.id} className="text-sm text-gray-600 tabular-nums">
            {ev.kind === 'command'
              ? describeCommand(ev)
              : (ev.kind as string) === MORNING_SYNC_KIND
                ? describeMorningSync(ev, morningStatus)
                : describePlanUpdate(ev)}
          </li>
        ))}
      </ul>
    </Card>
  )
}
