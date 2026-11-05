// linkwork:// 앱 내 링크를 해석한다.
// 순수 모듈이다. React·스토어·window 를 쓰지 않는다.
import { normalizeView, type ViewId } from '../components/layout/navConfig'

export type InternalLinkTarget =
  | { kind: 'view'; view: ViewId }
  | { kind: 'project'; id: number; taskId: number | null }
  | { kind: 'document'; id: number }
  | { kind: 'memo' | 'todo' | 'variable' | 'release' | 'recording' | 'note'; id: number }
  | { kind: 'calendar'; date: string; eventId: string | null }
  | {
      kind: 'today'
      focus: { kind: 'inbox' | 'briefing' | 'timeline' | 'item' | 'meeting'; id?: string }
    }

const SCHEME = 'linkwork://'
const NUM_RE = /^\d+$/
const EVENT_ID_RE = /^[A-Za-z0-9_-]+$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// id 하나만 받는 엔터티. 링크 형식은 linkwork://{kind}/{id} 다
const SIMPLE_KINDS = new Set(['memo', 'todo', 'variable', 'release', 'recording', 'note'])
type SimpleKind = 'memo' | 'todo' | 'variable' | 'release' | 'recording' | 'note'

const TODAY_AREAS = new Set(['inbox', 'briefing', 'timeline'])

// 숫자 id 를 읽는다. 0 이하와 안전 정수 밖의 값은 거부한다
function parseId(value: string | undefined): number | null {
  if (value === undefined || !NUM_RE.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

// 캘린더 링크가 받는 연도 범위. 이유: 0001 년 같은 값은 엉뚱한 주로 이동한다
const MIN_YEAR = 2000
const MAX_YEAR = 2100

// 'YYYY-MM-DD' 가 달력에 있는 날짜인지 본다. 예: 2026-02-30 은 거부한다
function isValidDate(value: string): boolean {
  const m = DATE_RE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < MIN_YEAR || y > MAX_YEAR) return false
  if (mo < 1 || mo > 12 || d < 1) return false
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  return d <= last
}

// linkwork:// 스킴 링크인지 본다. 형식 검사는 parseInternalLink 가 한다
export function isInternalLink(href: string): boolean {
  return typeof href === 'string' && href.startsWith(SCHEME)
}

// 링크를 대상으로 바꾼다. 모르는 형식이나 잘못된 id 면 null 을 돌려준다
export function parseInternalLink(href: string): InternalLinkTarget | null {
  if (!isInternalLink(href)) return null
  // 끝의 '/' 1개는 허용한다. 이유: 모델이 링크 끝에 '/' 를 붙이기도 한다
  const body = href.slice(SCHEME.length).replace(/\/$/, '')
  const parts = body.split('/')
  const [kind, ...rest] = parts
  if (parts.some((p) => p === '')) return null

  if (kind === 'view') {
    if (rest.length !== 1) return null
    const view = normalizeView(rest[0])
    return view ? { kind: 'view', view } : null
  }

  if (kind === 'project') {
    const id = parseId(rest[0])
    if (id === null) return null
    if (rest.length === 1) return { kind: 'project', id, taskId: null }
    if (rest.length === 3 && rest[1] === 'task') {
      const taskId = parseId(rest[2])
      return taskId === null ? null : { kind: 'project', id, taskId }
    }
    return null
  }

  if (kind === 'document') {
    const id = rest.length === 1 ? parseId(rest[0]) : null
    return id === null ? null : { kind: 'document', id }
  }

  if (SIMPLE_KINDS.has(kind)) {
    const id = rest.length === 1 ? parseId(rest[0]) : null
    return id === null ? null : { kind: kind as SimpleKind, id }
  }

  if (kind === 'calendar') {
    if (rest.length < 1 || rest.length > 2 || !isValidDate(rest[0])) return null
    if (rest.length === 1) return { kind: 'calendar', date: rest[0], eventId: null }
    return EVENT_ID_RE.test(rest[1]) ? { kind: 'calendar', date: rest[0], eventId: rest[1] } : null
  }

  if (kind === 'today') {
    const [area, id] = rest
    if (rest.length === 1 && TODAY_AREAS.has(area)) {
      return { kind: 'today', focus: { kind: area as 'inbox' | 'briefing' | 'timeline' } }
    }
    if (rest.length === 2 && area === 'item' && parseId(id) !== null) {
      return { kind: 'today', focus: { kind: 'item', id } }
    }
    if (rest.length === 2 && area === 'meeting' && EVENT_ID_RE.test(id)) {
      return { kind: 'today', focus: { kind: 'meeting', id } }
    }
    return null
  }

  return null
}
