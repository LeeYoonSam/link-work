export interface TrayAPI {
  getData: () => Promise<unknown>
  openApp: () => Promise<void>
  // 트레이 '오늘 보기'. 메인 창을 오늘 화면으로 연다 (docs/ASSISTANT.md §10)
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
  // 일정이 온 Google 캘린더 id. 기본 캘린더는 'primary' 다
  calendarId?: string
}

export interface CalendarStatus {
  connected: boolean
  hasCredentials: boolean
}

// Google 캘린더 목록 항목 (calendarList.list)
export interface CalendarListEntry {
  id: string
  summary: string
  primary: boolean
  color: string | null
}

export type Fail = { success: false; error: string }

export interface CalendarAPI {
  auth: () => Promise<{ success: boolean; error?: string }>
  getEvents: (weekStartISO?: string) => Promise<CalendarEvent[]>
  refresh: (weekStartISO?: string) => Promise<CalendarEvent[]>
  disconnect: () => Promise<{ success: boolean }>
  status: () => Promise<CalendarStatus>
  saveSettings: (clientId: string, clientSecret: string) => Promise<{ success: boolean }>
  // 가져올 캘린더 (docs/SETTINGS.md). 저장값이 없으면 ['primary']
  listCalendars: () => Promise<
    { success: true; calendars: CalendarListEntry[]; selectedIds: string[] } | Fail
  >
  setSelectedCalendars: (ids: string[]) => Promise<{ success: true; selectedIds: string[] } | Fail>
  // 선택한 캘린더 전부의 일정을 범위로 받는다. 범위는 45일 이하
  range: (
    fromISO: string,
    toISO: string,
    force?: boolean
  ) => Promise<{ success: true; events: CalendarEvent[]; fetchedAt: string } | Fail>
}

// ── 오늘 대시보드 신호 (docs/ASSISTANT.md §11). 한 줄 브리핑·신호 문구는 렌더러 규칙(todayModel)이 만든다 ──
export type SignalKind =
  | 'release_risk'
  | 'release_day'
  | 'overdue'
  | 'due_today'
  | 'meeting_soon'
  | 'qa_start'
export type SignalSeverity = 'critical' | 'warn' | 'info'

/** 규칙 문구를 만든 사실(건수·연결 여부) */
export interface TodayFacts {
  // 미연결 영역을 "없음"으로 말하지 않으려고 둔다
  calendarConnected: boolean
  jiraConnected: boolean
  meetingCount: number
  overdueCount: number
  dueTodayCount: number
  // start 'HH:mm'
  nextMeeting: { title: string; start: string } | null
  release: {
    version: string | null
    date: string
    dDay: number
    qaStart: string | null
    linked: boolean
    mine: { total: number; done: number; review: number; progress: number; todo: number }
  } | null
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
  // 출처 링크(linkwork:// 앱 내 링크 또는 https:// URL). 없으면 null
  source_link: string | null
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
  source_link?: string | null
  tag_ids?: number[]
}

export interface TodoTagInput {
  name: string
  color?: string
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
  listVoiceprints: () => Promise<MemberVoiceprint[]>
  clearVoiceprint: (memberId: number) => Promise<{ success: boolean }>
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
  // 2=무음 컷편집·용어집·참석자 힌트 파이프라인, 3=현재(docs/MEETING_RECORDING.md §13).
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
  // 목소리로 연결된 구성원. manual=사용자가 지정·확정, auto=목소리로 자동 지정, suggested=후보만 제시
  member_id: number | null
  member_source: 'manual' | 'auto' | 'suggested' | null
  // 목소리 매칭 점수(코사인 0~1). 자동 지정·제안일 때만 값이 있다
  match_score: number | null
  // 이 화자의 목소리 임베딩이 저장돼 있는지 (임베딩 자체는 렌더러로 오지 않는다)
  has_voice: boolean
  // 이 화자 목소리가 구성원 표본으로 실제 저장돼 있는지
  voice_enrolled: boolean
  // member_id 구성원 이름 (제안 문구용)
  member_name: string | null
}

// 목소리 등록·확인·거절 IPC 공통 반환
export interface SpeakerVoiceResult {
  success: boolean
  error?: string
  member_id?: number | null
  enrolled?: boolean
}

