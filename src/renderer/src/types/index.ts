// 프로젝트 우선순위. null(미지정)이면 우선순위 그룹 밖으로 밀려 상태 순으로만 정렬된다.
export type ProjectPriority = 'now' | 'next' | 'later'

/**
 * 프로젝트 진행 상태.
 *
 * 'on_hold'(중단)만 수동 전용이다 — 날짜 기반 자동 계산(utils/projectStatus.ts)은 이 값을
 * 절대 반환하지 않고, status_manual=1로 고정할 때만 들어간다. 재개는 status_manual=0으로
 * 되돌려 자동 계산에 다시 맡긴다. 진행 중 목록에서는 빠진다(utils/projectOrder.ts의
 * ACTIVE_STATUSES 미포함).
 */
export type ProjectStatus =
  | 'scheduled'
  | 'development'
  | 'qa_pending'
  | 'qa'
  | 'deploy_pending'
  | 'deploy'
  | 'on_hold'
  | 'completed'
  | 'cancelled'

export interface Project {
  id: number
  name: string
  description: string | null
  dev_start_date: string
  dev_end_date: string
  qa_start_date: string
  qa_end_date: string
  deploy_date: string
  deploy_version: string | null
  status: ProjectStatus
  status_manual: number
  // 우선순위와 같은 레벨 안에서의 수동 순서. 구버전 DB·테스트 픽스처가 값을 갖지
  // 않을 수 있어 옵셔널이다 — 정렬은 utils/projectOrder.ts가 미지정을 흡수한다.
  priority?: ProjectPriority | null
  sort_order?: number
  created_at: string
  updated_at: string
}

export interface Task {
  id: number
  project_id: number
  // 상위 작업 id. null이면 최상위 작업. 깊이는 1단계만(상위는 항상 최상위).
  parent_task_id: number | null
  name: string
  start_date: string | null
  end_date: string | null
  status: 'pending' | 'in_progress' | 'done'
  sort_order: number
  created_at: string
}

export interface ProjectInput {
  name: string
  description?: string
  dev_start_date: string
  dev_end_date: string
  qa_start_date?: string
  qa_end_date?: string
  deploy_date?: string
  deploy_version?: string
  status?: string
  status_manual?: number
  priority?: ProjectPriority | null
  sort_order?: number
}

export interface TaskInput {
  project_id: number
  parent_task_id?: number | null
  name: string
  start_date?: string
  end_date?: string
  status?: string
  sort_order?: number
}

export interface CalculatedDates {
  qaStart: string
  qaEnd: string
  deployDate: string
}

export interface ProjectAPI {
  create: (input: ProjectInput) => Promise<{ id: number }>
  list: (status?: string) => Promise<Project[]>
  get: (id: number) => Promise<Project>
  update: (id: number, input: Partial<ProjectInput>) => Promise<Project>
  delete: (id: number) => Promise<{ success: boolean }>
  calculateDates: (devEndDate: string) => Promise<CalculatedDates>
  lastDates: () => Promise<{ devStartDate: string; devEndDate: string } | null>
  reorder: (items: { id: number; sort_order: number }[]) => Promise<{ success: boolean }>
}

export interface TaskAPI {
  create: (input: TaskInput) => Promise<{ id: number }>
  list: (projectId: number) => Promise<Task[]>
  listByProjectIds: (projectIds: number[]) => Promise<Record<number, Task[]>>
  update: (id: number, input: Partial<TaskInput>) => Promise<Task>
  delete: (id: number) => Promise<{ success: boolean }>
}

export interface TrayAPI {
  getData: () => Promise<unknown>
  openApp: () => Promise<void>
  // 트레이 '오늘 보기'. 메인 창을 오늘 화면으로 연다 (부록 E.4.3)
  openToday: () => Promise<void>
  onData: (callback: (data: unknown) => void) => () => void
}

export interface CalendarEvent {
  id: string
  summary: string
  description?: string
  start: string
  end: string
  allDay: boolean
  location?: string
  htmlLink?: string
}

export interface CalendarStatus {
  connected: boolean
  hasCredentials: boolean
}

export interface CalendarAPI {
  auth: () => Promise<{ success: boolean; error?: string }>
  getEvents: (weekStartISO?: string) => Promise<CalendarEvent[]>
  refresh: (weekStartISO?: string) => Promise<CalendarEvent[]>
  disconnect: () => Promise<{ success: boolean }>
  status: () => Promise<CalendarStatus>
  saveSettings: (clientId: string, clientSecret: string) => Promise<{ success: boolean }>
}

