// 모바일 화면 순수 함수. React·window·fetch 를 쓰지 않는다(시각 now 는 호출부가 넘긴다).
import type { Memo, MemoCategory, Todo, TodoPriority } from '../types'
import { sortMemos, searchMemos, toListItem, type MemoListItem } from '../components/memo/memoSearch'
import { MobileApiError } from './api'

// ─── 탭·연결 상태 ─────────────────────────────────────────

export type MobileTab = 'today' | 'todos' | 'memos'
export const TABS: { key: MobileTab; label: string }[] = [
  { key: 'today', label: '오늘' },
  { key: 'todos', label: '할 일' },
  { key: 'memos', label: '메모' }
]

/** '#todos' → 'todos'. 모르는 값이면 오늘 */
export function parseTabHash(hash: string): MobileTab {
  const key = hash.replace(/^#/, '')
  return key === 'todos' || key === 'memos' ? key : 'today'
}

/** 'online' = 정상, 'offline' = Mac 에 닿지 않음(마지막 데이터 유지), 'expired' = 401(QR 재스캔) */
export type Connection = 'online' | 'offline' | 'expired'

/** 요청 실패 후 연결 상태. http 오류(4xx/5xx)는 연결 상태를 바꾸지 않는다 */
export function connectionAfterError(current: Connection, e: unknown): Connection {
  if (current === 'expired') return 'expired'
  if (e instanceof MobileApiError) {
    if (e.kind === 'auth') return 'expired'
    if (e.kind === 'network') return 'offline'
  }
  return current
}

/** 요청 성공 후 연결 상태. 만료는 성공으로 풀리지 않는다(쿠키가 다시 생기려면 재스캔해야 한다) */
export const connectionAfterSuccess = (current: Connection): Connection => (current === 'expired' ? 'expired' : 'online')

// ─── 요청 순번(응답 경쟁) ─────────────────────────────────────

/**
 * 같은 목록을 여러 번 읽을 때 늦게 도착한 옛 응답이 새 상태를 덮지 않게 한다.
 * begin() 이 순번을 내주고, 마지막으로 시작한(또는 invalidate 한) 순번의 응답만 적용한다
 */
interface RequestGate {
  begin: () => number
  isLatest: (seq: number) => boolean
  /** 진행 중인 응답을 모두 버린다(낙관적 갱신이 옛 응답에 덮이지 않게) */
  invalidate: () => void
}

export function createRequestGate(): RequestGate {
  let latest = 0
  return {
    begin: () => ++latest,
    isLatest: (seq) => seq === latest,
    invalidate: () => {
      latest += 1
    }
  }
}

/**
 * 할 일 목록 응답을 적용할지. 가장 최근 요청이어야 하고, 요청한 목록 종류(완료 여부)가
 * 지금 보고 있는 종류와 같아야 한다 — '진행 중' 응답이 '완료 보기' 로 바꾼 뒤 도착하면 버린다
 */
export function acceptTodosResponse(
  gate: Pick<RequestGate, 'isLatest'>,
  seq: number,
  requestedCompleted: boolean,
  currentCompleted: boolean
): boolean {
  return gate.isLatest(seq) && requestedCompleted === currentCompleted
}

// ─── 날짜 ─────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0')
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

/** 로컬 'YYYY-MM-DD' */
export const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 'YYYY-MM-DD…' → 'M/D'. 형식이 틀리면 그대로 */
export function monthDay(date: string): string {
  const m = date.slice(0, 10).match(/^\d{4}-(\d{2})-(\d{2})$/)
  return m ? `${Number(m[1])}/${Number(m[2])}` : date
}

/** 'YYYY-MM-DD' → '11/24(화)'. 데스크톱 ReleaseCard.shortDayLabel 과 같은 모양 */
export function shortDayLabel(date: string | null): string {
  if (!date) return ''
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return date
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return `${Number(m[2])}/${Number(m[3])}(${WEEKDAYS[d.getDay()]})`
}

/** 0 → 'D-day', 5 → 'D-5', -1 → 'D+1' */
export function dDayLabel(dDay: number): string {
  if (dDay === 0) return 'D-day'
  return dDay > 0 ? `D-${dDay}` : `D+${-dDay}`
}

/** 이보다 오래된 스냅샷은 경고색으로 보인다 */
const STALE_AFTER_MS = 5 * 60_000

/** 스냅샷 발행 시각 문구와 오래됨 여부. 'Mac 에서 3분 전 갱신' */
export function publishedAgo(publishedAt: string, now: Date): { text: string; stale: boolean } {
  const t = Date.parse(publishedAt)
  if (Number.isNaN(t)) return { text: 'Mac 갱신 시각을 알 수 없어요', stale: true }
  const diff = Math.max(0, now.getTime() - t)
  const min = Math.floor(diff / 60_000)
  let ago: string
  if (min < 1) ago = '방금'
  else if (min < 60) ago = `${min}분 전`
  else if (min < 24 * 60) ago = `${Math.floor(min / 60)}시간 전`
  else ago = `${Math.floor(min / (24 * 60))}일 전`
  return { text: `Mac 에서 ${ago} 갱신`, stale: diff > STALE_AFTER_MS }
}

/** 남은 분(올림). 지난 시각은 0 이하 */
export function minutesUntil(startISO: string, now: Date): number {
  const t = Date.parse(startISO)
  if (Number.isNaN(t)) return Number.NaN
  return Math.ceil((t - now.getTime()) / 60_000)
}

// ─── 할 일 ─────────────────────────────────────────────────

const PRIORITY_ORDER: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 }

