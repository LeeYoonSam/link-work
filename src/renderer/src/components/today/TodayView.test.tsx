import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  AssistantEvent,
  AssistantSettings,
  DailyPlan,
  DayTimeline,
  PlanItem,
  TodayPayload
} from '../../types'

// 오늘 화면은 상태(계획 없음·근무 중·닫힘)마다 상단 영역과 본문이 달라야 한다.
// zustand v5 는 서버 렌더에서 초기 상태만 돌려주므로 스토어 훅을 모킹한다
// (ProjectSyncModal.test.tsx 와 같은 방식). 순수 헬퍼는 실제 구현을 쓴다.

const SETTINGS: AssistantSettings = {
  enabled: true,
  dayRollover: '04:00',
  startNudge: true,
  workEnd: '18:00',
  planSize: 5,
  llmEnabled: true,
  llmModel: 'sonnet',
  jiraScope: 'all',
  openAtLogin: false,
  refreshCalendarMin: 5,
  refreshJiraMin: 15,
  refreshNotify: true,
  meetingLeadMin: 15,
  startView: 'today',
  meetingBriefingEnabled: true,
  morningSyncEnabled: true,
  morningSyncTime: '08:00',
  completeOriginOnDone: false
}

const plan = (over: Partial<DailyPlan> = {}): DailyPlan => ({
  id: 1,
  plan_date: '2026-11-02',
  status: 'active',
  started_at: '2026-11-02 09:40:00',
  closed_at: null,
  closed_by: null,
  source_snapshot: null,
  briefing_text: '## 오늘의 초점\n- 결제 모듈 리팩토링부터 시작하세요',
  briefing_source: 'rules',
  briefing_model: null,
  briefing_error: null,
  briefing_at: '2026-11-02 09:40:05',
  briefing_instruction: null,
  recovery_text: null,
  recovery_source: null,
  recovery_at: null,
  wrapup_note: null,
  wrapup_at: null,
  last_refresh_at: '2026-11-02 10:42:00',
  created_at: '2026-11-02 09:40:00',
  updated_at: '2026-11-02 09:40:00',
  ...over
})

const item = (over: Partial<PlanItem> & Pick<PlanItem, 'id'>): PlanItem => ({
  plan_id: 1,
  candidate_id: `task:${over.id}`,
  source: 'task',
  title: `작업 ${over.id}`,
  link: `linkwork://project/3`,
  jira_issue_key: null,
  project_id: 3,
  due_date: null,
  score: 50,
  rank: over.id,
  slot_start: null,
  slot_end: null,
  pinned: false,
  added_by: 'start',
  urgent: false,
  status: 'planned',
  status_note: null,
  status_at: null,
  first_planned_date: '2026-11-02',
  work_type: 'etc',
  work_version: null,
  parent_key: null,
  group_name: null,
  ...over
})

const EMPTY_TIMELINE: DayTimeline = {
  entries: [],
  freeMinutesLeft: 0,
  focusItemId: null,
  unplacedDeadlineItemIds: []
}

const event = (over: Partial<AssistantEvent> & Pick<AssistantEvent, 'id'>): AssistantEvent => ({
  event_key: `plan_update:2026-11-02:${over.id}`,
  kind: 'plan_update',
  plan_date: '2026-11-02',
  scheduled_at: '2026-11-02 10:42:00',
  fired_at: null,
  status: 'logged',
  ref_id: null,
  payload: null,
  response: null,
  responded_at: null,
  created_at: '2026-11-02 10:42:00',
  ...over
})

const payload = (over: Partial<TodayPayload> = {}): TodayPayload => ({
  logicalDate: '2026-11-02',
  plan: null,
  items: [],
  events: [],
  settings: SETTINGS,
  missingWrapupDate: null,
  aiAvailable: true,
  jiraConnected: true,
  calendarConnected: true,
  jiraTruncated: false,
  lastErrors: [],
  timeline: EMPTY_TIMELINE,
  recovery: { inFlight: false, error: null },
  exclusions: [],
  ...over
})

// 사용자가 고른 화면 모양 (부록 B). 집중 작업 1건이 두 블록을 받고, 마감 todo 가 마지막 블록을 받는다
const WORKING_TIMELINE: DayTimeline = {
  entries: [
    { kind: 'block', start: '09:45', end: '11:00', minutes: 75, state: 'current', itemId: 1, reason: 'focus', continued: false },
    { kind: 'meeting', start: '11:00', end: '12:00', title: '주간 스프린트' },
    { kind: 'meeting', start: '12:00', end: '13:00', title: '점심' },
    { kind: 'block', start: '13:00', end: '15:30', minutes: 150, state: 'future', itemId: 1, reason: 'focus', continued: true },
    { kind: 'meeting', start: '15:30', end: '16:00', title: '1:1' },
    { kind: 'block', start: '16:00', end: '18:00', minutes: 120, state: 'future', itemId: 2, reason: 'deadline', continued: false }
  ],
  freeMinutesLeft: 270,
  focusItemId: 1,
  unplacedDeadlineItemIds: []
}

const state: {
  today: TodayPayload | null
  skippedWrapupDate: string | null
  error: string
} = { today: null, skippedWrapupDate: null, error: '' }

vi.mock('../../stores/assistantStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/assistantStore')>()),
  useAssistantStore: () => ({
    ...state,
    loading: false,
    busy: false,
    candidates: [],
    candidatesLoading: false,
    candidatesError: '',
    focus: null,
    command: null,
    commandPhase: 'idle',
    commandError: '',
    commandResult: null,
    commandScope: null,
    interpretCommand: async () => {},
    applyCommand: async () => true,
    clearCommand: () => {},
    load: async () => {},
    startDay: async () => {},
    closeDay: async () => {},
    reopenDay: async () => {},
    saveWrapup: async () => true,
    skipWrapup: () => {},
    refresh: async () => {},
    refreshBriefing: async () => {},
    generateRecovery: async () => {},
    loadCandidates: async () => {},
    addItem: async () => {},
    acceptSuggestion: async () => {},
    dismissSuggestion: async () => {},
    setItemStatus: async () => {},
    excludeItem: async () => {},
    removeExclusion: async () => {},
    focusItem: async () => {},
    completeOrigin: async () => true,
    saveSettings: async () => true,
    setFocus: () => {},
    clearError: () => {},
    regenerateMeetingBriefing: async () => {},
    meetingRegeneratingIds: []
  })
}))

// 홈 일정·개요는 다른 스토어를 읽는다. 여기서는 그려진 자리와 횟수만 본다.
// 표시 내용은 HomeOverview.test.tsx 와 TodaySchedule.test.tsx 가 맡는다.
// 표식에 날짜를 넣지 않는다. 이유: 'ISO 날짜는 화면에 없다' 검사에 걸린다
vi.mock('../dashboard/HomeSchedule', () => ({
  default: (props: { logicalDate?: string | null }) => (
    <div id="home-schedule" data-logical={props.logicalDate ? 'yes' : 'no'} />
  )
}))
// 진행 중 프로젝트(home-projects)와 중요 메모(home-overview)는 따로 그린다 (부록 M.11 Q1)
vi.mock('../dashboard/HomeOverview', () => ({
  HomeProjects: () => <div id="home-projects" />,
  HomeMemos: () => <div id="home-overview" />,
  default: () => (
    <div>
      <div id="home-projects" />
      <div id="home-overview" />
    </div>
  )
}))

const TodayView = (await import('./TodayView')).default
const { orderPlanItems, todayNotices, unplacedDeadlineItems, focusTargetId } = await import('./TodayView')
const { dayCountLabel, dueLabel, durationLabel, freeTimeLabel, itemSlotLabel, isItemExcluded } = await import(
  './PlanItemRow'
)
const { dueAlertCount, summaryTiles } = await import('./SummaryTiles')
const { default: SummaryTilesView } = await import('./SummaryTiles')
const { describePlanUpdate, planUpdateEvents, commandEvents, describeCommand } = await import('./ChangeLog')
const { describeMorningSync, morningSyncEvents, morningStatusLine, parseMorningPart, describeMorningPart } =
  await import('./ChangeLog')
const { sortSuggestions } = await import('./InboxSection')
const { candidatesNotInPlan } = await import('./CandidatePicker')
const { originTarget } = await import('../../stores/assistantStore')
const { validateSettings, diffSettings, parseNumberInput, numberInputValue, formStartView, START_VIEW_OPTIONS } =
  await import('./AssistantSettingsModal')
const AssistantSettingsModal = (await import('./AssistantSettingsModal')).default
const { recoveryButtonLabel } = await import('./RecoveryCard')
const { localNow } = await import('./TodayView')

const render = (): string => renderToStaticMarkup(<TodayView />)
// '더 보기' 를 연 상태로 그린다 (부록 J.8). 자동 클릭이 불가해 초기값을 주입한다
const renderOpen = (): string => renderToStaticMarkup(<TodayView moreOpenInitial />)

beforeEach(() => {
  state.today = null
  state.skippedWrapupDate = null
  state.error = ''
})

