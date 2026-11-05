export type CandidateSource = 'jira' | 'task' | 'todo' | 'action_item' | 'manual'
export type CandidatePriority = 'high' | 'medium' | 'low'
export type JiraCategory = 'new' | 'indeterminate' | 'done'
export type AiModelName = 'opus' | 'sonnet' | 'haiku'

export interface Candidate {
  id: string                       // 'task:12' | 'todo:5' | 'jira:PROJ-1' | 'action_item:7:0'
  source: CandidateSource
  title: string
  jiraKey: string | null
  projectId: number | null
  projectName: string | null
  dueDate: string | null           // 'YYYY-MM-DD'
  dueTime: string | null           // 'HH:mm'. todo 만
  inProgress: boolean
  priority: CandidatePriority | null
  jiraPriority: string | null      // Jira 원본 이름. 긴급 판정용
  lastTouchedAt: string | null     // 로컬 'YYYY-MM-DD HH:mm:ss'
  link: string | null
  parentKey: string | null         // Jira 부모 키. jira·task(머지) 만 (부록 J)
  groupName: string | null         // Jira 부모 요약 또는 WBS 프로젝트 이름
  workType: WorkType
  workVersion: string | null
}

export interface TaskRow {
  id: number; project_id: number; project_name: string
  project_priority: 'now' | 'next' | 'later' | null
  name: string; status: string; end_date: string | null; jira_issue_key: string | null
}
export interface TodoRow { id: number; title: string; priority: string; due_date: string | null; updated_at: string | null }
export interface ActionItemRow { meeting_id: number; index: number; text: string; due: string | null; meeting_title: string }
export interface JiraCandidateInput {
  key: string; summary: string; status: string; statusCategory: JiraCategory
  priority: string | null; duedate: string | null
  updatedLocal: string | null      // 로컬 'YYYY-MM-DD HH:mm:ss' 로 바꾼 값
  url: string | null               // getJiraIssueUrl 결과
  issueType: string
  parentKey: string | null
  parentSummary: string | null
}
export interface CandidateInput {
  tasks: TaskRow[]                 // 미완료 작업. 활성 프로젝트 소속만
  todos: TodoRow[]                 // is_completed = 0
  jiraIssues: JiraCandidateInput[] | null   // null 이면 이번에 Jira 를 보지 않았다
  actionItems: ActionItemRow[]     // todo_id 없는 항목만. 회의 요약 생성 14일 이내
  taskTouchedAt: Record<number, string>
}

export interface ScoredCandidate { candidate: Candidate; score: number }
export interface BusyBlock { start: string; end: string }     // 'HH:mm'
export type Slot = BusyBlock

export type PlanStatus = 'active' | 'closed'
export type PlanClosedBy = 'button' | 'auto'
export type PlanItemStatus = 'suggested' | 'planned' | 'in_progress' | 'done' | 'deferred' | 'dropped' | 'dismissed'
export type PlanAddedBy = 'start' | 'user' | 'refresh'

export interface CalendarRef { id: string; title: string; start: string; end: string; allDay: boolean }  // start·end 는 오늘 기준 'HH:mm'
export interface JiraSnapshotRef { key: string; status: string; priority: string | null; duedate: string | null; updated: string }
export interface SourceSnapshot { calendar: CalendarRef[]; jira: JiraSnapshotRef[]; seenCandidateIds: string[]; takenAt: string }

export interface DailyPlan {
  id: number; plan_date: string; status: PlanStatus
  started_at: string; closed_at: string | null; closed_by: PlanClosedBy | null
  source_snapshot: SourceSnapshot | null     // 저장소가 JSON 을 파싱해 돌려준다
  briefing_text: string | null; briefing_source: 'rules' | 'llm' | null; briefing_model: string | null
  briefing_error: string | null; briefing_at: string | null
  recovery_text: string | null; recovery_source: 'rules' | 'llm' | null; recovery_at: string | null
  wrapup_note: string | null; wrapup_at: string | null; last_refresh_at: string | null
  briefing_instruction: string | null   // 사용자 브리핑 방침 (부록 G.7)
  created_at: string; updated_at: string
}