export interface Document {
  id: number
  name: string
  url: string
  type: 'link' | 'file'
  description: string | null
  project_id: number | null
  project_name?: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface DocumentInput {
  name: string
  url: string
  type: 'link' | 'file'
  description?: string
  project_id?: number | null
  sort_order?: number
}

export interface DocumentAPI {
  create: (input: DocumentInput) => Promise<{ id: number }>
  list: (projectId?: number | null) => Promise<Document[]>
  listAll: () => Promise<Document[]>
  update: (id: number, input: Partial<DocumentInput>) => Promise<Document>
  delete: (id: number) => Promise<{ success: boolean }>
  reorder: (items: { id: number; sort_order: number }[]) => Promise<{ success: boolean }>
  open: (url: string, type: 'link' | 'file') => Promise<{ success: boolean }>
}

export type VariableViewType = 'general' | 'secret'

export interface Variable {
  id: number
  key: string
  value: string
  description: string | null
  view_type: VariableViewType
  sort_order: number
  created_at: string
  updated_at: string
}

export interface VariableInput {
  key: string
  value: string
  description?: string
  view_type?: VariableViewType
  sort_order?: number
}

export interface VariableAPI {
  create: (input: VariableInput) => Promise<{ id: number }>
  list: () => Promise<Variable[]>
  update: (id: number, input: Partial<VariableInput>) => Promise<Variable>
  delete: (id: number) => Promise<{ success: boolean }>
  reorder: (items: { id: number; sort_order: number }[]) => Promise<{ success: boolean }>
}

export interface Memo {
  id: number
  content: string
  is_archived: number
  is_important: number
  color: string
  category_id: number | null
  created_at: string
  updated_at: string
}

export interface MemoInput {
  content: string
  color?: string
  is_important?: number
  category_id?: number | null
}

export interface MemoAPI {
  create: (input: MemoInput) => Promise<{ id: number }>
  list: (archived?: boolean) => Promise<Memo[]>
  listImportant: () => Promise<Memo[]>
  update: (id: number, input: Partial<MemoInput>) => Promise<Memo>
  archive: (id: number) => Promise<{ success: boolean }>
  restore: (id: number) => Promise<{ success: boolean }>
  toggleImportant: (id: number) => Promise<{ success: boolean; is_important: number }>
  delete: (id: number) => Promise<{ success: boolean }>
}

export interface MemoCategory {
  id: number
  name: string
  color: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface MemoCategoryInput {
  name: string
  color?: string
  sort_order?: number
}

export interface MemoCategoryAPI {
  create: (input: MemoCategoryInput) => Promise<{ id: number }>
  list: () => Promise<MemoCategory[]>
  update: (id: number, input: Partial<MemoCategoryInput>) => Promise<MemoCategory>
  delete: (id: number) => Promise<{ success: boolean }>
}

export interface ActivityLog {
  id: number
  entity_type: 'project' | 'task' | 'document' | 'variable' | 'memo'
  entity_id: number | null
  entity_name: string | null
  action: 'create' | 'update' | 'delete' | 'archive' | 'restore'
  details: string | null
  created_at: string
}

export interface WeeklySummary {
  entity_type: string
  action: string
  count: number
}

export interface DailyStat {
  date: string
  entity_type: string
  count: number
}

export interface WeeklyTrend {
  week: string
  entity_type: string
  count: number
}

export interface ReportAPI {
  weeklyActivities: (weekStart: string, weekEnd: string) => Promise<ActivityLog[]>
  weeklySummary: (weekStart: string, weekEnd: string) => Promise<WeeklySummary[]>
  dailyStats: (weekStart: string, weekEnd: string) => Promise<DailyStat[]>
  weeklyTrend: (weeks: number) => Promise<WeeklyTrend[]>
}

// TODO types
export type TodoPriority = 'low' | 'medium' | 'high'

export interface TodoTag {
  id: number
  name: string
  color: string
  created_at: string
  updated_at: string
}

export interface Todo {
  id: number
  title: string
  priority: TodoPriority
  due_date: string | null
  due_reminder: number
  is_completed: number
  completed_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
  tags?: TodoTag[]
}

export interface TodoInput {
  title: string
  priority?: TodoPriority
  due_date?: string | null
  due_reminder?: number
  notes?: string | null
  tag_ids?: number[]
}

export interface TodoTagInput {
  name: string
  color?: string
}

export interface TodoHistory {
  id: number
  todo_id: number
  action: 'complete' | 'restore' | 'create' | 'update' | 'delete'
  snapshot: string
  created_at: string
}

export interface TodoAPI {
  create: (input: TodoInput) => Promise<{ id: number }>
  list: (completed?: boolean) => Promise<Todo[]>
  listByTag: (tagId: number, completed?: boolean) => Promise<Todo[]>
  update: (id: number, input: Partial<TodoInput>) => Promise<Todo>
  complete: (id: number) => Promise<{ success: boolean }>
  setCompletedAt: (id: number, completedAt: string) => Promise<{ success: boolean }>
  restore: (id: number) => Promise<{ success: boolean }>
  delete: (id: number) => Promise<{ success: boolean }>
  history: (todoId: number) => Promise<TodoHistory[]>
  listActive: () => Promise<Todo[]>
}

export interface TodoTagAPI {
  create: (input: TodoTagInput) => Promise<{ id: number }>
  list: () => Promise<TodoTag[]>
  update: (id: number, input: Partial<TodoTagInput>) => Promise<TodoTag>
  delete: (id: number) => Promise<{ success: boolean }>
}

// AI Chat types

// 채팅별 데이터 작성 모드: 읽기 전용 | 승인 후 쓰기 | 자동 모드(기본) | 계획 모드.
// plan 은 조회만 하고 계획을 먼저 보여 준다. 사용자가 계획을 승인하면 auto 또는 ask 로 바뀐다.
export type AiWriteMode = 'readonly' | 'ask' | 'auto' | 'plan'

// 오늘 화면 비서(AssistantSettings.llmModel)의 모델 선택지
export type AiModelChoice = 'opus' | 'sonnet' | 'haiku'

// AI 대화 모델 선택지 (앱 전역 설정, 다음 메시지부터 적용).
// main 이 Claude Code 의 supportedModels() 로 라벨을 정한다. 예: value 'fable', label 'Fable 5.1'.
export interface AiChatModelOption {
  value: string
  label: string
  description: string
}

export interface AiChat {
  id: number
  title: string
  session_id: string | null
  write_mode: AiWriteMode
  created_at: string
  updated_at: string
  message_count?: number
  last_message?: string | null
}

export type AiMessageRole = 'user' | 'assistant'

export interface AiMessage {
  id: number
  chat_id: number
  role: AiMessageRole
  content: string
  meta: string | null
  created_at: string
}

// 사용자 메시지의 이미지 첨부 (ai_messages.meta JSON의 attachments 항목)
// file: 저장 파일명 — linkwork-media://attachment/<file> 로 표시
export interface AiAttachmentMeta {
  file: string
  name: string
  type: string
}

// ai:send로 전달하는 첨부 이미지 원본 바이트
export interface AiAttachmentInput {
  name: string
  type: string
  bytes: ArrayBuffer
}

export interface AiNotionStatus {
  connected: boolean
}

export interface AiBitbucketStatus {
  connected: boolean
  email: string | null
}

export type AiBitbucketSaveResult =
  | { success: true; account: string }
  | { success: false; error: string }

// 쓰기 도구 실행 전 사용자 승인 요청 (HITL)
// current: 수정(update) 도구의 변경 전 현재 값 (생성 도구는 null)
// kind: 'plan' 이면 계획 승인 요청이다. name 'ExitPlanMode', input { plan: 마크다운 }.
export interface AiApprovalRequest {
  requestId: string
  name: string
  label: string
  input: Record<string, unknown>
  current?: Record<string, unknown> | null
  kind?: 'write' | 'fetch' | 'plan'
}

// 계획 승인 시 바꿀 쓰기 모드
export interface AiApproveOptions {
  mode?: 'auto' | 'ask'
}

export type AiStreamEvent =
  | { chatId: number; event: 'start' }
  | { chatId: number; event: 'text'; delta: string }
  | { chatId: number; event: 'tool'; name: string; label: string }
  | { chatId: number; event: 'approval'; request: AiApprovalRequest }
  | { chatId: number; event: 'approval_resolved'; requestId: string; approved: boolean }
  | { chatId: number; event: 'mode_changed'; mode: AiWriteMode }
  | { chatId: number; event: 'done'; message?: AiMessage; cancelled?: boolean }
  | { chatId: number; event: 'error'; error: string }

export interface AiStatus {
  available: boolean
  error?: string
  warning?: string
}

export interface AiProgress {
  running: boolean
  text: string
  toolLabel: string | null
  pendingApproval: AiApprovalRequest | null
}

export interface AiAPI {
  chatList: () => Promise<AiChat[]>
  chatCreate: () => Promise<{ id: number }>
  chatDelete: (id: number) => Promise<{ success: boolean }>
  chatRename: (id: number, title: string) => Promise<{ success: boolean }>
  messages: (chatId: number) => Promise<AiMessage[]>
  send: (
    chatId: number,
    text: string,
    attachments?: AiAttachmentInput[]
  ) => Promise<{ started: boolean; error?: string }>
  cancel: (chatId: number) => Promise<{ success: boolean }>
  progress: (chatId: number) => Promise<AiProgress>
  status: () => Promise<AiStatus>
  notionStatus: () => Promise<AiNotionStatus>
  notionSaveToken: (token: string) => Promise<{ success: boolean; workspace?: string; error?: string }>
  notionDisconnect: () => Promise<{ success: boolean }>
  approve: (
    requestId: string,
    approved: boolean,
    options?: AiApproveOptions
  ) => Promise<{ success: boolean }>
  setChatWriteMode: (chatId: number, mode: AiWriteMode) => Promise<{ success: boolean }>
  getModel: () => Promise<string>
  setModel: (model: string) => Promise<{ success: boolean; model: string }>
  // 첫 호출은 main 의 모델 탐침 때문에 수 초 걸릴 수 있다
  getModelOptions: () => Promise<AiChatModelOption[]>
  bitbucketStatus: () => Promise<AiBitbucketStatus>
  bitbucketSaveToken: (email: string, token: string) => Promise<AiBitbucketSaveResult>
  bitbucketDisconnect: () => Promise<{ success: true }>
  onStream: (callback: (event: AiStreamEvent) => void) => () => void
  onDataChanged: (callback: (data: { entity: string }) => void) => () => void
}

// ── 인식 보조 장치 (용어집 · 구성원) — docs/MEETING_RECORDING.md ──
// 사용자가 직접 입력하는 값만 담는다. 이 기기의 로컬 DB에만 저장되며
// 전사 힌트(whisper initial_prompt) · 전사 후 표기 교정 · AI 요약 프롬프트에 쓰인다.

export interface GlossaryEntry {
  id: number
  // 정답 표기
  term: string
  // 오인식/변형 표기 — 전사 후 term으로 되돌리는 데 쓰인다
  aliases: string[]
  // 설명(요약 프롬프트 힌트). 선택
  note: string | null
  // 높을수록 initial_prompt에 먼저 들어간다
  priority: number
  enabled: number
  // null이면 전역, 값이 있으면 그 프로젝트의 회의에서만 쓰인다
  project_id: number | null
  created_at: string
  updated_at: string
}

export interface Member {
  id: number
  name: string
  // 호칭/영문명 등
  aliases: string[]
  role: string | null
  enabled: number
  sort_order: number
  created_at: string
  updated_at: string
}

// 회의에 지정된 참석자 (meeting_attendees JOIN meeting_members)
export interface Attendee {
  member_id: number
  name: string
  role: string | null
}

export interface RecognitionAidsAPI {
  listGlossary: () => Promise<GlossaryEntry[]>
  upsertGlossary: (input: {
    id?: number
    term: string
    aliases?: string[]
    note?: string | null
    priority?: number
    enabled?: boolean
    project_id?: number | null
  }) => Promise<{ id: number }>
  removeGlossary: (id: number) => Promise<{ success: boolean }>
  // "정답 | 별칭1, 별칭2 | 메모" 줄 형식 일괄 가져오기
  importGlossaryText: (
    text: string
  ) => Promise<{ added: number; updated: number; skipped: number }>
  listMembers: () => Promise<Member[]>
  upsertMember: (input: {
    id?: number
    name: string
    aliases?: string[]
    role?: string | null
    enabled?: boolean
    sort_order?: number
  }) => Promise<{ id: number }>
  removeMember: (id: number) => Promise<{ success: boolean }>
}

// ── 회의 녹음 (Meeting Recording) — docs/MEETING_RECORDING.md ──

export type MeetingStatus =
  | 'recording'
  | 'processing'
  | 'transcribed'
  | 'summarized'
  | 'failed'
export type MeetingSource = 'mic' | 'mic+system'
// 녹음 종류 — 요약 스키마와 상세 UI가 이 값으로 갈린다
export type MeetingKind = 'meeting' | 'interview'

export interface Meeting {
  id: number
  title: string
  kind: MeetingKind
  status: MeetingStatus
  audio_path: string | null
  audio_mime: string
  duration_ms: number
  language: string
  source: MeetingSource
  expected_speakers: number | null
  // 무음 컷편집: 처리 시 수행할지(녹음 시작 시 선택)
  compact_audio: number
  // 컷편집이 실제로 적용됐는지 (1이면 audio_path의 WAV가 이미 잘린 파일)
  audio_compacted: number
  // 컷편집 전 길이. audio_compacted=0이면 null
  original_duration_ms: number | null
  // 이 회의를 처리한 파이프라인 버전. 0=구 파이프라인/미처리,
  // 2=무음 컷편집·용어집·참석자 힌트 파이프라인.
  // 요약 재생성 시 "새 파이프라인으로 재분석할지"를 이 값으로 판단한다.
  pipeline_version: number
  project_id: number | null
  calendar_event_id: string | null
  calendar_event_title: string | null
  error: string | null
  started_at: string
  created_at: string
  updated_at: string
}

export interface MeetingSpeaker {
  id: number
  meeting_id: number
  speaker_key: string
  label: string
  display_name: string | null
  color: string
  sort_order: number
}

export interface MeetingSegment {
  id: number
  meeting_id: number
  start_ms: number
  end_ms: number
  speaker_id: number | null
  text: string
  confidence: number | null
  speaker_corrected: number
  text_corrected: number
  sort_order: number
}

export interface MeetingCut {
  id: number
  meeting_id: number
  type: 'silence' | 'filler' | 'manual'
  start_ms: number
  end_ms: number
  enabled: number
  auto: number
  note: string | null
}

export interface ActionItem {
  text: string
  assignee?: string | null
  due?: string | null
  speaker_id?: number | null
  source_segment_id?: number | null
  todo_id?: number | null
}

// ── 면접 기록 (kind='interview') 전용 요약 구조 ──
// 점수·합불 판단을 담지 않는다. 실제 발언과 확인이 필요한 지점만 기록한다.
export interface InterviewQaPair {
  question: string
  answer_summary: string
  // 질문 시작 위치(ms). null이면 재생 점프 불가.
  start_ms: number | null
  quote?: string | null
}

export interface InterviewCompetency {
  topic: string
  evidence: string[]
  note?: string | null
}

export interface MeetingSummary {
  id: number
  meeting_id: number
  // 회의: TL;DR / 면접: 면접 개요
  tldr: string | null
  key_points: string[]
  // 회의 전용 3분류 (면접에서는 빈 배열)
  decisions: string[]
  action_items: ActionItem[]
  next_steps: string[]
  // 면접 전용 4분류 (회의에서는 빈 배열)
  qa_pairs: InterviewQaPair[]
  competencies: InterviewCompetency[]
  follow_ups: string[]
  fact_checks: string[]
  model: string | null
  generated_at: string
}

export interface MeetingDetail {
  meeting: Meeting
  speakers: MeetingSpeaker[]
  segments: MeetingSegment[]
  cuts: MeetingCut[]
  summary: MeetingSummary | null
  attendees: Attendee[]
}

export interface RecordingStreamEvent {
  meetingId: number
  // 'cancelled' — 사용자 취소로 파이프라인이 중단됨(에러와 구분되는 중립 종료)
  phase:
    // 'compact' — 전사 전에 긴 무음 구간을 잘라내는 단계
    | 'compact'
    | 'transcribe'
    | 'diarize'
    | 'vad'
    | 'merge'
    | 'summarize'
    | 'done'
    | 'error'
    | 'cancelled'
  progress?: number
  message?: string
  error?: string
}

// 화자분리용 L(mic)/R(system) 채널 에너지 envelope (utils/audio.ts에서 추출)
export interface ChannelEnergy {
  hopMs: number
  left: number[]
  right: number[]
}

// ── 회의록 (요약 완료된 회의를 문서처럼 열람) — docs/MEETING_NOTES.md ──
export interface MeetingNoteFilter {
  q?: string                      // 검색어(공백 trim, 빈 문자열은 무시)
  kind?: 'all' | MeetingKind      // 기본 'all'
  projectId?: number | null       // undefined·null=전체, 숫자=해당 프로젝트
}

export interface MeetingNoteItem {
  id: number
  title: string
  kind: MeetingKind
  started_at: string
  duration_ms: number
  project_id: number | null
  project_name: string | null
  tldr: string | null
  key_point_count: number
  decision_count: number
  action_item_count: number
  open_action_count: number       // action_items 중 todo_id가 없는 개수
  attendee_names: string[]        // meeting_attendees JOIN meeting_members 이름(없으면 [])
  generated_at: string            // 요약 생성 시각
}

export interface MeetingNotesAPI {
  list: (filter?: MeetingNoteFilter) => Promise<MeetingNoteItem[]>   // started_at DESC
  markdown: (id: number) => Promise<string>                           // 회의록 Markdown 문서 (없으면 '')
}

export interface RecordingAPI {
  list: () => Promise<Meeting[]>
  get: (id: number) => Promise<MeetingDetail | null>
  createDraft: (input: {
    title?: string
    source?: MeetingSource
    kind?: MeetingKind
    // 참석 인원(화자분리 클러스터 수). 미지정 시 면접=2, 회의=자동 추정(null).
    expected_speakers?: number | null
    // 참석자로 지정할 구성원 id 목록 (인원 수와 별개인 '누가' 들어왔는지의 명단)
    attendee_ids?: number[]
    // 처리 시 무음 구간 자동 제거 (기본 true)
    compact_audio?: boolean
  }) => Promise<{ id: number }>
  saveAudio: (
    id: number,
    bytes: ArrayBuffer,
    meta: { mime: string; durationMs: number },
    channelEnergy?: ChannelEnergy | null
  ) => Promise<{ path: string }>
  process: (
    id: number,
    opts?: { skipTranscribe?: boolean }
  ) => Promise<{ success: boolean; error?: string; transcribed?: boolean }>
  // 활성 파이프라인 취소. success=취소된 파이프라인이 있었는지 여부
  cancel: (id: number) => Promise<{ success: boolean }>
  summarize: (id: number) => Promise<{ success: boolean; error?: string }>
  rename: (id: number, title: string) => Promise<{ success: boolean }>
  remove: (id: number) => Promise<{ success: boolean }>
  updateSpeaker: (
    speakerId: number,
    input: { display_name?: string | null; color?: string; label?: string }
  ) => Promise<{ success: boolean }>
  reassignSegment: (segmentId: number, speakerId: number | null) => Promise<{ success: boolean }>
  updateSegmentText: (segmentId: number, text: string) => Promise<{ success: boolean }>
  addSpeaker: (
    meetingId: number,
    name: string
  ) => Promise<{ success: boolean; id?: number; existed?: boolean; error?: string }>
  mergeSpeakers: (
    meetingId: number,
    fromSpeakerId: number,
    intoSpeakerId: number
  ) => Promise<{ success: boolean }>
  toggleCut: (cutId: number, enabled: boolean) => Promise<{ success: boolean }>
  actionItemToTodo: (meetingId: number, index: number) => Promise<{ todo_id: number }>
  linkProject: (id: number, projectId: number | null) => Promise<{ success: boolean }>
  setExpectedSpeakers: (id: number, n: number | null) => Promise<{ success: boolean }>
  setAttendees: (meetingId: number, memberIds: number[]) => Promise<{ success: boolean }>
  // 녹음 시작 실패·취소 시 draft 행 삭제. status='recording'이고 오디오가 없는 행만 지운다.
  discardDraft: (id: number) => Promise<{ success: boolean }>
  onStream: (cb: (e: RecordingStreamEvent) => void) => () => void
}

// main → 렌더러 녹음 명령 (창 닫기/앱 종료 가드가 녹음 저장을 요청할 때)
export interface RecorderCommand {
  type: 'stop-and-save'
  requestId: string
  // true면 저장 후 전사·요약까지 진행, false면 저장만(앱 종료 직전)
  process: boolean
}

// 렌더러 녹음기 ↔ main 가드 브리지
export interface RecorderBridgeAPI {
  // active = 녹음기 상태가 'recording'|'paused'|'stopped'(저장 전)
  reportState: (s: { active: boolean; draftId: number | null }) => void
  onCommand: (handler: (cmd: RecorderCommand) => void) => () => void
  commandDone: (r: { requestId: string; success: boolean; error?: string }) => void
}

export interface ExportAPI {
  // 저장 다이얼로그를 띄워 마크다운을 .md 파일로 저장한다. 사용자가 취소하면 canceled=true.
  saveMarkdown: (
    content: string,
    defaultFileName: string
  ) => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>
}

// ── 릴리스 노트 (Jira 릴리스 동기화) — docs/RELEASE_NOTES.md ──

export interface ReleaseNote {
  id: number
  jira_project_key: string
  // 매칭 키는 이름이 아니라 불변 ID다 — Jira에서 버전 이름이 바뀌어도 연결이 끊기지 않는다
  jira_version_id: string
  version_name: string
  description: string | null
  released: number
  archived: number
  release_date: string | null
  start_date: string | null
  // NULL이면 아직 한 번도 동기화하지 않은 상태
  last_synced_at: string | null
  last_sync_error: string | null
  created_at: string
  updated_at: string
}

export interface ReleaseNoteItem {
  id: number
  release_note_id: number
  issue_key: string
  issue_type: string | null
  status: string | null
  resolution: string | null
  summary: string
  parent_key: string | null
  sort_order: number
}

/** 목록용 — 가져온 이슈 수를 덧붙인 형태 */
export interface ReleaseNoteSummary extends ReleaseNote {
  item_count: number
}

/** 상세용 */
export interface ReleaseNoteWithItems extends ReleaseNote {
  items: ReleaseNoteItem[]
}

export interface JiraConnectionStatus {
  connected: boolean
  siteUrl: string | null
  accountName: string | null
  expiresAt: string | null
  // API 토큰은 최대 1년 만료라 갱신 시점을 UI가 먼저 알려야 한다 (조용한 401 방지)
  expiringSoon: boolean
  expired: boolean
  /** 전체 동기화가 배포 버전과 같은 이름의 릴리스를 찾을 Jira 프로젝트. 미설정이면 전체 동기화 불가 */
  defaultProjectKey: string | null
}

/**
 * 전체 동기화 결과. 성공·실패가 섞이므로 항목별로 나눠 돌려받는다 —
 * 특히 unmatched를 감추면 "동기화했는데 왜 없지" 상태가 된다.
 */
export interface SyncAllResult {
  /** 이슈까지 가져온 릴리스 */
  synced: Array<{ noteId: number; version: string; itemCount: number }>
  /** 릴리스는 가져왔지만 이슈 조회는 상한에 걸려 미룬 것 — 행의 동기화 버튼으로 개별로 받는다 */
  metaOnly: Array<{ noteId: number; version: string }>
  failed: Array<{ version: string; error: string }>
  /**
   * 이번 실행에서 목록에 새로 들어온 릴리스 수. main 은 늘 채운다.
   * 렌더러 쪽은 선택 필드다. 이유: 이 필드가 없는 기존 테스트 리터럴이 타입체크를 통과해야 한다.
   */
  linked?: number
}

export interface JiraProjectSummary {
  key: string
  name: string
}

export interface JiraCredentialsInput {
  siteUrl: string
  email: string
  apiToken: string
  expiresAt: string
}

export interface ReleaseNoteAPI {
  /** deployVersion을 주면 그 배포 버전과 이름이 같은 릴리스만 (프로젝트 상세용) */
  list: (deployVersion?: string) => Promise<ReleaseNoteSummary[]>
  get: (id: number) => Promise<ReleaseNoteWithItems | null>
  // 네트워크가 얽혀 있어 throw 대신 결과 객체로 감싼다 — 오류 문구를 그대로 표시해야 한다
  sync: (
    id: number
  ) => Promise<{ success: boolean; itemCount?: number; truncated?: boolean; error?: string }>
  /** 기본 Jira 프로젝트의 릴리스 전체를 가져와 동기화한다. 릴리스 수만큼 느리다 */
  syncAll: () => Promise<{ success: boolean; result?: SyncAllResult; error?: string }>
}

export interface JiraAPI {
  status: () => Promise<JiraConnectionStatus>
  saveCredentials: (
    input: JiraCredentialsInput
  ) => Promise<{ success: boolean; accountName?: string; error?: string }>
  disconnect: () => Promise<{ success: boolean }>
  listProjects: () => Promise<{
    success: boolean
    projects?: JiraProjectSummary[]
    error?: string
  }>
  /** 전체 동기화가 릴리스를 찾을 기준 프로젝트. null이면 해제 */
  setDefaultProject: (projectKey: string | null) => Promise<{ success: boolean; error?: string }>
  openIssue: (issueKey: string) => Promise<{ success: boolean }>
}

// ── Jira 프로젝트 싱크업 (docs/PROJECT_SYNC.md) ──
// main의 project-sync 서비스가 돌려주는 모양과 같아야 한다 — 한쪽만 바꾸면 미리보기가 조용히 빈 값을 그린다.

export type ProjectSyncSkipReason = 'qa' | 'no_epic' | 'tracked_in_project'

export interface ProjectSyncPlanItem {
  jiraKey: string
  summary: string
  kind: 'epic' | 'sustain'
  action: 'create' | 'update' | 'unchanged'
  /** create면 null */
  projectId: number | null
  /** 기존 프로젝트 이름 또는 생성될 이름 */
  projectName: string
  matchedBy: 'jira_key' | 'document_url' | 'name' | null
  newTasks: number
  /** status 전진 또는 키 백필이 일어나는 기존 작업 수 */
  updatedTasks: number
  newDocuments: number
  /** 기존 프로젝트 항목을 강제 적용할 때 덮어써질 필드/작업 수(이름 1 + 설명 1 + forceTasks.length). create 항목은 0 */
  forceChanges: number
  /** 강제 적용 시 이름·상태·마감일이 바뀌는 기존 작업. 이름이 같으면 before === after. create 항목은 [] */
  forceTasks: { before: string; after: string }[]
}

/** 적용할 항목. 기존 프로젝트(projectId !== null)는 force=true로만 넘긴다 — 사용자가 덮어쓰기를 확인한 것 */
export interface ProjectSyncSelection {
  jiraKey: string
  force: boolean
  /** 미리보기 때의 대상 프로젝트. 적용 시 재계획 결과와 다르면 main이 거부한다 */
  projectId: number | null
}

export interface ProjectSyncSkipped {
  jiraKey: string
  summary: string
  reason: ProjectSyncSkipReason
  detail: string | null
}

export interface ProjectSyncPlan {
  items: ProjectSyncPlanItem[]
  skipped: ProjectSyncSkipped[]
  /** Jira 조회 상한에 걸림 */
  truncated: boolean
  /** Jira에서 찾은 트리거(내게 할당된 "할 일") 이슈 수 — 0건이면 조회 자체가 비었다는 뜻 */
  triggerCount: number
  /** ISO */
  fetchedAt: string
}

export interface ProjectSyncResult {
  created: number
  updated: number
  unchanged: number
  tasksAdded: number
  tasksUpdated: number
  documentsAdded: number
  skipped: ProjectSyncSkipped[]
  /**
   * 실제로 적용한 항목. main 은 늘 채운다.
   * 렌더러 쪽은 선택 필드다. 이유: 이 필드가 없는 기존 테스트 리터럴이 타입체크를 통과해야 한다.
   */
  applied?: ProjectSyncAppliedItem[]
}

/** 적용한 항목 1건. main 의 project-sync-plan.ts 와 같은 모양이다 */
export interface ProjectSyncAppliedItem {
  jiraKey: string
  action: ProjectSyncPlanItem['action']
  projectId: number | null
  projectName: string
  force: boolean
}

// ── 아침 자동 동기화 (docs/ASSISTANT.md A54, docs/PROJECT_SYNC.md R11) ──
// main 의 assistant-types.ts 와 같은 모양이다. 한쪽만 바꾸면 배지와 상태 줄이 빈 값을 그린다.

export type MorningSyncPartName = 'release' | 'project'
/** deferred 는 사용자가 수동 미리보기를 검토 중이라 미룬 상태다. 시도로 세지 않는다 */
export type MorningSyncPartStatus = 'running' | 'ok' | 'skipped' | 'failed' | 'deferred'

export interface MorningSyncPart {
  status: MorningSyncPartStatus
  /** 센 시도 수. 오프라인·deferred 는 세지 않는다 */
  attempts: number
  /** 마지막 시도 시작 'YYYY-MM-DD HH:mm:ss' */
  startedAt: string | null
  /** 마지막 시도 끝. running 이면 null */
  finishedAt: string | null
  /** failed 의 사용자용 문구. skipped 이면 건너뛴 이유 */
  error: string | null
  /** 새 항목 수. 릴리스는 새 릴리스, 싱크업은 새 프로젝트 */
  newCount: number
  /** 갱신한 항목 수 */
  updatedCount: number
  /** 싱크업만 쓴다. 자동 적용하지 않고 확인이 필요한 항목 수 (R11) */
  reviewCount: number
  /** 릴리스만 쓴다. 일부 버전의 실패 수 */
  failedCount: number
}

export interface MorningSyncStatus {
  enabled: boolean
  /** 설정 시각 'HH:mm' */
  at: string
  inFlight: boolean
  /** 마지막 행의 논리 날짜. 행이 없으면 null */
  date: string | null
  release: MorningSyncPart | null
  project: MorningSyncPart | null
}

export interface ProjectSyncAPI {
  // 네트워크가 얽혀 있어 throw 대신 결과 객체로 감싼다 — 오류 문구를 그대로 표시해야 한다
  preview: () => Promise<{ success: true; plan: ProjectSyncPlan } | { success: false; error: string }>
  /** preview가 캐시한 Jira 스냅샷으로 현재 DB 기준 재계획 후, 고른 항목만 적용한다 */
  apply: (
    selection: ProjectSyncSelection[]
  ) => Promise<
    { success: true; result: ProjectSyncResult } | { success: false; error: string }
  >
  /** 아침 자동 동기화 상태. 읽기 전용이다 */
  morningStatus: () => Promise<
    { success: true; status: MorningSyncStatus } | { success: false; error: string }
  >
}

// ── 앱 데이터 백업 · 복원 (docs/DATA_BACKUP.md) ──
// 백업 한 벌은 단일 .zip 파일이다(안에 manifest.json · linkwork.db · recordings/ · ai-attachments/).
// main의 services/backup-service.ts가 만드는 manifest.json과 같은 모양이라
// 한쪽만 바꾸면 복원 화면이 조용히 빈 값을 그린다 — 둘을 함께 고칠 것.

export interface BackupManifest {
  format: 'linkwork-backup'
  formatVersion: number
  appVersion: string
  /** ISO 문자열 */
  createdAt: string
  platform: string
  db: { bytes: number; tables: Record<string, number> }
  files: {
    recordings: { count: number; bytes: number }
    attachments: { count: number; bytes: number }
  }
  /** 백업에서 실제로 제거된 기기 종속 시크릿 — 'auth_tokens' | 'app_settings:notion_token' */
  excluded: string[]
}

export interface BackupProgress {
  phase: 'db' | 'files' | 'done' | 'error'
  /** 0~1 */
  progress: number
  message?: string
}

/** 복원 전 확인 결과. 치명적 문제는 에러로 오고, 여기 warnings는 "알고 진행"할 것들이다. */
export interface BackupSummary {
  /** 고른 백업 .zip 파일의 전체 경로 */
  path: string
  manifest: BackupManifest
  warnings: string[]
}

export interface BackupAPI {
  /** 저장 다이얼로그 → .zip 하나로 내보내기. 취소하면 canceled=true */
  exportToFile: () => Promise<{
    success: boolean
    canceled?: boolean
    /** 만들어진 백업 .zip의 전체 경로 */
    path?: string
    manifest?: BackupManifest
    error?: string
  }>
  /** 파일 선택 다이얼로그 → manifest 확인만 (복원하지 않는다) */
  pickBackup: () => Promise<{
    success: boolean
    canceled?: boolean
    summary?: BackupSummary
    error?: string
  }>
  /** 현재 데이터를 백업으로 **대체**하고 앱을 재시작한다. 성공 응답 뒤 1초 후 재시작. */
  importBackup: (path: string) => Promise<{ success: boolean; error?: string }>
  /** 진행률 구독. 반환 함수를 호출하면 해제된다. */
  onProgress: (cb: (p: BackupProgress) => void) => () => void
}

// ── 개인 비서 (docs/ASSISTANT.md 부록 A.1·A.5·B.7 복제) ──
// main 의 src/main/services/assistant-types.ts 와 같은 모양을 유지한다.

// 'manual' 은 명령으로 만든 임시 항목이다 (부록 G.6)
export type CandidateSource = 'jira' | 'task' | 'todo' | 'action_item' | 'manual'
export type CandidatePriority = 'high' | 'medium' | 'low'
// 업무 유형 (부록 J.2·J.9.13)
export type WorkType = 'qa' | 'sus' | 'trd' | 'prd' | 'etc'

export interface Candidate {
  id: string
  source: CandidateSource
  title: string
  jiraKey: string | null
  projectId: number | null
  projectName: string | null
  dueDate: string | null
  dueTime: string | null
  inProgress: boolean
  priority: CandidatePriority | null
  jiraPriority: string | null
  lastTouchedAt: string | null
  link: string | null
  // Jira 부모 키. jira·task(머지) 만 (부록 J)
  parentKey: string | null
  // Jira 부모 요약 또는 WBS 프로젝트 이름
  groupName: string | null
  workType: WorkType
  workVersion: string | null
}

export type PlanStatus = 'active' | 'closed'
export type PlanClosedBy = 'button' | 'auto'
export type PlanItemStatus =
  | 'suggested'
  | 'planned'
  | 'in_progress'
  | 'done'
  | 'deferred'
  | 'dropped'
  | 'dismissed'
export type PlanAddedBy = 'start' | 'user' | 'refresh'

export interface DailyPlan {
  id: number
  plan_date: string
  status: PlanStatus
  started_at: string
  closed_at: string | null
  closed_by: PlanClosedBy | null
  // 렌더러는 출처 스냅샷을 쓰지 않는다
  source_snapshot: unknown
  briefing_text: string | null
  briefing_source: 'rules' | 'llm' | null
  briefing_model: string | null
  briefing_error: string | null
  briefing_at: string | null
  // 사용자가 명령으로 저장한 브리핑 지시 (부록 G.7)
  briefing_instruction: string | null
  recovery_text: string | null
  recovery_source: 'rules' | 'llm' | null
  recovery_at: string | null
  wrapup_note: string | null
  wrapup_at: string | null
  last_refresh_at: string | null
  created_at: string
  updated_at: string
}

export interface PlanItem {
  id: number
  plan_id: number
  candidate_id: string
  source: CandidateSource
  title: string
  link: string | null
  jira_issue_key: string | null
  project_id: number | null
  due_date: string | null
  score: number
  rank: number | null
  slot_start: string | null
  slot_end: string | null
  pinned: boolean
  added_by: PlanAddedBy
  urgent: boolean
  status: PlanItemStatus
  status_note: string | null
  status_at: string | null
  // 같은 candidate_id 가 처음 계획에 오른 논리 날짜. 저장소가 조회 시 계산한다 (부록 B.5)
  first_planned_date: string | null
  // 업무 유형·묶음 (부록 J.5)
  work_type: WorkType
  work_version: string | null
  parent_key: string | null
  group_name: string | null
}

// 오늘 타임라인 (부록 B.7)
export type TimelineEntry =
  | { kind: 'meeting'; start: string; end: string; title: string }
  | {
      kind: 'block'
      start: string
      end: string
      minutes: number
      state: 'past' | 'current' | 'future'
      itemId: number | null
      reason: 'focus' | 'deadline' | null
      continued: boolean
    }
export interface DayTimeline {
  // 시작 시각 오름차순
  entries: TimelineEntry[]
  freeMinutesLeft: number
  focusItemId: number | null
  unplacedDeadlineItemIds: number[]
}

export type AssistantEventKind =
  | 'start_nudge'
  | 'plan_update'
  | 'checkin'
  | 'meeting_briefing'
  | 'command'
  | 'morning_sync'
export type AssistantEventStatus = 'sent' | 'late' | 'skipped' | 'failed' | 'logged'
export interface AssistantEvent {
  id: number
  event_key: string
  kind: AssistantEventKind
  plan_date: string
  scheduled_at: string
  fired_at: string | null
  status: AssistantEventStatus
  ref_id: string | null
  payload: string | null
  response: string | null
  responded_at: string | null
  created_at: string
}

// plan_update 이벤트 payload 의 변경 요약
export interface RefreshSummary {
  calendarAdded: number
  calendarChanged: number
  calendarRemoved: number
  suggested: number
  urgentSuggestedIds: string[]
  completed: number
  dropped: number
  replaced: number
  timelineChanged: boolean
  currentOrNextChanged: boolean
  // 변경 기록 행에서만 있다. INSERT 에 성공한 알림 종류 (부록 E.3.3)
  notified?: Array<'slot' | 'urgent'>
}

export interface AssistantSettings {
  enabled: boolean
  dayRollover: string
  startNudge: boolean
  workEnd: string
  planSize: number
  llmEnabled: boolean
  llmModel: AiModelChoice
  jiraScope: 'all' | 'default_project'
  openAtLogin: boolean
  refreshCalendarMin: number
  refreshJiraMin: number
  refreshNotify: boolean
  meetingLeadMin: number
  // 회의 전 브리핑 켜기 (부록 I.11.4)
  meetingBriefingEnabled: boolean
  // 첫 화면 (docs/ASSISTANT.md 부록 C, A24). 저장된 auto·dashboard 는 main 이 today 로 읽는다
  startView: 'today' | 'projects' | 'calendar'
  // 아침 자동 동기화 켜기 (부록 K, A54)
  morningSyncEnabled: boolean
  // 아침 자동 동기화 시각 'HH:mm'
  morningSyncTime: string
  // 계획 항목을 완료하면 원본도 완료한다. 기본 false (D10)
  completeOriginOnDone: boolean
}

export interface TodayPayload {
  logicalDate: string
  plan: DailyPlan | null
  items: PlanItem[]
  events: AssistantEvent[]
  settings: AssistantSettings
  missingWrapupDate: string | null
  aiAvailable: boolean
  jiraConnected: boolean
  calendarConnected: boolean
  jiraTruncated: boolean
  lastErrors: string[]
  timeline: DayTimeline
  // 맥락 복구 진행·실패 상태 (부록 F.6). 메모리 값이다
  recovery: RecoveryState
}

// 맥락 복구 상태 (부록 F.9.1)
export interface RecoveryState {
  inFlight: boolean
  error: string | null
}

export interface AssistantChangedEvent {
  date: string
  reason: 'refresh' | 'briefing' | 'day' | 'recovery' | 'command' | 'meeting'
}
export interface AssistantNavigateEvent {
  view: 'today'
  focus?: {
    kind: 'inbox' | 'item' | 'briefing' | 'timeline' | 'meeting'
    id?: string
  }
}

// 트레이 오늘 계획 섹션 (부록 E.6.1 과 같은 모양)
export interface TrayPlanItem {
  id: number
  title: string
  rank: number | null
  status: PlanItemStatus
  isFocus: boolean
}
export interface TrayAssistant {
  logicalDate: string
  status: 'none' | 'active' | 'closed'
  // 'HH:mm'
  startedAt: string | null
  // 활성 항목 rank 순 상위 3건
  items: TrayPlanItem[]
  activeCount: number
  doneCount: number
  suggestedCount: number
  urgentSuggestedCount: number
  freeMinutesLeft: number
}

// ── 명령 입력 (부록 G.3.1·G.3.4 복제) ──
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
export interface CommandPreviewOp {
  op: CommandOp
  label: string
  executable: boolean
}
export interface CommandInterpretation {
  // 공백 정리한 명령 원문
  text: string
  scopeItemId: number | null
  ops: CommandPreviewOp[]
  source: 'llm' | 'rules'
  // LLM 실패 사유. 성공이거나 LLM 을 건너뛰면 null
  error: string | null
  // 검증에서 뺀 조작 수
  dropped: number
}
export interface CommandOpResult {
  op: CommandOp
  label: string
  ok: boolean
  error: string | null
}
export interface CommandApplyOutcome {
  today: TodayPayload
  results: CommandOpResult[]
  applied: number
  failed: number
}

// ── 회의 전 브리핑 (부록 I.11.1 복제) ──
// 시각은 'YYYY-MM-DD HH:mm:ss' 다. 종일 일정은 없다
export interface MeetingRef {
  id: string
  title: string
  startAt: string
  endAt: string
}
export interface MeetingProjectRef {
  id: number
  name: string
}
export type MeetingLlmStatus = 'off' | 'pending' | 'done' | 'failed'
export interface MeetingBriefingPayload {
  meeting: MeetingRef
  // 알림 문구
  title: string
  body: string
  projects: MeetingProjectRef[]
  hasContext: boolean
  ruleMarkdown: string
  llmStatus: MeetingLlmStatus
  llmMarkdown: string | null
  llmModel: string | null
  llmAt: string | null
  llmError: string | null
}

export type AssistantResult<T> = ({ success: true } & T) | { success: false; error: string }
export type TodayResult = AssistantResult<{ today: TodayPayload }>

export interface AssistantAPI {
  getToday: () => Promise<TodayResult>
  startDay: () => Promise<TodayResult>
  closeDay: (note?: string) => Promise<TodayResult>
  reopenDay: () => Promise<TodayResult>
  saveWrapup: (note: string, date: string) => Promise<AssistantResult<{ plan: DailyPlan }>>
  refresh: () => Promise<TodayResult>
  refreshBriefing: () => Promise<TodayResult>
  // 맥락 복구 본문을 만든다 (부록 F.7)
  generateRecovery: () => Promise<TodayResult>
  listCandidates: () => Promise<AssistantResult<{ candidates: Candidate[] }>>
  addItem: (candidateId: string) => Promise<TodayResult>
  acceptSuggestion: (itemId: number) => Promise<TodayResult>
  dismissSuggestion: (itemId: number) => Promise<TodayResult>
  setItemStatus: (itemId: number, status: PlanItemStatus, note?: string) => Promise<TodayResult>
  focusItem: (itemId: number) => Promise<TodayResult>
  getSettings: () => Promise<AssistantSettings>
  saveSettings: (
    patch: Partial<AssistantSettings>
  ) => Promise<AssistantResult<{ settings: AssistantSettings }>>
  onNavigate: (cb: (p: AssistantNavigateEvent) => void) => () => void
  onChanged: (cb: (p: AssistantChangedEvent) => void) => () => void
  // 명령 입력 (부록 G.9). 해석은 DB 를 쓰지 않는다
  interpretCommand: (
    text: string,
    scopeItemId?: number
  ) => Promise<AssistantResult<{ interpretation: CommandInterpretation }>>
  applyCommand: (
    ops: CommandOp[],
    text: string
  ) => Promise<AssistantResult<Omit<CommandApplyOutcome, never>>>
  // 회의 브리핑의 AI 본문을 다시 만든다 (부록 I.11.10). 결과를 기다린다
  regenerateMeetingBriefing: (eventId: number) => Promise<TodayResult>
}