describe('TodayView 상태별 렌더링', () => {
  it('계획 없음: 하루 시작 버튼과 어제 메모 입력을 보여 준다', () => {
    state.today = payload({ missingWrapupDate: '2026-10-30' })
    const html = render()
    expect(html).toContain('하루 시작')
    expect(html).toContain('어제 메모가 없어요. 한 줄 남길까요?')
    expect(html).toContain('건너뛰기')
    // 계획이 없으면 퇴근·새로고침·브리핑이 없다
    expect(html).not.toContain('>퇴근</button>')
    expect(html).not.toContain('새로고침')
    expect(html).not.toContain('브리핑')
  })

  it('계획 없음: 어제 메모를 건너뛰면 입력 칸을 숨긴다', () => {
    state.today = payload({ missingWrapupDate: '2026-10-30' })
    state.skippedWrapupDate = '2026-10-30'
    expect(render()).not.toContain('어제 메모가 없어요')
  })

  it('근무 중 + 제안 1건: 상단·브리핑·후보·회의·할 일·변경 내역을 보여 준다', () => {
    state.today = payload({
      plan: plan(),
      items: [
        item({
          id: 1,
          candidate_id: 'jira:PROJ-12',
          source: 'jira',
          title: 'PROJ-12 결제 API 리팩터링',
          link: 'https://example.atlassian.net/browse/PROJ-12',
          status: 'in_progress',
          due_date: '2026-11-04',
          first_planned_date: '2026-10-31'
        }),
        item({ id: 2, candidate_id: 'todo:7', source: 'todo', title: '문서 리뷰', due_date: '2026-11-02' }),
        item({
          id: 3,
          candidate_id: 'jira:PROJ-123',
          source: 'jira',
          title: 'PROJ-123 장애 대응',
          link: 'https://example.atlassian.net/browse/PROJ-123',
          rank: null,
          status: 'suggested',
          urgent: true,
          due_date: '2026-11-02',
          added_by: 'refresh'
        })
      ],
      timeline: WORKING_TIMELINE,
      events: [
        event({
          id: 10,
          // main 은 RefreshSummary 를 감싸지 않고 그대로 저장한다
          payload: JSON.stringify({
            calendarAdded: 1,
            calendarChanged: 0,
            calendarRemoved: 0,
            suggested: 0,
            urgentSuggestedIds: [],
            completed: 0,
            dropped: 0,
            replaced: 0,
            timelineChanged: true,
            currentOrNextChanged: false
          })
        })
      ],
      jiraTruncated: true
    })
    const html = render()
    // 상단 영역
    expect(html).toContain('근무 중')
    expect(html).toContain('09:40 시작')
    expect(html).toContain('마지막 최신화 10:42')
    expect(html).toContain('새로고침')
    expect(html).toContain('>퇴근</button>')
    // 브리핑
    expect(html).toContain('규칙 브리핑')
    expect(html).toContain('결제 모듈 리팩토링부터 시작하세요')
    expect(html).toContain('다시 생성')
    // 후보 카드의 새로 들어온 제안 (부록 M10)
    expect(html).toContain('새로 들어온 제안')
    expect(html).toContain('PROJ-123 장애 대응')
    expect(html).toContain('긴급')
    expect(html).toContain('계획에 추가')
    expect(html).toContain('무시')
    // 집중 가능 시간은 요약 타일이 보인다
    expect(html).toContain('집중 가능')
    expect(html).toContain('4시간 30분')
    // 회의 구역: 회의 행만 그린다. 빈 시간 블록 행과 [회의] 접두사가 없다 (부록 M8·M9)
    expect(html).toContain('주간 스프린트')
    // 회의 행 시각은 캘린더처럼 'HH:mm - HH:mm' 이다 (부록 M.10 P1)
    expect(html).toContain('15:30 - 16:00')
    expect(html).not.toContain('15:30–16:00')
    expect(html).not.toMatch(/빈 시간 \d/)
    expect(html).not.toContain('[회의]')
    expect(html).not.toContain('(이어서)')
    // 할 일 구역: 작업 시간은 메타 줄에 쓴다. 집중 항목은 두 블록을 받아 둘 다 보인다 (부록 M.9 N2)
    expect(html).toContain('>오늘</h3>')
    expect(html).toContain('할 일 2 · 회의 3')
    expect(html).toContain('>작업 시간 09:45–11:00, 13:00–15:30<')
    expect(html).toContain('>작업 시간 16:00–18:00<')
    expect(html).toContain('마감 오늘')
    expect(html).toContain('집중 중')
    expect(html).toContain('3일째')
    expect(html).toContain('D-2')
    // 상태 버튼은 완료·제외·⋯ 3개다. 진행 중 항목은 ⋯ 버튼에 상태를 같이 쓴다 (부록 M11)
    expect(html).toContain('>완료</button>')
    expect(html).toContain('>제외</button>')
    expect(html).toContain('>진행 중 ⋯</button>')
    expect(html).toContain('>⋯</button>')
    // ⋯ 를 펼치지 않으면 미룸·지금 집중이 없다
    expect(html).not.toContain('>미룸</button>')
    expect(html).not.toContain('지금 집중</button>')
    // 3판에서 지운 시간 표시
    expect(html).not.toContain('시간 미배정')
    expect(html).not.toContain('시간 변경')
    expect(html).not.toContain('고정')
    // 근무 중에는 하루 시작 버튼이 없다
    expect(html).not.toContain('하루 시작')
    // 후보 더 보기는 후보 카드에 있다. 변경 내역·안내 문구는 접힌 더 보기 안이다 (부록 M10)
    expect(html).not.toContain('변경 내역')
    expect(html.indexOf('후보 더 보기')).toBeGreaterThan(-1)
    expect(html.indexOf('후보 더 보기')).toBeLessThan(html.indexOf('id="today-more"'))
    const open = renderOpen()
    expect(open).toContain('변경 내역')
    expect(open).toContain('10:42 회의 1건 추가로 시간표 갱신')
    expect(open).toContain('Jira 이슈가 많아 일부만 가져왔어요.')
    expect(open.split('후보 더 보기').length - 1).toBe(1)
  })

  it('근무 중: 지난 블록은 시각에 쓰지 않고, 배정 못 한 마감 항목은 안내와 미배정으로 보인다', () => {
    state.today = payload({
      plan: plan(),
      items: [
        item({ id: 1, title: '집중 작업' }),
        item({ id: 2, title: '급한 보고서', due_date: '2026-11-01' })
      ],
      timeline: {
        entries: [
          { kind: 'block', start: '09:45', end: '10:00', minutes: 15, state: 'past', itemId: null, reason: null, continued: false },
          { kind: 'meeting', start: '10:00', end: '17:00', title: '워크숍' },
          { kind: 'block', start: '17:00', end: '18:00', minutes: 60, state: 'future', itemId: 1, reason: 'focus', continued: false }
        ],
        freeMinutesLeft: 60,
        focusItemId: 1,
        unplacedDeadlineItemIds: [2]
      }
    })
    const html = render()
    expect(html).toContain('집중 가능')
    expect(html).toContain('1시간')
    expect(html).not.toContain('09:45–10:00')
    expect(html).toContain('>작업 시간 17:00–18:00<')
    expect(html).toContain('워크숍')
    expect(html).toContain('할 일 2 · 회의 1')
    // 경고는 '오늘' 카드 머리 아래, 할 일 구역 앞이다
    expect(html).toContain('오늘 남은 빈 시간이 없어 배정하지 못한 마감 항목')
    expect(html.indexOf('id="today-agenda"')).toBeLessThan(html.indexOf('오늘 남은 빈 시간이 없어'))
    expect(html.indexOf('오늘 남은 빈 시간이 없어')).toBeLessThan(html.indexOf('id="today-tasks"'))
    expect(html).toContain('급한 보고서')
    expect(html).toContain('>미배정<')
    expect(html.split('>미배정<').length - 1).toBe(1)
    // 지난 마감은 빨간 글자다 (부록 M.4 강조 2)
    expect(html).toContain('<span class="text-red-600 font-medium">1일 지남</span>')
  })

  it('근무 중: LLM 실패 사유와 다시 생성을 보여 준다', () => {
    state.today = payload({
      plan: plan({ briefing_error: 'Claude Code 로그인이 필요합니다.' }),
      aiAvailable: false
    })
    const html = render()
    expect(html).toContain('Claude Code 로그인이 필요합니다.')
    expect(html).toContain('다시 생성')
  })

  it('닫힘: 오늘 마감·퇴근 메모·다시 열기를 보여 주고 상태 버튼을 숨긴다', () => {
    state.today = payload({
      plan: plan({
        status: 'closed',
        closed_at: '2026-11-02 18:30:00',
        closed_by: 'button',
        wrapup_note: '결제 모듈 리뷰 요청까지 완료'
      }),
      items: [item({ id: 1, status: 'done' })],
      timeline: {
        entries: [
          { kind: 'block', start: '09:45', end: '18:00', minutes: 495, state: 'past', itemId: null, reason: null, continued: false }
        ],
        freeMinutesLeft: 0,
        focusItemId: null,
        unplacedDeadlineItemIds: []
      }
    })
    const html = render()
    expect(html).toContain('오늘 마감')
    expect(html).toContain('결제 모듈 리뷰 요청까지 완료')
    expect(html).toContain('다시 열기')
    expect(html).toContain('18:30 퇴근')
    expect(html).not.toContain('새로고침')
    expect(html).not.toContain('하루 시작')
    expect(html).not.toContain('지금 집중')
    // 닫힌 날의 집중 가능 시간 타일은 — 다 (부록 L)
    expect(html).toMatch(/집중 가능 시간<\/p><p[^>]*>—</)
    // 블록 행이 없고 회의도 없다
    expect(html).toContain('오늘 회의가 없어요.')
    expect(html).not.toContain('09:45–18:00')
    expect(html).not.toContain('후보 더 보기')
    expect(html).not.toContain('>⋯</button>')
  })

  // 부록 G.10.1 명령 입력창. 근무 중에만 보인다
  it('명령 입력: 근무 중이면 비서에게 말하기 입력창이 더 보기 안, 할 일 구역 아래에 있다 (A53)', () => {
    state.today = payload({ plan: plan() })
    expect(render()).not.toContain('비서에게 말하기')
    const html = renderOpen()
    expect(html).toContain('비서에게 말하기')
    expect(html.indexOf('id="today-tasks"')).toBeLessThan(html.indexOf('today-more'))
    expect(html.indexOf('today-more')).toBeLessThan(html.indexOf('비서에게 말하기'))
  })

  it('명령 입력: 계획 없음·닫힘이면 비서에게 말하기 입력창이 없다', () => {
    state.today = payload({ plan: null })
    expect(renderOpen()).not.toContain('비서에게 말하기')
    state.today = payload({
      plan: plan({ status: 'closed', closed_at: '2026-11-02 18:30:00', closed_by: 'button' })
    })
    expect(renderOpen()).not.toContain('비서에게 말하기')
  })

  // 부록 I.10 회의 브리핑. 시간표 회의 행에 붙고, 짝이 없으면 시간표 아래에 묶인다 (2차 개편 V3·V4). 계획이 없어도 보인다
  const meetingEvent = (over: Partial<AssistantEvent> = {}): AssistantEvent =>
    event({
      id: 40,
      event_key: 'meeting_briefing:2026-11-02:cal-1',
      kind: 'meeting_briefing',
      scheduled_at: '2026-11-02 10:45:00',
      fired_at: '2026-11-02 10:45:10',
      status: 'sent',
      ref_id: 'cal-1',
      payload: JSON.stringify({
        meeting: { id: 'cal-1', title: '주간 스프린트', startAt: '2099-01-01 23:59:00', endAt: '2099-01-01 23:59:59' },
        title: '주간 스프린트 15분 전',
        body: '결제 · 미완료 액션 1건',
        projects: [{ id: 3, name: '결제' }],
        hasContext: true,
        ruleMarkdown: '# 주간 스프린트 23:59\n- 관련 프로젝트: 결제',
        llmStatus: 'off',
        llmMarkdown: null,
        llmModel: null,
        llmAt: null,
        llmError: null
      }),
      ...over
    })

  it('회의 브리핑: 계획이 없어도 카드와 meeting-briefing- 행을 보여 준다', () => {
    state.today = payload({ plan: null, events: [meetingEvent()] })
    const html = render()
    expect(html).toContain('id="meeting-briefing-40"')
    expect(html).toContain('주간 스프린트')
    expect(html).toContain('규칙 브리핑')
    expect(html).toContain('다시 만들기')
  })

  it('회의 브리핑: 회의 구역에 짝이 없으면 후보 카드 아래 기타 회의 브리핑에 놓인다 (2차 개편 V4, A59)', () => {
    state.today = payload({
      plan: plan(),
      items: [item({ id: 1, title: '결제 API 리팩터링', status: 'in_progress' })],
      events: [meetingEvent()],
      timeline: WORKING_TIMELINE
    })
    const html = render()
    // 하루 브리핑은 헤더 안이라 그리드보다 앞이다
    expect(html.indexOf('today-briefing')).toBeLessThan(html.indexOf('today-agenda'))
    expect(html.indexOf('today-agenda')).toBeLessThan(html.indexOf('today-timeline'))
    expect(html.indexOf('today-timeline')).toBeLessThan(html.indexOf('id="today-inbox"'))
    expect(html.indexOf('id="today-inbox"')).toBeLessThan(html.indexOf('기타 회의 브리핑'))
    expect(html.indexOf('기타 회의 브리핑')).toBeLessThan(html.indexOf('meeting-briefing-40'))
    expect(html.indexOf('meeting-briefing-40')).toBeLessThan(html.indexOf('home-overview'))
  })

  it('회의 브리핑: 시간표 회의 행과 HH:mm·제목이 같으면 그 행에 붙고 기타 묶음이 없다 (2차 개편 V3)', () => {
    const matched = meetingEvent({
      id: 41,
      payload: JSON.stringify({
        meeting: { id: 'cal-2', title: '주간 스프린트', startAt: '2026-11-02 11:00:00', endAt: '2026-11-02 12:00:00' },
        title: '주간 스프린트 15분 전',
        body: '결제',
        projects: [],
        hasContext: false,
        ruleMarkdown: '- 관련 프로젝트: 결제',
        llmStatus: 'off',
        llmMarkdown: null,
        llmModel: null,
        llmAt: null,
        llmError: null
      })
    })
    state.today = payload({ plan: plan(), events: [matched], timeline: WORKING_TIMELINE })
    const html = render()
    expect(html.split('id="meeting-briefing-41"').length - 1).toBe(1)
    expect(html.indexOf('today-timeline')).toBeLessThan(html.indexOf('meeting-briefing-41'))
    expect(html.indexOf('meeting-briefing-41')).toBeLessThan(html.indexOf('home-overview'))
    expect(html).not.toContain('기타 회의 브리핑')
  })

  it('회의 브리핑: 짝 있는 회의가 가장 가깝고 짝 없는 회의도 있으면 기타 카드의 본문은 접혀 있다 (화면 전체 기본 펼침 1건)', () => {
    const briefing = (id: number, title: string, startAt: string, line: string): AssistantEvent =>
      meetingEvent({
        id,
        ref_id: `cal-${id}`,
        payload: JSON.stringify({
          meeting: { id: `cal-${id}`, title, startAt, endAt: startAt },
          title: `${title} 15분 전`,
          body: '',
          projects: [],
          hasContext: false,
          ruleMarkdown: `- ${line}`,
          llmStatus: 'off',
          llmMarkdown: null,
          llmModel: null,
          llmAt: null,
          llmError: null
        })
      })
    // 둘 다 시작 전이다. 시간표 11:00 '주간 스프린트' 와 짝인 41 이 더 가깝다
    const matched = briefing(41, '주간 스프린트', '2099-01-01 11:00:00', '짝 본문')
    const other = briefing(43, '외부 미팅', '2099-01-02 09:00:00', '기타 본문')
    state.today = payload({ plan: plan(), events: [other, matched], timeline: WORKING_TIMELINE })
    const html = render()
    expect(html).toContain('짝 본문')
    expect(html).toContain('기타 회의 브리핑')
    const card = html.slice(html.indexOf('id="meeting-briefing-43"'))
    expect(card).toContain('펼치기')
    expect(html).not.toContain('기타 본문')
  })

  it('회의 브리핑: 행이 없거나 skipped 뿐이면 카드가 없다', () => {
    state.today = payload({ plan: plan(), events: [meetingEvent({ status: 'skipped', payload: '{"reason":"window"}' })] })
    const html = render()
    expect(html).not.toContain('meeting-briefing-')
    expect(html).not.toContain('회의 브리핑')
  })

  it('회의 브리핑: AI 를 쓸 수 없거나 AI 브리핑이 꺼져 있으면 다시 만들기를 숨긴다', () => {
    state.today = payload({ plan: null, aiAvailable: false, events: [meetingEvent()] })
    expect(render()).not.toContain('다시 만들기')
    state.today = payload({ plan: null, settings: { ...SETTINGS, llmEnabled: false }, events: [meetingEvent()] })
    expect(render()).not.toContain('다시 만들기')
  })

  it('불러오기 실패: 오류 문구와 다시 시도를 보여 준다', () => {
    state.error = '데이터베이스를 열 수 없습니다'
    const html = render()
    expect(html).toContain('데이터베이스를 열 수 없습니다')
    expect(html).toContain('다시 시도')
  })
})