export interface PlanItem {
  id: number; plan_id: number; candidate_id: string; source: CandidateSource; title: string
  link: string | null; jira_issue_key: string | null; project_id: number | null; due_date: string | null
  score: number; rank: number | null; slot_start: string | null; slot_end: string | null
  pinned: boolean; added_by: PlanAddedBy; urgent: boolean
  status: PlanItemStatus; status_note: string | null; status_at: string | null
  first_planned_date: string | null   // 조회 전용. 같은 candidate_id 가 처음 계획에 오른 논리 날짜
  work_type: WorkType                 // 부록 J
  work_version: string | null
  parent_key: string | null
  group_name: string | null
}
export type NewPlanItem = Omit<PlanItem, 'id' | 'plan_id' | 'status_at' | 'first_planned_date'>
export interface PlanItemUpdate {
  id: number
  patch: Partial<Pick<PlanItem,
    'candidate_id' | 'source' | 'link' | 'title' | 'jira_issue_key' | 'project_id' | 'due_date'
    | 'score' | 'rank' | 'slot_start' | 'slot_end' | 'pinned' | 'urgent' | 'status' | 'status_note'
    | 'work_type' | 'work_version' | 'parent_key' | 'group_name'>>
}

// 'checkin' 은 제거된 작업 경계 체크인의 과거 행이다 (부록 L). 새 행을 만들지 않는다
export type AssistantEventKind = 'start_nudge' | 'plan_update' | 'checkin' | 'meeting_briefing' | 'command' | 'morning_sync'
export type AssistantEventStatus = 'sent' | 'late' | 'skipped' | 'failed' | 'logged'
export interface AssistantEvent {
  id: number; event_key: string; kind: AssistantEventKind; plan_date: string; scheduled_at: string
  fired_at: string | null; status: AssistantEventStatus; ref_id: string | null; payload: string | null
  response: string | null; responded_at: string | null; created_at: string
}
export type NewAssistantEvent = Pick<AssistantEvent, 'event_key' | 'kind' | 'plan_date' | 'scheduled_at' | 'fired_at' | 'status' | 'ref_id' | 'payload'>

export interface CurrentSources {
  candidates: Candidate[]
  calendar: CalendarRef[] | null   // null 이면 이번에 보지 않았거나 조회에 실패했다
  jira: JiraSnapshotRef[] | null   // null 이면 이번에 보지 않았거나 조회에 실패했다
}
export type VanishedResolution =
  | { kind: 'done' }
  | { kind: 'dropped'; note: string }
  | { kind: 'replace'; candidate: Candidate }
export interface RefreshDiff {
  calendarAdded: CalendarRef[]; calendarChanged: CalendarRef[]; calendarRemoved: CalendarRef[]
  newCandidates: Candidate[]; vanishedCandidateIds: string[]; updatedCandidates: Candidate[]
}
export interface RefreshContext {
  today: string; nowHHmm: string; workEnd: string
  dayStart: string                 // 타임라인 시작 'HH:mm'. started_at 을 15분 단위로 올린 값
  resolutions: Record<string, VanishedResolution>
}
export interface RefreshSummary {
  calendarAdded: number; calendarChanged: number; calendarRemoved: number
  suggested: number; urgentSuggestedIds: string[]
  completed: number; dropped: number; replaced: number
  timelineChanged: boolean         // 일정 변경 여부
  currentOrNextChanged: boolean    // current 블록 end·itemId, 다음 future 블록 start·end·itemId 변경 여부 (E.3.1)
}
export interface RefreshPlan { inserts: NewPlanItem[]; updates: PlanItemUpdate[]; snapshot: SourceSnapshot; summary: RefreshSummary }

export interface AssistantSettings {
  enabled: boolean; dayRollover: string; startNudge: boolean; workEnd: string
  planSize: number; llmEnabled: boolean; llmModel: AiModelName
  jiraScope: 'all' | 'default_project'; openAtLogin: boolean
  refreshCalendarMin: number; refreshJiraMin: number; refreshNotify: boolean
  meetingLeadMin: number
  startView: 'today' | 'projects' | 'calendar'   // 첫 화면 (부록 C, A24)
  meetingBriefingEnabled: boolean              // 회의 전 브리핑 (부록 I)
  morningSyncEnabled: boolean                  // 아침 자동 동기화 (A54)
  morningSyncTime: string                        // 아침 자동 동기화 시각 'HH:mm'
  completeOriginOnDone: boolean                // 계획 항목 완료 때 원본도 완료한다
}

