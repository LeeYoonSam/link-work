import { describe, it, expect } from 'vitest'
import type {
  CalendarEvent,
  JiraBoardIssue,
  JiraBoardSnapshot,
  ReleaseNoteSummary,
  Todo
} from '../../types'
import {
  buildTodayDashboard,
  minutesUntil,
  todoInputSummary,
  visibleRefs,
  SIGNAL_REF_DISPLAY_LIMIT,
  JIRA_ROW_LIMIT,
  TODO_ROW_LIMIT,
  type TodayModelInput
} from './todayModel'
import { todoBucket } from '../todo/todoModel'

// 오늘 대시보드 조립 규칙을 고정한다. 시각은 로컬 시각으로 만들어 넣어 시간대와 무관하게 돈다.

const at = (h: number, m = 0, day = 19): Date => new Date(2026, 10, day, h, m)
const iso = (h: number, m = 0, day = 19): string => at(h, m, day).toISOString()

const allDay = (id: string, summary: string, start: string, end: string): CalendarEvent => ({
  id,
  summary,
  start,
  end,
  allDay: true
})
const timed = (id: string, summary: string, h: number, m: number, dur = 30, day = 19): CalendarEvent => ({
  id,
  summary,
  start: iso(h, m, day),
  end: new Date(at(h, m, day).getTime() + dur * 60_000).toISOString(),
  allDay: false
})

const note = (over: Partial<ReleaseNoteSummary> & { id: number; version_name: string }): ReleaseNoteSummary => ({
  jira_project_key: 'ICA',
  jira_version_id: `v-${over.id}`,
  description: null,
  released: 0,
  archived: 0,
  release_date: null,
  start_date: null,
  last_synced_at: null,
  last_sync_error: null,
  created_at: '2026-11-01 00:00:00',
  updated_at: '2026-11-01 00:00:00',
  item_count: 0,
  ...over
})

const issue = (key: string, over: Partial<JiraBoardIssue> = {}): JiraBoardIssue => ({
  key,
  summary: `${key} 요약`,
  issueType: '작업',
  level: 'standard',
  status: '진행 중',
  statusCategory: 'indeterminate',
  inScope: true,
  priority: null,
  parentKey: null,
  parentSummary: null,
  assigneeAccountId: 'me',
  assigneeName: '나',
  duedate: null,
  updated: '2026-11-18T00:00:00.000Z',
  resolvedAt: null,
  labels: [],
  excerpt: null,
  fixVersions: [],
  links: [],
  ...over
})

const snap = (issues: JiraBoardIssue[], myAccountId: string | null = 'me'): JiraBoardSnapshot => ({
  projectKey: 'ICA',
  myAccountId,
  issues,
  truncated: false,
  recentDoneDays: 14,
  fetchedAt: '2026-11-19T00:00:00.000Z',
  lastFullSyncAt: null
})

let todoId = 0
const todo = (title: string, over: Partial<Todo> = {}): Todo => ({
  id: ++todoId,
  title,
  priority: 'medium',
  due_date: null,
  due_reminder: 0,
  is_completed: 0,
  completed_at: null,
  notes: null,
  source_link: null,
  created_at: `2026-11-10 09:00:${String(todoId % 60).padStart(2, '0')}`,
  updated_at: '2026-11-10 09:00:00',
  ...over
})

const QA = allDay('qa', '[QA] Release Train', '2026-11-19', '2026-11-24')
const REL = allDay('rel1', ' App Release(v4.177.0)', '2026-11-24', '2026-11-25')
const REL2 = allDay('rel2', ' App Release', '2026-12-01', '2026-12-02')
const NOTES = [
  note({ id: 177, version_name: '4.177.0', jira_version_id: '10177', release_date: '2026-11-24', released: 1, item_count: 42 }),
  note({ id: 178, version_name: '4.178.0', jira_version_id: '10178', release_date: '2026-12-01' }),
  note({ id: 179, version_name: '4.177.0-alpha02', jira_version_id: '10179' })
]
const fv177 = [{ id: '10177', name: '4.177.0' }]

const input = (over: Partial<TodayModelInput> = {}): TodayModelInput => ({
  now: at(11, 20),
  events: [],
  calendarConnected: true,
  snapshot: snap([]),
  boardErrorCode: null,
  notes: [],
  activeTodos: [],
  completedTodos: [],
  ...over
})

