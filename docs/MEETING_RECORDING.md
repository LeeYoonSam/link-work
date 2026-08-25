# 회의 녹음 (Meeting Recording) — 설계 명세 (SSOT)

> 이 문서는 회의 녹음 기능의 **단일 계약(Single Source of Truth)**입니다.
> 모든 구현 에이전트는 여기 정의된 데이터 모델 · IPC 채널 · 타입 · 어댑터 인터페이스를 **그대로** 따릅니다.
> 임의로 채널명/타입/시그니처를 바꾸지 마세요. 변경이 필요하면 이 문서를 먼저 고칩니다.

## 0. 목표 & 결정사항

사용자 확정 결정:
- **STT**: 로컬 Whisper 우선 (`@fugood/whisper.node` + `large-v3-turbo`, 모델 첫 실행 다운로드). API 키 미사용 — 앱의 무과금/프라이버시 철학과 일치.
- **녹음 소스**: 마이크 + 시스템 오디오. **마이크=L / 시스템=R 스테레오 분리 저장** → 모델 없이도 2화자(나/상대) 확보.
- **화자 분리**: 다자 자동분리(`sherpa-onnx`) + **수동 보정** 하이브리드.
- **범위**: MVP 풀 파이프라인 — 녹음 → 전사 → 시간대별 타임라인 → AI 요약(5분류) → 액션아이템 TODO 자동등록 + 캘린더 매칭.

핵심 재사용:
- **AI 요약** = 기존 `ai-agent.ts`의 Claude Code 구독 OAuth(`query()`) 패턴 재사용 → 추가 과금 0.
- **TODO 연계** = `todo:create({title, priority?, due_date?, notes?, tag_ids?})`.
- **캘린더 연계** = `calendar:events`(getWeekEvents) 시간 매칭.

## 1. 아키텍처 개요

```
[Renderer]                          [Main]
RecordingView ── recordingStore ──IPC──► recording.ipc.ts
  │  useRecorder (getUserMedia + 시스템오디오                │
  │   + WebAudio 믹싱 mic=L/sys=R → MediaRecorder webm/opus) │
  │                                                          ▼
  └─ ArrayBuffer 업로드 (recording:saveAudio) ──► recording-storage.ts
                                                   userData/recordings/<id>.webm
                                                          │
                          recording:process ──► meeting-pipeline.ts
                                                   0) compact (audio-compaction.ts) → 긴 침묵 제거한 WAV로 교체 (§11)
                                                   1) (필요시) webm→16k mono wav
                                                   2) STT  (stt/)        → raw segments (VAD 구간은 0)에서 재사용)
                                                      → cleanSegments → applyGlossary (용어집 후보정, §12)
                                                   3) VAD  (vad/)        → cuts[] (silence/filler)
                                                   4) Diar (diarization/)→ speaker turns
                                                   5) merge → segments[] + speakers[]
                                                   진행률: recording:stream 이벤트
                                                          │
                          recording:summarize ──► meeting-summary.ts
                                                   Claude query(전사 → 5분류 JSON)
                                                          │
                          액션아이템 → todo:create / 캘린더 매칭
```

**설계 원칙 (리서치 기반)**
1. **처리 후 비파괴(non-destructive after compaction)**: 녹음 파일은 첫 처리 직전 **무음 컷편집을 정확히 1회** 거쳐 교체되고(§11, 사용자 결정: 컷편집본을 그 녹음의 파일로 사용), 그 이후로는 불변이다. 제거한 구간은 `<id>.compaction.json` 사이드카에 남긴다. 짧은 침묵/필러 컷은 여전히 `cuts[]` 메타데이터로만 저장(`enabled` 토글). 화자 보정은 `segments`/`speakers`에 반영하되 시간축(`start_ms`)은 보존.
2. **시간은 항상 (컷편집된) 파일의 절대 ms**. (whisper.cpp 타임스탬프 재배치 함정 회피)
3. **어댑터 패턴**: STT/Diarization/VAD는 인터페이스로 추상화. 네이티브 엔진 미설치 시 **폴백 어댑터**로 graceful degrade (앱은 항상 빌드·동작).
4. **화자 자동분리는 "초안"**. 수동 보정 도구를 1급 기능으로.

## 2. 데이터 모델 (SQLite, database.ts)

모든 테이블 `CREATE TABLE IF NOT EXISTS`. 시간 컬럼은 기존 컨벤션(`datetime('now','localtime')`) 따름. 밀리초 타임스탬프는 정수.

