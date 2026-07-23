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
                                                   1) (필요시) webm→16k mono wav
                                                   2) STT  (stt/)        → raw segments
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
1. **비파괴(non-destructive)**: 원본 오디오는 불변. 침묵/필러 컷은 `cuts[]` 메타데이터로만 저장(`enabled` 토글). 화자 보정은 `segments`/`speakers`에 반영하되 원본 시간축(`start_ms`)은 보존.
2. **시간은 항상 원본 절대 ms**. (whisper.cpp 타임스탬프 재배치 함정 회피)
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
  summary: MeetingSummary | null
}

/** 처리 진행률 스트림 (recording:stream) */
export interface RecordingStreamEvent {
  meetingId: number
  // 'cancelled' — 사용자 취소로 파이프라인이 중단됨(에러와 구분되는 중립 종료)
  phase: 'transcribe' | 'diarize' | 'vad' | 'merge' | 'summarize' | 'done' | 'error' | 'cancelled'
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
  }) => Promise<{ id: number }>
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

`env.d.ts`의 `Window.api`에 `recording: RecordingAPI` 추가.

## 4. IPC 채널 계약 (recording.ipc.ts → preload)

| 채널 | 인자 | 반환 |
|---|---|---|
| `recording:list` | — | `Meeting[]` |
| `recording:get` | `id` | `MeetingDetail \| null` |
| `recording:createDraft` | `{title?, source?, kind?, expected_speakers?}` | `{id}` |
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

preload: 다른 API와 동일하게 `ipcRenderer.invoke`, `onStream`은 `ipcRenderer.on('recording:stream', ...)` + cleanup 반환.

## 5. 어댑터 인터페이스 (main/services)

가용성 우선순위로 팩토리가 선택. 네이티브 미설치/실패 시 폴백.

```ts
// stt/index.ts
export interface SttSegment { start_ms: number; end_ms: number; text: string; confidence?: number }
export interface SttAdapter {
  readonly name: string
  isAvailable(): Promise<boolean>
  transcribe(wavPath: string, opts: { language: string; prompt?: string; signal?: AbortSignal; onProgress?: (p: number) => void }): Promise<SttSegment[]>
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
1. 오디오 로드 → (필요시) 16k mono wav 변환. ffmpeg 없으면 원본 사용 시도, 실패 시 명확한 에러.
2. `stt.transcribe` → raw segments (phase:transcribe, progress)
3. `vad.detectSilence` → cuts[] (phase:vad)
4. `diar.diarize` → turns (phase:diarize). 폴백은 채널 기반.
5. **merge**: 각 STT segment를 겹치는 diar turn의 speaker_key에 귀속. speakers[] 생성(중복 key 통합, 색상/라벨 부여). (phase:merge)
6. DB 저장(meeting_speakers, meeting_segments, meeting_cuts), meeting.status='transcribed'.
7. 실패 시 status='failed', error 기록, phase:error.

모든 네이티브 의존성은 **optionalDependencies + lazy import**. 미설치여도 import 에러가 앱을 죽이지 않도록 try/catch. 폴백 어댑터로 파이프라인은 항상 완주.

## 6. AI 요약 (meeting-summary.ts)

`ai-agent.ts`의 인프라(SDK lazy load, `findClaudeExecutable`, `sanitizedEnv`, `settingSources:[]`, `cwd`)를 **재사용**하되, MCP 도구 없이 단순 텍스트→JSON query. 회의 요약은 데이터 조회가 아니라 변환이므로 `allowedTools:[]`, `mcpServers` 없음.

- 입력: 전사본을 `[mm:ss] 화자명: 텍스트` 라인들로 직렬화(긴 회의는 청크/길이 가드 — 너무 길면 앞부분 우선 + 길이 상한).
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
components/recording/
  RecordingView.tsx           # 좌: 목록 + 종류 필터(전체/회의/면접), 우: 상세
  RecorderControls.tsx        # 종류(회의/면접) + 소스 선택, 시작/일시정지/종료 + 레벨미터
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
