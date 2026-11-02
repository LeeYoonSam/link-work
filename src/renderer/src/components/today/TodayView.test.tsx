import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
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
  checkinMinGap: 45,
  checkinDailyCap: 4,
  meetingLeadMin: 15,
  startView: 'auto',
  checkinEnabled: true,
  meetingBriefingEnabled: true
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
    focusItem: async () => {},
    completeOrigin: async () => true,
    saveSettings: async () => true,
    setFocus: () => {},
    clearError: () => {},
    respondCheckin: async () => {},
    regenerateMeetingBriefing: async () => {},
    meetingRegeneratingIds: [],
    subscribe: () => () => {}
  })
}))

const TodayView = (await import('./TodayView')).default
const { orderPlanItems, todayNotices, unplacedDeadlineItems, focusTargetId } = await import('./TodayView')
const { dayCountLabel, dueLabel, durationLabel, freeTimeLabel } = await import('./PlanItemRow')
const { blockItemMeta } = await import('./Timeline')
const { describePlanUpdate, planUpdateEvents, commandEvents, describeCommand } = await import('./ChangeLog')
const { sortSuggestions } = await import('./InboxSection')
const { candidatesNotInPlan } = await import('./CandidatePicker')
const { originTarget } = await import('../../stores/assistantStore')
const { validateSettings, diffSettings, parseNumberInput, numberInputValue } = await import('./AssistantSettingsModal')
const AssistantSettingsModal = (await import('./AssistantSettingsModal')).default
const { recoveryButtonLabel } = await import('./RecoveryCard')
const { localNow } = await import('./TodayView')