// 부록 F.7 맥락 복구 카드. 2차 개편부터 2열 그리드 아래 전체 폭에 둔다 (V6).
// 본문·진행 중·오류가 없으면 더 보기 안에 1줄로 간다
describe('맥락 복구 카드 렌더링', () => {
  const RECOVERY_MD = '# 2026-11-02 맥락 복구\n\n## 남은 작업\n\n- 결제 모듈 리팩토링 · 진행 중\n'

  it('맥락 복구 본문 없음: 더 보기 안에 제목과 만들기 버튼 1줄만 보인다 (A53)', () => {
    state.today = payload({ plan: plan() })
    expect(render()).not.toContain('today-recovery')
    const html = renderOpen()
    expect(html).toContain('맥락 복구')
    expect(html).toContain('id="today-recovery"')
    expect(html).toMatch(/<button[^>]*>만들기<\/button>/)
    expect(html).not.toContain('다시 만들기')
    expect(html).not.toContain('만드는 중…')
    expect(html).not.toContain('AI 복구')
    expect(html).not.toContain('규칙 복구')
    expect(html).not.toContain('>접기<')
    expect(html.indexOf('today-more')).toBeLessThan(html.indexOf('today-recovery'))
  })

  it('맥락 복구 진행 중: 만드는 중… 을 보이고 버튼을 비활성으로 둔다', () => {
    state.today = payload({ plan: plan(), recovery: { inFlight: true, error: null } })
    const html = render()
    // 진행 중이면 본문 영역에 보인다. 후보 카드 아래 전체 폭, 홈 개요 위다 (2차 개편 V6)
    expect(html.indexOf('today-briefing')).toBeLessThan(html.indexOf('today-inbox'))
    expect(html.indexOf('today-inbox')).toBeLessThan(html.indexOf('today-recovery'))
    expect(html.indexOf('today-recovery')).toBeLessThan(html.indexOf('home-overview'))
    expect(html).toContain('만드는 중…')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>만들기<\/button>/)
  })

  it('맥락 복구 오류: amber 경고 아래에 규칙 본문을 그대로 보인다', () => {
    state.today = payload({
      plan: plan({
        recovery_text: RECOVERY_MD,
        recovery_source: 'rules',
        recovery_at: '2026-11-02 09:40:30'
      }),
      recovery: { inFlight: false, error: 'Claude Code 로그인이 필요합니다.' }
    })
    const html = render()
    expect(html).toContain('맥락 복구를 마치지 못했습니다. Claude Code 로그인이 필요합니다.')
    expect(html).toContain('bg-amber-50')
    expect(html).toContain('규칙 복구')
    expect(html).toContain('09:40')
    expect(html).toContain('결제 모듈 리팩토링 · 진행 중')
    expect(html.indexOf('맥락 복구를 마치지 못했습니다')).toBeLessThan(html.indexOf('결제 모듈 리팩토링 · 진행 중'))
  })

  it('맥락 복구 본문 있음: AI 복구 배지·시각·다시 만들기·접기를 보인다. 닫힌 날에도 버튼이 있다', () => {
    state.today = payload({
      plan: plan({
        status: 'closed',
        closed_at: '2026-11-02 18:30:00',
        closed_by: 'button',
        recovery_text: RECOVERY_MD,
        recovery_source: 'llm',
        recovery_at: '2026-11-02 09:41:10'
      })
    })
    const html = render()
    expect(html).toContain('AI 복구')
    expect(html).not.toContain('규칙 복구')
    expect(html).toContain('09:41')
    expect(html).toMatch(/<button[^>]*>다시 만들기<\/button>/)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>다시 만들기<\/button>/)
    expect(html).toContain('>접기<')
    expect(html).toContain('결제 모듈 리팩토링 · 진행 중')
    expect(html).not.toContain('맥락 복구를 마치지 못했습니다')
  })

  it('맥락 복구: 비서가 꺼져 있으면 버튼을 숨기고, 계획이 없으면 카드를 그리지 않는다', () => {
    state.today = payload({ plan: plan(), settings: { ...SETTINGS, enabled: false } })
    let html = renderOpen()
    expect(html).toContain('today-recovery')
    expect(html).not.toMatch(/<button[^>]*>만들기<\/button>/)

    state.today = payload({ plan: null })
    html = renderOpen()
    expect(html).not.toContain('today-recovery')
  })

  it('recoveryButtonLabel: 본문이 있으면 다시 만들기, 없으면 만들기', () => {
    expect(recoveryButtonLabel(true)).toBe('다시 만들기')
    expect(recoveryButtonLabel(false)).toBe('만들기')
  })
})

