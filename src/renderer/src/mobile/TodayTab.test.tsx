import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TodayDashboard } from '../components/today/todayModel'
import type { MobileTodaySnapshot } from './contract'
import { collect, click } from '../components/today/testTree'
import { SNAPSHOT_EMPTY_TEXT, TodayContent, TodoSummarySection, type TodayContentProps } from './TodayTab'

const NOW = new Date('2026-11-19T01:30:00Z')

const dashboard = (over: Partial<TodayDashboard> = {}): TodayDashboard => ({
  date: '2026-11-19',
  headline: '배포 D-1, 리뷰 2건을 오늘 끝내야 해요',
  signals: [
    {
      id: 'sig-risk',
      kind: 'release_risk',
      severity: 'critical',
      text: '1.4.0 배포에 아직 리뷰 중인 내 작업이 있어요',
      refs: [
        { type: 'issue', id: 'APP-12', label: 'APP-12' },
        { type: 'release', id: '1.4.0', label: '1.4.0' }
      ]
    },
    {
      id: 'sig-meet',
      kind: 'meeting_soon',
      severity: 'info',
      text: '주간 회의',
      refs: [{ type: 'meeting', id: 'ev-2', label: '주간 회의' }]
    }
  ],
  hiddenSignalCount: 1,
  hiddenSignals: [{ id: 'sig-hidden', kind: 'due_today', severity: 'warn', text: '숨은 신호 문구', refs: [] }],
  summaryLine: '',
  release: {
    version: '1.4.0',
    date: '2026-11-20',
    dDay: 1,
    linked: true,
    noteId: 1,
    jiraVersionId: '100',
    qaStart: '2026-11-17',
    qaEnd: '2026-11-18',
    phase: 'qa',
    totalCount: 24,
    mineKnown: true,
    mine: { total: 5, done: 2, review: 1, progress: 1, todo: 1 },
    rows: [
      {
        key: 'APP-12',
        summary: '결제 화면 리뷰 반영',
        status: '리뷰 중',
        statusCategory: 'indeterminate',
        review: true,
        duedate: '2026-11-18',
        overdue: true,
        dueToday: false,
        signaled: true,
        revealable: true
      }
    ],
    moreCount: 0
  },
  releaseUnknown: false,
  jira: {
    state: 'ok',
    rows: [
      {
        key: 'APP-30',
        summary: '알림 설정 화면',
        status: '진행 중',
        statusCategory: 'indeterminate',
        review: false,
        duedate: '2026-11-19',
        overdue: false,
        dueToday: true,
        signaled: false,
        revealable: true
      }
    ],
    moreCount: 0
  },
  todos: {
    rows: [{ id: 5, title: '배포 체크리스트', priority: 'high', dueDate: '2026-11-19', bucket: 'today', signaled: false }],
    moreCount: 0,
    doneTodayCount: 1
  },
  schedule: {
    connected: true,
    allDay: [{ id: 'ad-1', title: '창립기념일' }],
    rows: [
      {
        id: 'ev-1',
        title: '스탠드업',
        start: '09:30',
        end: '09:45',
        startISO: '2026-11-19T00:30:00Z',
        endISO: '2026-11-19T00:45:00Z',
        timing: 'past',
        location: null,
        htmlLink: null
      },
      {
        id: 'ev-2',
        title: '주간 회의',
        start: '11:00',
        end: '12:00',
        startISO: '2026-11-19T02:00:00Z',
        endISO: '2026-11-19T03:00:00Z',
        timing: 'upcoming',
        location: '3층 회의실',
        htmlLink: null
      }
    ],
    nowIndex: 1,
    tomorrowCount: 2,
    tomorrowFirst: '10:00 디자인 리뷰'
  },
  ...over
})

const snapshot = (over: Partial<MobileTodaySnapshot> = {}): MobileTodaySnapshot => ({
  v: 1,
  publishedAt: '2026-11-19T01:29:00Z',
  date: '2026-11-19',
  heading: '11월 19일 (목)',
  dashboard: dashboard(),
  loading: false,
  ...over
})

const props = (over: Partial<TodayContentProps> = {}): TodayContentProps => ({
  snapshot: snapshot(),
  now: NOW,
  refreshing: false,
  error: null,
  todoError: null,
  doneTodoIds: [],
  onRefresh: () => {},
  onCompleteTodo: () => {},
  ...over
})