export type TimelineEntry =
  | { kind: 'meeting'; start: string; end: string; title: string }
  | {
      kind: 'block'; start: string; end: string; minutes: number
      state: 'past' | 'current' | 'future'
      itemId: number | null; reason: 'focus' | 'deadline' | null; continued: boolean
    }
export interface DayTimeline {
  entries: TimelineEntry[]         // 시작 시각 오름차순
  freeMinutesLeft: number
  focusItemId: number | null
  unplacedDeadlineItemIds: number[]
}

export interface TodayPayload {
  logicalDate: string
  plan: DailyPlan | null
  items: PlanItem[]                // suggested·dismissed 포함 전부. rank 순 정렬
  timeline: DayTimeline
  events: AssistantEvent[]         // 오늘 논리 날짜의 이벤트
  settings: AssistantSettings
  missingWrapupDate: string | null
  aiAvailable: boolean; jiraConnected: boolean; calendarConnected: boolean; jiraTruncated: boolean
  lastErrors: string[]             // 마지막 수집에서 실패한 출처의 사용자용 문구
  recovery: RecoveryState          // 맥락 복구 진행·실패 상태 (부록 F.6)
}
export interface AssistantChangedEvent { date: string; reason: 'refresh' | 'briefing' | 'day' | 'recovery' | 'command' | 'meeting' }
export interface AssistantNavigateEvent { view: 'today'; focus?: { kind: 'inbox' | 'item' | 'briefing' | 'timeline' | 'meeting'; id?: string } }

// ── MVP2 (부록 E.6.1) ──
export type RefreshMode = 'full' | 'local' | 'calendar' | 'jira'

export interface SourceCheckTimes { calendarAt: number | null; jiraAt: number | null }   // epoch ms. 마지막 확인 대상 시각

export interface RefreshDecisionInput {
  nowMs: number
  settings: Pick<AssistantSettings, 'enabled' | 'refreshCalendarMin' | 'refreshJiraMin'>
  hasActivePlan: boolean
  inFlight: boolean            // 자동 최신화가 진행 중이다
  times: SourceCheckTimes
  wake: boolean                // resume·unlock-screen 에서 불렀다
}

export interface NotifyContext { refreshNotify: boolean; inMeeting: boolean }
export type PlanUpdateNoticeKind = 'slot' | 'urgent'
export interface PlanUpdateNotice {
  kind: PlanUpdateNoticeKind
  eventKey: string             // 'plan_update:<date>:<HHmm>' | 'plan_update:<date>:urgent:<candidate_id>'
  refId: string                // '<HHmm>' | 'urgent:<candidate_id>'
  title: string
  body: string
  focus: NonNullable<AssistantNavigateEvent['focus']>
}
export interface SentPlanUpdateNotice extends PlanUpdateNotice { eventId: number }
export interface NoticeInput {
  diff: RefreshDiff; summary: RefreshSummary; after: DayTimeline; items: PlanItem[]   // items 는 갱신 후 항목
  today: string; nowHHmm: string; ctx: NotifyContext
}
export type PlanUpdateRecord = RefreshSummary & { notified: PlanUpdateNoticeKind[] }   // 변경 기록 행 payload
export interface AutoRefreshOutcome { today: TodayPayload; notices: SentPlanUpdateNotice[] }

export interface TrayPlanItem { id: number; title: string; rank: number | null; status: PlanItemStatus; isFocus: boolean }
export interface TrayAssistant {
  logicalDate: string
  status: 'none' | 'active' | 'closed'
  startedAt: string | null     // 'HH:mm'
  items: TrayPlanItem[]        // 활성 항목 rank 순 상위 3건
  activeCount: number; doneCount: number
  suggestedCount: number; urgentSuggestedCount: number
  freeMinutesLeft: number
}

// ── MVP3 (부록 F) ──
export type RecoveryTriggerReason = 'gap' | 'monday' | 'manual'

export type RecoveryLastPlan = Pick<DailyPlan, 'id' | 'plan_date' | 'started_at' | 'closed_at' | 'wrapup_note' | 'wrapup_at'>

export interface RecoveryContext {
  today: string                 // 논리 날짜
  weekday: number               // today 의 요일. 0=일 … 6=토
  lastPlan: RecoveryLastPlan | null
  gapDays: number | null        // daysBetween(lastPlan.plan_date, today). lastPlan 이 null 이면 null
  since: string                 // 수집 기준 시각 'YYYY-MM-DD HH:mm:ss'
  sinceDate: string             // since 의 날짜
  jiraDays: number              // 1~14
}