describe('오늘 화면 순수 헬퍼', () => {
  it('orderPlanItems: 제안·무시를 빼고 활성 항목을 rank 순으로 앞에 둔다', () => {
    const items = [
      item({ id: 1, rank: 2 }),
      item({ id: 2, rank: 1, status: 'done' }),
      item({ id: 3, rank: 4, status: 'in_progress' }),
      item({ id: 4, rank: 3 }),
      item({ id: 5, status: 'suggested', rank: null }),
      item({ id: 6, status: 'dismissed', rank: null })
    ]
    expect(orderPlanItems(items).map((i) => i.id)).toEqual([1, 4, 3, 2])
  })

  it('unplacedDeadlineItems: 타임라인의 id 순서대로 항목을 고른다', () => {
    const items = [item({ id: 1 }), item({ id: 2 }), item({ id: 3 })]
    const timeline = { ...EMPTY_TIMELINE, unplacedDeadlineItemIds: [3, 9, 1] }
    expect(unplacedDeadlineItems({ items, timeline }).map((i) => i.id)).toEqual([3, 1])
  })

  it('여러 날 작업·마감 표시: n일째, D-n, 마감 오늘, n일 지남', () => {
    expect(dayCountLabel('2026-10-31', '2026-11-02')).toBe('3일째')
    expect(dayCountLabel('2026-11-02', '2026-11-02')).toBe('')
    expect(dayCountLabel(null, '2026-11-02')).toBe('')
    // 월 경계
    expect(dayCountLabel('2026-10-30', '2026-11-01')).toBe('3일째')
    expect(dueLabel('2026-11-04', '2026-11-02')).toBe('D-2')
    expect(dueLabel('2026-11-02', '2026-11-02')).toBe('마감 오늘')
    expect(dueLabel('2026-10-30', '2026-11-02')).toBe('3일 지남')
    expect(dueLabel(null, '2026-11-02')).toBe('')
  })

  it('시간 표시: 블록 길이와 집중 가능 시간', () => {
    expect(durationLabel(75)).toBe('1h15m')
    expect(durationLabel(120)).toBe('2h')
    expect(durationLabel(20)).toBe('20m')
    expect(freeTimeLabel(270)).toBe('4시간 30분')
    expect(freeTimeLabel(120)).toBe('2시간')
    expect(freeTimeLabel(45)).toBe('45분')
    expect(freeTimeLabel(0)).toBe('0분')
  })

  it('itemSlotLabel: 지난 블록을 빼고 남은 블록을 시작순으로 쉼표로 잇는다. 3개를 넘으면 외 n개 (부록 M.9 N2)', () => {
    expect(itemSlotLabel(1, WORKING_TIMELINE)).toBe('작업 시간 09:45–11:00, 13:00–15:30')
    expect(itemSlotLabel(2, WORKING_TIMELINE)).toBe('작업 시간 16:00–18:00')
    expect(itemSlotLabel(9, WORKING_TIMELINE)).toBeNull()
    // 지난 블록은 세지 않는다. 입력 순서와 무관하게 시작순이다
    const entries: DayTimeline['entries'] = [
      { kind: 'block', start: '15:00', end: '16:00', minutes: 60, state: 'future', itemId: 3, reason: 'focus', continued: true },
      { kind: 'block', start: '09:00', end: '10:00', minutes: 60, state: 'past', itemId: 3, reason: 'focus', continued: false },
      { kind: 'block', start: '13:00', end: '14:00', minutes: 60, state: 'current', itemId: 3, reason: 'focus', continued: true },
      { kind: 'block', start: '17:00', end: '18:00', minutes: 60, state: 'future', itemId: 3, reason: 'focus', continued: true }
    ]
    expect(itemSlotLabel(3, { entries })).toBe('작업 시간 13:00–14:00, 15:00–16:00, 17:00–18:00')
    // 남은 블록이 5개면 앞 3개 뒤에 ' 외 2개' 를 붙인다
    const many: DayTimeline['entries'] = [
      ...entries,
      { kind: 'block', start: '18:00', end: '19:00', minutes: 60, state: 'future', itemId: 3, reason: 'focus', continued: true },
      { kind: 'block', start: '19:00', end: '20:00', minutes: 60, state: 'future', itemId: 3, reason: 'focus', continued: true }
    ]
    expect(itemSlotLabel(3, { entries: many })).toBe('작업 시간 13:00–14:00, 15:00–16:00, 17:00–18:00 외 2개')
    expect(itemSlotLabel(3, { entries: entries.filter((e) => e.kind === 'block' && e.state === 'past') })).toBeNull()
    expect(itemSlotLabel(3, { entries: [] })).toBeNull()
  })

  it('isItemExcluded: 후보 id 가 같거나 두 Jira 키가 같으면 제외 항목이다 (main isExcludedCandidate 와 같은 규칙)', () => {
    const ex = [
      { candidate_id: 'jira:ICA-1', jira_key: 'ICA-1' },
      { candidate_id: 'task:7', jira_key: null }
    ]
    expect(isItemExcluded({ candidate_id: 'jira:ICA-1', jira_issue_key: 'ICA-1' }, ex)).toBe(true)
    // task 가 생겨 후보 id 가 바뀌어도 Jira 키로 맞춘다. 대소문자는 가리지 않는다
    expect(isItemExcluded({ candidate_id: 'task:99', jira_issue_key: 'ica-1' }, ex)).toBe(true)
    expect(isItemExcluded({ candidate_id: 'task:7', jira_issue_key: null }, ex)).toBe(true)
    // 키가 null 끼리는 맞추지 않는다
    expect(isItemExcluded({ candidate_id: 'task:8', jira_issue_key: null }, ex)).toBe(false)
    expect(isItemExcluded({ candidate_id: 'jira:ICA-2', jira_issue_key: 'ICA-2' }, ex)).toBe(false)
    expect(isItemExcluded({ candidate_id: 'jira:ICA-1', jira_issue_key: 'ICA-1' }, [])).toBe(false)
  })

  it('dueAlertCount: 활성 항목 중 마감 오늘·지남이거나 긴급인 항목만 센다 (부록 M.5.7)', () => {
    const items = [
      item({ id: 1, due_date: '2026-11-02' }),
      item({ id: 2, due_date: '2026-10-30', status: 'in_progress' }),
      item({ id: 3, urgent: true }),
      item({ id: 4, due_date: '2026-11-05' }),
      item({ id: 5, due_date: '2026-11-01', status: 'done' }),
      item({ id: 6, due_date: '2026-11-01', status: 'dropped' }),
      item({ id: 7, urgent: true, status: 'suggested' })
    ]
    expect(dueAlertCount(items, '2026-11-02')).toBe(3)
    expect(dueAlertCount([], '2026-11-02')).toBe(0)
    const tiles = summaryTiles({ plan: plan(), items, timeline: EMPTY_TIMELINE, logicalDate: '2026-11-02' }, '10:00')
    expect(tiles[0]).toMatchObject({ key: 'remaining', sub: '전체 6건', alert: '마감 3건' })
    const calm = summaryTiles(
      { plan: plan(), items: [item({ id: 4, due_date: '2026-11-05' })], timeline: EMPTY_TIMELINE, logicalDate: '2026-11-02' },
      '10:00'
    )
    expect(calm[0].alert).toBeNull()
  })

  it('요약 타일: 남은 할 일 보조 문구 끝에 마감 n건을 빨간 글자로 붙인다', () => {
    state.today = payload({
      plan: plan(),
      items: [item({ id: 1, due_date: '2026-11-02' }), item({ id: 2 })],
      timeline: EMPTY_TIMELINE
    })
    const html = render()
    expect(html).toContain('전체 2건 · <span class="text-red-600 font-medium">마감 1건</span>')
    state.today = payload({ plan: plan(), items: [item({ id: 2 })], timeline: EMPTY_TIMELINE })
    expect(render()).not.toContain('마감 1건')
  })

  it('요약 타일: 타일 4개가 TILE_TONE 색으로 서로 구별된다. 값 크기는 text-2xl 이다 (부록 M.9 N4)', () => {
    const tiles = summaryTiles(
      { plan: plan(), items: [item({ id: 1, due_date: '2026-11-02' })], timeline: WORKING_TIMELINE, logicalDate: '2026-11-02' },
      '10:00'
    )
    const html = renderToStaticMarkup(<SummaryTilesView tiles={tiles} />)
    const tones = [
      ['remaining', 'bg-blue-50 border-blue-200', 'text-blue-700', 'text-blue-900'],
      ['done', 'bg-green-50 border-green-200', 'text-green-700', 'text-green-900'],
      ['meeting', 'bg-purple-50 border-purple-200', 'text-purple-700', 'text-purple-900'],
      ['free', 'bg-teal-50 border-teal-200', 'text-teal-700', 'text-teal-900']
    ]
    for (const [key, box, label, value] of tones) {
      const start = html.indexOf(`data-tile="${key}"`)
      expect(start).toBeGreaterThan(-1)
      const tile = html.slice(start, html.indexOf('data-tile=', start + 1) === -1 ? undefined : html.indexOf('data-tile=', start + 1))
      expect(tile).toContain(box)
      expect(tile).toContain(`class="text-sm ${label}"`)
      expect(tile).toContain(`text-2xl font-bold tabular-nums break-words ${value}`)
    }
    // 공용 Card 의 흰 배경을 쓰지 않는다. 마감 경고는 빨강을 유지한다
    expect(html).not.toContain('bg-white')
    expect(html).toContain('<span class="text-red-600 font-medium">마감 1건</span>')
  })

  it('sortSuggestions: 긴급 제안을 맨 위에 둔다', () => {
    const items = [
      item({ id: 1, status: 'suggested', score: 90 }),
      item({ id: 2, status: 'suggested', score: 10, urgent: true }),
      item({ id: 3, status: 'planned' })
    ]
    expect(sortSuggestions(items).map((i) => i.id)).toEqual([2, 1])
  })

  it('describePlanUpdate: 요약을 문장으로 바꾼다', () => {
    expect(
      describePlanUpdate(
        event({
          id: 1,
          payload: JSON.stringify({
            calendarChanged: 1,
            timelineChanged: true,
            currentOrNextChanged: true,
            suggested: 1,
            urgentSuggestedIds: ['jira:A-1']
          })
        })
      )
    ).toBe('10:42 회의 1건 변경으로 시간표 갱신 · 지금·다음 블록 변경 · 새로 들어온 일 1건 (긴급 1건)')
    expect(describePlanUpdate(event({ id: 5, payload: JSON.stringify({ calendarRemoved: 2 }) }))).toBe(
      '10:42 회의 2건 취소'
    )
    expect(describePlanUpdate(event({ id: 2, payload: JSON.stringify({ completed: 2 }) }))).toBe(
      '10:42 2건 완료 반영'
    )
    expect(describePlanUpdate(event({ id: 3, payload: 'not json' }))).toBe('10:42 계획 최신화')
    // { summary } 로 감싼 형태도 읽는다
    expect(describePlanUpdate(event({ id: 4, payload: JSON.stringify({ summary: { dropped: 1 } }) }))).toBe(
      '10:42 1건 제외'
    )
  })

  it('describeCommand: 시각·명령 30자·적용 건수, 실패가 있으면 실패 건수 (부록 G.10.4)', () => {
    const ok = event({
      id: 20,
      kind: 'command',
      event_key: 'command:2026-11-02:2026-11-02 11:05:00',
      scheduled_at: '2026-11-02 11:05:00',
      payload: JSON.stringify({ text: 'PROJ-12 끝났어', applied: 1, failed: 0, results: [] })
    })
    expect(describeCommand(ok)).toBe("11:05 명령 'PROJ-12 끝났어' · 1건 적용")
    const long = event({
      id: 21,
      kind: 'command',
      scheduled_at: '2026-11-02 11:10:00',
      payload: JSON.stringify({ text: '가'.repeat(40), applied: 2, failed: 1, results: [] })
    })
    expect(describeCommand(long)).toBe(`11:10 명령 '${'가'.repeat(30)}…' · 2건 적용 · 1건 실패`)
    expect(describeCommand(event({ id: 22, kind: 'command', payload: '{깨짐' }))).toBe(
      "10:42 명령 '' · 0건 적용"
    )
  })

  it('commandEvents: command 만 고르고 변경 내역에 plan_update 와 시각 순으로 합친다', () => {
    const events = [
      event({ id: 30, kind: 'command', scheduled_at: '2026-11-02 11:00:00', payload: JSON.stringify({ text: '명령 B', applied: 1, failed: 0 }) }),
      event({ id: 31, scheduled_at: '2026-11-02 10:00:00' }),
      event({ id: 32, kind: 'command', scheduled_at: '2026-11-02 09:50:00', payload: JSON.stringify({ text: '명령 A', applied: 1, failed: 0 }) }),
      event({ id: 33, kind: 'start_nudge', scheduled_at: '2026-11-02 09:00:00' })
    ]
    expect(commandEvents(events).map((e) => e.id)).toEqual([32, 30])
    state.today = payload({ plan: plan(), events })
    const html = renderOpen()
    const a = html.indexOf("09:50 명령 &#x27;명령 A&#x27;")
    const mid = html.indexOf('10:00 계획 최신화')
    const b = html.indexOf("11:00 명령 &#x27;명령 B&#x27;")
    expect(a).toBeGreaterThan(-1)
    expect(a).toBeLessThan(mid)
    expect(mid).toBeLessThan(b)
  })

  it('planUpdateEvents: plan_update 만 시각 순으로 고른다', () => {
    const list = planUpdateEvents([
      event({ id: 1, scheduled_at: '2026-11-02 14:00:00' }),
      event({ id: 2, kind: 'start_nudge', scheduled_at: '2026-11-02 09:00:00' }),
      event({ id: 3, scheduled_at: '2026-11-02 10:00:00' })
    ])
    expect(list.map((e) => e.id)).toEqual([3, 1])
  })

  it('planUpdateEvents: 알림 행(ref_id 있음)은 빼고 변경 기록 행만 고른다 (부록 E.3.3)', () => {
    const list = planUpdateEvents([
      event({ id: 1, scheduled_at: '2026-11-02 14:42:00' }),
      event({ id: 2, event_key: 'plan_update:2026-11-02:1430', ref_id: '1430', status: 'sent' }),
      event({ id: 3, event_key: 'plan_update:2026-11-02:urgent:jira:A-1', ref_id: 'urgent:jira:A-1', status: 'sent' })
    ])
    expect(list.map((e) => e.id)).toEqual([1])
  })

  it('describePlanUpdate: notified 가 있으면 끝에 알림 보냄을 붙인다 (부록 E.5)', () => {
    expect(
      describePlanUpdate(
        event({ id: 1, payload: JSON.stringify({ currentOrNextChanged: true, notified: ['slot'] }) })
      )
    ).toBe('10:42 지금·다음 블록 변경 · 알림 보냄')
    expect(
      describePlanUpdate(event({ id: 2, payload: JSON.stringify({ completed: 1, notified: ['slot', 'urgent'] }) }))
    ).toBe('10:42 1건 완료 반영 · 알림 보냄')
    // 빈 배열·없음은 표시하지 않는다
    expect(describePlanUpdate(event({ id: 3, payload: JSON.stringify({ completed: 1, notified: [] }) }))).toBe(
      '10:42 1건 완료 반영'
    )
    expect(describePlanUpdate(event({ id: 4, payload: JSON.stringify({ completed: 1 }) }))).toBe(
      '10:42 1건 완료 반영'
    )
  })

  it('변경 내역: 알림 행은 그리지 않고 시간표 카드에 today-timeline id 를 둔다', () => {
    state.today = payload({
      plan: plan(),
      items: [item({ id: 1 })],
      timeline: WORKING_TIMELINE,
      events: [
        event({ id: 10, payload: JSON.stringify({ completed: 1, notified: ['slot'] }) }),
        // 알림 행. payload 가 있어도 변경 내역에 나오면 안 된다
        event({
          id: 11,
          event_key: 'plan_update:2026-11-02:1030',
          ref_id: '1030',
          status: 'sent',
          payload: JSON.stringify({ dropped: 9 })
        })
      ]
    })
    const html = renderOpen()
    expect(html).toContain('id="today-timeline"')
    expect(html).toContain('10:42 1건 완료 반영 · 알림 보냄')
    expect(html).not.toContain('9건 제외')
  })

  it('focusTargetId: 알림 focus 를 스크롤 대상 id 로 바꾼다 (부록 E.3.5)', () => {
    expect(focusTargetId({ kind: 'timeline' })).toBe('today-timeline')
    expect(focusTargetId({ kind: 'inbox' })).toBe('today-inbox')
    expect(focusTargetId({ kind: 'briefing' })).toBe('today-briefing')
    expect(focusTargetId({ kind: 'item', id: '7' })).toBe('plan-item-7')
    // 회의 브리핑 알림 클릭 (부록 I.10.2)
    expect(focusTargetId({ kind: 'meeting', id: '40' })).toBe('meeting-briefing-40')
  })

  it('localNow: 지금 로컬 시각을 YYYY-MM-DD HH:mm:ss 로 만든다', () => {
    expect(localNow(new Date(2026, 10, 2, 9, 5, 7))).toBe('2026-11-02 09:05:07')
    expect(localNow(new Date(2026, 0, 31, 23, 59, 0))).toBe('2026-01-31 23:59:00')
  })

  it('todayNotices: 연결 상태와 수집 실패를 안내한다', () => {
    const notes = todayNotices(
      payload({ jiraConnected: false, calendarConnected: false, lastErrors: ['캘린더 조회 실패'] })
    )
    expect(notes).toHaveLength(3)
    expect(notes).toContain('캘린더 조회 실패')
  })

  it('candidatesNotInPlan: 예정·진행 중·완료·제안 항목의 후보만 뺀다. 제외·미룸·무시 후보는 남긴다 (부록 M.5.7)', () => {
    const base = {
      title: 't',
      jiraKey: null,
      projectId: null,
      projectName: null,
      dueDate: null,
      dueTime: null,
      inProgress: false,
      priority: null,
      jiraPriority: null,
      lastTouchedAt: null,
      link: null,
      parentKey: null,
      groupName: null,
      workType: 'etc' as const,
      workVersion: null
    }
    const statuses = ['planned', 'in_progress', 'done', 'suggested', 'dropped', 'deferred', 'dismissed'] as const
    const rest = candidatesNotInPlan(
      [
        ...statuses.map((_, n) => ({ ...base, id: `task:${n + 1}`, source: 'task' as const })),
        { ...base, id: 'todo:9', source: 'todo' }
      ],
      statuses.map((status, n) => item({ id: n + 1, candidate_id: `task:${n + 1}`, status }))
    )
    expect(rest.map((c) => c.id)).toEqual(['task:5', 'task:6', 'task:7', 'todo:9'])
  })

  it('originTarget: todo·task 만 원본 완료 대상이다. jira 는 숨긴다', () => {
    expect(originTarget({ source: 'todo', candidate_id: 'todo:5' })).toEqual({ kind: 'todo', id: 5 })
    expect(originTarget({ source: 'task', candidate_id: 'task:12' })).toEqual({ kind: 'task', id: 12 })
    expect(originTarget({ source: 'jira', candidate_id: 'jira:PROJ-1' })).toBeNull()
    expect(originTarget({ source: 'action_item', candidate_id: 'action_item:7:0' })).toBeNull()
  })

  it('설정: 형식 검증과 바뀐 키만 patch', () => {
    expect(validateSettings({ ...SETTINGS, workEnd: '25:00' })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, planSize: 0 })).not.toBeNull()
    expect(validateSettings(SETTINGS)).toBeNull()
    expect(diffSettings(SETTINGS, { ...SETTINGS, planSize: 7 })).toEqual({ planSize: 7 })
  })

  it('설정: 최신화 주기는 1~240분 정수만 받고 MVP2 키도 patch 에 담는다', () => {
    expect(validateSettings({ ...SETTINGS, refreshCalendarMin: 0 })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, refreshCalendarMin: 241 })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, refreshJiraMin: 1.5 })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, refreshCalendarMin: 1, refreshJiraMin: 240 })).toBeNull()
    expect(
      diffSettings(SETTINGS, { ...SETTINGS, refreshCalendarMin: 10, refreshJiraMin: 30, refreshNotify: false })
    ).toEqual({ refreshCalendarMin: 10, refreshJiraMin: 30, refreshNotify: false })
  })

  it('설정 모달: MVP2 최신화 설정 3개를 보여 준다', () => {
    const html = renderToStaticMarkup(
      <AssistantSettingsModal settings={SETTINGS} busy={false} onClose={() => {}} onSave={async () => true} />
    )
    expect(html).toContain('최신화 알림')
    expect(html).toContain('지금·다음 블록이 바뀌거나 긴급한 일이 들어오면 알립니다')
    expect(html).toContain('캘린더 확인 주기 (분)')
    expect(html).toContain('권장 5분')
    expect(html).toContain('Jira 확인 주기 (분)')
    expect(html).toContain('기본 15분')
    expect(html).toContain('value="5"')
    expect(html).toContain('value="15"')
  })

  it('설정: 빈 숫자 칸은 0 이 아니라 검증 오류다', () => {
    expect(parseNumberInput('')).toBeNaN()
    expect(parseNumberInput('  ')).toBeNaN()
    expect(parseNumberInput('0')).toBe(0)
    expect(parseNumberInput('12')).toBe(12)
    expect(numberInputValue(Number.NaN)).toBe('')
    expect(numberInputValue(0)).toBe(0)
    for (const key of ['planSize', 'refreshCalendarMin', 'refreshJiraMin', 'meetingLeadMin'] as const) {
      expect(validateSettings({ ...SETTINGS, [key]: parseNumberInput('') })).toMatch(/입력하세요/)
    }
  })

  it('설정: 회의 전 알림은 1~120분 정수만 받고 회의 브리핑 키도 patch 에 담는다 (부록 I.10.4)', () => {
    expect(validateSettings({ ...SETTINGS, meetingLeadMin: 0 })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, meetingLeadMin: 121 })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, meetingLeadMin: 10.5 })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, meetingLeadMin: 1 })).toBeNull()
    expect(validateSettings({ ...SETTINGS, meetingLeadMin: 120 })).toBeNull()
    expect(
      diffSettings(SETTINGS, { ...SETTINGS, meetingBriefingEnabled: false, meetingLeadMin: 20 })
    ).toEqual({ meetingBriefingEnabled: false, meetingLeadMin: 20 })
  })

  it('설정 모달: 회의 브리핑 설정 2개를 보여 준다', () => {
    const html = renderToStaticMarkup(
      <AssistantSettingsModal settings={SETTINGS} busy={false} onClose={() => {}} onSave={async () => true} />
    )
    expect(html).toContain('회의 전 브리핑')
    expect(html).toContain('회의 시작 전에 관련 프로젝트·지난 회의·액션아이템을 알립니다')
    expect(html).toContain('회의 전 알림(분)')
    expect(html).toContain('권장 15분. 기존 10분 전 일정 알림보다 앞서게 두세요')
  })

  it('설정 모달: 노출 키만 보여 준다', () => {
    const html = renderToStaticMarkup(
      <AssistantSettingsModal settings={SETTINGS} busy={false} onClose={() => {}} onSave={async () => true} />
    )
    expect(html).toContain('비서 설정')
    expect(html).toContain('날짜 경계')
    expect(html).toContain('시작 알림')
    // MVP5 가 회의 브리핑 설정 2개를 노출한다 (부록 I.10.4)
    expect(html).toContain('회의 전 브리핑')
    expect(html).toContain('회의 전 알림(분)')
    // 3판은 항목 소요 분 설정을 없앴다
    expect(html).not.toContain('소요 분')
  })
})