describe('buildTodayDashboard — 실데이터 사례(11/19)', () => {
  const issues = [
    issue('ICA-812', { fixVersions: fv177 }),
    issue('ICA-830', { statusCategory: 'new', status: '할 일', fixVersions: fv177 }),
    issue('ICA-790', { status: 'In Review', fixVersions: fv177 }),
    issue('ICA-950') // fixVersion 없는 진행 중
  ]
  const d = buildTodayDashboard(
    input({
      events: [QA, REL, REL2, timed('weekly', 'Tech weekly', 14, 0, 40), timed('scrum', '[클라이언트셀] 스크럼', 10, 0, 15)],
      notes: NOTES,
      snapshot: snap(issues)
    })
  )

  it('다음 배포는 4.177.0, D-5, QA 단계, 연결됨', () => {
    expect(d.date).toBe('2026-11-19')
    expect(d.release).toMatchObject({ version: '4.177.0', dDay: 5, phase: 'qa', linked: true, qaStart: '2026-11-19' })
  })

  it('QA 중 미완 이슈는 release_risk(warn) 1건으로 합치고 근거 ref 를 붙인다', () => {
    const risk = d.signals.find((s) => s.kind === 'release_risk')!
    expect(risk.severity).toBe('warn')
    expect(risk.refs.filter((r) => r.type === 'issue').map((r) => r.id)).toEqual(['ICA-812', 'ICA-830'])
    expect(risk.refs.some((r) => r.type === 'release' && r.label === '4.177.0')).toBe(true)
    expect(d.signals.map((s) => s.kind)).toEqual(['release_risk', 'qa_start'])
  })

  it('fixVersion 없는 진행 중 이슈는 경보로 올리지 않는다', () => {
    const refs = d.signals.flatMap((s) => s.refs.map((r) => r.id))
    expect(refs).not.toContain('ICA-950')
    const row = d.jira.rows.find((r) => r.key === 'ICA-950')!
    expect(row.signaled).toBe(false)
    // 배포 카드에 보이는 이슈는 Jira 카드에서 빠지고 배포 카드에서 강조된다
    expect(d.release!.rows.map((r) => r.key)).toEqual(['ICA-812', 'ICA-830', 'ICA-790'])
    expect(d.release!.rows.find((r) => r.key === 'ICA-812')!.signaled).toBe(true)
    expect(d.jira.rows.map((r) => r.key)).toEqual(['ICA-950'])
  })

  it('릴리스·QA 종일 일정은 일정 rows·allDay 에 없다', () => {
    expect(d.schedule.rows.map((r) => r.id)).toEqual(['scrum', 'weekly'])
    expect(d.schedule.allDay).toEqual([])
    expect(d.schedule.nowIndex).toBe(1)
    expect(d.schedule.rows[0].timing).toBe('past')
    expect(d.schedule.rows[1]).toMatchObject({ start: '14:00', end: '14:40', timing: 'upcoming' })
  })

  it('헤드라인은 규칙 문구 1줄', () => {
    expect(d.headline).toBe('오늘 QA 시작, 배포 D-5. 배포 포함 미완 2건이 남았어요.')
  })
})

describe('buildTodayDashboard — 거짓 경보 방어', () => {
  it('Jira 릴리스 매칭에 실패하면 release_risk 를 만들지 않는다', () => {
    const d = buildTodayDashboard(
      input({ events: [QA, REL], notes: [], snapshot: snap([issue('ICA-812', { fixVersions: fv177 })]) })
    )
    expect(d.release?.linked).toBe(false)
    expect(d.signals.some((s) => s.kind === 'release_risk')).toBe(false)
  })

  it('D-1 미완료는 critical', () => {
    const d = buildTodayDashboard(
      input({
        now: at(9, 0, 23),
        events: [QA, REL],
        notes: NOTES,
        snapshot: snap([issue('ICA-790', { status: 'In Review', fixVersions: fv177 })])
      })
    )
    const risk = d.signals[0]
    expect(risk).toMatchObject({ kind: 'release_risk', severity: 'critical' })
    expect(risk.text).toContain('내일 배포')
  })

  it('배포 당일에는 release_day(warn) 신호', () => {
    const d = buildTodayDashboard(input({ now: at(9, 0, 24), events: [QA, REL], notes: NOTES }))
    expect(d.signals.map((s) => s.kind)).toEqual(['release_day'])
    expect(d.release?.phase).toBe('release_day')
  })
})

