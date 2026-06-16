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
  status: 'scheduled' | 'development' | 'qa' | 'deploy' | 'completed' | 'cancelled'
  status_manual: number
  created_at: string
  updated_at: string
}

export interface Task {
  id: number
  project_id: number
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
  getEvents: () => Promise<CalendarEvent[]>
  refresh: () => Promise<CalendarEvent[]>
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
  send: (chatId: number, text: string) => Promise<{ started: boolean; error?: string }>
  cancel: (chatId: number) => Promise<{ success: boolean }>
  progress: (chatId: number) => Promise<AiProgress>
  status: () => Promise<AiStatus>
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

export interface Meeting {
  id: number
  title: string
  status: MeetingStatus
  audio_path: string | null
  audio_mime: string
  duration_ms: number
  language: string
  source: MeetingSource
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

export interface MeetingSummary {
  id: number
  meeting_id: number
  tldr: string | null
  key_points: string[]
  decisions: string[]
  action_items: ActionItem[]
  next_steps: string[]
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
  phase: 'transcribe' | 'diarize' | 'vad' | 'merge' | 'summarize' | 'done' | 'error'
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
  createDraft: (input: { title?: string; source?: MeetingSource }) => Promise<{ id: number }>
  saveAudio: (
    id: number,
    bytes: ArrayBuffer,
    meta: { mime: string; durationMs: number },
    channelEnergy?: ChannelEnergy | null
  ) => Promise<{ path: string }>
  process: (id: number) => Promise<{ success: boolean; error?: string; transcribed?: boolean }>
  summarize: (id: number) => Promise<{ success: boolean; error?: string }>
  rename: (id: number, title: string) => Promise<{ success: boolean }>
  remove: (id: number) => Promise<{ success: boolean }>
  updateSpeaker: (
    speakerId: number,
    input: { display_name?: string | null; color?: string; label?: string }
  ) => Promise<{ success: boolean }>
  reassignSegment: (segmentId: number, speakerId: number | null) => Promise<{ success: boolean }>
  mergeSpeakers: (
    meetingId: number,
    fromSpeakerId: number,
    intoSpeakerId: number
  ) => Promise<{ success: boolean }>
  toggleCut: (cutId: number, enabled: boolean) => Promise<{ success: boolean }>
  actionItemToTodo: (meetingId: number, index: number) => Promise<{ todo_id: number }>
  linkProject: (id: number, projectId: number | null) => Promise<{ success: boolean }>
  onStream: (cb: (e: RecordingStreamEvent) => void) => () => void
}