export type RecoveryEntityType = 'project' | 'task' | 'todo'
export interface RecoveryActivityGroup {
  entityType: RecoveryEntityType
  entityId: number | null
  name: string                  // 마지막 entity_name. 없으면 원본 이름. 그래도 없으면 '(이름 없음)'
  actions: string[]             // 시각순. 중복 없음
  count: number
  firstAt: string               // 로컬 'YYYY-MM-DD HH:mm:ss'
  lastAt: string
  deleted: boolean
}
export interface RecoveryMeeting {
  meetingId: number; title: string; startedAt: string; projectName: string | null
  tldr: string | null           // 300자
  openActionItems: string[]     // todo_id 없는 항목 text. 최대 5건
  openActionCount: number
}
export interface RecoveryTodoDone { id: number; title: string; completedAt: string }
export interface RecoveryJiraIssue {
  key: string; summary: string; status: string; statusCategory: JiraCategory
  priority: string | null; duedate: string | null
  updatedLocal: string | null   // 로컬 'YYYY-MM-DD HH:mm:ss'
  url: string | null
}
export interface RecoveryLocalInput {
  wrapupNote: string | null         // gapDays <= 7 일 때만. 아니면 null
  unfinishedItems: PlanItem[]       // 마지막 계획의 planned·in_progress·deferred. rank 순. 최대 20
  activity: RecoveryActivityGroup[] // lastAt 내림차순. 최대 50
  meetings: RecoveryMeeting[]       // startedAt 내림차순. 최대 10
  completedTodos: RecoveryTodoDone[] // completedAt 내림차순. 최대 50
}
export interface RecoveryInput extends RecoveryLocalInput {
  ctx: RecoveryContext
  jira: RecoveryJiraIssue[] | null  // null 이면 미연결 또는 실패. updated 내림차순. 최대 50
  jiraConnected: boolean
  jiraTruncated: boolean
  errors: string[]
}

export type RecoverySectionKey = 'last_day' | 'unfinished' | 'done' | 'meetings' | 'jira' | 'errors'
export interface RecoverySection { key: RecoverySectionKey; title: string; lines: string[] }

export interface RecoveryState { inFlight: boolean; error: string | null }

// ── 명령 입력 (부록 G) ──
export type CommandStatus = 'planned' | 'in_progress' | 'done' | 'deferred' | 'dropped'
export type CommandOp =
  | { kind: 'set_status'; itemId: number; status: CommandStatus; note: string | null }
  | { kind: 'focus'; itemId: number }
  | { kind: 'accept_suggestion'; itemId: number }
  | { kind: 'dismiss_suggestion'; itemId: number }
  | { kind: 'add_candidate'; candidateId: string }
  | { kind: 'add_manual'; title: string; dueDate: string | null }
  | { kind: 'regenerate_briefing'; instruction: string | null }
  | { kind: 'unsupported'; reason: string }

export interface CommandItemRef {
  itemId: number; candidateId: string; title: string; status: PlanItemStatus
  jiraKey: string | null; dueDate: string | null; rank: number | null
}
export interface CommandCandidateRef {
  candidateId: string; title: string; source: CandidateSource; jiraKey: string | null; dueDate: string | null
}
export interface CommandContext {
  today: string
  scopeItemId: number | null
  items: CommandItemRef[]           // dismissed 제외. scope 모드면 범위 항목 1건
  candidates: CommandCandidateRef[] // 계획 항목이 아닌 후보. scope 모드면 빈 배열. 최대 50건
  briefingInstruction: string | null
}

export interface CommandPreviewOp { op: CommandOp; label: string; executable: boolean }
export interface CommandInterpretation {
  text: string                      // 공백 정리한 명령 원문
  scopeItemId: number | null
  ops: CommandPreviewOp[]
  source: 'llm' | 'rules'
  error: string | null              // LLM 실패 사유. 성공이거나 LLM 을 건너뛰면 null
  dropped: number                   // 검증에서 뺀 조작 수
}
export interface CommandOpResult { op: CommandOp; label: string; ok: boolean; error: string | null }
export interface CommandApplyOutcome { today: TodayPayload; results: CommandOpResult[]; applied: number; failed: number }
export interface CommandLlmInput { ctx: CommandContext; text: string }

