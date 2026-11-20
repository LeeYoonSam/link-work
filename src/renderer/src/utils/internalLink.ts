// linkwork:// 앱 내 링크를 해석한다.
// 순수 모듈이다. React·스토어·window 를 쓰지 않는다.
import { normalizeView, projectsTabAlias, type ViewId } from '../components/layout/navConfig'
import type { ProjectsTab } from '../stores/navigationStore'

type InternalLinkTarget =
  // tab 은 view 가 'projects' 일 때 열 탭이다. 없으면 마지막으로 본 탭을 그대로 둔다
  | { kind: 'view'; view: ViewId; tab?: ProjectsTab }
  | { kind: 'memo' | 'todo' | 'variable' | 'release' | 'recording' | 'note'; id: number }
  | { kind: 'calendar'; date: string; eventId: string | null }
  // focus 가 null 이면 오늘 화면만 연다
  | { kind: 'today'; focus: { kind: 'meeting'; id: string } | null }

const SCHEME = 'linkwork://'
const NUM_RE = /^\d+$/
const EVENT_ID_RE = /^[A-Za-z0-9_-]+$/
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

// id 하나만 받는 엔터티. 링크 형식은 linkwork://{kind}/{id} 다
const SIMPLE_KINDS = new Set(['memo', 'todo', 'variable', 'release', 'recording', 'note'])
type SimpleKind = 'memo' | 'todo' | 'variable' | 'release' | 'recording' | 'note'

// 옛 오늘 화면(하루 계획)의 영역 링크. 이유: 옛 대화의 링크가 죽지 않게 오늘 화면만 연다
const LEGACY_TODAY_AREAS = new Set(['inbox', 'briefing', 'timeline'])

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
    // 릴리스·문서는 메뉴에서 프로젝트 페이지의 탭으로 옮겼다. 옛 view 이름은 그 탭을 연다
    const tab = projectsTabAlias(rest[0])
    if (tab) return { kind: 'view', view: 'projects', tab }
    const view = normalizeView(rest[0])
    if (!view) return null
    // 링크로 프로젝트 페이지를 가리키면 티켓 탭이다. 이유: AI 가 티켓 안내에 이 링크를 쓴다.
    // 마지막 탭 기억은 사이드바 메뉴 클릭에만 적용한다
    return view === 'projects' ? { kind: 'view', view, tab: 'tickets' } : { kind: 'view', view }
  }

  // 옛 프로젝트·작업 링크는 프로젝트 보드로 보낸다. 이유: 대화 기록의 링크가 죽지 않게 한다
  if (kind === 'project') {
    const id = parseId(rest[0])
    if (id === null) return null
    if (rest.length === 1) return { kind: 'view', view: 'projects', tab: 'tickets' }
    if (rest.length === 3 && rest[1] === 'task' && parseId(rest[2]) !== null) {
      return { kind: 'view', view: 'projects', tab: 'tickets' }
    }
    return null
  }

  // 문서 메뉴는 없어졌다. 옛 문서 링크는 프로젝트 페이지의 문서 탭으로 보낸다
  if (kind === 'document') {
    const id = rest.length === 1 ? parseId(rest[0]) : null
    return id === null ? null : { kind: 'view', view: 'projects', tab: 'docs' }
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
    if (rest.length === 1 && LEGACY_TODAY_AREAS.has(area)) return { kind: 'today', focus: null }
    // 옛 계획 항목 링크. 위와 같은 이유로 오늘 화면만 연다
    if (rest.length === 2 && area === 'item' && parseId(id) !== null) return { kind: 'today', focus: null }
    if (rest.length === 2 && area === 'meeting' && EVENT_ID_RE.test(id)) {
      return { kind: 'today', focus: { kind: 'meeting', id } }
    }
    return null
  }

  return null
}