describe('buildTodayDashboard — 신호 상한·요약', () => {
  it('신호가 4건 이상이면 3건만 보이고 나머지는 hiddenSignals, meeting_soon 은 한 자리를 보장받는다', () => {
    const d = buildTodayDashboard(
      input({
        events: [QA, REL, timed('m1', 'Tech weekly', 12, 0)],
        notes: NOTES,
        snapshot: snap([
          issue('ICA-812', { fixVersions: fv177 }),
          issue('ICA-10', { duedate: '2026-11-10' }),
          issue('ICA-11', { duedate: '2026-11-19' })
        ]),
        activeTodos: [todo('지난 할 일', { due_date: '2026-11-18' })]
      })
    )
    // release_risk, overdue:jira, overdue:todo, meeting_soon, due_today, qa_start
    expect(d.signals.map((s) => s.id)).toEqual(['release_risk', 'overdue:jira', 'meeting_soon:m1'])
    expect(d.hiddenSignalCount).toBe(3)
    expect(d.hiddenSignals!.map((s) => s.id)).toEqual(['overdue:todo', 'due_today', 'qa_start'])
    // 숨은 신호의 항목(ICA-11 오늘 마감, 지난 할 일)은 강조하지 않는다
    expect(d.jira.rows.find((r) => r.key === 'ICA-11')!.signaled).toBe(false)
    expect(d.jira.rows.find((r) => r.key === 'ICA-10')!.signaled).toBe(true)
    expect(d.todos.rows[0].signaled).toBe(false)
  })

  it('meeting_soon 이 없으면 상위 3건 그대로', () => {
    const d = buildTodayDashboard(
      input({
        events: [QA, REL],
        notes: NOTES,
        snapshot: snap([issue('ICA-812', { fixVersions: fv177 }), issue('ICA-10', { duedate: '2026-11-10' })]),
        activeTodos: [todo('지난 할 일', { due_date: '2026-11-18' })]
      })
    )
    expect(d.signals.map((s) => s.id)).toEqual(['release_risk', 'overdue:jira', 'overdue:todo'])
    expect(d.hiddenSignals!.map((s) => s.id)).toEqual(['qa_start'])
  })

  it('meeting_soon 은 60분 이내 가장 가까운 회의, 문구는 절대 시각', () => {
    const d = buildTodayDashboard(
      input({ events: [timed('a', '스크럼', 12, 30), timed('b', 'Tech weekly', 12, 0), timed('c', '늦은 회의', 15, 0)] })
    )
    expect(d.signals).toHaveLength(1)
    expect(d.signals[0]).toMatchObject({ id: 'meeting_soon:b', kind: 'meeting_soon', severity: 'info', text: '12:00 Tech weekly' })
    expect(d.signals[0].refs).toEqual([{ type: 'meeting', id: 'b', label: 'Tech weekly' }])
  })

  it('추가 캘린더 회의는 일정에는 보이되 meeting_soon·회의 수 집계에서 빠진다', () => {
    const tech = { ...timed('t', 'Tech weekly', 12, 0), calendarId: 'c_tech@group.calendar.google.com' }
    const mine = { ...timed('p', '1:1', 15, 0), calendarId: 'primary' }
    const d = buildTodayDashboard(input({ events: [tech, mine, timed('n', '무소속', 16, 0)] }))
    expect(d.schedule.rows.map((r) => r.id)).toEqual(['t', 'p', 'n'])
    expect(d.schedule.rows.map((r) => r.calendarId)).toEqual(['c_tech@group.calendar.google.com', 'primary', null])
    expect(d.signals).toEqual([])
    expect(d.facts?.meetingCount).toBe(2)
    expect(d.summaryLine).toBe('회의 2')
    expect(d.facts?.nextMeeting).toEqual({ title: '1:1', start: '15:00' })
  })

  it('신호 0건이면 summaryLine 이 회의·오늘 마감·배포를 요약한다', () => {
    const d = buildTodayDashboard(
      input({
        now: at(8, 0, 18),
        events: [QA, REL, timed('x', '회의1', 15, 0, 30, 18), timed('y', '회의2', 16, 0, 30, 18)],
        notes: NOTES
      })
    )
    expect(d.signals).toEqual([])
    expect(d.summaryLine).toBe('회의 2 · 배포 D-6')
    const empty = buildTodayDashboard(input())
    expect(empty.summaryLine).toBe('오늘 챙길 일이 없어요')
    expect(empty.headline).toBe('오늘은 급한 일이 없어요.')
  })
})