```sql
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '제목 없는 회의',
  kind TEXT NOT NULL DEFAULT 'meeting',       -- meeting|interview (요약 스키마·상세 UI 분기)
  status TEXT NOT NULL DEFAULT 'recording',   -- recording|processing|transcribed|summarized|failed
  audio_path TEXT,                            -- userData/recordings/ 상대 파일명
  audio_mime TEXT DEFAULT 'audio/webm',
  duration_ms INTEGER DEFAULT 0,
  language TEXT DEFAULT 'ko',
  source TEXT DEFAULT 'mic',                  -- mic|mic+system
  expected_speakers INTEGER,                  -- 참석 인원(화자분리 클러스터 수). NULL=자동
  compact_audio INTEGER NOT NULL DEFAULT 1,   -- 처리 시 무음 컷편집 수행 여부(녹음 시작 시 선택, §11)
  audio_compacted INTEGER NOT NULL DEFAULT 0, -- 컷편집이 실제 적용됐는지(멱등 가드)
  original_duration_ms INTEGER,               -- 컷편집 전 길이(NULL=미적용)
  pipeline_version INTEGER NOT NULL DEFAULT 0,-- 처리 파이프라인 버전(0=구/미처리, 2=컷편집·용어집·참석자). 전체 처리 시 기록(§13)
  project_id INTEGER,                         -- (선택) 프로젝트 귀속
  calendar_event_id TEXT,                     -- (선택) 매칭된 캘린더 이벤트
  calendar_event_title TEXT,
  error TEXT,                                 -- 처리 실패 사유
  started_at TEXT DEFAULT (datetime('now','localtime')),
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS meeting_speakers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL,
  speaker_key TEXT NOT NULL,                  -- 엔진 라벨: 'spk_0' / 'mic' / 'system'
  label TEXT NOT NULL,                        -- 기본 표시명 '화자 1'
  display_name TEXT,                          -- 사용자가 입력한 실명 (null=미지정)
  color TEXT NOT NULL DEFAULT '#4F8EF7',
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS meeting_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,                  -- 원본 절대 시간 (불변 기준)
  end_ms INTEGER NOT NULL,
  speaker_id INTEGER,                         -- meeting_speakers.id (FK, null 허용)
  text TEXT NOT NULL DEFAULT '',
  confidence REAL,
  speaker_corrected INTEGER NOT NULL DEFAULT 0, -- 사용자가 화자 변경 여부
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  FOREIGN KEY (speaker_id) REFERENCES meeting_speakers(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS meeting_cuts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'silence',       -- silence|filler|manual
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,         -- 컷 적용 여부(비파괴 토글)
  auto INTEGER NOT NULL DEFAULT 1,            -- 자동 검출 여부
  note TEXT,                                  -- 필러 단어 등
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS meeting_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL UNIQUE,
  tldr TEXT,                                  -- 한 줄/문단 요약 (면접에서는 '면접 개요')
  key_points TEXT,                            -- JSON string[]
  -- 회의(kind='meeting') 전용 3분류. 면접 요약 시 '[]'로 덮어쓴다.
  decisions TEXT,                             -- JSON string[]
  action_items TEXT,                          -- JSON ActionItem[] (아래 타입)
  next_steps TEXT,                            -- JSON string[]
  -- 면접(kind='interview') 전용 4분류. 회의 요약 시 '[]'로 덮어쓴다.
  qa_pairs TEXT,                              -- JSON InterviewQaPair[]
  competencies TEXT,                          -- JSON InterviewCompetency[]
  follow_ups TEXT,                            -- JSON string[]
  fact_checks TEXT,                           -- JSON string[]
  model TEXT,
  generated_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

-- ── 인식 보조 장치 (§12): 사용자가 직접 입력하는 용어집·구성원. 로컬 DB에만 저장 ──
CREATE TABLE IF NOT EXISTS stt_glossary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,                         -- 정답 표기
  aliases TEXT NOT NULL DEFAULT '[]',         -- JSON string[] 오인식/변형 표기
  note TEXT,                                  -- 설명(요약 프롬프트 힌트, 선택)
  priority INTEGER NOT NULL DEFAULT 0,        -- 높을수록 initial_prompt에 먼저
  enabled INTEGER NOT NULL DEFAULT 1,
  project_id INTEGER,                         -- NULL=전역, 지정 시 그 프로젝트 회의에만
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS meeting_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',         -- JSON string[] 호칭/영문명
  role TEXT,                                  -- 직책/팀(선택)
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS meeting_attendees (  -- 회의별 참석자(구성원 중 선택)
  meeting_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, member_id),
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES meeting_members(id) ON DELETE CASCADE
);
```

마이그레이션은 기존 패턴(다른 테이블 영향 없으니 `CREATE IF NOT EXISTS`만으로 충분, 추가 컬럼 시 `PRAGMA table_info` 체크).

## 3. 공용 타입 (src/renderer/src/types/index.ts 에 append)

