// 릴리스 화면 상단의 아침 자동 동기화 상태 줄 (docs/RELEASE_NOTES.md §8.1).
// 옛 오늘 화면의 변경 내역(ChangeLog)에서 옮겨 왔다. 변경 내역은 오늘 대시보드 개편(부록 O)으로 지웠다.
import type { MorningSyncPart, MorningSyncPartName, MorningSyncStatus } from '../../types'
import { useMorningSyncStore } from '../../stores/morningSyncStore'

export type MorningPartKey = MorningSyncPartName

// payload 의 부분 상태 1개. 공유 타입 MorningSyncPart 를 따른다 (ASSISTANT A54).
// status 는 모르는 값도 받는다. 이유: 새 상태가 생겨도 화면이 그 값을 그대로 보인다
export type MorningPartView = Omit<MorningSyncPart, 'status'> & {
  status: MorningSyncPart['status'] | (string & {})
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

// 'YYYY-MM-DD HH:mm:ss' 의 'HH:mm'. 못 찾으면 빈 문자열이다
function hhmmOf(datetime: string | null | undefined): string {
  if (!datetime) return ''
  const m = datetime.match(/(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : ''
}

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

// 미룸 사유. main 은 deferred 에 문구를 두지 않는다
const DEFERRED_TEXT = '검토 중인 미리보기 있음'

// 성공한 부분의 건수 문구. 예: '새 1건 · 일부 실패 1건'.
// 릴리스의 갱신 수는 보이지 않는다. 이유: 매일 거의 모든 릴리스가 갱신으로 세어진다
export function morningCounts(part: MorningPartView): string {
  const parts: string[] = []
  if (part.newCount > 0) parts.push(`새 ${part.newCount}건`)
  if (part.failedCount > 0) parts.push(`일부 실패 ${part.failedCount}건`)
  return parts.length > 0 ? parts.join(' · ') : '변경 없음'
}

// 부분 상태를 상태어와 본문으로 나눈다
function morningPartBody(part: MorningPartView): { word: string; body: string } {
  switch (part.status) {
    case 'ok':
      return { word: '', body: morningCounts(part) }
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

// 화면 상단 상태 줄. 예: '아침 동기화 08:01 · 새 1건', '아침 동기화 실패 08:01 · 토큰 만료'.
// today 는 로컬 날짜 'YYYY-MM-DD' 다. run 을 생략하면 스토어의 현재 상태를 읽는다.
// run 이 null 이면 실행 설정을 모른다. 그때 part 가 없으면 null 이다.
// 자동 실행이 꺼져 있거나 오늘 실행 전이면 그 사실을 보여 준다 (RELEASE_NOTES §8.1)
export function morningStatusLine(
  label: string,
  // 부분 이름. 지금은 'release' 1가지다. 호출부 호환을 위해 받는다
  _key: MorningPartKey,
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
  const { word, body } = morningPartBody(part)
  const head = [label, word, last].filter(Boolean).join(' ')
  return body ? `${head} · ${body}` : head
}