describe('buildTodayDashboard — 내 Jira 작업', () => {
  it('정렬: 지남 → 오늘 마감 → 진행 중 → 리뷰 → 나머지, 상한 7(지남은 상한 제외)', () => {
    const overdue = Array.from({ length: 3 }, (_, k) => issue(`ICA-${k + 1}`, { duedate: '2026-11-01' }))
    const progress = Array.from({ length: 8 }, (_, k) => issue(`ICA-${k + 20}`))
    const extra = [
      issue('ICA-50', { status: 'QA', duedate: null }),
      issue('ICA-60', { duedate: '2026-11-19', statusCategory: 'new', status: '할 일' }),
      issue('ICA-70', { statusCategory: 'new', status: '할 일' }), // 마감도 배포도 없는 할 일 → 제외
      issue('ICA-80', { statusCategory: 'done', status: '완료' }),
      issue('ICA-90', { level: 'epic' }),
      issue('ICA-91', { inScope: false }),
      issue('ICA-92', { assigneeAccountId: 'other' })
    ]
    const d = buildTodayDashboard(input({ snapshot: snap([...progress, ...extra, ...overdue]) }))
    expect(d.jira.state).toBe('ok')
    const keys = d.jira.rows.map((r) => r.key)
    expect(keys.slice(0, 4)).toEqual(['ICA-1', 'ICA-2', 'ICA-3', 'ICA-60'])
    expect(keys).toHaveLength(3 + JIRA_ROW_LIMIT)
    expect(keys).not.toContain('ICA-70')
    expect(keys).not.toContain('ICA-50') // 리뷰는 진행 중 8건 뒤라 상한에 걸린다
    expect(d.jira.moreCount).toBe(9 - (JIRA_ROW_LIMIT - 1))
  })

  it('배포 카드에 보이는 행은 빼고, 배포 카드 상한으로 잘린 포함 할 일은 마감 없어도 보인다', () => {
    const keys = ['ICA-70', 'ICA-71', 'ICA-72', 'ICA-73']
    const d = buildTodayDashboard(
      input({
        now: at(9, 0, 17),
        events: [QA, REL],
        notes: NOTES,
        snapshot: snap(keys.map((k) => issue(k, { statusCategory: 'new', status: '할 일', fixVersions: fv177 })))
      })
    )
    expect(d.release!.rows.map((r) => r.key)).toEqual(['ICA-70', 'ICA-71', 'ICA-72'])
    expect(d.release!.moreCount).toBe(1)
    expect(d.jira.rows.map((r) => r.key)).toEqual(['ICA-73'])
    expect(d.jira.moreCount).toBe(0)
  })

  it('연결 상태를 그대로 옮긴다', () => {
    expect(buildTodayDashboard(input({ snapshot: null, boardErrorCode: 'not_connected' })).jira.state).toBe('not_connected')
    expect(buildTodayDashboard(input({ snapshot: null, boardErrorCode: 'no_default_project' })).jira.state).toBe('no_project')
    expect(buildTodayDashboard(input({ snapshot: null })).jira.state).toBe('loading')
  })

  it('저장본 없이 조회가 실패하면 error, 도는 중이면 loading', () => {
    expect(buildTodayDashboard(input({ snapshot: null, boardError: 'Jira 503' })).jira.state).toBe('error')
    expect(buildTodayDashboard(input({ snapshot: null, boardError: 'Jira 503', boardLoading: true })).jira.state).toBe(
      'loading'
    )
    // 저장본이 있으면 실패해도 그대로 보인다
    expect(buildTodayDashboard(input({ boardError: 'Jira 503' })).jira.state).toBe('ok')
  })
})