```ts
export type MeetingStatus = 'recording' | 'processing' | 'transcribed' | 'summarized' | 'failed'
export type MeetingSource = 'mic' | 'mic+system'

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
  project_id: number | null
  calendar_event_id: string | null
  calendar_event_title: string | null
  error: string | null
  expected_speakers: number | null
  compact_audio: number          // 1=처리 시 무음 컷편집
  audio_compacted: number        // 1=컷편집 적용 완료(멱등)
  original_duration_ms: number | null
  pipeline_version: number       // 0=구 파이프라인, 2=현재(§13). 요약 재생성 분기 기준
  started_at: string
  created_at: string
  updated_at: string
}

// ── 인식 보조 장치 (§12) ──
export interface GlossaryEntry {
  id: number
  term: string
  aliases: string[]
  note: string | null
  priority: number
  enabled: number
  project_id: number | null
  created_at: string
  updated_at: string
}
export interface Member {
  id: number
  name: string
  aliases: string[]
  role: string | null
  enabled: number
  sort_order: number
  created_at: string
  updated_at: string
}
export interface Attendee {
  member_id: number
  name: string
  role: string | null
}
export interface RecognitionAidsAPI {
  listGlossary: () => Promise<GlossaryEntry[]>
  upsertGlossary: (input: { id?: number; term: string; aliases?: string[]; note?: string | null; priority?: number; enabled?: boolean; project_id?: number | null }) => Promise<{ id: number }>
  removeGlossary: (id: number) => Promise<{ success: boolean }>
  /** 줄 형식 `정답 | 별칭1, 별칭2 | 메모` (`#` 주석, 파이프 없이 정답만도 허용) */
  importGlossaryText: (text: string) => Promise<{ added: number; updated: number; skipped: number }>
  listMembers: () => Promise<Member[]>
  upsertMember: (input: { id?: number; name: string; aliases?: string[]; role?: string | null; enabled?: boolean; sort_order?: number }) => Promise<{ id: number }>
  removeMember: (id: number) => Promise<{ success: boolean }>
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
  assignee?: string | null   // 화자 display_name 또는 발언자
  due?: string | null        // 'YYYY-MM-DD' or null
  speaker_id?: number | null
  source_segment_id?: number | null
  todo_id?: number | null    // 등록 완료 시 채움
}

// 면접(kind='interview') 전용 구조 — 점수·합불 판단을 담지 않는다
export interface InterviewQaPair {
  question: string
  answer_summary: string
  start_ms: number | null   // AI는 "mm:ss"로 답하고, main에서 ms로 환산
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
  tldr: string | null       // 면접에서는 '면접 개요'
  key_points: string[]
  // 회의 전용 (면접에서는 빈 배열)
  decisions: string[]
  action_items: ActionItem[]
  next_steps: string[]
  // 면접 전용 (회의에서는 빈 배열)
  qa_pairs: InterviewQaPair[]
  competencies: InterviewCompetency[]
  follow_ups: string[]
  fact_checks: string[]
  model: string | null
  generated_at: string
}

/** 상세 화면용 묶음 */
export interface MeetingDetail {
  meeting: Meeting
  speakers: MeetingSpeaker[]
  segments: MeetingSegment[]
  cuts: MeetingCut[]
  attendees: Attendee[]
  summary: MeetingSummary | null
}

/** 처리 진행률 스트림 (recording:stream) */
export interface RecordingStreamEvent {
  meetingId: number
  // 'compact' — 무음 컷편집(§11). 'cancelled' — 사용자 취소로 파이프라인이 중단됨(에러와 구분되는 중립 종료)
  phase: 'compact' | 'transcribe' | 'diarize' | 'vad' | 'merge' | 'summarize' | 'done' | 'error' | 'cancelled'
  progress?: number          // 0..1
  message?: string
  error?: string
}

