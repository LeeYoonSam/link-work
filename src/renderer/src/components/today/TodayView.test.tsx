import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TodayDashboard } from './todayModel'

// 오늘 대시보드 (docs/ASSISTANT.md 부록 O).
// 스토어는 상태 객체를 읽는 가짜로 바꾼다. 대시보드 조립(buildTodayDashboard)은 고정 fixture 를 돌려준다 —
// 조립 규칙은 todayModel.test.ts 가 맡는다. 화면은 배치·문구·이동만 본다.

type Sel<S> = (s: S) => unknown
const fakeStore = <S extends object>(state: S) => {
  const hook = ((sel?: Sel<S>) => (sel ? sel(state) : state)) as ((sel?: Sel<S>) => unknown) & {
    getState: () => S
    setState: (p: Partial<S>) => void
  }
  hook.getState = () => state
  hook.setState = (p) => Object.assign(state, p)
  return hook
}

const nav = { setView: vi.fn(), openProjectsTab: vi.fn(), view: 'today' }
const todo = {
  activeTodos: [],
  completedTodos: [],
  setFilterTagId: vi.fn(),
  setSelectedTodoId: vi.fn(),
  completeTodo: vi.fn(async () => {}),
  createTodo: vi.fn(async () => {})
}
const today = {
  events: [],
  eventsError: null as string | null,
  loading: false,
  lastSyncedAt: null as string | null,
  load: vi.fn(async () => {}),
  refresh: vi.fn(async () => {})
}
const assistant = {
  today: null,
  error: '',
  focus: null,
  meetingRegeneratingIds: [],
  setFocus: vi.fn(),
  regenerateMeetingBriefing: vi.fn(async () => {})
}
const focus = { requestFocus: vi.fn() }
const projectNav = { revealInTickets: vi.fn((_k: string) => true), openReleaseForVersion: vi.fn(async (_id: string) => {}) }

vi.mock('../../stores/navigationStore', () => ({ useNavigationStore: fakeStore(nav) }))
vi.mock('../../stores/todoStore', () => ({ useTodoStore: fakeStore(todo) }))
vi.mock('../../stores/todayStore', () => ({ useTodayStore: fakeStore(today) }))
vi.mock('../../stores/assistantStore', () => ({ useAssistantStore: fakeStore(assistant) }))
vi.mock('../../stores/jiraBoardStore', () => ({ useJiraBoardStore: fakeStore({ snapshot: null, errorCode: null }) }))
vi.mock('../../stores/releaseNoteStore', () => ({ useReleaseNoteStore: fakeStore({ allNotes: [] }) }))
vi.mock('../../stores/focusStore', () => ({ useFocusStore: fakeStore(focus) }))
vi.mock('../../stores/settingsStore', () => ({ useSettingsStore: fakeStore({ open: vi.fn() }) }))
vi.mock('../project/projectNav', () => projectNav)
vi.mock('../dashboard/HomeOverview', () => ({ HomeMemos: () => <section id="home-overview">중요 메모</section> }))

const DASH: TodayDashboard = {
  date: '2026-11-19',
  headline: '오늘 QA 시작, 배포 D-5. 진행 중 2건이 아직 QA 전이에요.',
  signals: [
    {
      id: 'release_risk',
      kind: 'release_risk',
      severity: 'warn',
      text: 'QA 시작, 2건 미완 — 4.177.0 포함분',
      refs: [{ type: 'issue', id: 'ICA-812', label: 'ICA-812' }]
    },
    {
      id: 'meeting_soon',
      kind: 'meeting_soon',
      severity: 'info',
      text: '14:00 Tech weekly',
      refs: [{ type: 'meeting', id: 'cal-b', label: 'Tech weekly' }]
    }
  ],
  hiddenSignalCount: 0,
  summaryLine: '회의 2 · 배포 D-5',
  releaseUnknown: false,
  release: {
    version: '4.177.0',
    date: '2026-11-24',
    dDay: 5,
    linked: true,
    noteId: 12,
    jiraVersionId: '10501',
    qaStart: '2026-11-19',
    qaEnd: '2026-11-23',
    phase: 'qa',
    totalCount: 40,
    mine: { total: 2, done: 1, review: 0, progress: 1, todo: 0 },
    rows: [
      {
        key: 'ICA-812',
        summary: '결제 수정',
        status: '진행 중',
        statusCategory: 'indeterminate',
        review: false,
        duedate: null,
        overdue: false,
        dueToday: false,
        signaled: true,
        revealable: true
      }
    ],
    moreCount: 0
  },
  jira: { state: 'ok', rows: [], moreCount: 0 },
  todos: { rows: [{ id: 3, title: '보고서', priority: 'medium', dueDate: null, bucket: 'none', signaled: false }], moreCount: 0, doneTodayCount: 0 },
  schedule: {
    connected: true,
    allDay: [],
    rows: [
      {
        id: 'cal-b',
        title: 'Tech weekly',
        start: '14:00',
        end: '15:00',
        startISO: new Date(2026, 10, 19, 14, 0).toISOString(),
        endISO: new Date(2026, 10, 19, 15, 0).toISOString(),
        timing: 'upcoming',
        location: null,
        htmlLink: null
      }
    ],
    nowIndex: 0,
    tomorrowCount: 0,
    tomorrowFirst: null
  }
}