describe('buildTodayDashboard — 할 일', () => {
  it('지남 → 오늘 → 우선순위 → 생성순, 상한 6(지남은 상한 제외), 오늘 완료 수', () => {
    const over = [todo('지남1', { due_date: '2026-11-17 18:00' }), todo('지남2', { due_date: '2026-11-18' })]
    const today = todo('오늘', { due_date: '2026-11-19T18:00', priority: 'low' })
    const rest = [
      todo('낮음', { priority: 'low' }),
      todo('높음', { priority: 'high', due_date: '2026-11-25' }),
      ...Array.from({ length: 6 }, (_, k) => todo(`보통${k}`))
    ]
    const doneToday = todo('끝냄', { is_completed: 1, completed_at: '2026-11-19 09:30:00' })
    const doneOld = todo('예전', { is_completed: 1, completed_at: '2026-11-18 09:30:00' })
    const d = buildTodayDashboard(
      input({ activeTodos: [...rest, today, ...over, doneToday], completedTodos: [doneToday, doneOld] })
    )
    expect(d.todos.rows.map((r) => r.title)).toEqual(['지남1', '지남2', '오늘', '높음', '보통0', '보통1', '보통2', '보통3'])
    expect(d.todos.rows.map((r) => r.bucket).slice(0, 4)).toEqual(['overdue', 'overdue', 'today', 'later'])
    expect(d.todos.rows).toHaveLength(2 + TODO_ROW_LIMIT)
    expect(d.todos.moreCount).toBe(9 - TODO_ROW_LIMIT)
    expect(d.todos.doneTodayCount).toBe(1)
  })
})

describe('buildTodayDashboard — 할 일 정렬', () => {
  it('지남 → 오늘 → 마감 있음(날짜순) → 마감 없음, 같은 날짜는 우선순위', () => {
    const list = [
      todo('없음-높음', { priority: 'high' }),
      todo('12/1-낮음', { priority: 'low', due_date: '2026-12-01' }),
      todo('11/25-보통', { due_date: '2026-11-25' }),
      todo('11/25-높음', { priority: 'high', due_date: '2026-11-25' }),
      todo('오늘', { due_date: '2026-11-19' }),
      todo('지남', { priority: 'low', due_date: '2026-11-01' })
    ]
    const d = buildTodayDashboard(input({ activeTodos: list }))
    expect(d.todos.rows.map((r) => r.title)).toEqual(['지남', '오늘', '11/25-높음', '11/25-보통', '12/1-낮음', '없음-높음'])
    expect(d.todos.rows.map((r) => r.bucket)).toEqual(['overdue', 'today', 'later', 'later', 'later', 'none'])
  })
})

describe('buildTodayDashboard — 미연결 문구', () => {
  it('캘린더·Jira 둘 다 미연결이면 "없음"으로 단정하지 않는다', () => {
    const d = buildTodayDashboard(input({ calendarConnected: false, snapshot: null, boardErrorCode: 'not_connected' }))
    expect(d.headline).toBe('캘린더와 Jira를 연결하면 오늘 챙길 것이 여기에 보여요.')
    expect(d.summaryLine).toBe('캘린더와 Jira를 연결하면 오늘 챙길 것이 여기에 보여요')
    expect(d.facts).toMatchObject({ calendarConnected: false, jiraConnected: false })
  })

  it('한쪽만 미연결이면 그 조각을 말하지 않는다', () => {
    const noCal = buildTodayDashboard(input({ calendarConnected: false, events: [timed('a', '회의', 15, 0)] }))
    expect(noCal.headline).not.toContain('회의 1')
    expect(noCal.summaryLine).not.toContain('회의 1')
    expect(noCal.headline).toContain('캘린더를 연결하면')
    const noJira = buildTodayDashboard(input({ snapshot: null, boardErrorCode: 'no_default_project' }))
    expect(noJira.headline).toContain('Jira를 연결하면')
    expect(noJira.facts?.jiraConnected).toBe(false)
    // 할 일 신호가 있으면 그것을 말한다
    const withTodo = buildTodayDashboard(
      input({ calendarConnected: false, snapshot: null, boardErrorCode: 'not_connected', activeTodos: [todo('오늘', { due_date: '2026-11-19' })] })
    )
    expect(withTodo.headline).toBe('오늘 마감 할 일 1건이 있어요.')
  })

  it('불러오는 중·조회 실패는 연결된 것으로 본다', () => {
    expect(buildTodayDashboard(input({ snapshot: null })).facts?.jiraConnected).toBe(true)
    expect(buildTodayDashboard(input({ snapshot: null, boardError: 'x' })).facts?.jiraConnected).toBe(true)
    expect(buildTodayDashboard(input()).headline).toBe('오늘은 급한 일이 없어요.')
  })
})