const render = (): string => renderToStaticMarkup(<TodayView />)

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

  it('근무 중 + 제안 1건: 상단·브리핑·새로 들어온 일·타임라인·오늘 할 일·변경 내역을 보여 준다', () => {
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
    // 새로 들어온 일
    expect(html).toContain('새로 들어온 일')
    expect(html).toContain('PROJ-123 장애 대응')
    expect(html).toContain('긴급')
    expect(html).toContain('계획에 추가')
    expect(html).toContain('무시')
    // 타임라인: 집중 가능 시간, 회의, 빈 시간 블록, 이어서, 여러 날 작업, 마감 배정
    expect(html).toContain('집중 가능')
    expect(html).toContain('4시간 30분')
    expect(html).toContain('09:45–11:00')
    expect(html).toContain('빈 시간 1h15m')
    expect(html).toContain('빈 시간 2h30m')
    expect(html).toContain('빈 시간 2h')
    expect(html).toContain('[회의]')
    expect(html).toContain('주간 스프린트')
    expect(html).toContain('15:30–16:00')
    expect(html).toContain('진행 중 · 3일째 · D-2')
    expect(html).toContain('(이어서)')
    expect(html).toContain('마감 오늘')
    expect(html).toContain('data-state="current"')
    // 오늘 할 일: 집중 중 배지, 지금 집중 버튼, 상태 버튼
    expect(html).toContain('오늘 할 일')
    expect(html).toContain('집중 중')
    expect(html).toContain('지금 집중')
    expect(html).toContain('3일째')
    expect(html).toContain('D-2')
    expect(html).toContain('진행 중')
    expect(html).toContain('완료')
    expect(html).toContain('미룸')
    expect(html).toContain('제외')
    // 3판에서 지운 시간 표시
    expect(html).not.toContain('시간 미배정')
    expect(html).not.toContain('시간 변경')
    expect(html).not.toContain('고정')
    // 변경 내역과 안내 문구
    expect(html).toContain('변경 내역')
    expect(html).toContain('10:42 회의 1건 추가로 시간표 갱신')
    expect(html).toContain('Jira 이슈가 많습니다. 일부만 가져왔습니다.')
    expect(html).toContain('후보 더 보기')
    // 근무 중에는 하루 시작 버튼이 없다
    expect(html).not.toContain('하루 시작')
  })

  it('근무 중: 지난 블록은 흐리게, 30분 미만 블록은 작게, 배정 못 한 마감 항목은 안내한다', () => {
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
    expect(html).toContain('data-state="past"')
    expect(html).toMatch(/data-state="past" class="[^"]*opacity-50/)
    expect(html).toContain('빈 시간 15m')
    expect(html).toContain('text-[11px]')
    expect(html).toContain('오늘 남은 빈 시간이 없어 배정하지 못한 마감 항목')
    expect(html).toContain('급한 보고서')
    expect(html).toContain('1일 지남')
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
    expect(html).not.toContain('집중 가능')
    expect(html).toContain('data-state="past"')
    expect(html).not.toContain('후보 더 보기')
  })

  // 부록 G.10.1 명령 입력창. 근무 중에만 보인다
  it('명령 입력: 근무 중이면 비서에게 말하기 입력창이 DayHeader 아래, 맥락 복구 위에 있다', () => {
    state.today = payload({ plan: plan() })
    const html = render()
    expect(html).toContain('비서에게 말하기')
    expect(html.indexOf('비서에게 말하기')).toBeLessThan(html.indexOf('맥락 복구'))
    expect(html.indexOf('>퇴근</button>')).toBeLessThan(html.indexOf('비서에게 말하기'))
  })

  it('명령 입력: 계획 없음·닫힘이면 비서에게 말하기 입력창이 없다', () => {
    state.today = payload({ plan: null })
    expect(render()).not.toContain('비서에게 말하기')
    state.today = payload({
      plan: plan({ status: 'closed', closed_at: '2026-11-02 18:30:00', closed_by: 'button' })
    })
    expect(render()).not.toContain('비서에게 말하기')
  })

  // 부록 H.8.2 체크인 패널. 응답 없는 체크인이 있으면 맥락 복구 위에 둔다
  const checkinEvent = (over: Partial<AssistantEvent> = {}): AssistantEvent =>
    event({
      id: 30,
      event_key: 'checkin:2026-11-02:1100',
      kind: 'checkin',
      scheduled_at: '2026-11-02 10:55:00',
      fired_at: '2026-11-02 10:55:20',
      status: 'sent',
      ref_id: '1',
      payload: JSON.stringify({
        itemId: 1,
        candidateId: 'task:1',
        itemTitle: '결제 API 리팩터링',
        blockStart: '09:45',
        blockEnd: '11:00',
        title: '체크인: 결제 API 리팩터링',
        body: '지금까지 어떻게 됐나요? 답장하거나 눌러서 고르세요.'
      }),
      ...over
    })

  it('체크인: 응답 없는 체크인이 있으면 맥락 복구 위에 패널을 보여 준다', () => {
    state.today = payload({
      plan: plan(),
      items: [item({ id: 1, title: '결제 API 리팩터링', status: 'in_progress' })],
      events: [checkinEvent()]
    })
    const html = render()
    expect(html).toContain('id="today-checkin"')
    expect(html).toContain('체크인 · 10:55')
    expect(html).toContain('09:45–11:00')
    expect(html).toContain('>넘기기<')
    expect(html.indexOf('today-checkin')).toBeLessThan(html.indexOf('맥락 복구'))
    // 패널에도 범위 지정 명령 입력이 있다
    expect(html).toContain('완료, 미룸, 또는 진행 상황 한 줄')
  })

  it('체크인: 응답했거나 항목이 이미 완료면 패널이 없다', () => {
    state.today = payload({
      plan: plan(),
      items: [item({ id: 1 })],
      events: [checkinEvent({ response: 'button:in_progress', responded_at: '2026-11-02 10:56:00' })]
    })
    expect(render()).not.toContain('today-checkin')
    state.today = payload({
      plan: plan(),
      items: [item({ id: 1, status: 'done' })],
      events: [checkinEvent()]
    })
    expect(render()).not.toContain('today-checkin')
  })

  it('체크인: 닫힌 날은 버튼 없이 오늘 마감만 보여 준다', () => {
    state.today = payload({
      plan: plan({ status: 'closed', closed_at: '2026-11-02 18:30:00', closed_by: 'button' }),
      items: [item({ id: 1 })],
      events: [checkinEvent()]
    })
    const html = render()
    expect(html).toContain('id="today-checkin"')
    expect(html).not.toContain('>넘기기<')
  })

  // 부록 I.10 회의 브리핑 카드. 체크인 아래, 맥락 복구 위다. 계획이 없어도 보인다
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

  it('회의 브리핑: 체크인 아래, 맥락 복구 위에 놓인다', () => {
    state.today = payload({
      plan: plan(),
      items: [item({ id: 1, title: '결제 API 리팩터링', status: 'in_progress' })],
      events: [checkinEvent(), meetingEvent()]
    })
    const html = render()
    expect(html.indexOf('today-checkin')).toBeLessThan(html.indexOf('meeting-briefing-40'))
    expect(html.indexOf('meeting-briefing-40')).toBeLessThan(html.indexOf('맥락 복구'))
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

// 부록 F.7 맥락 복구 카드. 브리핑 바로 위에 둔다
describe('맥락 복구 카드 렌더링', () => {
  const RECOVERY_MD = '# 2026-11-02 맥락 복구\n\n## 남은 작업\n\n- 결제 모듈 리팩토링 · 진행 중\n'

  it('맥락 복구 본문 없음: 제목과 만들기 버튼 1줄만 보이고 브리핑 위에 놓인다', () => {
    state.today = payload({ plan: plan() })
    const html = render()
    expect(html).toContain('맥락 복구')
    expect(html).toContain('id="today-recovery"')
    expect(html).toMatch(/<button[^>]*>만들기<\/button>/)
    expect(html).not.toContain('다시 만들기')
    expect(html).not.toContain('만드는 중…')
    expect(html).not.toContain('AI 복구')
    expect(html).not.toContain('규칙 복구')
    expect(html).not.toContain('>접기<')
    expect(html.indexOf('today-recovery')).toBeLessThan(html.indexOf('today-briefing'))
  })

  it('맥락 복구 진행 중: 만드는 중… 을 보이고 버튼을 비활성으로 둔다', () => {
    state.today = payload({ plan: plan(), recovery: { inFlight: true, error: null } })
    const html = render()
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
    let html = render()
    expect(html).toContain('today-recovery')
    expect(html).not.toMatch(/<button[^>]*>만들기<\/button>/)

    state.today = payload({ plan: null })
    html = render()
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

  it('blockItemMeta: 이어서·마감·집중 문구', () => {
    const it1 = { status: 'in_progress' as const, first_planned_date: '2026-10-31', due_date: '2026-11-04' }
    expect(blockItemMeta({ reason: 'focus', continued: false }, it1, '2026-11-02')).toBe('진행 중 · 3일째 · D-2')
    expect(blockItemMeta({ reason: 'focus', continued: true }, it1, '2026-11-02')).toBe('(이어서)')
    expect(
      blockItemMeta({ reason: 'deadline', continued: false }, { ...it1, status: 'planned', due_date: '2026-11-02' }, '2026-11-02')
    ).toBe('마감 오늘')
    expect(
      blockItemMeta({ reason: 'focus', continued: false }, { status: 'planned', first_planned_date: '2026-11-02', due_date: null }, '2026-11-02')
    ).toBe('')
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
      event({ id: 33, kind: 'checkin', scheduled_at: '2026-11-02 09:00:00' })
    ]
    expect(commandEvents(events).map((e) => e.id)).toEqual([32, 30])
    state.today = payload({ plan: plan(), events })
    const html = render()
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

  it('변경 내역: 알림 행은 그리지 않고 오늘 계획 카드에 today-timeline id 를 둔다', () => {
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
    const html = render()
    expect(html).toContain('id="today-timeline"')
    expect(html).toContain('10:42 1건 완료 반영 · 알림 보냄')
    expect(html).not.toContain('9건 제외')
  })

  it('focusTargetId: 알림 focus 를 스크롤 대상 id 로 바꾼다 (부록 E.3.5)', () => {
    expect(focusTargetId({ kind: 'timeline' })).toBe('today-timeline')
    expect(focusTargetId({ kind: 'inbox' })).toBe('today-inbox')
    expect(focusTargetId({ kind: 'briefing' })).toBe('today-briefing')
    expect(focusTargetId({ kind: 'item', id: '7' })).toBe('plan-item-7')
    // 체크인 알림 클릭 (부록 H.6.3)
    expect(focusTargetId({ kind: 'checkin', id: '42' })).toBe('today-checkin')
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

  it('candidatesNotInPlan: 계획에 이미 있는 후보를 뺀다', () => {
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
      link: null
    }
    const rest = candidatesNotInPlan(
      [
        { ...base, id: 'task:1', source: 'task' },
        { ...base, id: 'todo:9', source: 'todo' }
      ],
      [item({ id: 1, candidate_id: 'task:1' })]
    )
    expect(rest.map((c) => c.id)).toEqual(['todo:9'])
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

  it('설정: 체크인 상한 0~20, 간격 5~480분 정수만 받고 체크인 키도 patch 에 담는다 (부록 H.8.4)', () => {
    expect(validateSettings({ ...SETTINGS, checkinDailyCap: -1 })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, checkinDailyCap: 21 })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, checkinMinGap: 4 })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, checkinMinGap: 481 })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, checkinMinGap: 30.5 })).not.toBeNull()
    expect(validateSettings({ ...SETTINGS, checkinDailyCap: 0, checkinMinGap: 5 })).toBeNull()
    expect(validateSettings({ ...SETTINGS, checkinDailyCap: 20, checkinMinGap: 480 })).toBeNull()
    expect(
      diffSettings(SETTINGS, { ...SETTINGS, checkinEnabled: false, checkinDailyCap: 2, checkinMinGap: 60 })
    ).toEqual({ checkinEnabled: false, checkinDailyCap: 2, checkinMinGap: 60 })
  })

  it('설정: 빈 숫자 칸은 0 이 아니라 검증 오류다', () => {
    expect(parseNumberInput('')).toBeNaN()
    expect(parseNumberInput('  ')).toBeNaN()
    expect(parseNumberInput('0')).toBe(0)
    expect(parseNumberInput('12')).toBe(12)
    expect(numberInputValue(Number.NaN)).toBe('')
    expect(numberInputValue(0)).toBe(0)
    for (const key of ['planSize', 'refreshCalendarMin', 'refreshJiraMin', 'checkinDailyCap', 'checkinMinGap', 'meetingLeadMin'] as const) {
      expect(validateSettings({ ...SETTINGS, [key]: parseNumberInput('') })).toMatch(/입력하세요/)
    }
  })

  it('설정 모달: 체크인 설정 3개를 보여 준다', () => {
    const html = renderToStaticMarkup(
      <AssistantSettingsModal settings={SETTINGS} busy={false} onClose={() => {}} onSave={async () => true} />
    )
    expect(html).toContain('작업 경계 체크인')
    expect(html).toContain('빈 시간 블록이 끝나기 5분 전에 진행 상황을 묻습니다')
    expect(html).toContain('하루 체크인 상한')
    expect(html).toContain('체크인 최소 간격(분)')
    expect(html).toContain('value="45"')
    expect(html).toContain('value="4"')
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