vi.mock('./todayModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./todayModel')>()
  return { ...actual, buildTodayDashboard: vi.fn(() => DASH) }
})

const mod = await import('./TodayView')
const { default: TodayView, dateHeading, headerErrorText, releaseUnknownReason, meetingFocusEventId, openIssue, openTodo, openRelease, openSignalRef, syncedClock } = mod

const NOW = new Date(2026, 10, 19, 13, 20, 0)
const render = (): string => renderToStaticMarkup(<TodayView now={NOW} />)

beforeEach(() => {
  vi.clearAllMocks()
  today.loading = false
  today.lastSyncedAt = null
})

describe('TodayView 화면', () => {
  it('헤더: 날짜·헤드라인·동기화 시각·새로고침', () => {
    today.lastSyncedAt = new Date(2026, 10, 19, 9, 12).toISOString()
    const html = render()
    expect(html).toContain('11월 19일 (목)')
    expect(html).toContain(DASH.headline)
    expect(html).toContain('동기화 09:12')
    expect(html).toContain('aria-label="새로고침"')
  })

  it('불러오는 중이면 새로고침 버튼을 막는다', () => {
    today.loading = true
    expect(render()).toMatch(/<button[^>]*disabled=""[^>]*aria-label="새로고침"/)
  })

  it('DOM 순서는 좁은 창 순서다: 신호 → 배포 → Jira → 할 일 → 일정 → 메모. 넓은 창은 컨테이너 격자다', () => {
    const html = render()
    const ids = ['today-headline', 'today-signals', 'today-release', 'today-jira', 'today-todos', 'today-schedule', 'home-overview']
    const pos = ids.map((id) => html.search(new RegExp(`(id|data-testid)="${id}"`)))
    expect(pos.every((p) => p >= 0)).toBe(true)
    expect([...pos].sort((a, b) => a - b)).toEqual(pos)
    expect(html).toContain('@container')
    expect(html).toContain('@min-[1000px]:grid-cols-')
    // 일정은 넓은 창에서 왼쪽 열에 놓인다
    expect(html).toMatch(/@min-\[1000px\]:col-start-1[^"]*@min-\[1000px\]:row-start-3/)
  })

  it('meeting_soon 신호에 n분 뒤를 붙인다', () => {
    expect(render()).toContain('40분 뒤')
  })

  it('헤드라인과 신호는 규칙 문구 그대로 보인다(LLM 다듬기 없음)', () => {
    const html = render()
    expect(html).toContain(DASH.headline)
    for (const sig of DASH.signals) {
      expect(html).toContain(`data-signal="${sig.id}"`)
      expect(html).toContain(sig.text)
    }
    expect(html).not.toContain('data-source=')
  })

  it('계획 조작 UI(완료·제외·집중·하루 시작·퇴근·명령·변경 내역·후보)가 없다', () => {
    const html = render()
    for (const word of ['하루 시작', '퇴근', '집중', '후보', '변경 내역', '제외', '명령', '미룸', '맥락 복구']) {
      expect(html).not.toContain(word)
    }
    expect(html).not.toMatch(/>완료<\/button>/)
  })

  it('오늘 화면 소스(.tsx)에 금지 문구가 없다', () => {
    const dir = resolve(__dirname)
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx') && !n.includes('.test.'))) {
      const src = readFileSync(resolve(dir, f), 'utf8')
      // '집중'+' 가능' 은 저장소 전체 grep(완료 조건 C8)에 걸리지 않도록 나눠 쓴다
      for (const word of ['하루 시작', '퇴근', '지금 집중', '후보', '집중' + ' 가능']) {
        expect(src, f).not.toContain(word)
      }
    }
  })
})

describe('TodayView 이동', () => {
  it('openIssue: 보드에 있으면 그 이슈를 펼친다. 없으면 티켓 탭만 연다', () => {
    openIssue('ICA-812')
    expect(projectNav.revealInTickets).toHaveBeenCalledWith('ICA-812')
    expect(nav.openProjectsTab).not.toHaveBeenCalled()
    projectNav.revealInTickets.mockReturnValueOnce(false)
    openIssue('ICA-999')
    expect(nav.openProjectsTab).toHaveBeenCalledWith('tickets')
  })

  it('openTodo: 필터를 풀고 그 할 일을 선택해 할 일 화면으로 간다', () => {
    openTodo(3)
    expect(todo.setFilterTagId).toHaveBeenCalledWith(null)
    expect(todo.setSelectedTodoId).toHaveBeenCalledWith(3)
    expect(nav.setView).toHaveBeenCalledWith('todos')
  })

  it('openRelease: Jira 버전 id 가 있으면 그 릴리스, 노트만 있으면 포커스 요청 + 릴리스 탭, 없으면 탭만', async () => {
    await openRelease({ jiraVersionId: '10501', noteId: 12 })
    expect(projectNav.openReleaseForVersion).toHaveBeenCalledWith('10501')
    await openRelease({ jiraVersionId: null, noteId: 12 })
    expect(focus.requestFocus).toHaveBeenCalledWith({ entity: 'release', id: 12 })
    expect(nav.openProjectsTab).toHaveBeenLastCalledWith('releases')
    await openRelease(null)
    expect(nav.openProjectsTab).toHaveBeenCalledTimes(2)
  })

  it('openSignalRef: issue·todo·release 는 해당 화면으로, meeting 은 일정 행으로 스크롤', () => {
    openSignalRef({ type: 'issue', id: 'ICA-1', label: 'ICA-1' }, null)
    expect(projectNav.revealInTickets).toHaveBeenCalledWith('ICA-1')
    openSignalRef({ type: 'todo', id: '7', label: 't' }, null)
    expect(todo.setSelectedTodoId).toHaveBeenCalledWith(7)
    openSignalRef({ type: 'release', id: '4.177.0', label: '4.177.0' }, DASH.release)
    expect(projectNav.openReleaseForVersion).toHaveBeenCalledWith('10501')
    const el = { scrollIntoView: vi.fn() }
    ;(globalThis as unknown as { document: unknown }).document = { getElementById: vi.fn(() => el) }
    openSignalRef({ type: 'meeting', id: 'cal-b', label: 'Tech weekly' }, null)
    expect((globalThis as unknown as { document: { getElementById: ReturnType<typeof vi.fn> } }).document.getElementById).toHaveBeenCalledWith(
      'schedule-row-cal-b'
    )
    expect(el.scrollIntoView).toHaveBeenCalled()
    delete (globalThis as unknown as { document?: unknown }).document
  })

  it('알림 focus: meeting 만 브리핑 이벤트 id 로 바꾸고 다른 kind 는 무시한다', () => {
    expect(meetingFocusEventId({ kind: 'meeting', id: '42' })).toBe(42)
    expect(meetingFocusEventId({ kind: 'meeting', id: 'x' })).toBeNull()
    expect(meetingFocusEventId({ kind: 'item', id: '7' })).toBeNull()
    expect(meetingFocusEventId({ kind: 'inbox' })).toBeNull()
    expect(meetingFocusEventId(null)).toBeNull()
  })

  it('헤더 오류: 캘린더 미연결은 일정 카드만 안내하고 헤더에는 실제 오류만 보인다', () => {
    expect(headerErrorText('Google 캘린더가 연결되어 있지 않습니다.', false, '')).toBe('')
    expect(headerErrorText('시간 초과', true, '')).toBe('일정: 시간 초과')
    expect(headerErrorText(null, false, '회의 브리핑을 다시 만들지 못했습니다')).toBe('회의 브리핑을 다시 만들지 못했습니다')
  })

  it('today 폴더 화면 문구에 영문 낱말 뒤 조사 띄어쓰기("Jira 가")가 없다', () => {
    const dir = resolve(__dirname)
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx') && !n.includes('.test.'))) {
      const src = readFileSync(resolve(dir, f), 'utf8')
      const strings = src.match(/'[^'\n]*'|>[^<>{}\n]+</g) ?? []
      for (const t of strings) expect(t, f).not.toMatch(/[A-Za-z0-9] (가|이|를|을|는|은|와|과|로|으로)[ .,']/)
    }
  })

  it('releaseUnknownReason: Jira 미연결이면 연결 안내, 그 밖이면 불러오기 안내, 배포를 알면 null', () => {
    const d = (state: TodayDashboard['jira']['state'], releaseUnknown: boolean) => ({
      jira: { state, rows: [], moreCount: 0 },
      releaseUnknown
    })
    expect(releaseUnknownReason(d('not_connected', true))).toBe('not_connected')
    expect(releaseUnknownReason(d('no_project', true))).toBe('not_connected')
    expect(releaseUnknownReason(d('error', true))).toBe('load_failed')
    expect(releaseUnknownReason(d('ok', false))).toBeNull()
  })

  it('넓은 창의 Jira·할 일 카드는 내용 높이(self-start)다', () => {
    const html = render()
    expect(html).toMatch(/self-start @min-\[1000px\]:col-start-2 @min-\[1000px\]:row-start-4/)
    expect(html).toMatch(/self-start @min-\[1000px\]:col-start-3 @min-\[1000px\]:row-start-4/)
  })

  it('헬퍼: dateHeading·syncedClock', () => {
    expect(dateHeading(new Date(2026, 11, 1))).toBe('12월 1일 (화)')
    expect(syncedClock(null)).toBeNull()
    expect(syncedClock('깨짐')).toBeNull()
  })
})