describe('buildTodayDashboard — Jira 를 모를 때(N1·N2)', () => {
  const overdueTodo = (): Todo => todo('지난 할 일', { due_date: '2026-11-18' })
  const todayTodo = (): Todo => todo('오늘 할 일', { due_date: '2026-11-19' })

  for (const [name, over] of [
    ['조회 실패', { snapshot: null, boardError: 'Jira 503' }],
    ['불러오는 중', { snapshot: null, boardLoading: true }],
    ['미연결', { snapshot: null, boardErrorCode: 'not_connected' as const }]
  ] as const) {
    it(`${name}: 배포 카드는 내 작업을 모른다고 표시하고 위험을 만들지 않는다`, () => {
      const d = buildTodayDashboard(input({ ...over, events: [QA, REL], notes: NOTES }))
      expect(d.release).toMatchObject({ linked: true, mineKnown: false, mine: { total: 0 } })
      expect(d.signals.some((s) => s.kind === 'release_risk')).toBe(false)
      expect(d.releaseUnknown).toBe(false)
    })
  }

  it('내 계정 id 를 모르면 mineKnown false', () => {
    const d = buildTodayDashboard(
      input({ events: [QA, REL], notes: NOTES, snapshot: snap([issue('ICA-812', { fixVersions: fv177 })], null) })
    )
    expect(d.release?.mineKnown).toBe(false)
    expect(d.signals.some((s) => s.kind === 'release_risk')).toBe(false)
  })

  it('스냅샷이 있으면 mineKnown true', () => {
    const d = buildTodayDashboard(input({ events: [QA, REL], notes: NOTES }))
    expect(d.release?.mineKnown).toBe(true)
  })

  it('마감 건수는 할 일만 센 값임을 문구에 드러낸다', () => {
    const d = buildTodayDashboard(input({ snapshot: null, boardError: 'x', activeTodos: [overdueTodo(), todayTodo()] }))
    expect(d.headline).toBe('마감 지난 할 일 1건이 있어요.')
    expect(d.signals.map((s) => s.text)).toEqual(['마감 지난 할 일 1건', '오늘 마감 할 일 1건'])
    const t = buildTodayDashboard(input({ now: at(9, 0, 18), snapshot: null, boardError: 'x', activeTodos: [todo('a', { due_date: '2026-11-18' })] }))
    expect(t.headline).toBe('오늘 마감 할 일 1건이 있어요.')
    // 신호가 있어도 summaryLine 은 늘 계산된다
    expect(t.summaryLine).toBe('오늘 마감 할 일 1')
    // Jira 를 알면 기존 문구
    const k = buildTodayDashboard(input({ activeTodos: [todayTodo()] }))
    expect(k.signals[0].text).toBe('오늘 마감 1건 (할 일 1)')
    expect(k.summaryLine).toBe('오늘 마감 1')
  })

  it('releaseUnknown: 배포를 못 찾았는데 Jira 상태가 ok 가 아니면 true', () => {
    expect(buildTodayDashboard(input({ snapshot: null, boardErrorCode: 'not_connected' })).releaseUnknown).toBe(true)
    expect(buildTodayDashboard(input({ snapshot: null })).releaseUnknown).toBe(true)
    expect(buildTodayDashboard(input({ snapshot: null, boardError: 'x' })).releaseUnknown).toBe(true)
    expect(buildTodayDashboard(input()).releaseUnknown).toBe(false)
    // 캘린더 배포 일정이 있으면 Jira 와 무관하게 안다
    expect(buildTodayDashboard(input({ snapshot: null, boardErrorCode: 'not_connected', events: [REL] })).releaseUnknown).toBe(false)
  })
})

describe('buildTodayDashboard — 일정', () => {
  it('일반 종일 일정은 칩, 지금 진행 중 일정은 current, 내일 첫 일정', () => {
    const d = buildTodayDashboard(
      input({
        events: [
          allDay('h', '팀 워크숍', '2026-11-19', '2026-11-20'),
          allDay('old', '어제 일정', '2026-11-18', '2026-11-19'),
          timed('now', '진행 중 회의', 11, 0, 60),
          timed('t1', '내일 스크럼', 10, 0, 15, 20),
          timed('t2', '내일 첫 회의', 9, 30, 30, 20)
        ],
        calendarConnected: false
      })
    )
    expect(d.schedule.connected).toBe(false)
    expect(d.schedule.allDay).toEqual([{ id: 'h', title: '팀 워크숍' }])
    expect(d.schedule.rows[0].timing).toBe('current')
    expect(d.schedule.nowIndex).toBe(1)
    expect(d.schedule.tomorrowCount).toBe(2)
    expect(d.schedule.tomorrowFirst).toBe('09:30 내일 첫 회의')
  })
})