// ── MVP5 (부록 I) ──
export interface MeetingRef { id: string; title: string; startAt: string; endAt: string }   // 'YYYY-MM-DD HH:mm:ss'. 종일 제외
export interface MeetingDecisionInput {
  today: string; at: string                                   // at 은 'YYYY-MM-DD HH:mm:ss'
  settings: Pick<AssistantSettings, 'enabled' | 'meetingBriefingEnabled' | 'meetingLeadMin'>
  meetings: MeetingRef[]
  events: AssistantEvent[]
}
export type DueMeetingBriefing =
  | { action: 'send'; meeting: MeetingRef; eventKey: string; scheduledAt: string; late: boolean }
  | { action: 'skip'; meeting: MeetingRef; eventKey: string; scheduledAt: string; reason: 'window' | 'cap' }

export interface MeetingProjectRef { id: number; name: string }
export interface MeetingPastRef { meetingId: number; title: string; startedAt: string; tldr: string | null; openActionItems: string[] }
export interface MeetingContext {
  meeting: MeetingRef
  projects: MeetingProjectRef[]            // 최대 3
  pastMeetings: MeetingPastRef[]           // 최대 3. startedAt 내림차순
  openActionItems: string[]                // 최대 10
  relatedItems: Pick<PlanItem, 'id' | 'title' | 'status'>[]   // 최대 5
  errors: string[]
}
export type MeetingLlmStatus = 'off' | 'pending' | 'done' | 'failed'
export interface MeetingBriefingPayload {
  meeting: MeetingRef
  title: string; body: string              // 알림 문구
  projects: MeetingProjectRef[]
  hasContext: boolean
  ruleMarkdown: string
  llmStatus: MeetingLlmStatus
  llmMarkdown: string | null; llmModel: string | null; llmAt: string | null; llmError: string | null
}
export interface SentMeetingNotice {
  eventId: number; title: string; body: string
  focus: { kind: 'meeting'; id: string }
}

// ── 부록 J ──
export type WorkType = 'qa' | 'sus' | 'trd' | 'prd' | 'etc'

export interface WorkClassifyInput {
  source: CandidateSource; jiraKey: string | null
  title: string; parentSummary: string | null; projectName: string | null; issueType: string | null
}
export interface WorkClassification { workType: WorkType; workVersion: string | null }

// ── 아침 자동 동기화 (A54) ──
export type MorningSyncPartName = 'release' | 'project'
// deferred 는 사용자가 수동 미리보기를 검토 중이라 미룬 상태다. 시도로 세지 않는다
export type MorningSyncPartStatus = 'running' | 'ok' | 'skipped' | 'failed' | 'deferred'
export interface MorningSyncPart {
  status: MorningSyncPartStatus
  attempts: number                 // 센 시도 수. 오프라인·deferred 는 세지 않는다
  startedAt: string | null         // 마지막 시도 시작 'YYYY-MM-DD HH:mm:ss'
  finishedAt: string | null        // 마지막 시도 끝. running 이면 null
  error: string | null             // failed 의 사용자용 문구. skipped 이면 건너뛴 이유
  newCount: number                 // 새 항목 수. 릴리스는 새 릴리스, 싱크업은 새 프로젝트
  updatedCount: number             // 갱신한 항목 수
  reviewCount: number              // 싱크업만. 자동 적용하지 않고 확인이 필요한 항목 수 (R11)
  failedCount: number              // 릴리스만. 일부 버전의 실패 수
}
export interface MorningSyncPayload {
  date: string                     // 논리 날짜
  release: MorningSyncPart | null  // null 이면 아직 시도하지 않았다
  project: MorningSyncPart | null
}
export interface MorningSyncDecisionInput {
  today: string                    // 논리 날짜
  calendarDate: string             // now 의 달력 날짜. 논리 날짜와 다르면 새벽이다
  nowHHmm: string
  at: string                       // 'YYYY-MM-DD HH:mm:ss'
  settings: Pick<AssistantSettings, 'morningSyncEnabled' | 'morningSyncTime'>
  inFlight: boolean
  payload: MorningSyncPayload | null   // 오늘 행의 payload. 행이 없으면 null
}
export interface MorningSyncStatus {
  enabled: boolean
  at: string                       // 설정 시각 'HH:mm'
  inFlight: boolean
  date: string | null              // 마지막 행의 논리 날짜. 행이 없으면 null
  release: MorningSyncPart | null
  project: MorningSyncPart | null
}