// 부록 J.8 오늘 화면 재배치 (A53). 자동 클릭이 불가해 renderToStaticMarkup 으로 판정한다
const { recoveryVisible } = await import('./TodayView')
const { default: PlanItemRow, WorkTypeBadge, workTypeLabel, isGroupItem, longDateLabel } = await import('./PlanItemRow')
const { default: InboxSection, INBOX_SHOWN, inboxSourceSummary } = await import('./InboxSection')
const { default: MoreSection } = await import('./MoreSection')
const { button } = await import('../ui')

describe('오늘 화면 배치 (부록 J.8)', () => {
  const meeting = (): AssistantEvent =>
    event({
      id: 40,
      event_key: 'meeting_briefing:2026-11-02:cal-1',
      kind: 'meeting_briefing',
      scheduled_at: '2026-11-02 10:45:00',
      fired_at: '2026-11-02 10:45:10',
      status: 'sent',
      ref_id: 'cal-1',
      payload: JSON.stringify({
        meeting: { id: 'cal-1', title: '주간 스프린트', startAt: '2099-01-01 23:59:00', endAt: '2099-01-01 23:59:59' },
        title: '주간 스프린트 15분 전',
        body: '결제',
        projects: [],
        hasContext: false,
        ruleMarkdown: '- 관련 프로젝트: 결제',
        llmStatus: 'off',
        llmMarkdown: null,
        llmModel: null,
        llmAt: null,
        llmError: null
      })
    })
  // 실제 규칙 브리핑 형태: 산문 → '## 오늘 할 일 n건' + 표 → '## 챙길 것' (assistant-briefing.ts)
  const BRIEFING_WITH_TABLE = [
    '오늘은 회의가 3개 있어요. 오전에 1개, 오후에 2개예요.',
    '',
    '## 오늘 할 일 1건',
    '',
    '| 유형 | 묶음 | 작업 | 상태 | 마감 |',
    '|------|------|------|------|------|',
    '| 표셀유형 | 표셀묶음 | 표셀작업 | 표셀상태 | 표셀마감 |',
    '',
    '## 챙길 것',
    '- 새로 들어온 일이 1건 있어요.'
  ].join('\n')
  const working = (): TodayPayload =>
    payload({
      plan: plan({
        briefing_text: BRIEFING_WITH_TABLE,
        recovery_text: '## 남은 작업\n- 결제',
        recovery_source: 'rules',
        recovery_at: '2026-11-02 09:40:30'
      }),
      items: [
        item({ id: 1, title: '결제 API 리팩터링', status: 'in_progress' }),
        item({ id: 2, title: '제안 작업', status: 'suggested', rank: null, source: 'jira', candidate_id: 'jira:A-2' })
      ],
      events: [meeting(), event({ id: 10, payload: JSON.stringify({ completed: 1 }) })],
      timeline: WORKING_TIMELINE,
      jiraConnected: false
    })

  it('A60 근무 중 순서: 헤더(브리핑 요약) → 요약 타일 → 진행 중 프로젝트 → 오늘(할 일 → 회의) → 후보 → 기타 회의 브리핑 → 맥락 복구 → 중요 메모 → 더 보기', () => {
    state.today = working()
    for (const html of [render(), renderOpen()]) {
      const marks = [
        '근무 중',
        'id="today-briefing"',
        'id="today-summary"',
        'id="home-projects"',
        'id="today-agenda"',
        '>오늘</h3>',
        'id="today-tasks"',
        '>할 일</h4>',
        'id="plan-item-1"',
        'id="today-timeline"',
        '>회의</h4>',
        'id="today-inbox"',
        '>후보</h3>',
        '후보 더 보기',
        '기타 회의 브리핑',
        'id="meeting-briefing-40"',
        'id="today-recovery"',
        'id="home-overview"',
        'id="today-more"'
      ].map((m) => html.indexOf(m))
      expect(marks.every((i) => i > -1)).toBe(true)
      for (let i = 1; i < marks.length; i++) expect(marks[i - 1]).toBeLessThan(marks[i])
      // 브리핑은 산문만 보인다. 표 셀과 '오늘 할 일' 절은 없다 (V2)
      expect(html).toContain('오늘은 회의가 3개 있어요.')
      for (const cell of ['표셀유형', '표셀묶음', '표셀작업', '표셀상태', '표셀마감']) expect(html).not.toContain(cell)
      expect(html).not.toContain('오늘 할 일 1건')
      expect(html).not.toContain('전체 보기')
      // 후보 더 보기는 후보 카드 1곳에만 있다. 더 보기 안에는 없다 (A59)
      expect(html.split('후보 더 보기').length - 1).toBe(1)
      // 프로젝트·메모는 1번씩만 그린다 (Q5)
      expect(html.split('id="home-projects"').length - 1).toBe(1)
      expect(html.split('id="home-overview"').length - 1).toBe(1)
      // 체크인 카드는 없다 (부록 L)
      expect(html).not.toContain('어떻게 됐나요')
    }
    const html = render()
    // 시간표·오늘 할 일 카드는 '오늘' 카드 1개로 합쳤다 (부록 M7). 집중 가능 시간은 타일만 보인다
    expect(html).not.toContain('>시간표<')
    expect(html).not.toContain('>오늘 할 일<')
    expect(html).not.toContain('>오늘 계획<')
    expect(html).not.toContain('id="today-main"')
    expect(html).not.toContain('id="today-side"')
    expect(html.split('집중 가능').length - 1).toBe(1)
    // 모든 카드는 가로 전체 폭을 쓴다(사용자 피드백 2026-11-05). 2열 그리드가 없다. 바깥 폭은 max-w-6xl 이다
    expect(html).toContain('max-w-6xl')
    expect(html).not.toContain('lg:grid-cols-5')
    expect(html).not.toContain('lg:col-span-')
  })

  it('A60 계획 없음: 타일·오늘 카드·후보 카드가 없고 진행 중 프로젝트 → 홈 일정 → 회의 브리핑 → 중요 메모 → 더 보기 순이다', () => {
    state.today = payload({ plan: null, events: [meeting()] })
    for (const html of [render(), renderOpen()]) {
      expect(html).not.toContain('today-summary')
      expect(html).not.toContain('today-agenda')
      expect(html).not.toContain('today-inbox')
      expect(html).not.toContain('today-briefing')
      const marks = [
        'id="home-projects"',
        'id="home-schedule"',
        'id="meeting-briefing-',
        'id="home-overview"',
        'id="today-more"'
      ].map((m) => html.indexOf(m))
      expect(marks.every((i) => i > -1)).toBe(true)
      for (let i = 1; i < marks.length; i++) expect(marks[i - 1]).toBeLessThan(marks[i])
    }
  })

  it('A55 닫힘: 타일은 보이고 집중 가능 시간은 — 다', () => {
    state.today = payload({
      plan: plan({ status: 'closed', closed_at: '2026-11-02 18:30:00', closed_by: 'button' }),
      items: [item({ id: 1, status: 'done' }), item({ id: 2, status: 'deferred' })],
      timeline: WORKING_TIMELINE
    })
    const html = render()
    expect(html).toContain('id="today-summary"')
    expect(html).toMatch(/집중 가능 시간<\/p><p[^>]*>—</)
    expect(html).toContain('미룸 1')
    expect(html).not.toContain('4시간 30분')
  })

  it('A53 날짜는 헤더 1곳에만 긴 라벨로 보인다. ISO 날짜는 화면에 없다', () => {
    state.today = working()
    for (const html of [render(), renderOpen()]) {
      expect(html.split('11월 2일 월요일').length - 1).toBe(1)
      expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    }
    // '오늘' 은 할 일·회의 카드 제목 1곳뿐이다. 날짜 대신 쓰는 페이지 제목 줄이 없다
    expect(render().split('>오늘</h3>').length - 1).toBe(1)
    // 계획 없음·닫힘도 날짜 1번이다
    state.today = payload({ plan: null })
    let html = renderOpen()
    expect(html.split('11월 2일 월요일').length - 1).toBe(1)
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    state.today = payload({ plan: plan({ status: 'closed', closed_at: '2026-11-02 18:30:00', closed_by: 'auto' }) })
    html = renderOpen()
    expect(html.split('11월 2일 월요일').length - 1).toBe(1)
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(html).toContain('18:30 퇴근 · 자동 닫기')
  })

  it('A53 더 보기 접힘: 명령 입력·변경 내역·연결 안내·비서 설정이 없다. 후보 더 보기는 후보 카드에 있다', () => {
    state.today = working()
    const html = render()
    expect(html).toContain('id="today-more"')
    expect(html).toMatch(/id="today-more"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*id="today-more"/)
    expect(html).not.toContain('비서에게 말하기')
    expect(html.indexOf('후보 더 보기')).toBeLessThan(html.indexOf('id="today-more"'))
    expect(html).not.toContain('변경 내역')
    expect(html).not.toContain('Jira 가 연결되지 않았어요.')
    expect(html).not.toContain('비서 설정')
  })

  it('A59 더 보기 열림: 명령 입력·변경 내역·연결 안내·비서 설정이 더 보기 아래에 있다. 후보 더 보기는 없다', () => {
    state.today = working()
    const html = renderOpen()
    expect(html).toMatch(/id="today-more"[^>]*aria-expanded="true"|aria-expanded="true"[^>]*id="today-more"/)
    const more = html.indexOf('id="today-more"')
    for (const text of ['비서에게 말하기', '변경 내역', 'Jira 가 연결되지 않았어요. Jira 이슈는 후보에 없어요.', '비서 설정']) {
      expect(html.indexOf(text)).toBeGreaterThan(more)
    }
    expect(html.lastIndexOf('후보 더 보기')).toBeLessThan(more)
  })

  it('A53 계획 없음: 헤더·회의 브리핑·홈 일정·홈 개요·더 보기만 보인다. 더 보기에는 변경 내역·연결 안내·비서 설정만 있다', () => {
    state.today = payload({
      plan: null,
      events: [meeting(), event({ id: 10, payload: JSON.stringify({ completed: 1 }) })],
      calendarConnected: false
    })
    const html = renderOpen()
    expect(html).toContain('하루 시작')
    expect(html).toContain('id="meeting-briefing-40"')
    expect(html).toContain('id="today-more"')
    expect(html).toContain('변경 내역')
    expect(html).toContain('캘린더가 연결되지 않았어요. 회의 없이 빈 시간을 계산해요.')
    expect(html).toContain('비서 설정')
    expect(html).toContain('id="home-schedule"')
    expect(html).toContain('id="home-overview"')
    for (const absent of ['today-summary', 'today-briefing', 'today-recovery', 'today-agenda', 'today-timeline', 'today-tasks', 'today-inbox', '비서에게 말하기', '후보 더 보기']) {
      expect(html).not.toContain(absent)
    }
  })

  it('A53 닫힘: 오늘 카드는 읽기 전용으로 보이고 명령 입력·후보 더 보기가 없다', () => {
    state.today = payload({
      plan: plan({ status: 'closed', closed_at: '2026-11-02 18:30:00', closed_by: 'button' }),
      items: [item({ id: 1, status: 'done' })],
      timeline: WORKING_TIMELINE
    })
    const html = renderOpen()
    expect(html).toContain('id="today-timeline"')
    expect(html).toContain('id="today-tasks"')
    expect(html).toContain('>완료</span>')
    expect(html).not.toContain('지금 집중')
    expect(html).not.toContain('>⋯</button>')
    expect(html).not.toContain('비서에게 말하기')
    expect(html).not.toContain('후보 더 보기')
    expect(html).toContain('비서 설정')
  })

  it('A53 recoveryVisible: 본문·진행 중·오류 중 하나가 있으면 본문 영역에 둔다', () => {
    const idle = { inFlight: false, error: null }
    expect(recoveryVisible({ recovery_text: null }, idle)).toBe(false)
    expect(recoveryVisible({ recovery_text: '' }, idle)).toBe(false)
    expect(recoveryVisible({ recovery_text: '# 복구' }, idle)).toBe(true)
    expect(recoveryVisible({ recovery_text: null }, { inFlight: true, error: null })).toBe(true)
    expect(recoveryVisible({ recovery_text: null }, { inFlight: false, error: '실패' })).toBe(true)
  })

  it('MoreSection: 열렸을 때만 children 을 그리고 버튼 id 는 today-more 다', () => {
    const closed = renderToStaticMarkup(
      <MoreSection open={false} onToggle={() => {}}>
        <p>안쪽</p>
      </MoreSection>
    )
    expect(closed).toContain('id="today-more"')
    expect(closed).toContain('더 보기')
    expect(closed).not.toContain('안쪽')
    const open = renderToStaticMarkup(
      <MoreSection open onToggle={() => {}}>
        <p>안쪽</p>
      </MoreSection>
    )
    expect(open).toContain('안쪽')
  })

  it('todayNotices: 해요체 문구 (A52)', () => {
    expect(todayNotices(payload({ calendarConnected: false, jiraConnected: false, jiraTruncated: true }))).toEqual([
      '캘린더가 연결되지 않았어요. 회의 없이 빈 시간을 계산해요.',
      'Jira 가 연결되지 않았어요. Jira 이슈는 후보에 없어요.',
      'Jira 이슈가 많아 일부만 가져왔어요.'
    ])
  })
})