type DueBucket = 'overdue' | 'today' | 'later' | 'none'

function dueBucket(due: string | null, today: string): DueBucket {
  if (!due) return 'none'
  const d = due.slice(0, 10)
  if (d < today) return 'overdue'
  if (d === today) return 'today'
  return 'later'
}

/** 마감 글자. 데스크톱 TodoCard.todoDueText 와 같은 문구('11/17 지남'·'오늘'·'11/24') */
export function dueLabel(due: string | null, today: string): { text: string; bucket: DueBucket } | null {
  if (!due) return null
  const bucket = dueBucket(due, today)
  if (bucket === 'overdue') return { text: `${monthDay(due)} 지남`, bucket }
  if (bucket === 'today') return { text: '오늘', bucket }
  return { text: monthDay(due), bucket }
}

/** 진행 중: 지난 마감 → 오늘 → 마감 이른 순 → 마감 없음, 같으면 우선순위·id */
export function sortActiveTodos(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    const da = a.due_date ? a.due_date.slice(0, 10) : null
    const db = b.due_date ? b.due_date.slice(0, 10) : null
    if (da !== db) {
      if (da === null) return 1
      if (db === null) return -1
      return da < db ? -1 : 1
    }
    return (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1) || a.id - b.id
  })
}

/** 완료: 최근 완료 순 */
export function sortCompletedTodos(todos: Todo[]): Todo[] {
  const t = (x: Todo): string => x.completed_at ?? x.updated_at ?? ''
  return [...todos].sort((a, b) => (t(a) < t(b) ? 1 : t(a) > t(b) ? -1 : b.id - a.id))
}

type Updater<T> = (cur: T[]) => T[]

/**
 * 낙관적 제거 후 서버 호출. 실패하면 항목을 원래 자리에 되돌리고 onError 를 부른다.
 * setItems 는 함수형 갱신을 받는다(그 사이 다른 갱신이 있어도 덮어쓰지 않는다). 성공하면 true
 */
