import { describe, it, expect } from 'vitest'
import type { CalendarEvent, JiraBoardIssue, JiraBoardSnapshot, MeetingNoteItem, Todo, TodoPriority } from '../../types'
import { buildWorkShare, workShareText, type WorkShareInput } from './shareModel'

// 2026-11: 19일 목, 20일 금, 21일 토, 22일 일, 23일 월
const local = (d: number, h = 0, m = 0): Date => new Date(2026, 10, d, h, m)
const iso = (d: number, h = 0, m = 0): string => local(d, h, m).toISOString()
const sqlite = (d: number, h = 0, m = 0): string =>
  `2026-11-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`

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
  updated: iso(1),
  resolvedAt: null,
  labels: [],
  excerpt: null,
  fixVersions: [],
  links: [],
  ...over
})

const snap = (issues: JiraBoardIssue[], myAccountId: string | null = 'me'): JiraBoardSnapshot => ({
  projectKey: 'PROJ',
  myAccountId,
  issues,
  truncated: false,
  recentDoneDays: 14,
  fetchedAt: iso(20, 9),
  lastFullSyncAt: null
})

const todo = (id: number, title: string, over: Partial<Todo> = {}): Todo => ({
  id,
  title,
  priority: 'medium' as TodoPriority,
  due_date: null,
  due_reminder: 0,
  is_completed: 0,
  completed_at: null,
  notes: null,
  source_link: null,
  created_at: sqlite(1),
  updated_at: sqlite(1),
  ...over
})
const doneTodo = (id: number, title: string, completed_at: string): Todo =>
  todo(id, title, { is_completed: 1, completed_at })

const event = (id: string, summary: string, d: number, h: number, m = 0, dur = 30): CalendarEvent => ({
  id,
  summary,
  start: iso(d, h, m),
  end: new Date(local(d, h, m).getTime() + dur * 60_000).toISOString(),
  allDay: false
})

const meetingNote = (id: number, title: string, started_at: string, tldr: string | null = null): MeetingNoteItem => ({
  id,
  title,
  kind: 'meeting',
  started_at,
  duration_ms: 1_800_000,
  tldr,
  key_point_count: 0,
  decision_count: 0,
  action_item_count: 0,
  open_action_count: 0,
  attendee_names: [],
  generated_at: started_at
})

const input = (over: Partial<WorkShareInput> = {}): WorkShareInput => ({
  now: local(20, 9, 30),
  snapshot: null,
  activeTodos: [],
  completedTodos: [],
  events: [],
  pastEvents: [],
  notes: [],
  ...over
})

describe('buildWorkShare — 작업 완료', () => {
  it('[어제 0시, 오늘 0시) 는 done, [오늘 0시, now] 는 doneToday. 이슈 키 순 → 할 일 완료 시각순, 중복 없음', () => {
    const w = buildWorkShare(
      input({
        snapshot: snap([
          issue('PROJ-12', { statusCategory: 'done', resolvedAt: iso(19, 15) }),
          issue('PROJ-2', { statusCategory: 'done', resolvedAt: iso(19, 23, 59) }), // 전날 23:59 → done
          issue('PROJ-3', { statusCategory: 'done', resolvedAt: iso(20, 0) }), // 오늘 00:00 → doneToday
          issue('PROJ-6', { statusCategory: 'done', resolvedAt: iso(20, 9, 31) }), // now 이후 → 제외
          issue('PROJ-4', { statusCategory: 'done', resolvedAt: iso(18, 23, 59) }), // 그제 → 제외
          issue('PROJ-5', { statusCategory: 'done', resolvedAt: iso(19, 10), assigneeAccountId: 'other' })
        ]),
        activeTodos: [doneTodo(1, '오늘 완료', sqlite(20, 9)), todo(9, '미완료')],
        completedTodos: [
          doneTodo(1, '오늘 완료', sqlite(20, 9)), // active 와 중복
          doneTodo(7, '오늘 자정', sqlite(20, 0)),
          doneTodo(8, '어제 늦게', sqlite(19, 23, 59)),
          doneTodo(2, '어제 자정', sqlite(19, 0)), // from 포함
          doneTodo(3, '그제', sqlite(18, 23, 59))
        ]
      })
    )
    expect(w.done.map((i) => [i.kind, i.id])).toEqual([
      ['issue', 'PROJ-2'],
      ['issue', 'PROJ-12'],
      ['todo', '2'],
      ['todo', '8']
    ])
    expect(w.doneToday.map((i) => [i.kind, i.id, i.note])).toEqual([
      ['issue', 'PROJ-3', null],
      ['todo', '7', null],
      ['todo', '1', null]
    ])
    expect(w.total).toBe(7)
  })

  it('오늘 완료한 이슈·할 일도 작업 중·예정에서 빠진다', () => {
    const w = buildWorkShare(
      input({
        snapshot: snap([issue('PROJ-9', { resolvedAt: iso(20, 8) }), issue('PROJ-10', { statusCategory: 'new', resolvedAt: iso(20, 8) })]),
        activeTodos: [todo(1, '오늘 마감 완료', { due_date: '2026-11-20', is_completed: 1, completed_at: sqlite(20, 8) })]
      })
    )
    expect(w.doneToday.map((i) => i.id)).toEqual(['PROJ-9', 'PROJ-10', '1'])
    expect(w.doing).toEqual([])
    expect(w.planned).toEqual([])
  })
})