describe('업무 유형 배지·묶음 (부록 J.8, A49)', () => {
  const epic = item({
    id: 1,
    source: 'jira',
    candidate_id: 'jira:ICA-8054',
    jira_issue_key: 'ICA-8054',
    title: 'ICA-8054 안드로이드QA-2026',
    rank: 1,
    work_type: 'qa'
  })
  const child = item({
    id: 2,
    source: 'jira',
    candidate_id: 'jira:ICA-8971',
    jira_issue_key: 'ICA-8971',
    title: 'ICA-8971 안드로이드 구매자 앱 v4.174.0 QA',
    rank: 2,
    status: 'in_progress',
    work_type: 'qa',
    work_version: '4.174.0',
    parent_key: 'ICA-8054',
    group_name: '안드로이드QA-2026'
  })
  const rowHtml = (target: PlanItem, items: PlanItem[], focusItemId: number | null, menuOpen = false): string =>
    renderToStaticMarkup(
      <PlanItemRow
        item={target}
        items={items}
        logicalDate="2026-11-02"
        focusItemId={focusItemId}
        onStatus={() => {}}
        onFocus={() => {}}
        onCompleteOrigin={async () => true}
        menuOpenInitial={menuOpen}
      />
    )

  it('workTypeLabel: QA 만 버전을 붙인다. etc 는 기타', () => {
    expect(workTypeLabel('qa', '4.174.0')).toBe('QA 4.174.0')
    expect(workTypeLabel('qa', null)).toBe('QA')
    expect(workTypeLabel('sus', '4.162.0')).toBe('SUS')
    expect(workTypeLabel('trd', null)).toBe('TRD')
    expect(workTypeLabel('prd', null)).toBe('PRD')
    expect(workTypeLabel('etc', null)).toBe('기타')
  })

  it('WorkTypeBadge: 유형별 색. etc 는 배지가 없다', () => {
    const b = (type: PlanItem['work_type'], version: string | null = null): string =>
      renderToStaticMarkup(<WorkTypeBadge type={type} version={version} />)
    expect(b('qa', '4.174.0')).toContain('bg-rose-50 text-rose-700')
    expect(b('qa', '4.174.0')).toContain('QA 4.174.0')
    expect(b('sus')).toContain('bg-orange-50 text-orange-700')
    expect(b('trd')).toContain('bg-cyan-50 text-cyan-700')
    expect(b('prd')).toContain('bg-violet-50 text-violet-700')
    expect(b('etc')).toBe('')
  })

  it('A49 isGroupItem: 받아들인 하위가 같은 계획에 있는 Jira 항목만 묶음이다', () => {
    expect(isGroupItem(epic, [epic, child])).toBe(true)
    expect(isGroupItem(child, [epic, child])).toBe(false)
    // 제안·무시·제외 하위는 세지 않는다
    for (const status of ['suggested', 'dismissed', 'dropped'] as const) {
      expect(isGroupItem(epic, [epic, { ...child, status }])).toBe(false)
    }
    for (const status of ['planned', 'done', 'deferred'] as const) {
      expect(isGroupItem(epic, [epic, { ...child, status }])).toBe(true)
    }
    // 하위가 없는 에픽, Jira 키가 없는 항목은 보통 항목이다
    expect(isGroupItem(epic, [epic])).toBe(false)
    expect(isGroupItem({ id: 9, jira_issue_key: null }, [{ id: 1, parent_key: null, status: 'planned' }])).toBe(false)
  })

  it('A49 묶음 항목: 묶음 배지, 순위 표시 없음, 집중 중·지금 집중 없음', () => {
    const html = rowHtml(epic, [epic, child], epic.id, true)
    expect(html).toContain('>묶음<')
    expect(html).toContain('bg-gray-100 text-gray-600')
    expect(html).not.toContain('>–<')
    expect(html).not.toContain('집중 중')
    expect(html).not.toContain('지금 집중')
    expect(html).toContain('QA')
  })

  it('하위 항목: 유형 배지·버전·묶음 이름을 보이고 지금 집중을 둔다', () => {
    const html = rowHtml(child, [epic, child], null, true)
    expect(html).toContain('QA 4.174.0')
    expect(html).toContain('안드로이드QA-2026')
    expect(html).not.toContain('>묶음<')
    expect(html).toContain('지금 집중')
    // 묶음 이름은 메타 끝에 둔다 (부록 M.4)
    expect(html.indexOf('QA 4.174.0')).toBeLessThan(html.indexOf('안드로이드QA-2026'))
    // ⋯ 를 접으면 지금 집중이 없다
    expect(rowHtml(child, [epic, child], null)).not.toContain('지금 집중')
  })

  it('A53 오늘 할 일: TodayView 가 묶음 판정에 계획 항목 전체를 넘긴다', () => {
    state.today = payload({ plan: plan(), items: [epic, child], timeline: { ...EMPTY_TIMELINE, focusItemId: 2 } })
    const html = render()
    expect(html).toContain('>묶음<')
    expect(html).toContain('QA 4.174.0')
    expect(html.split('집중 중').length - 1).toBe(1)
  })

  it('longDateLabel: YYYY-MM-DD 를 긴 한국어 라벨로. 형식이 아니면 그대로', () => {
    expect(longDateLabel('2026-11-03')).toBe('11월 3일 화요일')
    expect(longDateLabel('2026-01-01')).toBe('1월 1일 목요일')
    expect(longDateLabel('2026-02-30')).toBe('2026-02-30')
    expect(longDateLabel('오늘')).toBe('오늘')
  })
})

describe('새로 들어온 일 접기 (부록 J.8, J-9)', () => {
  const suggestions = (n: number): PlanItem[] =>
    Array.from({ length: n }, (_, i) =>
      item({
        id: i + 1,
        title: `제안 ${i + 1}`,
        status: 'suggested',
        rank: null,
        source: i < 2 ? 'jira' : 'action_item',
        candidate_id: `x:${i + 1}`,
        score: 100 - i,
        work_type: i === 0 ? 'prd' : 'etc'
      })
    )
  const inbox = (items: PlanItem[]): string =>
    renderToStaticMarkup(<InboxSection items={items} busy={false} onAccept={() => {}} onDismiss={() => {}} />)

  it('INBOX_SHOWN 건까지 보이고 나머지 n건 보기 버튼을 둔다', () => {
    expect(INBOX_SHOWN).toBe(5)
    const html = inbox(suggestions(7))
    expect(html).toContain('7건')
    for (let i = 1; i <= 5; i++) expect(html).toContain(`>제안 ${i}<`)
    expect(html).not.toContain('>제안 6<')
    expect(html).not.toContain('>제안 7<')
    expect(html).toContain('나머지 2건 보기')
    // 유형 배지
    expect(html).toContain('PRD')
  })

  it('5건 이하면 버튼이 없다', () => {
    expect(inbox(suggestions(5))).not.toContain('나머지')
  })

  it('inboxSourceSummary: 출처별 수. 많은 출처가 앞이다', () => {
    expect(inboxSourceSummary(suggestions(7))).toBe('액션아이템 5 · Jira 2')
    expect(inbox(suggestions(7))).toContain('액션아이템 5 · Jira 2')
    expect(inboxSourceSummary([])).toBe('')
  })
})