export interface RecordingAPI {
  list: () => Promise<Meeting[]>
  get: (id: number) => Promise<MeetingDetail | null>
  createDraft: (input: {
    title?: string
    source?: MeetingSource
    kind?: MeetingKind
    expected_speakers?: number | null  // 참석 인원(화자분리 클러스터 수). 미지정 시 면접=2, 회의=자동(null)
    attendee_ids?: number[]            // 참석자(meeting_members.id) — 프롬프트 힌트·화자 프리셋·요약 담당자 매칭
    compact_audio?: boolean            // 처리 시 무음 컷편집(기본 true)
  }) => Promise<{ id: number }>
  /** 참석자 지정/변경 (meeting_attendees 교체) */
  setAttendees: (meetingId: number, memberIds: number[]) => Promise<{ success: boolean }>
  /** 오디오 바이트 저장 (ArrayBuffer). 저장 후 duration/경로 메타 갱신 */
  saveAudio: (id: number, bytes: ArrayBuffer, meta: { mime: string; durationMs: number }) => Promise<{ path: string }>
  /** 전사+화자분리+VAD 파이프라인 실행 (진행률은 onStream) */
  process: (id: number) => Promise<{ success: boolean; error?: string }>
  /** 진행 중인 처리 취소. success=취소된 활성 파이프라인이 있었는지 여부. 취소 완료는 onStream phase:'cancelled' */
  cancel: (id: number) => Promise<{ success: boolean }>
  /** AI 요약 5분류 생성 (진행률은 onStream) */
  summarize: (id: number) => Promise<{ success: boolean; error?: string }>
  rename: (id: number, title: string) => Promise<{ success: boolean }>
  remove: (id: number) => Promise<{ success: boolean }>
  /** 화자 보정 */
  updateSpeaker: (speakerId: number, input: { display_name?: string | null; color?: string; label?: string }) => Promise<{ success: boolean }>
  reassignSegment: (segmentId: number, speakerId: number | null) => Promise<{ success: boolean }>
  mergeSpeakers: (meetingId: number, fromSpeakerId: number, intoSpeakerId: number) => Promise<{ success: boolean }>
  /** 컷 토글 */
  toggleCut: (cutId: number, enabled: boolean) => Promise<{ success: boolean }>
  /** 액션아이템 → TODO 등록. 반환된 todo_id를 summary에 반영 */
  actionItemToTodo: (meetingId: number, index: number) => Promise<{ todo_id: number }>
  /** 녹음 시각 근처 캘린더 이벤트 후보 */
  calendarMatches: (id: number) => Promise<{ id: string; title: string; start: string }[]>
  linkCalendar: (id: number, eventId: string | null, eventTitle: string | null) => Promise<{ success: boolean }>
  /** 처리/요약 진행률 구독. 반환값은 unsubscribe */
  onStream: (cb: (e: RecordingStreamEvent) => void) => () => void
}
```

`env.d.ts`의 `Window.api`에 `recording: RecordingAPI`, `recognitionAids: RecognitionAidsAPI` 추가.

## 4. IPC 채널 계약 (recording.ipc.ts → preload)

| 채널 | 인자 | 반환 |
|---|---|---|
| `recording:list` | — | `Meeting[]` |
| `recording:get` | `id` | `MeetingDetail \| null` |
| `recording:createDraft` | `{title?, source?, kind?, expected_speakers?, attendee_ids?, compact_audio?}` | `{id}` |
| `recording:setAttendees` | `meetingId, memberIds[]` | `{success}` |
| `recording:saveAudio` | `id, ArrayBuffer, {mime,durationMs}` | `{path}` |
| `recording:process` | `id` | `{success, error?}` |
| `recording:cancel` | `id` | `{success}` (활성 파이프라인 abort, 완료는 stream phase:`cancelled`) |
| `recording:summarize` | `id` | `{success, error?}` |
| `recording:rename` | `id, title` | `{success}` |
| `recording:remove` | `id` | `{success}` |
| `recording:updateSpeaker` | `speakerId, input` | `{success}` |
| `recording:reassignSegment` | `segmentId, speakerId` | `{success}` |
| `recording:mergeSpeakers` | `meetingId, from, into` | `{success}` |
| `recording:toggleCut` | `cutId, enabled` | `{success}` |
| `recording:actionItemToTodo` | `meetingId, index` | `{todo_id}` |
| `recording:calendarMatches` | `id` | `{id,title,start}[]` |
| `recording:linkCalendar` | `id, eventId, eventTitle` | `{success}` |
| 이벤트 `recording:stream` | (main→renderer) `RecordingStreamEvent` | — |

`recording:get`은 `attendees: Attendee[]`를 함께 반환한다. `recording:remove`는 오디오·`<id>.channels.json`·`<id>.compaction.json`을 모두 지운다.

인식 보조 장치 IPC (`recognition-aids.ipc.ts` → preload `window.api.recognitionAids`):

| 채널 | 인자 | 반환 |
|---|---|---|
| `recognitionAids:listGlossary` | — | `GlossaryEntry[]` |
| `recognitionAids:upsertGlossary` | `input` | `{id}` |
| `recognitionAids:removeGlossary` | `id` | `{success}` |
| `recognitionAids:importGlossaryText` | `text` | `{added, updated, skipped}` |
| `recognitionAids:listMembers` | — | `Member[]` |
| `recognitionAids:upsertMember` | `input` | `{id}` |
| `recognitionAids:removeMember` | `id` | `{success}` |

preload: 다른 API와 동일하게 `ipcRenderer.invoke`, `onStream`은 `ipcRenderer.on('recording:stream', ...)` + cleanup 반환.

## 5. 어댑터 인터페이스 (main/services)

가용성 우선순위로 팩토리가 선택. 네이티브 미설치/실패 시 폴백.

```ts
// stt/index.ts
export interface SttSegment { start_ms: number; end_ms: number; text: string; confidence?: number }
export interface SttAdapter {
  readonly name: string
  isAvailable(): Promise<boolean>
  // speechRegionsMs: 컷편집 단계(§11)가 이미 검출한 발화 구간. 주어지면 어댑터는 VAD를 다시 돌리지 않는다.
  transcribe(wavPath: string, opts: { language: string; prompt?: string; speechRegionsMs?: { startMs: number; endMs: number }[]; signal?: AbortSignal; onProgress?: (p: number) => void }): Promise<SttSegment[]>
}
// 구현: whisper-adapter (lazy import '@fugood/whisper.node', optionalDependency),
//        manual-adapter (폴백: 빈 결과 + '수동 입력 필요' — 앱이 항상 동작)

// diarization/index.ts
export interface DiarTurn { start_ms: number; end_ms: number; speaker_key: string }
export interface DiarizationAdapter {
  readonly name: string
  isAvailable(): Promise<boolean>
  diarize(wavPath: string, opts: { minSpeakers?: number; maxSpeakers?: number; numSpeakers?: number; signal?: AbortSignal }): Promise<DiarTurn[]>
}
// 구현: sherpa-adapter (lazy 'sherpa-onnx'),
//        channel-adapter (폴백: mic=L/sys=R 스테레오를 두 화자로 — 모델 불필요),
//        none-adapter (단일 화자)