describe('buildWorkShare — 작업 중·예정', () => {
  it('진행 중은 갱신 시각과 관계없이 전부, 상태 이름을 note 로', () => {
    const w = buildWorkShare(
      input({
        snapshot: snap([
          issue('PROJ-15', { status: 'In Review', updated: iso(1) }),
          issue('PROJ-8', { status: '진행 중' }),
          issue('PROJ-9', { statusCategory: 'indeterminate', resolvedAt: iso(19, 10) }), // 완료로 이미 들어감
          issue('PROJ-7', { assigneeAccountId: 'other' })
        ])
      })
    )
    expect(w.doing.map((i) => [i.id, i.note])).toEqual([
      ['PROJ-8', '진행 중'],
      ['PROJ-15', 'In Review']
    ])
    expect(w.done.map((i) => i.id)).toEqual(['PROJ-9'])
  })

  it('예정: 할 일 상태이고 범위 안 이슈(기한순 → 키 순) 다음 기한 지남·오늘 할 일(지남 먼저, 우선순위순)', () => {
    const w = buildWorkShare(
      input({
        snapshot: snap([
          issue('PROJ-30', { statusCategory: 'new' }),
          issue('PROJ-20', { statusCategory: 'new' }),
          issue('PROJ-40', { statusCategory: 'new', duedate: '2026-11-25' }),
          issue('PROJ-41', { statusCategory: 'new', duedate: '2026-11-21' }),
          issue('PROJ-50', { statusCategory: 'new', inScope: false }) // 백로그 → 제외
        ]),
        activeTodos: [
          todo(1, '오늘 낮음', { due_date: '2026-11-20', priority: 'low' }),
          todo(2, '오늘 높음', { due_date: '2026-11-20 15:00', priority: 'high' }),
          todo(3, '지난 보통', { due_date: '2026-11-18' }),
          todo(4, '내일', { due_date: '2026-11-21' }),
          todo(5, '기한 없음'),
          doneTodo(6, '오늘 완료(목록에 섞임)', sqlite(20, 8))
        ]
      })
    )
    expect(w.planned.map((i) => [i.kind, i.id, i.note])).toEqual([
      ['issue', 'PROJ-41', null],
      ['issue', 'PROJ-40', null],
      ['issue', 'PROJ-20', null],
      ['issue', 'PROJ-30', null],
      ['todo', '3', '기한 지남'],
      ['todo', '2', null],
      ['todo', '1', null]
    ])
  })

  it('스냅샷이나 내 계정이 없으면 Jira 항목이 없다', () => {
    const issues = [issue('PROJ-1'), issue('PROJ-2', { statusCategory: 'new' })]
    for (const s of [null, snap(issues, null)]) {
      const w = buildWorkShare(input({ snapshot: s }))
      expect(w.jiraKnown).toBe(false)
      expect(w.done.length + w.doing.length + w.planned.length).toBe(0)
    }
    expect(buildWorkShare(input({ snapshot: snap(issues) })).jiraKnown).toBe(true)
  })
})

describe('buildWorkShare — 회의·리뷰', () => {
  it('지난 근무일 일정이 먼저, 오늘 일정이 뒤. 회의록은 같은 규칙으로 붙거나 독립 행', () => {
    const w = buildWorkShare(
      input({
        pastEvents: [
          event('p-sync', '주간 회의', 19, 10),
          { id: 'p-all', summary: '휴가', start: iso(19), end: iso(20), allDay: true },
          event('p-old', '그제 회의', 18, 10)
        ],
        events: [
          event('t-prd', 'PRD 리뷰: 결제 개편', 20, 14, 0, 60),
          event('t-late', 'Design Review', 20, 11),
          event('t-tomorrow', '내일 회의', 21, 10),
          { id: 't-all', summary: '종일', start: iso(20), end: iso(21), allDay: true }
        ],
        notes: [
          meetingNote(1, '주간 회의 기록', sqlite(19, 9, 55), '요약 A'),
          meetingNote(2, '즉석 논의', sqlite(19, 16, 30)),
          meetingNote(3, 'PRD 기록', sqlite(20, 14, 5), '요약 C'),
          meetingNote(4, '오늘 아침 메모', sqlite(20, 8))
        ]
      })
    )
    expect(w.meetings.map((m) => [m.id, m.day, m.dayLabel, m.start, m.review, m.noteId, m.tldr])).toEqual([
      ['p-sync', 'past', '어제', '10:00', false, 1, '요약 A'],
      ['note-2', 'past', '어제', '16:30', false, 2, null],
      ['note-4', 'today', '오늘', '08:00', false, 4, null],
      ['t-late', 'today', '오늘', '11:00', true, null, null],
      ['t-prd', 'today', '오늘', '14:00', true, 3, '요약 C']
    ])
  })

  it('여러 날이면 지난 회의에 요일을 붙인다', () => {
    const w = buildWorkShare(input({ now: local(23, 9), pastEvents: [event('fri', '금 회의', 20, 10)] }))
    expect(w.meetings.map((m) => m.dayLabel)).toEqual(['금'])
    expect(w.range.multiDay).toBe(true)
  })
})