// 구성원별 저장된 목소리 표본 요약
export interface MemberVoiceprint {
  member_id: number
  sample_count: number
  total_speech_ms: number
  updated_at: string
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
  // 회의 전용 4개 필드 — key_points 포함 (면접에서는 빈 배열)
  key_points: string[]
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

// ── 회의록 (요약 완료된 회의를 문서처럼 열람) — docs/MEETING_RECORDING.md §10 ──
export interface MeetingNoteFilter {
  q?: string                      // 검색어(공백 trim, 빈 문자열은 무시)
  kind?: 'all' | MeetingKind      // 기본 'all'
}

export interface MeetingNoteItem {
  id: number
  title: string
  kind: MeetingKind
  started_at: string
  duration_ms: number
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
  ) => Promise<{ success: boolean; member_id?: number | null; enrolled?: boolean }>
  // 화자 목소리를 그 이름의 구성원 표본으로 등록 (구성원이 없으면 만든다)
  enrollSpeakerVoice: (speakerId: number) => Promise<SpeakerVoiceResult>
  // 자동 지정·제안을 맞다고 확정 → manual + 표본 등록
  confirmSpeakerMatch: (speakerId: number) => Promise<SpeakerVoiceResult>
  // 자동 지정·제안 거절 → 연결 해제, 다시 제안하지 않음
  rejectSpeakerMatch: (speakerId: number) => Promise<SpeakerVoiceResult>
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
  /** 저장된 Atlassian 이메일. Bitbucket 팝업에 미리 채운다. 토큰은 돌려주지 않는다 */
  email: string | null
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
  list: () => Promise<ReleaseNoteSummary[]>
  get: (id: number) => Promise<ReleaseNoteWithItems | null>
  // 네트워크가 얽혀 있어 throw 대신 결과 객체로 감싼다 — 오류 문구를 그대로 표시해야 한다
  sync: (
    id: number
  ) => Promise<{ success: boolean; itemCount?: number; truncated?: boolean; error?: string }>
  /** 기본 Jira 프로젝트의 릴리스 전체를 가져와 동기화한다. 릴리스 수만큼 느리다 */
  syncAll: () => Promise<{ success: boolean; result?: SyncAllResult; error?: string }>
  /** 마지막 확인 이후 바뀐 이슈만 반영한다. force=false 면 10분 안 재호출은 생략한다 */
  syncChanges: (
    force?: boolean
  ) => Promise<{ success: true; result: ReleaseChangeSyncResult } | { success: false; error: string }>
}