describe('TodayContent', () => {
  it('snapshot 이 null 이면 준비 안 됨 안내와 다시 읽기를 보인다', () => {
    const html = renderToStaticMarkup(<TodayContent {...props({ snapshot: null })} />)
    expect(html).toContain(SNAPSHOT_EMPTY_TEXT)
    expect(html).toContain('Mac 의 LinkWork 에서 아직 오늘 화면을 준비하지 못했어요')
    expect(html).toContain('다시 읽기')
  })

  it('스냅샷의 날짜·headline·신호·배포·Jira·일정·할 일을 그린다', () => {
    const html = renderToStaticMarkup(<TodayContent {...props()} />)
    expect(html).toContain('11월 19일 (목)')
    expect(html).toContain('배포 D-1, 리뷰 2건을 오늘 끝내야 해요')
    // 신호: severity 와 문구, refs 라벨 칩, 회의 'n분 뒤'
    expect(html).toContain('data-severity="critical"')
    expect(html).toContain('1.4.0 배포에 아직 리뷰 중인 내 작업이 있어요')
    expect(html).toMatch(/data-ref-type="issue"[^>]*>.*APP-12/)
    expect(html).toContain('30분 뒤')
    expect(html).toContain('외 1건')
    // 다음 배포
    expect(html).toContain('다음 배포')
    expect(html).toContain('D-1')
    expect(html).toContain('11/20(금)')
    expect(html).toContain('QA 11/17(화) ~ 11/18(수)')
    // 단계 열은 좁아 요일 없이 줄인다
    expect(html).toContain('11/17~11/18')
    expect(html).toContain('내 작업 5건: 완료 2 · 리뷰 1 · 진행 1 · 할 일 1')
    expect(html).toContain('결제 화면 리뷰 반영')
    expect(html).toContain('마감 지남')
    expect(html).toContain('전체 포함 24건')
    // Jira
    expect(html).toContain('APP-30')
    expect(html).toContain('오늘 마감')
    // 일정: 종일·지난 일정 흐림·장소·내일
    expect(html).toContain('창립기념일')
    // 지난 일정은 data-timing="past"(mobile.css 가 흐린 글자색으로 그린다)
    expect(html).toContain('data-timing="past"')
    expect(html).toContain('3층 회의실')
    expect(html).toContain('일정 2건 · 첫 10:00 디자인 리뷰')
    // 할 일
    expect(html).toContain('배포 체크리스트')
    expect(html).toContain('오늘 완료 1')
    // 최근 발행이라 경고 아님
    expect(html).toContain('Mac 에서 1분 전 갱신')
    expect(html).toContain('data-stale="false"')
  })

  it('publishedAt 이 5분 넘게 오래되면 경고 표시', () => {
    const html = renderToStaticMarkup(<TodayContent {...props({ snapshot: snapshot({ publishedAt: '2026-11-19T01:20:00Z' }) })} />)
    expect(html).toContain('data-stale="true"')
    expect(html).toContain('Mac 에서 10분 전 갱신')
    expect(html).toContain('오래된 내용일 수 있어요')
    expect(html).toMatch(/class="m-status"/)
  })

  it('Jira 상태별 안내와 캘린더 미연결 안내', () => {
    const states: [TodayDashboard['jira']['state'], string][] = [
      ['not_connected', 'Jira가 연결되지 않았어요.'],
      ['no_project', '기본 Jira 프로젝트가 정해지지 않았어요.'],
      ['loading', 'Jira 작업을 불러오는 중…'],
      ['error', 'Jira 작업을 불러오지 못했어요.']
    ]
    for (const [state, text] of states) {
      const d = dashboard({
        jira: { state, rows: [], moreCount: 0 },
        release: null,
        releaseUnknown: true,
        schedule: { ...dashboard().schedule, connected: false }
      })
      const html = renderToStaticMarkup(<TodayContent {...props({ snapshot: snapshot({ dashboard: d }) })} />)
      expect(html).toContain(text)
      expect(html).toContain('캘린더가 연결되지 않았어요.')
      expect(html).toContain(state === 'not_connected' || state === 'no_project' ? 'Jira를 연결하면 다음 배포가 보여요.' : 'Jira를 불러오면 다음 배포가 보여요.')
    }
  })

  it('할 일 요약의 체크는 그 id 로 완료를 부르고, 오류 문구를 보인다', () => {
    const onComplete = vi.fn()
    const tree = TodoSummarySection({ todos: dashboard().todos, today: '2026-11-19', doneIds: [], error: '완료하지 못했어요: 실패', onComplete })
    const box = collect(tree).find((e) => e.type === 'button' && e.props.role === 'checkbox')
    expect(box).toBeDefined()
    click(box!)
    expect(onComplete).toHaveBeenCalledWith(5)
    expect(renderToStaticMarkup(tree)).toContain('완료하지 못했어요: 실패')
  })
})