describe('minutesUntil', () => {
  it('남은 분을 올림으로 돌려준다', () => {
    expect(minutesUntil(iso(12, 0), at(11, 20))).toBe(40)
    expect(minutesUntil(iso(11, 0), at(11, 20))).toBe(-20)
    expect(Number.isNaN(minutesUntil('bad', at(11, 20)))).toBe(true)
  })
})

describe('규칙 사실(facts)과 신호 문구', () => {
  it('사실을 담고 신호 문구에 상대 시간은 넣지 않는다', () => {
    const d = buildTodayDashboard(
      input({ events: [QA, REL, timed('w', 'Tech weekly', 12, 0)], notes: NOTES, snapshot: snap([issue('ICA-812', { fixVersions: fv177 })]) })
    )
    expect(d.signals.map((s) => s.kind)).toContain('meeting_soon')
    expect(d.facts).toMatchObject({
      meetingCount: 1,
      release: { version: '4.177.0', dDay: 5, linked: true, qaStart: '2026-11-19', mine: { total: 1, progress: 1 } }
    })
    expect(JSON.stringify(d.signals.map((s) => s.text))).not.toMatch(/분 뒤|시간 뒤/)
  })
})

describe('visibleRefs', () => {
  it('화면 칩은 상한 + 나머지 수', () => {
    const many = Array.from({ length: 25 }, (_, k) => issue(`ICA-${k + 1}`, { duedate: '2026-11-01' }))
    const d = buildTodayDashboard(input({ snapshot: snap(many) }))
    const s = d.signals.find((x) => x.id === 'overdue:jira')!
    expect(s.refs).toHaveLength(25)
    const v = visibleRefs(s)
    expect(v.refs).toHaveLength(SIGNAL_REF_DISPLAY_LIMIT)
    expect(v.moreCount).toBe(25 - SIGNAL_REF_DISPLAY_LIMIT)
  })

  it('배포 ref 는 칩 상한과 무관하게 남는다', () => {
    const refs = [
      ...Array.from({ length: 6 }, (_, k) => ({ type: 'issue' as const, id: `K-${k}`, label: `K-${k}` })),
      { type: 'release' as const, id: '4.177.0', label: '4.177.0' }
    ]
    const v = visibleRefs({ refs })
    expect(v.refs.map((r) => r.id)).toEqual(['K-0', 'K-1', 'K-2', 'K-3', '4.177.0'])
    expect(v.moreCount).toBe(2)
  })
})

describe('할 일 공용 모델 연결', () => {
  it('대시보드 할 일 묶음은 todo/todoModel 의 todoBucket 과 같다', () => {
    const today = '2026-11-19'
    const dues = ['2026-11-17 18:00', '2026-11-19', '2026-11-19 09:00', '2026-11-25', null]
    const d = buildTodayDashboard(
      input({ activeTodos: dues.map((due, k) => todo(`b${k}`, { due_date: due })) })
    )
    for (const r of d.todos.rows) expect(r.bucket).toBe(todoBucket(r.dueDate, today))
    expect(d.todos.rows.map((r) => r.bucket)).toEqual(['overdue', 'today', 'today', 'later', 'none'])
  })
})

describe('todoInputSummary', () => {
  const today = '2026-11-19'
  const tags = [{ id: 1, name: '업무' }]
  it('마감·시각·우선순위·태그를 한 줄로 잇는다', () => {
    expect(todoInputSummary({ due_date: '2026-11-20 15:00', priority: 'high' }, today)).toBe('내일 15:00 · 높음')
    expect(todoInputSummary({ due_date: '2026-11-19' }, today)).toBe('오늘')
    expect(todoInputSummary({ due_date: '2026-11-25', priority: 'low', tag_ids: [1, 9] }, today, tags)).toBe('11/25 · 낮음 · #업무')
  })
  it('보통 우선순위만 있거나 알아본 것이 없으면 빈 문자열', () => {
    expect(todoInputSummary({ priority: 'medium' }, today)).toBe('')
    expect(todoInputSummary({ due_date: null }, today)).toBe('')
  })
  it('달이 바뀌는 내일도 내일이다', () => {
    expect(todoInputSummary({ due_date: '2026-12-01 09:30' }, '2026-11-30')).toBe('내일 09:30')
  })
})