// 메뉴 통합 1-7. 오늘 일정은 화면에 1번만 보인다.
// 계획이 있으면 시간표, 없으면 홈 일정이다. 오늘 계획을 못 읽어도 홈 일정·개요는 보인다
describe('홈 일정 단일 불변식 (메뉴 통합)', () => {
  const count = (html: string, mark: string): number => html.split(mark).length - 1

  it('계획이 근무 중이면 시간표만 있고 홈 일정은 없다. 홈 개요는 더 보기 앞이다', () => {
    state.today = payload({
      plan: plan(),
      timeline: WORKING_TIMELINE,
      items: [
        item({ id: 1 }),
        item({ id: 2 }),
        item({ id: 3, status: 'suggested', rank: null, source: 'jira', candidate_id: 'jira:A-3' })
      ]
    })
    for (const html of [render(), renderOpen()]) {
      expect(html).toContain('id="today-inbox"')
      expect(count(html, 'id="today-timeline"')).toBe(1)
      expect(html).not.toContain('id="home-schedule"')
      expect(count(html, 'id="home-overview"')).toBe(1)
      expect(html.indexOf('id="today-inbox"')).toBeLessThan(html.indexOf('id="home-overview"'))
      expect(html.indexOf('id="home-overview"')).toBeLessThan(html.indexOf('id="today-more"'))
    }
  })

  it('닫힌 날도 시간표만 있고 홈 일정은 없다', () => {
    state.today = payload({
      plan: plan({ status: 'closed', closed_at: '2026-11-02 18:30:00', closed_by: 'button' }),
      timeline: WORKING_TIMELINE
    })
    const html = render()
    expect(count(html, 'id="today-timeline"')).toBe(1)
    expect(html).not.toContain('id="home-schedule"')
  })

  it('계획이 없으면 홈 일정 1개를 logicalDate 기준으로 전체 폭에, 회의 브리핑은 그 아래 전체 폭에 그린다', () => {
    const meetingRow = event({
      id: 40,
      event_key: 'meeting_briefing:2026-11-02:cal-1',
      kind: 'meeting_briefing',
      scheduled_at: '2026-11-02 10:45:00',
      fired_at: '2026-11-02 10:45:10',
      status: 'sent',
      ref_id: 'cal-1',
      payload: JSON.stringify({
        meeting: { id: 'cal-1', title: '주간 스프린트', startAt: '2099-01-01 23:59:00', endAt: '2099-01-01 23:59:59' },
        title: '주간 스프린트 15분 전',
        body: '결제',
        projects: [],
        hasContext: false,
        ruleMarkdown: '- 관련 프로젝트: 결제',
        llmStatus: 'off',
        llmMarkdown: null,
        llmModel: null,
        llmAt: null,
        llmError: null
      })
    })
    state.today = payload({ plan: null, events: [meetingRow] })
    const html = render()
    expect(count(html, 'id="home-schedule"')).toBe(1)
    expect(html).toContain('data-logical="yes"')
    expect(html).not.toContain('id="today-timeline"')
    expect(html).not.toContain('id="today-main"')
    expect(html).not.toContain('id="today-side"')
    expect(html.indexOf('id="home-schedule"')).toBeLessThan(html.indexOf('id="meeting-briefing-40"'))
    expect(html.indexOf('id="meeting-briefing-40"')).toBeLessThan(html.indexOf('id="home-overview"'))
    expect(html.indexOf('id="home-overview"')).toBeLessThan(html.indexOf('id="today-more"'))
  })

  it('A60 오늘 계획을 못 읽어도 빈 카드 → 진행 중 프로젝트 → 홈 일정 → 중요 메모를 1번씩 그린다. 일정은 로컬 날짜 기준이다 (Q4)', () => {
    state.today = null
    const ordered = (html: string, marks: string[]): void => {
      const at = marks.map((m) => html.indexOf(m))
      expect(at.every((i) => i > -1)).toBe(true)
      for (let i = 1; i < at.length; i++) expect(at[i - 1]).toBeLessThan(at[i])
    }
    let html = render()
    expect(html).toContain('오늘 계획이 아직 없어요.')
    for (const id of ['home-projects', 'home-schedule', 'home-overview']) expect(count(html, `id="${id}"`)).toBe(1)
    expect(html).toContain('data-logical="no"')
    ordered(html, ['오늘 계획이 아직 없어요.', 'id="home-projects"', 'id="home-schedule"', 'id="home-overview"'])
    state.error = '데이터베이스를 열 수 없습니다'
    html = render()
    expect(html).toContain('다시 시도')
    for (const id of ['home-projects', 'home-schedule', 'home-overview']) expect(count(html, `id="${id}"`)).toBe(1)
    ordered(html, ['다시 시도', 'id="home-projects"', 'id="home-schedule"', 'id="home-overview"'])
  })

  it('TodayView 는 assistant:changed 를 직접 구독하지 않는다. 이유: dataSync 와 겹쳐 load 가 2번 돈다', () => {
    const src = readFileSync(resolve(__dirname, 'TodayView.tsx'), 'utf-8')
    expect(src).not.toMatch(/\bsubscribe\(/)
    expect(src).not.toMatch(/onChanged\(/)
    expect(src).not.toMatch(/onDataChanged\(/)
  })
})

// ASSISTANT A54·PROJECT_SYNC R11 아침 자동 동기화의 변경 내역 줄과 상태 줄
describe('아침 동기화 변경 내역 (A54, R11)', () => {
  // 문자열을 거쳐 바꾼다. 이유: 이전 타입 정의에도 컴파일된다
  const MORNING = 'morning_sync' as string as AssistantEvent['kind']
  const morning = (body: Record<string, unknown>, over: Partial<AssistantEvent> = {}): AssistantEvent =>
    event({
      id: 50,
      event_key: 'morning_sync:2026-11-02',
      kind: MORNING,
      scheduled_at: '2026-11-02 08:00:00',
      fired_at: '2026-11-02 08:01:10',
      status: 'logged',
      payload: JSON.stringify(body),
      ...over
    })
  const ok = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    status: 'ok',
    attempts: 1,
    startedAt: '2026-11-02 08:01:00',
    finishedAt: '2026-11-02 08:01:40',
    error: null,
    newCount: 0,
    updatedCount: 0,
    reviewCount: 0,
    failedCount: 0,
    ...extra
  })

  it('describeMorningSync: 두 부분이 성공하면 건수를 보인다', () => {
    const ev = morning({
      release: ok({ newCount: 2, updatedCount: 30 }),
      project: ok({ newCount: 1, updatedCount: 2, reviewCount: 1 })
    })
    // 릴리스의 갱신 수는 보이지 않는다
    expect(describeMorningSync(ev)).toBe(
      '08:01 아침 동기화 · 릴리스 새 2건 · 프로젝트 새 1건 · 갱신 2건 · 확인 필요 1건'
    )
    expect(describeMorningSync(morning({ release: ok({ newCount: 1, failedCount: 2 }) }))).toBe(
      '08:01 아침 동기화 · 릴리스 새 1건 · 일부 실패 2건'
    )
  })

  it('describeMorningSync: 변경 0건·실패·건너뜀·미룸·진행 중을 구분한다', () => {
    expect(describeMorningSync(morning({ release: ok(), project: ok() }))).toBe(
      '08:01 아침 동기화 · 릴리스 변경 없음 · 프로젝트 변경 없음'
    )
    expect(
      describeMorningSync(
        morning({
          release: { status: 'failed', attempts: 2, error: 'Jira 토큰이 만료됐어요' },
          // main 은 건너뛴 이유를 error 에 둔다
          project: { status: 'skipped', attempts: 0, error: 'Jira 미연결' }
        })
      )
    ).toBe('08:01 아침 동기화 · 릴리스 실패 (Jira 토큰이 만료됐어요) · 프로젝트 건너뜀 (Jira 미연결)')
    expect(describeMorningSync(morning({ project: { status: 'deferred', attempts: 1 } }))).toBe(
      '08:01 아침 동기화 · 프로젝트 미룸 (검토 중인 미리보기 있음)'
    )
    expect(describeMorningSync(morning({ release: { status: 'running', attempts: 1 } }))).toBe(
      '08:01 아침 동기화 · 릴리스 진행 중'
    )
  })

  it('describeMorningSync: payload 가 깨져도 시각과 제목은 보인다', () => {
    expect(describeMorningSync(morning({}, { payload: '{깨짐' }))).toBe('08:01 아침 동기화')
    expect(describeMorningSync(morning({}, { payload: null }))).toBe('08:01 아침 동기화')
  })

  it('morningSyncEvents: morning_sync 행만 고른다', () => {
    const rows = [event({ id: 1 }), morning({ release: ok() }), event({ id: 2, kind: 'command' })]
    expect(morningSyncEvents(rows).map((e) => e.id)).toEqual([50])
  })

  it('ChangeLog: 아침 동기화 줄을 다른 기록보다 앞에, 더 보기 안에 그린다', () => {
    state.today = payload({
      plan: plan(),
      events: [
        event({ id: 10, payload: JSON.stringify({ calendarAdded: 1, timelineChanged: true }) }),
        morning({ release: ok({ newCount: 3 }), project: ok({ newCount: 1 }) })
      ]
    })
    expect(render()).not.toContain('아침 동기화')
    const html = renderOpen()
    expect(html).toContain('08:01 아침 동기화 · 릴리스 새 3건 · 프로젝트 새 1건')
    expect(html.indexOf('08:01 아침 동기화')).toBeLessThan(html.indexOf('10:42 회의 1건 추가로 시간표 갱신'))
    expect(html.indexOf('id="today-more"')).toBeLessThan(html.indexOf('08:01 아침 동기화'))
  })

  it('ChangeLog: 계획이 없어도 아침 동기화 줄이 더 보기 안에 보인다', () => {
    state.today = payload({ plan: null, events: [morning({ release: ok({ newCount: 1 }) })] })
    expect(renderOpen()).toContain('08:01 아침 동기화 · 릴리스 새 1건')
  })

  it('morningStatusLine: 시각·건수·실패를 1줄로 만든다. 오늘이 아니면 날짜를 붙인다', () => {
    const today = '2026-11-02'
    expect(morningStatusLine('아침 싱크업', 'project', null, today)).toBeNull()
    expect(
      morningStatusLine(
        '아침 싱크업',
        'project',
        parseMorningPart(ok({ newCount: 1, updatedCount: 2, reviewCount: 1 })),
        today
      )
    ).toBe('아침 싱크업 08:01 · 새 1건 · 갱신 2건 · 확인 필요 1건')
    expect(
      morningStatusLine(
        '아침 동기화',
        'release',
        parseMorningPart({ status: 'failed', attempts: 3, finishedAt: '2026-11-02 09:01:00', error: '네트워크 오류' }),
        today
      )
    ).toBe('아침 동기화 실패 09:01 · 네트워크 오류')
    expect(morningStatusLine('아침 동기화', 'release', parseMorningPart(ok({ newCount: 0 })), '2026-11-03')).toBe(
      '아침 동기화 11/2 08:01 · 변경 없음'
    )
    expect(
      morningStatusLine('아침 싱크업', 'project', parseMorningPart({ status: 'skipped', error: '기본 프로젝트 없음' }), today)
    ).toBe('아침 싱크업 건너뜀 · 기본 프로젝트 없음')
  })

  it('parseMorningPart: 상태가 없거나 객체가 아니면 null 이다. 숫자가 아니면 0 이다', () => {
    expect(parseMorningPart(null)).toBeNull()
    expect(parseMorningPart('ok')).toBeNull()
    expect(parseMorningPart({ attempts: 1 })).toBeNull()
    const part = parseMorningPart({ status: 'ok', newCount: '3' })
    expect(part?.newCount).toBe(0)
    expect(describeMorningPart('project', part!)).toBe('프로젝트 변경 없음')
  })
})

// 메뉴 통합 D5·D9·D10 비서 설정
describe('비서 설정: 첫 화면·아침 자동 동기화·원본 완료', () => {
  const modal = (settings: AssistantSettings): string =>
    renderToStaticMarkup(
      <AssistantSettingsModal settings={settings} busy={false} onClose={() => {}} onSave={async () => true} />
    )

  it('formStartView: 이전 값 auto·dashboard 와 모르는 값은 today 다 (D5)', () => {
    expect(START_VIEW_OPTIONS.map((o) => o.value)).toEqual(['today', 'projects', 'calendar'])
    expect(formStartView('auto')).toBe('today')
    expect(formStartView('dashboard')).toBe('today')
    expect(formStartView(undefined)).toBe('today')
    expect(formStartView('projects')).toBe('projects')
    expect(formStartView('calendar')).toBe('calendar')
  })

  it('설정 모달: 첫 화면 옵션은 오늘·프로젝트·캘린더다. 자동·대시보드가 없다', () => {
    const html = modal(SETTINGS)
    expect(html).toContain('<option value="today" selected="">오늘</option>')
    expect(html).toContain('<option value="projects">프로젝트</option>')
    expect(html).toContain('<option value="calendar">캘린더</option>')
    expect(html).not.toContain('value="auto"')
    expect(html).not.toContain('value="dashboard"')
    expect(html).not.toContain('대시보드')
  })

  it('설정 모달: 저장된 dashboard 는 오늘로 선택된다', () => {
    const legacy = { ...SETTINGS, startView: 'dashboard' } as unknown as AssistantSettings
    expect(modal(legacy)).toContain('<option value="today" selected="">오늘</option>')
  })

  it('설정 모달: 아침 자동 동기화 토글·시각과 원본 완료 토글을 보인다', () => {
    const html = modal(SETTINGS)
    expect(html).toContain('아침 자동 동기화')
    expect(html).toContain('아침 동기화 시각')
    expect(html).toContain('value="08:00"')
    expect(html).toContain('완료하면 원본도 완료')
  })

  it('설정 모달: 이전 main 이 새 키를 주지 않으면 켬·08:00·끔이 기본값이다 (D9·D10)', () => {
    const old = { ...SETTINGS } as Partial<AssistantSettings>
    delete old.morningSyncEnabled
    delete old.morningSyncTime
    delete old.completeOriginOnDone
    const html = modal(old as AssistantSettings)
    expect(html).toContain('value="08:00"')
    // 아침 자동 동기화 토글은 켜짐이고 원본 완료 토글은 꺼짐이다
    const toggles = [...html.matchAll(/<input type="checkbox"([^>]*)\/><span><span[^>]*>([^<]+)</g)].map(
      (m) => [m[2], m[1].includes('checked=""')] as const
    )
    expect(toggles).toContainEqual(['아침 자동 동기화', true])
    expect(toggles).toContainEqual(['완료하면 원본도 완료', false])
  })

  it('설정: 아침 동기화 시각은 HH:mm 만 받고 새 키도 patch 에 담는다', () => {
    expect(validateSettings({ ...SETTINGS, morningSyncTime: '25:00' })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, morningSyncTime: '7:30' })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, morningSyncTime: '07:30' })).toBeNull()
    expect(
      diffSettings(SETTINGS, {
        ...SETTINGS,
        morningSyncEnabled: false,
        morningSyncTime: '07:30',
        completeOriginOnDone: true,
        startView: 'calendar'
      })
    ).toEqual({ morningSyncEnabled: false, morningSyncTime: '07:30', completeOriginOnDone: true, startView: 'calendar' })
  })
})

