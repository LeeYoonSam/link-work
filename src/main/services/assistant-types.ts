export type AiModelName = 'opus' | 'sonnet' | 'haiku'

// 'checkin' 은 제거된 작업 경계 체크인의 과거 행이다 (부록 L). 새 행을 만들지 않는다
export type AssistantEventKind = 'start_nudge' | 'plan_update' | 'checkin' | 'meeting_briefing' | 'command' | 'morning_sync' | 'today_briefing'
export type AssistantEventStatus = 'sent' | 'late' | 'skipped' | 'failed' | 'logged'
export interface AssistantEvent {
  id: number; event_key: string; kind: AssistantEventKind; plan_date: string; scheduled_at: string
  fired_at: string | null; status: AssistantEventStatus; ref_id: string | null; payload: string | null
  response: string | null; responded_at: string | null; created_at: string
}
export type NewAssistantEvent = Pick<AssistantEvent, 'event_key' | 'kind' | 'plan_date' | 'scheduled_at' | 'fired_at' | 'status' | 'ref_id' | 'payload'>

// 하루 계획 시절의 설정(startNudge·workEnd·planSize·jiraScope·refresh*·completeOriginOnDone)은 2026-11-19 에 뺐다.
// app_settings 의 옛 행은 남지만 읽지 않는다
export interface AssistantSettings {
  enabled: boolean; dayRollover: string
  llmEnabled: boolean; llmModel: AiModelName   // 회의 전 브리핑의 AI 본문
  openAtLogin: boolean
  meetingLeadMin: number
  startView: 'today' | 'projects' | 'calendar'   // 첫 화면 (부록 C, A24)
  meetingBriefingEnabled: boolean              // 회의 전 브리핑 (부록 I)
  morningSyncEnabled: boolean                  // 아침 자동 동기화 (A54)
  morningSyncTime: string                        // 아침 자동 동기화 시각 'HH:mm'
}

// 오늘 화면(assistant:getToday)이 읽는 값. 하루 계획·타임라인·맥락 복구 필드는 2026-11-19 에 뺐다
export interface TodayPayload {
  events: AssistantEvent[]         // 오늘 논리 날짜의 이벤트(회의 전 브리핑 카드)
  settings: AssistantSettings
  aiAvailable: boolean; calendarConnected: boolean
}
export interface AssistantChangedEvent { date: string; reason: 'meeting' }
export interface AssistantNavigateEvent { view: 'today'; focus?: { kind: 'inbox' | 'item' | 'briefing' | 'timeline' | 'meeting'; id?: string } }

// 명령 입력(부록 G)·최신화 알림·트레이 계획 요약 타입은 부록 O(오늘 대시보드 개편)에서 기능과 함께 제거됐다

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

export interface MeetingPastRef { meetingId: number; title: string; startedAt: string; tldr: string | null; openActionItems: string[] }
export interface MeetingContext {
  meeting: MeetingRef
  pastMeetings: MeetingPastRef[]           // 최대 3. startedAt 내림차순
  openActionItems: string[]                // 최대 10
  errors: string[]
}
export type MeetingLlmStatus = 'off' | 'pending' | 'done' | 'failed'
export interface MeetingBriefingPayload {
  meeting: MeetingRef
  title: string; body: string              // 알림 문구
  hasContext: boolean
  ruleMarkdown: string
  llmStatus: MeetingLlmStatus
  llmMarkdown: string | null; llmModel: string | null; llmAt: string | null; llmError: string | null
}
export interface SentMeetingNotice {
  eventId: number; title: string; body: string
  focus: { kind: 'meeting'; id: string }
}

// ── 아침 자동 동기화 (A54) ──
export type MorningSyncPartName = 'release'
// deferred 는 미룬 상태다. 시도로 세지 않는다. 지금 릴리스 파트는 쓰지 않지만 옛 행을 읽으려고 남긴다
export type MorningSyncPartStatus = 'running' | 'ok' | 'skipped' | 'failed' | 'deferred'
export interface MorningSyncPart {
  status: MorningSyncPartStatus
  attempts: number                 // 센 시도 수. 오프라인·deferred 는 세지 않는다
  startedAt: string | null         // 마지막 시도 시작 'YYYY-MM-DD HH:mm:ss'
  finishedAt: string | null        // 마지막 시도 끝. running 이면 null
  error: string | null             // failed 의 사용자용 문구. skipped 이면 건너뛴 이유
  newCount: number                 // 새 릴리스 수
  updatedCount: number             // 갱신한 항목 수
  reviewCount: number              // 확인이 필요한 항목 수. 릴리스 파트는 늘 0
  failedCount: number              // 릴리스만. 일부 버전의 실패 수
}
export interface MorningSyncPayload {
  date: string                     // 논리 날짜
  release: MorningSyncPart | null  // null 이면 아직 시도하지 않았다
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
}