/** 변경분 동기화 결과. main 의 release-note-sync.ts 와 같은 모양이다 */
export interface ReleaseChangeSyncResult {
  /** skipped = 10분 이내라 Jira를 부르지 않음. full = 전체 동기화로 넘어감 */
  mode: 'incremental' | 'full' | 'skipped'
  /** 항목이 바뀐 릴리스 */
  changed: Array<{ noteId: number; version: string; upserted: number; removed: number }>
  /** 새로 목록에 들어온 릴리스 수 */
  linked: number
  /** 이름·출시 여부·날짜 등 메타가 바뀐 릴리스 수 */
  metaUpdated: number
  /** mode가 'full'일 때 전체 동기화 결과 */
  full?: SyncAllResult
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

// ── 설정 화면: 연동 연결 테스트 (main 의 services/integration-verify.ts 와 같은 모양) ──
export type IntegrationId = 'google' | 'jira' | 'bitbucket' | 'notion'
export type IntegrationVerifyCode =
  | 'not_connected'
  | 'auth_failed'
  | 'expired'
  | 'unreachable'
  | 'unknown'
/** throw 하지 않는다. 비밀값은 담지 않는다. checkedAt 은 ISO 문자열 */
export type IntegrationVerifyResult =
  | { ok: true; account: string | null; checkedAt: string }
  | { ok: false; code: IntegrationVerifyCode; error: string; checkedAt: string }

export interface SettingsAPI {
  /** 저장된 자격 증명으로 가장 가벼운 GET 한 번. 연결 안 됐으면 외부 호출 없이 not_connected */
  verifyIntegration: (id: IntegrationId) => Promise<IntegrationVerifyResult>
}

// ── Jira 티켓 계층 보드 (docs/PROJECT_BOARD.md) ──
// main 의 services/jira-board.ts 와 같은 모양이다. 한쪽만 바꾸면 보드가 조용히 빈 값을 그린다.

export type JiraIssueLevel = 'epic' | 'standard' | 'subtask'
export type JiraStatusCategory = 'new' | 'indeterminate' | 'done'

export interface JiraBoardIssue {
  key: string
  summary: string
  /** Jira 표시 이름 (에픽, 작업, 버그, 하위 작업 …) */
  issueType: string
  level: JiraIssueLevel
  /** 세부 상태 이름 (표시용) */
  status: string
  statusCategory: JiraStatusCategory
  /** '할 일' 이상인가. false = 백로그 상태. 화면은 inScope 이슈와 그 조상만 그린다 */
  inScope: boolean
  priority: string | null
  parentKey: string | null
  parentSummary: string | null
  assigneeAccountId: string | null
  assigneeName: string | null
  /** YYYY-MM-DD */
  duedate: string | null
  /** ISO */
  updated: string
  /** 완료 시각(resolutiondate). 없으면 null */
  resolvedAt: string | null
  labels: string[]
  /** 설명 본문 평문 발췌. 최대 600자, 없으면 null */
  excerpt: string | null
  /** 이 이슈의 fixVersion. 릴리스 탭의 jira_version_id 와 대응한다 */
  fixVersions: { id: string; name: string }[]
  /** 연결 문서. 같은 이슈 안에서 url 중복 없음(앞 종류가 남는다). 순서: web → attachment → description → issue */
  links: JiraIssueLink[]
}

/** web=웹링크(remotelink), attachment=첨부, description=본문 안 링크, issue=연결 이슈 */
export type JiraIssueLinkKind = 'web' | 'attachment' | 'description' | 'issue'

export interface JiraIssueLink {
  kind: JiraIssueLinkKind
  title: string
  /** http(s) URL. issue면 그 이슈의 Jira browse URL, attachment면 첨부 content URL */
  url: string
  /** 출처 추정 라벨: 'Confluence' | 'Figma' | 'Google 문서' | 'Notion 문서' | 'Jira' | '첨부' | 호스트명 등.
   *  Jira 이슈 URL·연결 이슈는 'Jira', 첨부는 '첨부'다 */
  source: string
  /** kind === 'issue': 연결된 이슈 키, 관계 이름(예: 관심, 선행 작업), 그 이슈의 상태 이름. title 은 'KEY 요약' */
  issueKey?: string
  relation?: string
  issueStatus?: string
  /** kind === 'attachment' */
  mimeType?: string | null
  size?: number | null
  createdAt?: string | null
}

export interface JiraBoardSnapshot {
  projectKey: string
  myAccountId: string | null
  /** 키 중복 없음 */
  issues: JiraBoardIssue[]
  /** 조회 상한에 걸려 일부만 가져왔다 */
  truncated: boolean
  /** 최근 완료로 포함한 기간(일) */
  recentDoneDays: number
  /** 마지막 동기화(전체·증분) 시작 시각. ISO */
  fetchedAt: string
  /** 마지막 전체 동기화 시각(ISO). 없으면 null */
  lastFullSyncAt: string | null
}

/** auto 는 저장 상태를 보고 full / incremental / 생략을 고른다 */
export type JiraBoardSyncMode = 'auto' | 'incremental' | 'full'

export interface JiraBoardSyncInfo {
  /** 실제로 돈 방식. 'cache' = Jira를 부르지 않고 저장본을 돌려줌 */
  mode: 'full' | 'incremental' | 'cache'
  /** 이번에 새로 저장하거나 덮어쓴 이슈 수 (cache면 0) */
  changed: number
}

export interface JiraEpicAiSummary {
  epicKey: string
  /** 한 문장 */
  headline: string
  /** 2~4개: 진행 상황·남은 일·위험 */
  bullets: string[]
  /** ISO */
  generatedAt: string
}

export interface JiraBoardAPI {
  // 네트워크가 얽혀 있어 throw 대신 결과 객체로 감싼다 — 오류 문구를 그대로 표시해야 한다
  /** 로컬 DB 에 저장된 스냅샷만 읽는다. Jira 를 부르지 않는다. 저장본이 없으면 null */
  cached: () => Promise<
    | { success: true; snapshot: JiraBoardSnapshot | null }
    | { success: false; error: string; code?: 'not_connected' | 'no_default_project' }
  >
  /** Jira 와 동기화하고 저장본을 갱신한다. 기본 'auto' */
  fetch: (
    mode?: JiraBoardSyncMode
  ) => Promise<
    | { success: true; snapshot: JiraBoardSnapshot; sync: JiraBoardSyncInfo }
    | { success: false; error: string; code?: 'not_connected' | 'no_default_project' }
  >
  /** 사용자가 버튼을 눌렀을 때만 부른다. 저장된 스냅샷의 에픽 키만 받는다 */
  summarizeEpic: (
    epicKey: string
  ) => Promise<{ success: true; summary: JiraEpicAiSummary } | { success: false; error: string }>
  /** 저장된 스냅샷의 어떤 이슈 links 에 든 http(s) URL 만 기본 브라우저로 연다 */
  openLink: (url: string) => Promise<{ success: true } | { success: false; error: string }>
}

// ── 아침 자동 동기화 (docs/ASSISTANT.md §8) ──
// main 의 assistant-types.ts 와 같은 모양이다. 한쪽만 바꾸면 배지와 상태 줄이 빈 값을 그린다.

export type MorningSyncPartName = 'release'
/** deferred 는 옛 행 호환용으로 남긴 상태다. 시도로 세지 않는다 */
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
  /** 새 릴리스 수 */
  newCount: number
  /** 갱신한 항목 수 */
  updatedCount: number
  /** 옛 행 호환용. 지금은 늘 0 이다 */
  reviewCount: number
  /** 일부 버전의 실패 수 */
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
}