// 부록 M 할 일 행: 3열 그리드, 상태 버튼 3개, 계속 제외 2단계, 강조 5가지.
// 자동 클릭이 불가해 열린 상태는 prop 으로 주입한다
describe('할 일 행·오늘 카드 (부록 M)', () => {
  const row = (target: PlanItem, over: Partial<React.ComponentProps<typeof PlanItemRow>> = {}): string =>
    renderToStaticMarkup(
      <PlanItemRow
        item={target}
        items={[target]}
        logicalDate="2026-11-02"
        focusItemId={null}
        onStatus={() => {}}
        onFocus={() => {}}
        onCompleteOrigin={async () => true}
        {...over}
      />
    )
  const jiraDropped = item({
    id: 5,
    source: 'jira',
    candidate_id: 'jira:ICA-5',
    jira_issue_key: 'ICA-5',
    title: 'ICA-5 늘 열린 에픽',
    status: 'dropped'
  })

  it('행은 2열 그리드다. 1열 제목·메타(작업 시간 포함), 2열 버튼 완료·제외·⋯. 순위 숫자가 없다 (M11, M.9 N1·N2)', () => {
    const label = '작업 시간 13:00–14:00, 15:00–16:00'
    const html = row(item({ id: 1, rank: 3, title: '보고서 작성' }), { slotLabel: label })
    expect(html).toContain('grid grid-cols-[minmax(0,1fr)_auto]')
    expect(html).not.toContain('grid-cols-[7rem')
    expect(html).toContain('border-l-[3px]')
    expect(html).toContain('border-l-transparent')
    // 순위 숫자 3 과 순위 글자 클래스가 없다
    expect(html).not.toMatch(/>3</)
    expect(html).not.toContain('text-gray-400 tabular-nums')
    // 작업 시간은 메타 줄 안이다
    const meta = html.slice(html.indexOf('mt-1 flex flex-wrap'))
    expect(meta).toContain(`>${label}<`)
    expect(html.indexOf('보고서 작성')).toBeLessThan(html.indexOf(label))
    expect(html.indexOf(label)).toBeLessThan(html.indexOf('>완료</button>'))
    expect(html.indexOf('>완료</button>')).toBeLessThan(html.indexOf('>제외</button>'))
    expect(html.indexOf('>제외</button>')).toBeLessThan(html.indexOf('>⋯</button>'))
    expect(html).toContain('aria-expanded="false"')
    // 작업 시간이 없으면 글자가 없다
    expect(row(item({ id: 1 }))).not.toContain('작업 시간')
  })

  it('⋯ 를 펼치면 진행 중·미룸·지금 집중이 보인다. 접으면 없다 (menuOpenInitial)', () => {
    const closed = row(item({ id: 1 }))
    for (const label of ['>진행 중</button>', '>미룸</button>', '지금 집중</button>']) expect(closed).not.toContain(label)
    const open = row(item({ id: 1 }), { menuOpenInitial: true })
    expect(open).toContain('aria-expanded="true"')
    for (const label of ['>진행 중</button>', '>미룸</button>', '지금 집중</button>']) expect(open).toContain(label)
    // 집중 중인 항목과 끝난 항목은 지금 집중이 없다
    expect(row(item({ id: 1 }), { menuOpenInitial: true, focusItemId: 1 })).not.toContain('지금 집중')
    expect(row(item({ id: 1, status: 'deferred' }), { menuOpenInitial: true })).not.toContain('지금 집중')
    // 미룸 항목은 ⋯ 버튼에 상태를 같이 쓴다
    expect(row(item({ id: 1, status: 'deferred' }))).toContain('>미룸 ⋯</button>')
  })

  it('읽기 전용이면 버튼 대신 상태 글자만 보인다', () => {
    const html = row(item({ id: 1, status: 'in_progress' }), { readOnly: true })
    expect(html).toContain('>진행 중</span>')
    expect(html).not.toContain('<button type="button" class="px-2.5')
    expect(html).not.toContain('⋯')
  })

  it('제외된 jira·task 행: 오늘만 제외했어요 + 계속 제외. 계속 제외면 안내 + 제외 취소 (M5)', () => {
    const today = row(jiraDropped)
    expect(today).toContain('오늘만 제외했어요.')
    expect(today).toContain('>계속 제외</button>')
    expect(today).not.toContain('제외 취소')
    // 버튼은 공용 button.subtle 모양이다. 일반 글자와 구분된다
    expect(today).toMatch(new RegExp(`class="px-2\\.5 py-1 text-sm ${button.subtle}"[^>]*>계속 제외</button>`))
    expect(row(jiraDropped, { excluded: true })).toContain(`class="px-2.5 py-1 text-sm ${button.subtle}">제외 취소</button>`)
    const kept = row(jiraDropped, { excluded: true })
    expect(kept).toContain('계속 제외했어요. 내일부터 자동으로 넣지 않아요.')
    expect(kept).toContain('>제외 취소</button>')
    expect(kept).not.toContain('오늘만 제외했어요.')
    expect(kept).not.toContain('>계속 제외</button>')
    // task 출처도 같다
    expect(row(item({ id: 6, status: 'dropped' }))).toContain('오늘만 제외했어요.')
    // 제외가 아닌 상태, todo·액션아이템·임시 출처, 읽기 전용이면 안내 줄이 없다
    for (const html of [
      row({ ...jiraDropped, status: 'planned' }),
      row({ ...jiraDropped, status: 'deferred' }),
      row({ ...jiraDropped, source: 'todo', candidate_id: 'todo:5' }),
      row({ ...jiraDropped, source: 'action_item', candidate_id: 'action_item:5:0' }),
      row({ ...jiraDropped, source: 'manual', candidate_id: 'manual:5' }),
      row(jiraDropped, { readOnly: true })
    ]) {
      expect(html).not.toContain('오늘만 제외했어요.')
      expect(html).not.toContain('계속 제외')
    }
  })

  it('강조: 집중 행은 파란 막대·굵은 제목·집중 중 배지, 끝난 행은 흐리게, done 은 취소선 (M.4)', () => {
    const focus = row(item({ id: 1 }), { focusItemId: 1 })
    expect(focus).toContain('border-l-blue-600 bg-blue-50')
    expect(focus).toMatch(/<p class="[^"]*font-semibold[^"]*" title="작업 1">/)
    expect(focus).toContain('>집중 중<')
    const done = row(item({ id: 1, status: 'done' }), { focusItemId: 1 })
    expect(done).not.toContain('border-l-blue-600')
    expect(done).not.toContain('집중 중')
    expect(done).toContain('opacity-60')
    expect(done).toContain('line-through')
    for (const status of ['deferred', 'dropped'] as const) {
      const html = row(item({ id: 1, status }))
      expect(html).toContain('opacity-60')
      expect(html).not.toContain('line-through')
    }
    expect(row(item({ id: 1 }))).not.toContain('opacity-60')
  })

  it('마감 강조: 오늘·지남·긴급만 빨간 글자다. D-n 과 끝난 항목은 회색이다 (M.4 강조 2)', () => {
    const red = '<span class="text-red-600 font-medium">'
    expect(row(item({ id: 1, due_date: '2026-11-02' }))).toContain(`${red}마감 오늘</span>`)
    expect(row(item({ id: 1, due_date: '2026-10-31' }))).toContain(`${red}2일 지남</span>`)
    expect(row(item({ id: 1, due_date: '2026-11-04', urgent: true }))).toContain(`${red}D-2</span>`)
    expect(row(item({ id: 1, due_date: '2026-11-04' }))).not.toContain('text-red-600')
    expect(row(item({ id: 1, due_date: '2026-10-31', status: 'done' }))).not.toContain('text-red-600')
  })

  it('출처 배지: Jira·작업·TODO 는 회색, 액션아이템은 amber 다 (M12). 미배정은 메타에 쓴다', () => {
    for (const source of ['jira', 'task', 'todo'] as const) {
      const html = row(item({ id: 1, source }))
      expect(html).toContain('bg-gray-100 text-gray-600')
      expect(html).not.toMatch(/ bg-(indigo|green|blue)-50 text-/)
    }
    expect(row(item({ id: 1, source: 'action_item' }))).toContain('bg-amber-50 text-amber-700')
    expect(row(item({ id: 1 }), { unplaced: true })).toContain('>미배정<')
    expect(row(item({ id: 1 }))).not.toContain('미배정')
  })

  it('TodayView: today.exclusions 로 계속 제외 여부를 행에 넘긴다', () => {
    const exclusion = {
      candidate_id: 'jira:ICA-5',
      jira_key: 'ICA-5',
      title: 'ICA-5 늘 열린 에픽',
      source: 'jira' as const,
      excluded_at: '2026-11-02 09:50:00'
    }
    state.today = payload({ plan: plan(), items: [jiraDropped, item({ id: 6, status: 'dropped' })], exclusions: [exclusion] })
    const html = render()
    expect(html).toContain('계속 제외했어요. 내일부터 자동으로 넣지 않아요.')
    expect(html).toContain('오늘만 제외했어요.')
    expect(html.indexOf('계속 제외했어요.')).toBeLessThan(html.indexOf('id="today-timeline"'))
    // 이전 main 이 exclusions 를 주지 않아도 그린다
    state.today = { ...payload({ plan: plan(), items: [jiraDropped] }), exclusions: undefined } as unknown as TodayPayload
    expect(render()).toContain('오늘만 제외했어요.')
  })

  it('오늘 카드: 할 일·회의가 비면 각 구역에 빈 안내를 보인다. 머리 건수는 활성 할 일과 회의 행 수다', () => {
    state.today = payload({ plan: plan(), items: [], timeline: EMPTY_TIMELINE })
    let html = render()
    expect(html).toContain('할 일 0 · 회의 0')
    expect(html).toContain('계획 항목이 없어요. 아래 후보에서 추가해 주세요.')
    expect(html).toContain('오늘 회의가 없어요.')
    expect(html.indexOf('계획 항목이 없어요.')).toBeLessThan(html.indexOf('오늘 회의가 없어요.'))
    state.today = payload({
      plan: plan(),
      items: [item({ id: 1 }), item({ id: 2, status: 'done' }), item({ id: 3, status: 'suggested', rank: null })],
      timeline: WORKING_TIMELINE
    })
    html = render()
    expect(html).toContain('할 일 1 · 회의 3')
    expect(html).not.toContain('오늘 회의가 없어요.')
  })

  it('TodayView 는 CandidatePicker 를 직접 쓰지 않는다. 후보 더 보기는 CandidatesCard 가 맡는다 (M10)', () => {
    const src = readFileSync(resolve(__dirname, 'TodayView.tsx'), 'utf-8')
    expect(src).not.toContain('CandidatePicker')
    expect(src).toContain('CandidatesCard')
  })
})