// vad/index.ts
export interface VadRegion { start_ms: number; end_ms: number; kind: 'silence' }
export interface VadAdapter {
  readonly name: string
  detectSilence(wavPath: string, opts?: { minSilenceMs?: number }): Promise<VadRegion[]>
}
// 구현: silero-adapter (lazy), gap-adapter (폴백: STT 세그먼트 간 공백으로 침묵 추정)
```

**파이프라인(meeting-pipeline.ts)**: `process(id)`
0. **compact** (phase:compact, §11): `!skipTranscribe && compact_audio=1 && audio_compacted=0 && WAV`일 때만 `compactRecording` → 적용되면 파일 교체 + `duration_ms`/`original_duration_ms`/`audio_compacted=1` 갱신 + 기존 면접 요약의 `qa_pairs[].start_ms` 재매핑. 실패/미적용은 비치명적(원본으로 계속). 검출한 발화 구간은 2)에 `speechRegionsMs`로 전달.
1. 오디오 로드 → (필요시) 16k mono wav 변환. ffmpeg 없으면 원본 사용 시도, 실패 시 명확한 에러.
2. `stt.transcribe` → raw segments (phase:transcribe, progress) → `cleanSegments` → `applyGlossary`(§12, `skipTranscribe` 경로에도 적용) → WAV 길이 클램프
3. `vad.detectSilence` → cuts[] (phase:vad)
4. `diar.diarize` → turns (phase:diarize). 폴백은 채널 기반.
5. **merge**: 각 STT segment를 겹치는 diar turn의 speaker_key에 귀속. speakers[] 생성(중복 key 통합, 색상/라벨 부여). (phase:merge)
6. DB 저장(meeting_speakers, meeting_segments, meeting_cuts), meeting.status='transcribed'.
7. 실패 시 status='failed', error 기록, phase:error.

모든 네이티브 의존성은 **optionalDependencies + lazy import**. 미설치여도 import 에러가 앱을 죽이지 않도록 try/catch. 폴백 어댑터로 파이프라인은 항상 완주.

## 6. AI 요약 (meeting-summary.ts)

`ai-agent.ts`의 인프라(SDK lazy load, `findClaudeExecutable`, `sanitizedEnv`, `settingSources:[]`, `cwd`)를 **재사용**하되, MCP 도구 없이 단순 텍스트→JSON query. 회의 요약은 데이터 조회가 아니라 변환이므로 `allowedTools:[]`, `mcpServers` 없음.

- 입력: 전사본을 `[mm:ss] 화자명: 텍스트` 라인들로 직렬화(긴 회의는 청크/길이 가드 — 너무 길면 앞부분 우선 + 길이 상한). 앞에 `buildSummaryContextBlock(loadPromptContext(db, meetingId))`의 `[참고 정보]` 블록(참석자·용어집, §12)을 붙인다 — 비어 있으면 생략. `SummarySpec.buildPrompt(transcript, contextBlock)`.
- 시스템 프롬프트: "회의록을 분석해 한국어로 JSON만 출력. 키: tldr(string), key_points(string[]), decisions(string[]), action_items({text, assignee?, due?}[]), next_steps(string[]). 추측 금지, 회의에 없는 내용 생성 금지."
- 출력 파싱: 응답에서 JSON 블록 추출(코드펜스 허용) → zod 검증(`zod`는 이미 의존성) → `meeting_summaries` upsert.
- 진행률: phase:summarize, 완료 시 phase:done. 실패 시 friendly error(`toFriendlyError` 패턴 재사용 — 미로그인/미설치 안내).

### 6-1. 종류별 요약 스펙 (SummarySpec)

실행 인프라는 하나이고, **프롬프트 · 검증 · 저장만** `meetings.kind`로 갈아끼운다 (`summary-spec.ts`).

| kind | 스펙 | 위치 |
|---|---|---|
| `meeting` | `MEETING_SPEC` — 기존 5분류 | `meeting-summary.ts` |
| `interview` | `INTERVIEW_SPEC` — 면접 4분류 | `interview-summary.ts` |

두 스펙 모두 **상대 종류의 컬럼을 `'[]'`로 덮어쓴다**. 종류를 바꿔 재요약했을 때 이전 종류의 잔여 데이터가 화면에 남지 않게 하기 위함이다.

### 6-2. 면접 기록 (kind='interview')

**이 기능은 채용 판정 도구가 아니라 기록 보조다.** 프롬프트가 점수·등급·합불 의견·직무 무관 정보(성별·나이·출신 등) 생성을 금지하고, 화면에도 판정 근거로 쓰지 말라는 고지를 상시 노출한다.

- 출력 키: `overview`(→ tldr 컬럼 재사용), `qa_pairs`, `competencies`, `follow_ups`, `fact_checks`.
- **타임스탬프 규약**: AI에게 ms 정수를 만들게 하지 않는다. 전사록에 이미 `[mm:ss]`가 있으므로 그 표기를 `at` 필드로 그대로 돌려받고, `interview-summary.ts`의 `parseTimestamp`가 ms로 환산한다(형식이 어긋나면 `null` → 재생 점프 버튼 숨김). 회귀 테스트: `interview-summary.test.ts`.
- 화자 귀속: "질문하는 쪽=면접관"을 프롬프트가 추론하되, 화자 이름이 지정돼 있으면 그것을 우선한다. 화자 탭의 면접 프리셋(`면접관`/`지원자`)으로 지정하면 정확도가 올라간다.
- 참석 인원(`expected_speakers`)은 면접 기본 2(면접관+지원자 기본형 → 화자 자동추정 과분할 방지), 녹음 시작 화면의 "참석 인원" 입력으로 변경 가능하다(비우면 자동 추정). 다대일 면접이면 면접관 수를 포함한 인원을 지정한다. 상세 화면에서 사후 재분리도 가능(`recording:setExpectedSpeakers`).
- 면접관은 한 명 이상일 수 있다(다대일 면접). 요약 프롬프트가 "질문하는 쪽=면접관"을 복수로 허용하고, 화자 프리셋(`면접관`/`지원자`)을 여러 화자에 지정하면 이름이 겹치지 않게 `면접관 2`, `지원자 2`…로 자동 번호가 붙는다.
- 녹음 시작 전 **동의 고지 체크**가 필수다(개인정보보호법상 사전 동의). 체크 전에는 시작 버튼이 비활성.

## 7. 연계 플로우

**액션아이템 → TODO** (`recording:actionItemToTodo`): summary.action_items[index] → `todo:create({ title: text, due_date: due, notes: '회의: <title> 에서 추출' })`. 반환 todo_id를 action_items[index].todo_id에 기록 후 summary 갱신. (오토가 아니라 사용자 클릭 — 오탐 방지, Zoom Tasks Accept 패턴)

**캘린더 매칭** (`recording:calendarMatches`): `getWeekEvents()`에서 meeting.started_at ±90분 이내 이벤트를 후보로. 사용자가 `linkCalendar`로 확정 → calendar_event_id/title 저장.

## 8. 렌더러 구조

```
hooks/useRecorder.ts          # 캡처 상태머신: idle|recording|paused|stopped
stores/recordingStore.ts      # 목록/상세/처리상태/스트림 구독
stores/recognitionAidsStore.ts# 용어집·구성원 CRUD (§12)
components/recording/
  RecordingView.tsx           # 좌: 목록 + 종류 필터(전체/회의/면접) + "인식 보조" 패널 토글, 우: 상세
  RecognitionAidsPanel.tsx    # 용어집/구성원 탭 편집 + 텍스트 가져오기 (§12)
  RecorderControls.tsx        # 종류(회의/면접) + 소스 선택 + 참석자 칩 + 무음 제거 체크, 시작/일시정지/종료 + 레벨미터
  RecordingList.tsx           # 녹음 카드 목록(상태 pill, 면접 배지), kindFilter 적용
  MeetingDetail.tsx           # 헤더(제목/날짜/상태) + 탭(타임라인/요약), kind별 패널 분기
  SpeakerTimeline.tsx         # 시간대별 화자 발언 (클릭→오디오 점프), 컷 토글
  SummaryPanel.tsx            # [회의] 5분류 + 액션아이템 TODO버튼 + 캘린더 매칭
  InterviewPanel.tsx          # [면접] Q&A(클릭→질문 시점 재생)/근거/추가확인/레퍼런스체크
  SpeakerEditor.tsx           # 화자 실명 입력/색상/병합/세그먼트 재할당 (면접 프리셋 지원)
  AudioPlayer.tsx             # <audio> + seek, cuts enabled 구간 skip(비파괴)