export interface MorningSyncAPI {
  /** 아침 자동 동기화 상태. 읽기 전용이다 */
  status: () => Promise<
    { success: true; status: MorningSyncStatus } | { success: false; error: string }
  >
}

// ── 앱 데이터 백업 · 복원 (docs/DATA_BACKUP.md) ──
// 백업 한 벌은 단일 .zip 파일이다(안에 manifest.json · linkwork.db · recordings/ · ai-attachments/).
// main의 services/backup-service.ts가 만드는 manifest.json과 같은 모양이라
// 한쪽만 바꾸면 복원 화면이 조용히 빈 값을 그린다 — 둘을 함께 고칠 것.

/**
 * 백업 그룹 ID. 순서가 고정이다(main 의 services/backup-groups.ts 의 BACKUP_GROUP_IDS 와 같다).
 * 그룹을 추가하면 main 쪽 formatVersion 을 반드시 올린다.
 */
export type BackupGroupId = 'work' | 'meetings' | 'library' | 'ai' | 'settings'

export interface BackupManifest {
  format: 'linkwork-backup'
  /** 1 = 이전 형식(늘 전체 백업), 2 = 그룹 선택 백업 */
  formatVersion: number
  /** 이 백업에 담긴 그룹(고정 순서). main 이 v1 은 5개 전체로 정규화해 내려준다. */
  groups: BackupGroupId[]
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

/** `backup:stats` — 현재 데이터의 그룹별 행 수와 파일 용량 */
export interface BackupGroupStat {
  id: BackupGroupId
  /** 테이블별 행 수. settings 는 app_settings 키 수 */
  tables: Record<string, number>
  /** 그룹에 속한 파일(recordings/ · ai-attachments/). 파일이 없는 그룹은 0 */
  files: { count: number; bytes: number }
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
  /** 현재 데이터의 그룹별 건수·파일 용량 (내보내기·복원 화면 표시용) */
  stats: () => Promise<{ success: boolean; groups?: BackupGroupStat[]; error?: string }>
  /** 저장 다이얼로그 → 고른 그룹만 .zip 하나로 내보내기. 취소하면 canceled=true */
  exportToFile: (groups: BackupGroupId[]) => Promise<{
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
  /**
   * 고른 그룹만 현재 데이터를 백업 내용으로 **교체**하고(합치지 않음) 앱을 재시작한다.
   * 고르지 않은 그룹은 그대로 둔다. 성공 응답 뒤 1초 후 재시작.
   */
  importBackup: (
    path: string,
    groups: BackupGroupId[]
  ) => Promise<{
    success: boolean
    restoredDbBackupPath?: string
    groups?: BackupGroupId[]
    warnings?: string[]
    /** 경고가 1건 이상이면 true — main 은 자동 재시작하지 않고 `restart()` 를 기다린다 */
    restartPending?: boolean
    error?: string
  }>
  /** restartPending 으로 멈춘 복원 뒤, 사용자가 경고를 읽고 나서 앱을 재시작한다 */
  restart: () => Promise<{ success: true }>
  /** 진행률 구독. 반환 함수를 호출하면 해제된다. */
  onProgress: (cb: (p: BackupProgress) => void) => () => void
}

// ── 개인 비서 (docs/ASSISTANT.md §4·§5·§12) ──
// main 의 src/main/services/assistant-types.ts 와 같은 모양을 유지한다.

export type AssistantEventKind =
  | 'start_nudge'
  | 'plan_update'
  | 'checkin'
  | 'meeting_briefing'
  | 'command'
  | 'morning_sync'
  | 'today_briefing'
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

// 비서 설정 (docs/ASSISTANT.md §4)
export interface AssistantSettings {
  enabled: boolean
  dayRollover: string
  // 회의 전 브리핑의 AI 본문 사용·모델
  llmEnabled: boolean
  llmModel: AiModelChoice
  openAtLogin: boolean
  meetingLeadMin: number
  // 회의 전 브리핑 켜기 (§7)
  meetingBriefingEnabled: boolean
  // 첫 화면 (§4). 저장된 auto·dashboard 는 main 이 today 로 읽는다
  startView: 'today' | 'projects' | 'calendar'
  // 아침 자동 동기화 켜기 (§8)
  morningSyncEnabled: boolean
  // 아침 자동 동기화 시각 'HH:mm'
  morningSyncTime: string
}

// 오늘 화면(assistant:getToday)이 읽는 값 (docs/ASSISTANT.md §11.1)
export interface TodayPayload {
  // 오늘 논리 날짜의 비서 이벤트(회의 전 브리핑 카드)
  events: AssistantEvent[]
  settings: AssistantSettings
  aiAvailable: boolean
  calendarConnected: boolean
}

export interface AssistantChangedEvent {
  date: string
  reason: 'meeting'
}
// 메인이 보내는 focus 는 회의 브리핑 알림 클릭의 'meeting' 뿐이다 (docs/ASSISTANT.md §6.3)
export interface AssistantNavigateEvent {
  view: 'today'
  focus?: {
    kind: 'meeting'
    id?: string
  }
}

// ── 회의 전 브리핑 (docs/ASSISTANT.md §7) ──
// 시각은 'YYYY-MM-DD HH:mm:ss' 다. 종일 일정은 없다
export interface MeetingRef {
  id: string
  title: string
  startAt: string
  endAt: string
}
export type MeetingLlmStatus = 'off' | 'pending' | 'done' | 'failed'
export interface MeetingBriefingPayload {
  meeting: MeetingRef
  // 알림 문구
  title: string
  body: string
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
  // 오늘 데이터·회의 브리핑·설정·이동 (docs/ASSISTANT.md §12)
  getToday: () => Promise<TodayResult>
  getSettings: () => Promise<AssistantSettings>
  saveSettings: (
    patch: Partial<AssistantSettings>
  ) => Promise<AssistantResult<{ settings: AssistantSettings }>>
  onNavigate: (cb: (p: AssistantNavigateEvent) => void) => () => void
  onChanged: (cb: (p: AssistantChangedEvent) => void) => () => void
  // 회의 브리핑의 AI 본문을 다시 만든다 (docs/ASSISTANT.md §7.7). 결과를 기다린다
  regenerateMeetingBriefing: (eventId: number) => Promise<TodayResult>
}

// ── 휴대폰 열람 (docs/MOBILE_VIEW.md) ──
// 상태·스냅샷 모양은 mobile/contract.ts 가 단일 출처다. preload 의 window.api.mobile 과 같은 모양이다.
export interface MobileAPI {
  getStatus: () => Promise<import('../mobile/contract').MobileServerStatus>
  setEnabled: (enabled: boolean) => Promise<import('../mobile/contract').MobileServerStatus>
  regenerateToken: () => Promise<import('../mobile/contract').MobileServerStatus>
  /** 데스크톱이 조립한 오늘 대시보드 스냅샷(MobileTodaySnapshot)을 메인에 올린다 */
  publishToday: (snapshot: unknown) => Promise<{ success: boolean; error?: string }>
  /** 휴대폰이 /api/today 를 읽으면 메인이 재발행을 요청한다. 구독 해제 함수를 돌려준다 */
  onPublishRequested: (cb: () => void) => () => void
}
