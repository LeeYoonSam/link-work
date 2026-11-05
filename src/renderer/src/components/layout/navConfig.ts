// 사이드바 메뉴·화면 제목·화면 ID 의 단일 출처다.
// 순수 모듈이다. React·스토어·window 를 쓰지 않는다.
import type { MenuIconName } from '../icons/MenuIcon'

// 앱 화면 ID. 'today' 가 유일한 홈이다. 'dashboard' 는 없앴다
export const VIEW_IDS = [
  'today',
  'ai',
  'projects',
  'todos',
  'calendar',
  'releases',
  'reports',
  'recordings',
  'notes',
  'documents',
  'memos',
  'variables'
] as const

export type ViewId = (typeof VIEW_IDS)[number]

// 화면 제목. 사이드바와 Header 가 같은 레이블을 쓴다. 레이블은 한국어로 통일한다
export const VIEW_LABELS: Record<ViewId, string> = {
  today: '오늘',
  ai: 'AI 대화',
  projects: '프로젝트',
  todos: '할 일',
  calendar: '캘린더',
  releases: '릴리스',
  reports: '주간 보고',
  recordings: '녹음',
  notes: '회의록',
  documents: '문서',
  memos: '메모',
  variables: '변수'
}

export interface NavItem {
  id: ViewId
  label: string
  icon: MenuIconName
}

export interface NavGroup {
  // null 이면 그룹 제목을 그리지 않는다
  title: string | null
  items: NavItem[]
}

const item = (id: ViewId, icon: MenuIconName): NavItem => ({
  id,
  label: VIEW_LABELS[id],
  icon
})

// 사이드바 그룹. 그룹 안에 그룹을 두지 않는다
export const NAV_GROUPS: NavGroup[] = [
  {
    title: null,
    items: [{ id: 'today', label: VIEW_LABELS.today, icon: 'today' }, item('ai', 'ai')]
  },
  {
    title: '업무',
    items: [
      item('projects', 'projects'),
      item('todos', 'todos'),
      item('calendar', 'calendar'),
      item('releases', 'releases'),
      item('reports', 'reports')
    ]
  },
  { title: '회의', items: [item('recordings', 'recordings'), item('notes', 'notes')] },
  {
    title: '자료',
    items: [item('documents', 'documents'), item('memos', 'memos'), item('variables', 'variables')]
  }
]

// 없앤 화면 ID 를 새 ID 로 옮긴다. 이유: AI 링크·저장값에 예전 ID 가 남는다
const VIEW_ALIASES: Record<string, ViewId> = {
  dashboard: 'today'
}

const VIEW_ID_SET: ReadonlySet<string> = new Set(VIEW_IDS)

// 외부 값을 화면 ID 로 바꾼다. 모르는 값이면 null 을 돌려준다
export function normalizeView(value: unknown): ViewId | null {
  if (typeof value !== 'string') return null
  if (VIEW_ID_SET.has(value)) return value as ViewId
  // 자기 소유 키만 읽는다. 이유: 'constructor' 같은 키가 Object.prototype 멤버를 돌려준다
  return Object.hasOwn(VIEW_ALIASES, value) ? VIEW_ALIASES[value] : null
}