```

디자인: 반드시 `components/ui/tokens.ts`(button/typo/status pill), `ui/index.tsx`(Card/Badge/IconButton/EmptyState/SectionTitle), `ui/icons.tsx` 재사용. 새 색/커스텀 CSS 금지, Tailwind v4 인라인 클래스 + 토큰.

메뉴는 회의·면접 통합 단일 메뉴(`Sidebar` → `녹음`)다. 종류 구분은 목록 상단 필터 탭으로 하며, 선택값은 `recordingStore.kindFilter`에 둔다 — `RecordingView`가 메뉴 전환 시 언마운트되므로 로컬 state면 필터가 초기화된다.

상태머신: `idle → (start) recording → (pause/resume) → (stop) → saveAudio → process → summarize`. 녹음 중엔 경과시간/레벨미터. 종료 시 자동으로 process 트리거, 완료 후 summarize 버튼(또는 자동).

## 9. 네이티브 의존성 / 빌드 (별도 단계, MVP는 폴백으로 동작)

- `@fugood/whisper.node`(prebuilt, N-API), `sherpa-onnx`(prebuilt), 시스템오디오 `audiotee`(또는 `electron-audio-loopback`) — 모두 **optionalDependencies**.
- `package.json` build: `asarUnpack`에 `**/*.node`, 모델 `.bin`은 `userData/models/` 런타임 다운로드.
- `Info.plist`(electron-builder `mac.extendInfo`): `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`.
- entitlements: `com.apple.security.device.audio-input`, (외부 바이너리 시) `com.apple.security.cs.disable-library-validation`.
- **MVP 단계에서는 네이티브 미설치 가정** — 폴백 어댑터로 빌드/타입체크 통과 및 녹음·저장·요약·연계까지 동작. 네이티브 통합은 후속.

## 10. 검증 기준

- `npm run typecheck` (node+web) 통과.
- `npm run build` 통과.
- 폴백 경로로 전체 플로우가 런타임 에러 없이 도달(전사 없으면 "수동 입력/엔진 설치 안내" 상태로 graceful).

## 11. 무음 컷편집 (audio compaction)

**목적**: 처리 전에 긴 침묵을 잘라 (a) whisper 청크 수(28초 창에 발화가 더 촘촘히) (b) sherpa 화자분리 입력 길이 (c) 파일 크기를 줄이고, 재생 시 침묵 스킵이 필요 없게 한다. **컷편집본이 그 녹음의 파일이 된다**(사용자 결정, 원본 별도 보관 없음). 제거한 구간은 `<id>.compaction.json` 사이드카(`{version, originalMs, compactedMs, removed[], params, compactedAt}`)에 남긴다.

**구성**
- `stt/audio-compactor.ts` — 순수 함수(단위 테스트 대상): `planCompaction(speech, audioMs, opts)`, `compactPcm16(wav, dataRange, keep)`, `remapChannelEnergy(env, keep)`, `mapMsToCompacted(ms, keep)`, `speechRegionsToCompacted(speech, keep)`. 기본 파라미터는 `DEFAULT_COMPACTION_OPTIONS` 한곳에 둔다.
- `stt/vad-detect.ts` — whisper.node silero VAD 검출 공용 함수 `detectSpeechRegions(audioPath, dataRange, opts)` (컷편집·STT 공용). **반드시 `useGpu:false`**(Metal에서 ggml_abort로 앱 즉사 이력) + `.vad-crash-guard` 센티널 유지. **`initWhisperVad`는 반드시 `nThreads: 1`을 명시한다** — 기본값이 hardware_concurrency(12)인데 silero는 0.88MB 초소형 그래프라 프레임마다 12스레드를 동기화하는 비용이 연산을 압도해 사실상 멈춘다(실측 5초 오디오: nThreads 1=33ms, 2=43ms, 4=229ms, 기본값=60초 초과 미완료·CPU 480%. 97분 녹음이 9분 걸리고 진행률 0%로 보이던 원인). nThreads 1이면 전체 파일 검출이 길이에 선형으로 약 224× 실시간(8분 2.1초, 54분 14.6초, 98분 26초). **검출은 파일 전체를 한 번에 넣는다(`detectSpeechFile`)** — 청크 분할·병렬(`detectSpeechData`)은 3배 더 빠르지만 청크 경계마다 전체 검출 대비 발화 ~0.2초씩(98분에 총 ~4초)이 어긋나고 컷편집은 되돌릴 수 없으므로 채택하지 않았다(2026-08-25 실측 후 제거). 네이티브 호출 중에는 진행률을 얻을 수 없어 `estimateVadProgress(elapsedMs, audioMs, 200×)`(실측 224×보다 약간 보수적, 0.95 상한)를 1초 티커로 보고하고 완료 시 1.0으로 마감한다. 호출 중간 취소는 불가(최대 수십 초), 호출 전후에만 취소를 확인한다.
- `audio-compaction.ts` — I/O: VAD → plan → `.tmp`에 쓰고 검증 후 `rename`(원자적) → `<id>.channels.json` 재매핑 → 사이드카 기록. 어떤 실패도 `applied:false`로 흡수(취소만 전파).

**정책** (기본값 — 리서치 근거: faster-whisper VAD 기본 `min_silence_duration_ms=2000`, 편집 도구 관행, pyannote 경계 불연속 리스크)
- 침묵 판정은 VAD 발화 구간의 여집합. `padMs`(발화 앞뒤 여유, 200) 밖의 침묵 중 `minRemovableGapMs`(2000) 이상만 제거 대상이며, 제거 시 `keepGapMs`(600 — 화자분리 안정성을 위해 ≥0.5s)만큼의 **실제 오디오**(앞 절반은 직전 발화 뒤, 뒤 절반은 다음 발화 앞)를 남겨 룸톤을 유지한다. 디지털 무음(0)을 끼워 넣지 않는다 — whisper 환각·경계 클릭 방지. 접합부마다 `fadeMs`(8) 선형 fade-out/in을 건다(갭 길이보다 클릭이 더 위험). 파일 맨 앞/뒤 침묵은 `edgeMs`(300)만 남긴다.
- 라우드니스 정규화·하이패스·노이즈 억제는 **하지 않는다**. whisper는 [-1,1] 범위 안의 음량 차이에 대체로 불변이고, 노이즈 억제는 large 계열에서 WER을 오히려 높이며 pyannote DER도 악화시킨다는 보고가 있다(SciTePress 2024, arXiv 2603.04710, pyannote-audio #1053).
- 절감이 `minSavingsRatio` 미만이면 파일을 다시 쓰지 않는다(`applied:false`).
- 컷편집은 **첫 전체 처리에서 정확히 1회**(`audio_compacted` 멱등 가드). "빠른 재적용"(`skipTranscribe`)은 기존 세그먼트 타임스탬프를 재사용하므로 절대 컷편집하지 않는다. 이미 요약(면접 `qa_pairs.start_ms`)이 있는 회의를 전체 재처리하며 컷편집이 적용되면 그 시각을 `mapMsToCompacted`로 재매핑한다.
- 녹음 시작 화면의 "무음 구간 자동 제거"(`compact_audio`, 기본 on)로 회의별 opt-out 가능. 상세 화면은 `original_duration_ms`로 "무음 −mm:ss (n%)" 배지를 보여준다.
- `mic+system`의 채널 에너지 envelope(`<id>.channels.json`, 100ms hop)도 같은 keep 구간으로 재매핑해 화자 귀속이 어긋나지 않게 한다.

**진행률 표시**: main은 phase별 0~1을 보낸다(compact: VAD 0→0.85, 쓰기 0.95, 사이드카 1.0 / transcribe: 어댑터가 직접 VAD를 돌리면 0→0.08 뒤 전사 0.08→1). 렌더러 `utils/processing-progress.ts`가 phase 가중치(compact .10 / transcribe .55 / vad .02 / diarize .25 / merge .03 / summarize .05)로 **전체 진행률**을 계산해 바에 표시하고, phase 경과 시간을 함께 보여준다. 메시지 전용 스트림 이벤트(`progress` 없음)는 직전 진행률을 유지한다(`mergeProcessingEvent`) — 예전엔 이 이벤트가 진행률을 0으로 되돌렸다.

## 12. 인식 보조 장치 (용어집 · 구성원)

회사 기밀을 코드에 두지 않는다. 구조만 제공하고 내용은 사용자가 입력하며, **로컬 SQLite에만** 저장된다. whisper initial_prompt는 로컬 추론에만 쓰이고, 요약 단계에서는 참석자 이름·용어가 전사록과 함께 Claude로 전송된다(전사록이 이미 가는 경로와 동일).

| 보조 장치 | 저장 | 사용처 |
|---|---|---|
| 용어집 `stt_glossary` (정답 표기 · 오인식 표기 aliases · 메모 · 우선순위 · 프로젝트 범위) | 로컬 DB | ① `buildInitialPrompt({glossaryTerms})` — 프롬프트 **끝**에 ` 용어: A, B, C.`(최대 15개·120자, 전체 360자; whisper는 마지막 224토큰만 반영하므로 끝이 가장 중요, alias는 넣지 않는다) ② `applyGlossary(segments, rules)` 결정론적 후보정 ③ 요약 `[참고 정보]` 블록 |
| 구성원 `meeting_members` (이름 · 호칭/별칭 · 역할) + 회의별 참석자 `meeting_attendees` | 로컬 DB | ① 프롬프트 참석자 힌트(`speakerNames`에 합류) ② 녹음 시작 시 참석 인원 자동 제안 ③ `SpeakerEditor` 이름 프리셋 ④ 요약 `[참고 정보]`의 담당자 매칭 |

**후보정 규칙(`stt/glossary-correct.ts`)** — 오치환 방지가 우선: alias 2자 이상, term과 동일한 alias 제외, 긴 alias 우선. 라틴/숫자 alias는 대소문자 무시 + 양쪽 영숫자 경계. 한글 포함 alias는 경계 없음(조사 결합 허용: "링크워크를"→"LinkWork를"), 3자 이상이면 문자 사이 공백 0~1개 허용("링크 워크"). 이미 정답 표기인 부분은 재치환하지 않는다. 사용자 수정 플래그 `text_corrected`는 건드리지 않는다.

**서비스(`recognition-aids.ts`)**: `listGlossary/upsertGlossary/removeGlossary/importGlossaryText(parseGlossaryText)/listMembers/upsertMember/removeMember/setAttendees/listAttendees/loadPromptContext/buildSummaryContextBlock`. `loadPromptContext(db, meetingId)`는 `meetings.project_id`로 범위 필터(전역 + 해당 프로젝트), `priority DESC, updated_at DESC`, 실패 시 빈 컨텍스트(throw 금지).

**UI**: 녹음 목록 헤더 "인식 보조" → `RecognitionAidsPanel`(용어집/구성원 탭, 텍스트 가져오기 `정답 | 별칭1, 별칭2 | 메모`). 녹음 시작 화면 참석자 칩, 상세 화면 참석자 칩 편집.

**향후 후보(미구현)**: whisper.cpp는 hotword/keyword boosting이 없어 prompt·후보정으로만 대응한다. LLM 후보정 패스(요약 시 표기 교정 목록 회수), 오디오 정규화는 근거가 확인되면 §11 파이프라인에 추가한다.

## 13. 파이프라인 버전과 요약 재생성

전체 처리(`!skipTranscribe`)가 merge 트랜잭션에서 `meetings.pipeline_version = CURRENT_PIPELINE_VERSION`(meeting-pipeline.ts, 현재 **2** = 무음 컷편집 + 용어집 후보정/프롬프트 힌트 + 참석자 힌트)을 기록한다. 빠른 재적용은 컷편집·재전사를 하지 않으므로 값을 유지한다. 파이프라인 동작이 결과에 영향을 줄 만큼 바뀌면 이 상수를 올린다.

상세 화면의 "AI 요약 다시 생성"(면접: "면접 기록 다시 정리")은 `needsFullReanalysis(meeting)`(= `pipeline_version < 2`, MeetingDetail.tsx)로 분기한다:
- **구 파이프라인 회의** → "다시 분석 후 요약 생성": 전체 재처리(컷편집 → 용어집·참석자 힌트로 재전사 → 후보정 → 화자분리) 후 자동 요약. 수동으로 고친 발언·화자 지정은 초기화된다(merge가 세그먼트를 재생성).
- **현재 파이프라인 회의** → 요약만 재생성(전사·수동 수정 보존, `[참고 정보]` 블록은 항상 반영).
"전체 다시 처리"는 버전과 무관하게 항상 재전사 + 요약 재생성이다(`recordingStore.reprocessMeeting`이 성공·전사 시 `summarizeMeeting`을 호출).