export async function removeOptimistically<T extends { id: number }>(opts: {
  id: number
  items: T[]
  setItems: (fn: Updater<T>) => void
  call: (id: number) => Promise<unknown>
  onError: (e: unknown) => void
}): Promise<boolean> {
  const index = opts.items.findIndex((x) => x.id === opts.id)
  if (index < 0) return false
  const item = opts.items[index]
  opts.setItems((cur) => cur.filter((x) => x.id !== opts.id))
  try {
    await opts.call(opts.id)
    return true
  } catch (e) {
    opts.setItems((cur) => {
      if (cur.some((x) => x.id === opts.id)) return cur
      const next = [...cur]
      next.splice(Math.min(index, next.length), 0, item)
      return next
    })
    opts.onError(e)
    return false
  }
}

// ─── 메모 ─────────────────────────────────────────────────

/** 'all' = 전체, 'important' = 중요, 숫자 = 그 카테고리 */
export type MemoFilter = 'all' | 'important' | number

/** 필터·검색을 적용한 목록. 검색어가 있으면 점수순(본문·제목·카테고리 이름), 없으면 최근 수정순 */
export function visibleMemos(
  memos: Memo[],
  categories: MemoCategory[],
  filter: MemoFilter,
  query: string
): MemoListItem[] {
  const base =
    filter === 'all'
      ? memos
      : filter === 'important'
        ? memos.filter((m) => m.is_important === 1)
        : memos.filter((m) => m.category_id === filter)
  if (query.trim()) return searchMemos(base, categories, query)
  return sortMemos(base, 'updated').map(toListItem)
}

export interface MemoDraft {
  content: string
  categoryId: number | null
  important: boolean
}

export const MEMO_MAX_LENGTH = 20000

/** 작성 본문 → POST 본문. 빈 본문·너무 긴 본문이면 오류 문구 */
export function buildMemoBody(
  draft: MemoDraft
): { ok: true; body: { content: string; category_id: number | null; is_important: 0 | 1 } } | { ok: false; error: string } {
  if (!draft.content.trim()) return { ok: false, error: '내용을 입력하세요' }
  if (draft.content.length > MEMO_MAX_LENGTH) return { ok: false, error: `${MEMO_MAX_LENGTH.toLocaleString()}자까지 쓸 수 있어요` }
  return {
    ok: true,
    body: { content: draft.content, category_id: draft.categoryId, is_important: draft.important ? 1 : 0 }
  }
}

/** 작성 중 초안을 보관하는 sessionStorage 키. 탭 전환·401 재스캔 뒤에도 같은 브라우저 탭에서 복구한다 */
export const DRAFT_STORAGE_KEY = 'linkwork.mobile.memoDraft'

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** 보관된 초안을 읽는다. 없거나 모양이 틀리거나 저장소를 못 쓰면 null */
export function readDraft(storage: DraftStorage | null | undefined): MemoDraft | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(DRAFT_STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Record<string, unknown>
    if (!v || typeof v !== 'object' || typeof v.content !== 'string') return null
    const categoryId = typeof v.categoryId === 'number' && Number.isInteger(v.categoryId) ? v.categoryId : null
    return { content: v.content, categoryId, important: v.important === true }
  } catch {
    return null
  }
}

/** 초안을 보관한다. null 이면 지운다. 저장소 오류(사생활 보호 모드·용량)는 무시한다 */
export function writeDraft(storage: DraftStorage | null | undefined, draft: MemoDraft | null): void {
  if (!storage) return
  try {
    if (draft) storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft))
    else storage.removeItem(DRAFT_STORAGE_KEY)
  } catch {
    // 보관하지 못해도 메모리의 초안은 남는다
  }
}

/** 서버가 id 만 돌려주므로 목록에 바로 넣을 임시 메모를 만든다. 다음 목록 읽기로 서버 값으로 바뀐다 */
export function localMemo(id: number, draft: MemoDraft, now: Date): Memo {
  const at = now.toISOString()
  return {
    id,
    content: draft.content,
    is_archived: 0,
    is_important: draft.important ? 1 : 0,
    color: '',
    category_id: draft.categoryId,
    created_at: at,
    updated_at: at
  }
}