describe('workShareText', () => {
  it('어제는 짧게, 오늘은 섹션별. 묶음 사이 빈 줄', () => {
    const w = buildWorkShare(
      input({
        snapshot: snap([
          issue('PROJ-12', { summary: '로그인 오류 수정', statusCategory: 'done', resolvedAt: iso(19, 15) }),
          issue('PROJ-15', { summary: '결제 화면 개편', status: 'In Review' }),
          issue('PROJ-20', { summary: '알림 설정 추가', statusCategory: 'new' })
        ]),
        completedTodos: [doneTodo(1, '주간 보고 작성', sqlite(19, 11))],
        activeTodos: [todo(2, '배포 체크리스트 확인', { due_date: '2026-11-19' })],
        pastEvents: [event('e', '주간 회의', 19, 10), event('r', 'PRD 리뷰', 19, 15)],
        events: [event('t', 'PRD 리뷰: 결제 개편', 20, 14)],
        notes: [meetingNote(1, '기록', sqlite(19, 10), '비밀 요약')]
      })
    )
    expect(w.dateLabel).toBe('11월 20일 (금)')
    expect(w.pastTitle).toBe('어제')
    expect(w.total).toBe(8)
    expect(workShareText(w)).toBe(
      [
        '업무 공유 · 11월 20일 (금)',
        '',
        '■ 어제 · 11월 19일 (목)',
        '- PROJ-12 로그인 오류 수정',
        '- 주간 보고 작성',
        '- 회의: 주간 회의, PRD 리뷰',
        '',
        '■ 오늘',
        '[작업 중]',
        '- PROJ-15 결제 화면 개편 (In Review)',
        '[작업 예정]',
        '- PROJ-20 알림 설정 추가',
        '- 배포 체크리스트 확인 (기한 지남)',
        '[회의·리뷰]',
        '- 14:00 PRD 리뷰: 결제 개편'
      ].join('\n')
    )
  })

  it('여러 날이면 지난 근무일 이후 제목, 오늘 묶음이 비면 어제 묶음만', () => {
    const w = buildWorkShare(input({ now: local(23, 9), pastEvents: [event('e', '데모', 20, 15)] }))
    expect(w.pastTitle).toBe('지난 근무일 이후')
    expect(workShareText(w)).toBe(
      ['업무 공유 · 11월 23일 (월)', '', '■ 지난 근무일 이후 · 11월 20일 (금) ~ 22일 (일)', '- 회의: 데모'].join('\n')
    )
  })

  it('어제 묶음이 비면 오늘 묶음만', () => {
    const w = buildWorkShare(
      input({ snapshot: snap([issue('PROJ-15', { summary: '결제', status: 'In Review' })]), events: [event('t', '스크럼', 20, 10)] })
    )
    expect(workShareText(w)).toBe(
      ['업무 공유 · 11월 20일 (금)', '', '■ 오늘', '[작업 중]', '- PROJ-15 결제 (In Review)', '[회의·리뷰]', '- 10:00 스크럼'].join('\n')
    )
  })

  it('오늘 완료는 오늘 묶음의 마지막 섹션', () => {
    const w = buildWorkShare(
      input({
        snapshot: snap([
          issue('PROJ-12', { summary: '로그인 오류 수정', statusCategory: 'done', resolvedAt: iso(19, 15) }),
          issue('PROJ-15', { summary: '결제', status: 'In Review' }),
          issue('PROJ-30', { summary: '핫픽스', statusCategory: 'done', resolvedAt: iso(20, 8) })
        ]),
        completedTodos: [doneTodo(1, '회고 정리', sqlite(20, 9))],
        events: [event('t', '스크럼', 20, 10)]
      })
    )
    expect(workShareText(w)).toBe(
      [
        '업무 공유 · 11월 20일 (금)',
        '',
        '■ 어제 · 11월 19일 (목)',
        '- PROJ-12 로그인 오류 수정',
        '',
        '■ 오늘',
        '[작업 중]',
        '- PROJ-15 결제 (In Review)',
        '[회의·리뷰]',
        '- 10:00 스크럼',
        '[오늘 완료]',
        '- PROJ-30 핫픽스',
        '- 회고 정리'
      ].join('\n')
    )
  })

  it('아무것도 없으면 빈 문자열', () => {
    const w = buildWorkShare(input({ snapshot: snap([]) }))
    expect(w.total).toBe(0)
    expect(workShareText(w)).toBe('')
  })
})
