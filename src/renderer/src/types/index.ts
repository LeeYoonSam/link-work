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
  status:
    | 'scheduled'
    | 'development'
    | 'qa_pending'
    | 'qa'
    | 'deploy_pending'
    | 'deploy'
    | 'completed'
    | 'cancelled'
  status_manual: number
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

// 채팅별 데이터 작성 모드: 읽기 전용 | 승인 후 쓰기(기본) | 자동 쓰기
export type AiWriteMode = 'readonly' | 'ask' | 'auto'

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

// 쓰기 도구 실행 전 사용자 승인 요청 (HITL)
// current: 수정(update) 도구의 변경 전 현재 값 (생성 도구는 null)
export interface AiApprovalRequest {
  requestId: string
  name: string
  label: string
  input: Record<string, unknown>
  current?: Record<string, unknown> | null
}

export type AiStreamEvent =
  | { chatId: number; event: 'start' }
  | { chatId: number; event: 'text'; delta: string }
  | { chatId: number; event: 'tool'; name: string; label: string }
  | { chatId: number; event: 'approval'; request: AiApprovalRequest }
  | { chatId: number; event: 'approval_resolved'; requestId: string; approved: boolean }
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
  approve: (requestId: string, approved: boolean) => Promise<{ success: boolean }>
  setChatWriteMode: (chatId: number, mode: AiWriteMode) => Promise<{ success: boolean }>
  onStream: (callback: (event: AiStreamEvent) => void) => () => void
  onDataChanged: (callback: (data: { entity: string }) => void) => () => void
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
}

export interface RecordingStreamEvent {
  meetingId: number
  // 'cancelled' — 사용자 취소로 파이프라인이 중단됨(에러와 구분되는 중립 종료)
  phase:
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

export interface RecordingAPI {
  list: () => Promise<Meeting[]>
  get: (id: number) => Promise<MeetingDetail | null>
  createDraft: (input: {
    title?: string
    source?: MeetingSource
    kind?: MeetingKind
    // 참석 인원(화자분리 클러스터 수). 미지정 시 면접=2, 회의=자동 추정(null).
    expected_speakers?: number | null
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
  onStream: (cb: (e: RecordingStreamEvent) => void) => () => void
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
