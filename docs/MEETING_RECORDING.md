# 회의 녹음과 회의록

> 회의 녹음 기능(녹음 → 전사 → 화자 분리 → AI 요약 → 할 일 등록)과 회의록 메뉴의 계약 문서다.
> 데이터 모델 · IPC 채널 · 어댑터 인터페이스를 바꾸면 이 문서를 함께 고친다.

## 0. 목표와 결정

- **STT**: 로컬 Whisper(`@fugood/whisper.node` + `large-v3-turbo` q8_0, 모델은 첫 실행 때 `userData/models/`로 내려받는다). API 키를 쓰지 않는다.
- **녹음 소스**: 마이크 + 시스템 오디오. **마이크=L / 시스템=R 스테레오로 나눠 저장**해 모델 없이도 2화자(나/상대)를 얻는다.
- **화자 분리**: 다자 자동 분리(`sherpa-onnx-node`) + **수동 보정**.
- **범위**: 녹음 → 전사 → 시간대별 타임라인 → AI 요약(회의 5분류 / 면접 4분류) → 액션아이템을 할 일로 등록.
- **AI 요약**: Claude Code 구독 로그인(`query()`)을 쓴다. 추가 과금이 없다.

## 1. 아키텍처 개요

```
[Renderer]                          [Main]
RecordingView ── recordingStore ──IPC──► recording.ipc.ts
  │  recorderStore (getUserMedia + 시스템오디오 loopback       │
  │   + WebAudio 믹싱 mic=L/sys=R → MediaRecorder webm/opus) │
  │  utils/audio.ts blobToWav16kMono (Web Audio 디코드·리샘플) │
  │   → 16k mono WAV + 채널 에너지(<id>.channels.json)       │
  │   (변환 실패 시 원본 webm 그대로 저장)                    ▼
  └─ ArrayBuffer 업로드 (recording:saveAudio) ──► recording.ipc.ts
                                                   userData/recordings/<id>.wav (폴백 시 .webm)
                                                          │
                          recording:process ──► meeting-pipeline.ts
                                                   0) compact (audio-compaction.ts) → 긴 침묵 제거한 WAV로 교체 (§11)
                                                   1) STT  (stt/)        → raw segments (어댑터가 전사용 VAD를 직접 실행)
                                                      → cleanSegments → filterHallucinations → applyGlossary (§5-2, §12)
                                                   2) VAD  (vad/)        → cuts[] (silence)
                                                   3) Diar (diarization/)→ speaker turns (+ note 안내) → 후처리
                                                   4) merge → segments[] + speakers[] (최근접 귀속 + 화자 속성 승계)
                                                   진행률: recording:stream 이벤트
                                                          │
                          recording:summarize ──► meeting-summary.ts
                                                   Claude query(전사 → 종류별 JSON)
                                                          │
                          recording:actionItemToTodo ──► todos 행 추가
```

**설계 원칙**
1. **컷편집 뒤에는 비파괴**: 녹음 파일은 첫 처리 직전 **무음 컷편집을 정확히 1회** 거쳐 교체되고(§11, 컷편집본이 그 녹음의 파일이 된다), 그 뒤로는 바뀌지 않는다. 제거한 구간은 `<id>.compaction.json` 사이드카에 남긴다. 짧은 침묵 컷은 `meeting_cuts` 메타데이터로만 저장한다(`enabled` 토글). 화자 보정은 `segments`/`speakers`에 반영하되 시간축(`start_ms`)은 보존한다.
2. **시간은 항상 (컷편집된) 파일의 절대 ms**다.
3. **어댑터 패턴**: STT/화자 분리/VAD는 인터페이스로 추상화한다. 네이티브 엔진이 없거나 실패하면 **폴백 어댑터**로 내려가며, 앱은 항상 빌드·동작한다.
4. **화자 자동 분리는 "초안"**이다. 수동 보정 도구를 1급 기능으로 둔다.

## 2. 데이터 모델 (SQLite)

`meetings`·`meeting_speakers`·`meeting_segments`·`meeting_cuts`·`meeting_summaries`는 `src/main/db/schema.ts`, 인식 보조 테이블(`stt_glossary`·`meeting_members`·`meeting_attendees`)은 `src/main/services/recognition-aids.ts`의 `RECOGNITION_AIDS_SCHEMA`가 만든다. 모두 `CREATE TABLE IF NOT EXISTS`이고, 뒤에 붙은 컬럼은 `PRAGMA table_info` 확인 후 `ALTER TABLE`로 추가한다.

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
  expected_speakers INTEGER,                  -- 참석 인원(화자 분리 클러스터 수). NULL=자동
  compact_audio INTEGER NOT NULL DEFAULT 1,   -- 처리 시 무음 컷편집 수행 여부(녹음 시작 시 선택, §11)
  audio_compacted INTEGER NOT NULL DEFAULT 0, -- 컷편집이 실제 적용됐는지(멱등 가드)
  original_duration_ms INTEGER,               -- 컷편집 전 길이(NULL=미적용)
  pipeline_version INTEGER NOT NULL DEFAULT 0,-- 처리 파이프라인 버전(§13). 전체 처리 시 기록
  project_id INTEGER,                         -- 옛 프로젝트 귀속. 컬럼만 남고 쓰지 않는다
  calendar_event_id TEXT,                     -- 옛 캘린더 매칭. 새로 채우지 않는다
  calendar_event_title TEXT,                  -- 녹음 목록 카드 표시, 전사 초기 프롬프트, 비서의 회의 매칭에 쓴다
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
  start_ms INTEGER NOT NULL,                  -- 파일 기준 절대 시간
  end_ms INTEGER NOT NULL,
  speaker_id INTEGER,                         -- meeting_speakers.id (FK, null 허용)
  text TEXT NOT NULL DEFAULT '',
  confidence REAL,                            -- 항상 NULL(whisper.node 바인딩이 신뢰도를 내보내지 않음, §5-1)
  speaker_corrected INTEGER NOT NULL DEFAULT 0, -- 사용자가 화자를 바꿨는지
  text_corrected INTEGER NOT NULL DEFAULT 0,  -- 사용자가 발언 텍스트를 고쳤는지(recording:updateSegmentText)
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
  note TEXT,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS meeting_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL UNIQUE,
  tldr TEXT,                                  -- 한 줄/문단 요약 (면접에서는 '면접 개요')
  -- 회의(kind='meeting') 전용 4개 컬럼(key_points 포함). 면접 요약 시 '[]'로 덮어쓴다.
  key_points TEXT,                            -- JSON string[]
  decisions TEXT,                             -- JSON string[]
  action_items TEXT,                          -- JSON ActionItem[]
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
  project_id INTEGER,                         -- 옛 프로젝트 범위. 컬럼만 남고 모든 용어는 전역이다
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

## 3. 공용 타입

렌더러 타입은 `src/renderer/src/types/index.ts`에 있다: `MeetingStatus`, `MeetingSource`(`'mic' | 'mic+system'`), `MeetingKind`(`'meeting' | 'interview'`), `Meeting`(위 `meetings` 행), `MeetingSpeaker`, `MeetingSegment`, `MeetingCut`, `ActionItem`, `InterviewQaPair`, `InterviewCompetency`, `MeetingSummary`(JSON 컬럼을 배열로 푼 형태), `MeetingDetail`, `RecordingStreamEvent`, `ChannelEnergy`, `GlossaryEntry`, `Member`, `Attendee`, `RecordingAPI`, `RecorderBridgeAPI`, `RecognitionAidsAPI`, `MeetingNoteFilter`, `MeetingNoteItem`, `MeetingNotesAPI`.
메인 쪽 어댑터·요약 타입은 `src/main/services/meeting-types.ts`에 있다.

꼭 지켜야 하는 형태:

```ts
interface ActionItem {
  text: string
  assignee?: string | null
  due?: string | null        // AI 가 준 원문. 'YYYY-MM-DD' 형식일 때만 할 일의 due_date 가 된다(§7)
  speaker_id?: number | null
  source_segment_id?: number | null
  todo_id?: number | null    // 할 일로 등록하면 채운다
}

interface InterviewQaPair {
  question: string
  answer_summary: string
  start_ms: number | null    // AI 는 "mm:ss"로 답하고 main 이 ms 로 바꾼다(§6-2)
  quote?: string | null
}

interface MeetingDetail {
  meeting: Meeting
  speakers: MeetingSpeaker[]
  segments: MeetingSegment[]
  cuts: MeetingCut[]
  summary: MeetingSummary | null
  attendees: Attendee[]
}

/** 처리 진행률 스트림 (recording:stream) */
interface RecordingStreamEvent {
  meetingId: number
  // 'compact' — 무음 컷편집(§11). 'cancelled' — 사용자 취소로 파이프라인이 멈춤(에러와 구분되는 중립 종료)
  phase: 'compact' | 'transcribe' | 'diarize' | 'vad' | 'merge' | 'summarize' | 'done' | 'error' | 'cancelled'
  progress?: number          // 0..1
  message?: string
  error?: string
}
```

## 4. IPC 채널 계약

`recording.ipc.ts` → preload `window.api.recording`:

| 채널 | 인자 | 반환 |
|---|---|---|
| `recording:list` | — | `Meeting[]` (`started_at DESC`) |
| `recording:get` | `id` | `MeetingDetail \| null` |
| `recording:createDraft` | `{title?, source?, kind?, expected_speakers?, attendee_ids?, compact_audio?}` | `{id}` |
| `recording:discardDraft` | `id` | `{success}` (오디오가 없는 `status='recording'` 행만 지운다. 그 외는 `false`) |
| `recording:saveAudio` | `id, ArrayBuffer, {mime, durationMs}, channelEnergy?` | `{path}` |
| `recording:process` | `id, {skipTranscribe?}?` | `{success, error?}` |
| `recording:cancel` | `id` | `{success}` (활성 파이프라인 abort, 완료는 stream phase `cancelled`) |
| `recording:summarize` | `id` | `{success, error?}` |
| `recording:rename` | `id, title` | `{success}` |
| `recording:remove` | `id` | `{success}` |
| `recording:updateSpeaker` | `speakerId, {display_name?, color?, label?}` | `{success}` |
| `recording:reassignSegment` | `segmentId, speakerId \| null` | `{success}` |
| `recording:updateSegmentText` | `segmentId, text` | `{success}` (`text_corrected=1`) |
| `recording:addSpeaker` | `meetingId, name` | `{success, id?, existed?, error?}` (같은 이름이 있으면 그 화자를 쓴다) |
| `recording:mergeSpeakers` | `meetingId, from, into` | `{success}` |
| `recording:toggleCut` | `cutId, enabled` | `{success}` |
| `recording:actionItemToTodo` | `meetingId, index` | `{todo_id}` |
| `recording:setExpectedSpeakers` | `id, n \| null` | `{success}` (0 이하·null 은 자동 추정) |
| `recording:setAttendees` | `meetingId, memberIds[]` | `{success}` (`meeting_attendees` 교체) |
| 이벤트 `recording:stream` | (main→renderer) `RecordingStreamEvent` | — |

`recording:get`은 `attendees`를 함께 돌려준다. `recording:remove`는 오디오·`<id>.channels.json`·`<id>.compaction.json`을 모두 지운다.

녹음기 브리지(preload `window.api.recorder`, §14): `recorder:state`(renderer→main, `{active, draftId}`), `recorder:command`(main→renderer, `stop-and-save`), `recorder:command-done`(renderer→main, 결과).

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

## 5. 어댑터 인터페이스 (main/services)

인터페이스는 `meeting-types.ts`에 있고, 팩토리가 가용성 순서로 고른다. 네이티브가 없거나 실패하면 폴백한다.

```ts
interface SttAdapter {
  readonly name: string
  isAvailable(): Promise<boolean>
  // speechRegionsMs: 이미 검출한 발화 구간. 주어지면 어댑터는 VAD를 다시 돌리지 않는다.
  //   파이프라인은 컷편집 단계(§11)의 구간을 넘기지 않는다(컷편집용 VAD 임계값이 낮아 잡음 구간까지 포함).
  transcribe(audioPath: string, opts: { language: string; prompt?: string; speechRegionsMs?: { startMs: number; endMs: number }[]; signal?: AbortSignal; onProgress?: (p: number) => void; onMessage?: (m: string) => void }): Promise<SttSegment[]>
}
// stt/index.ts getSttAdapter(): whisper-adapter (lazy import '@fugood/whisper.node') → manual-adapter (폴백: 빈 결과)

interface DiarizationAdapter {
  readonly name: string
  isAvailable(): Promise<boolean>
  diarize(audioPath: string, opts: { minSpeakers?; maxSpeakers?; numSpeakers?; source?; segments?: SttSegment[]; signal?: AbortSignal }): Promise<DiarTurn[]>
}
// 구현: sherpa-adapter (워커 프로세스에서 'sherpa-onnx-node'), channel-adapter (mic=L/sys=R 채널 에너지로 2화자 — 모델 불필요)
// 오케스트레이션: diarization/index.ts diarizeWithFallback(audioPath, opts) → { turns, adapter, note? }
//   adapter: 'two-stage' | 'channel' | 'sherpa' | 'none'  ('none' = 빈 turns, merge 가 단일 화자 spk_0 로 귀속)
//   note: 사용자에게 보여줄 한국어 한 문장. 강등(모델 준비 실패·sherpa 실패·빈 결과·2-스테이지 강등)이나
//         centroid 병합으로 화자 수가 줄었을 때만 채운다(diarization/notes.ts).

interface VadAdapter {
  readonly name: string
  detectSilence(audioPath: string, opts?: { minSilenceMs?: number }): Promise<VadRegion[]>
}
// vad/index.ts getVadAdapter(): silero-adapter → gap-adapter (폴백: STT 세그먼트 사이 공백으로 침묵 추정)
```

**오디오 변환**: main에는 변환 단계가 없다. 렌더러가 저장 전에 `utils/audio.ts`의 `blobToWav16kMono`(Web Audio 디코드·리샘플)로 webm/opus를 16kHz mono 16-bit WAV로 바꾸고 채널 에너지(`<id>.channels.json`)를 함께 만든다. 변환이 실패하면 원본 webm을 그대로 저장하며, 이 경우 컷편집은 적용되지 않는다(§11, WAV 전용, §15).

**파이프라인(meeting-pipeline.ts)**: `process(id)`
0. **compact** (phase:compact, §11): `!skipTranscribe && compact_audio=1 && audio_compacted=0 && WAV`일 때만 `compactRecording` → 적용되면 파일 교체 + `duration_ms`/`original_duration_ms`/`audio_compacted=1` 갱신 + 기존 세그먼트·컷·면접 요약 `qa_pairs[].start_ms` 재매핑(`remapExistingTimelines`). 실패/미적용은 치명적이지 않다(원본으로 계속). 컷편집이 검출한 발화 구간은 STT에 넘기지 않는다(§11).
1. `buildInitialPrompt(...)`로 initial_prompt를 조립한다(STT 실행 여부와 무관 — 빠른 재적용의 환각 필터도 같은 값을 쓴다).
2. `stt.transcribe` → raw segments (phase:transcribe, progress) → `cleanSegments` → `filterHallucinations(segments, { prompt })` → `applyGlossary`(§12) → WAV 길이 클램프. 정제 3단계는 `skipTranscribe` 경로에도 적용된다(단, 사용자가 고친 발언은 건너뜀 — §5-4).
3. `vad.detectSilence` → cuts[] (phase:vad)
4. `diarizeWithFallback` → turns (phase:diarize). `note`가 있으면 스트림 메시지로 보낸다. `diarizeWithFallback` 자체가 throw하면(취소 제외) 단일 화자로 계속하고 "화자분리에 실패해 화자를 구분하지 않았습니다. (원인)"을 보낸다. 이어서 `postprocessTurns`(옵션 분기는 §5-3).
5. **merge**: 각 STT segment를 speaker_key에 귀속(§5-4 규칙). speakers[] 생성(중복 key 통합, 색상/라벨 부여 + 옛 화자 속성 승계). (phase:merge)
6. DB 저장(meeting_speakers, meeting_segments, meeting_cuts — 트랜잭션으로 삭제 후 재삽입), meeting.status='transcribed'.
7. 실패 시 status='failed', error 기록, phase:error.

### 5-1. STT 전사 (stt/whisper-adapter.ts)
- 언어는 `meetings.language`(현재 항상 `ko`, 선택 UI 없음 — §15).
- 전사용 VAD: 어댑터가 (컷편집된) 파일에 silero VAD를 기본 임계값 0.5(`VAD_PARAMS.threshold`)로 직접 돌려 발화 구간만 전사한다. VAD 실패·포맷 불일치 시 전체 파일 전사로 폴백.
- **세그먼트 분할**: 화자 귀속이 세그먼트 단위라 긴 세그먼트 안의 화자 교대가 사라진다. 그래서 `tokenTimestamps: true` + `maxLen: 30`(`SEGMENT_MAX_LEN`, UTF-8 글자 수)으로 세그먼트를 짧게 자른다. whisper.node 1.0.22는 `tokenTimestamps`가 true일 때만 `maxLen`을 적용한다. 분할로 흔들릴 수 있는 타임스탬프는 `stt/segment-split.ts`의 `sanitizeSegmentTimes`가 보정한다(음수·역전·상한 초과, start 오름차순).
- **깨진 글자 방어**: 분할 결과에 U+FFFD가 든 세그먼트가 있으면(토큰 경계가 한 글자의 UTF-8 바이트 중간에 걸린 경우, `hasBrokenText`) 해당 호출만 분할 옵션 없이 정확히 1회 다시 전사해 그 결과를 쓴다. 더 반복하지 않는다.
- **실측 근거**(2026-11-18, 실제 녹음 3건 · 28초 청크 128개 · 약 60분, whisper.node 1.0.22 + large-v3-turbo-q8_0, `tokenTimestamps:true, maxLen:30` 유무 비교): 최장 세그먼트 12~16초 → 7.5~8초, 세그먼트 수 +8~13%, 처리 시간 차이 없음, 비정상 타임스탬프 0건. 깨진 글자(U+FFFD)는 한 파일에서 세그먼트 566개 중 8개 발생(나머지 두 파일은 0건)해, 위의 "감지 시 해당 호출만 옵션 없이 1회 재전사" 방어를 둔 근거가 됐다.
- `beamSize: 5`를 넘기지만 whisper.node 1.0.22는 샘플링 전략을 greedy로 고정해 **적용되지 않는다**(사실상 greedy).
- 신뢰도: 바인딩이 토큰/세그먼트 확률을 내보내지 않아 `confidence`는 항상 NULL이다.

### 5-2. 정제 (transcript-cleaner.ts → stt/hallucination-filter.ts → stt/glossary-correct.ts)
- `cleanSegments`: filler-only·한 글자 단독 발화 제거. 단 응답어 한 글자(`네`/`예`/`응`/`넵`/`넹`/`옙`)는 보존한다. 인접 동일 발화 병합은 정규화 8자 초과면 2회째부터, **8자 이하 짧은 발화는 3회 연속째부터**만 병합한다(2회까지는 다른 사람의 응답일 수 있음). 근접 윈도 dedup(직전 K개·30초 이내 재등장 제거)에서도 8자 이하 짧은 발화는 제외한다. 문장 내 반복 축약은 반복 단위가 숫자·구두점·공백뿐이면 하지 않는다("10000000" 훼손 방지).
- `filterHallucinations(segments, { prompt })` → `{ segments, removed }`: 세그먼트 **전체**가 알려진 환각 문구(들)로만 이루어졌을 때만 제거하는 블록리스트("시청해주셔서 감사합니다", "구독과 좋아요" 등 — 부분 포함은 보존), 그리고 initial_prompt 에코(프롬프트 조각과 전체 일치, 또는 프롬프트의 10자 이상 연속 부분 문자열) 제거. `removed > 0`이면 "환각 의심 문구 N건 제거"를 보낸다. 블록리스트는 자체 수집 목록이라 보수적으로 유지한다.
- `applyGlossary`: §12.

### 5-3. 화자분리 (diarization/)
- 폴백 체인: (mic+system·참석 인원 3명 이상 지정) 2-스테이지 재정합 → (mic+system) 채널 분리 → sherpa → none.
- sherpa 클러스터링은 (1 − cosine) 거리의 complete linkage AHC이고 `threshold`는 덴드로그램을 자르는 높이다 — **클수록 화자 수가 줄어든다**(공식 기본 0.5, 앱은 과분할 완화를 위해 자동 추정 시 0.85). 참석 인원을 지정하면 `numClusters`로 정확히 그 수로 나눈다.
- **자동 추정 모드 전용 centroid 정제**(worker.ts `refineByCentroid` → embedding-merge.ts `planIterativeCentroidMerge`, 3D-Speaker `merge_by_cos`/`filter_minor_cluster` 방식): 화자별 대표 오디오(최대 24초, `REP_MAX_SEC`)로 CAM++ 임베딩 centroid를 구한 뒤 다음 순서로 정제한다.
  1. **반복 병합**: 현재 클러스터 중 centroid 코사인 유사도가 최대인 쌍이 0.8(`MERGE_COS_THRESHOLD`) 이상인 동안 그 한 쌍만 병합하고 centroid를 가중 평균으로 다시 계산한다(연쇄 과병합 없음).
  2. **소수 클러스터 재할당**: 누적 발화가 `max(4초, 전체 발화 시간 × 1%)`(`MINOR_SPEAKER_SEC`, `MINOR_SPEAKER_RATIO`) 미만인 클러스터를 주요 화자로 보낸다. centroid가 있으면 가장 유사한 주요 화자로, centroid가 없으면(누적 0.4초 미만 조각, `REP_MIN_SEC`) 발화량이 가장 많은 주요 화자로 보낸다. 주요 화자가 하나도 없으면 재할당하지 않는다.
  3. **상한 10명**(`MAX_AUTO_SPEAKERS`): ② 뒤에도 centroid 있는 클러스터가 10개를 넘을 때만 발동하는 안전장치로, 가장 유사한 쌍부터 더 병합한다. 상한을 ②보다 먼저 적용하면 조각 화자는 누구와도 닮지 않아 남고 실제 주요 화자끼리 합쳐진다(실측: 23분 회의가 2명으로 뭉개짐) — 그래서 반드시 마지막 단계다.
  
  화자 수가 줄면 `note`로 "유사한 화자 N명을 M명으로 병합했습니다."를 알린다. **인원을 지정하면 병합·재할당을 하지 않는다.**
  
  실측(2026-11-18, 실제 녹음 4건, sherpa-onnx-node 1.13.3, threshold 0.85 자동 추정): sherpa 원시 화자 수 37 / 23 / 30 / 97명 → 정제 후 8 / 2 / 4 / 6명(각각 23분 / 20분 / 60분 / 98분 녹음). 라벨이 없어 정답 화자 수는 확인하지 못했다 — 이 수치는 "조각 화자가 정리된다"는 근거일 뿐 정확도 근거가 아니다. 처리 시간(화자분리)은 측정 스크립트 기준(segmentation·embedding 각각 `numThreads` 4) 23분 녹음 51초, 98분 녹음 231초다. 앱 워커는 각각 `numThreads` 2라 이보다 더 걸릴 수 있다. 참고로 앱 워커 설정 그대로 테스트 인스턴스에서 8분 클립 전체 처리(전사+화자분리)는 48초였다.
- sherpa 워커 타임아웃은 30분(`DEFAULT_WORKER_TIMEOUT_MS`)이다.
- **후처리 옵션 분기**(`speaker-assign.ts`의 `resolvePostprocessOptions({ adapter, expectedSpeakers })`, `postprocess.ts`는 그대로):
  | 조건 | smoothing | 소수 화자 흡수 |
  |---|---|---|
  | adapter `channel`/`two-stage` | 같은 화자 병합만(`minTurnMs 0, sandwichMs 0, gapFillMs 500`) — 채널 에너지로 확정한 짧은 발화 보존 | 끔 |
  | 그 외(sherpa 등) | `minTurnMs 200, sandwichMs 300, gapFillMs 500` — 같은 화자 사이에 낀 "네" 같은 짧은 응답 보존 | 켬(`minRatio 0.02, minDurationMs 60000`) |
  | 참석 인원 지정(`expected_speakers > 0`) | 위 adapter 기준 | 끔(지정 인원이 9→5처럼 줄어드는 현상 방지) |

### 5-4. merge — 화자 귀속과 속성 승계 (speaker-assign.ts, speaker-carryover.ts)
- **귀속(`assignSpeaker`)**: 겹침이 가장 큰 turn의 화자. 겹침이 같으면 먼저 나온 turn. 어떤 turn과도 겹치지 않으면 **시간상 가장 가까운 turn**(구간 사이 간격 최소)의 화자. turns가 없으면 `spk_0`.
- **화자 속성 승계(`planSpeakerCarryover`)**: merge 트랜잭션이 지우기 직전의 옛 세그먼트(시간 + speaker_id)와 새 귀속 결과(시간 + speaker_key)를 시간 겹침으로 대조한다. 새 화자 키마다 겹침이 가장 큰 옛 화자가 새 화자 발화 시간의 **과반(>50%)**을 차지하면 그 옛 화자의 `display_name`·`color`·사용자가 바꾼 `label`(키·순서로 만든 기본 라벨과 다를 때)을 이어받는다. 한 옛 화자는 겹침이 가장 큰 새 화자 한 명에게만 승계한다. 승계 대상이 없는 새 화자는 기본값(`resolveSpeakerMeta`). 전체 재처리·빠른 재적용 모두 적용된다. 이번 처리에서 컷편집이 적용됐으면 옛 세그먼트 시각은 이미 `remapExistingTimelines`가 새 타임라인으로 옮겨 두었다.
- **빠른 재적용(`skipTranscribe`) 전용 — 수동 보정 보존**:
  - `text_corrected=1` 세그먼트는 정제·환각 필터·용어집 후보정을 건너뛰고 원문 그대로 유지하며, 플래그도 1로 다시 저장한다.
  - `speaker_corrected=1` 세그먼트는 자동 귀속을 무시하고 사용자가 지정했던 옛 화자를 유지한다(`matchCorrectedSpeakers` + `planSpeakerRows`). 그 옛 화자가 승계로 새 화자에 매핑됐으면 그 새 화자 행에, 아니면 옛 행을 별도 화자 행으로 다시 만들어(`speaker_key`·`label`·`display_name`·`color` 보존) 연결하고 `speaker_corrected=1`로 저장한다. 정제가 세그먼트를 병합·삭제하므로 정제 전후 대응은 시간 기준(겹침이 새 세그먼트 길이의 과반)이며, 대응을 못 찾으면 그 보정 정보는 버린다.
  - 기존 전사가 오디오 길이와 어긋나 전체 재전사로 폴백하면 수동 보정 보존은 하지 않는다(속성 승계만 시도).

## 6. AI 요약 (meeting-summary.ts)

Claude Agent SDK의 `query()`를 Claude Code 구독 로그인으로 부른다. SDK lazy load, 실행 파일 찾기, 환경 변수 정리, `toFriendlyError`(미로그인·미설치 안내)는 `ai-agent.ts`와 같은 방식으로 이 파일 안에 따로 둔다. 요약은 데이터 조회가 아니라 변환이므로 도구를 모두 끈다(`tools: []`, `allowedTools: []`, `settingSources: []`, MCP 없음).

- 입력: 전사본을 `[mm:ss] 화자명: 텍스트` 줄로 직렬화한다(너무 길면 앞부분 우선 + 길이 상한). 앞에 `buildSummaryContextBlock(loadPromptContext(db, meetingId))`의 `[참고 정보]` 블록(참석자·용어집, §12)을 붙인다 — 비어 있으면 생략. `SummarySpec.buildPrompt(transcript, contextBlock)`.
- 시스템 프롬프트: 회의는 tldr·key_points·decisions·action_items·next_steps를 JSON으로만 내게 한다(추측·회의에 없는 내용 금지). 회의·면접 요약 시스템 프롬프트는 공통 조각 `src/main/services/writing-style.ts`의 ASD-STE100 글쓰기 규칙과 JSON 보조 안내를 포함하고, "순수 JSON만 출력" 문장을 마지막에 둔다.
- 출력 파싱: 응답에서 JSON 블록 추출(코드펜스 허용) → zod 검증 → `meeting_summaries` upsert.
- 진행률: phase:summarize, 완료 시 phase:done. 실패하면 친절한 오류 문구로 바꿔 보낸다.

### 6-1. 종류별 요약 스펙 (SummarySpec)

실행 인프라는 하나이고, **프롬프트 · 검증 · 저장만** `meetings.kind`로 갈아끼운다 (`summary-spec.ts`).

| kind | 스펙 | 위치 |
|---|---|---|
| `meeting` | `MEETING_SPEC` — 5분류 | `meeting-summary.ts` |
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

## 7. 액션아이템 → 할 일

`recording:actionItemToTodo(meetingId, index)`: `summary.action_items[index]`로 `todos` 행을 직접 만든다(`title=text`, `priority='medium'`). `due`가 `YYYY-MM-DD`(시각 허용) 형식일 때만 `due_date`에 넣고, 아니면 원문을 notes에 남긴다. notes는 `회의에서 추출: <회의 제목>`, `담당: <assignee>`, `기한: <원문>` 줄로 만든다. 만든 `todo_id`를 그 항목에 기록해 다시 등록하지 않게 하고, `logActivity('todo', 'create', …)`를 남긴다. 자동 등록하지 않고 사용자가 버튼을 눌러야 한다(오탐 방지).

## 8. 렌더러 구조

```
stores/recorderStore.ts        # MediaRecorder 래퍼·캡처 상태(idle|recording|paused|stopped)·레벨미터 (§14)
stores/recorderSession.ts      # 녹음 세션 수명주기 오케스트레이션 (§14)
stores/recordingStore.ts       # 목록/상세/처리 상태/스트림 구독, kindFilter
stores/recognitionAidsStore.ts # 용어집·구성원 CRUD (§12)
utils/audio.ts                 # blobToWav16kMono, 채널 에너지 추출
utils/processing-progress.ts   # phase 가중치로 전체 진행률 계산 (§11)
components/recording/
  RecordingView.tsx            # 좌: [새 녹음]으로 여는 녹음 컨트롤 + 종류 필터(전체/회의/면접) + "인식 보조" 패널 토글 + 목록, 우: 상세
  RecognitionAidsPanel.tsx     # 용어집/구성원 탭 편집 + 텍스트 가져오기 (§12). 설정 > 회의 녹음에도 같은 패널이 있다
  RecorderControls.tsx         # 종류(회의/면접) + 소스 선택 + 참석자 칩 + 무음 제거 체크, 시작/일시정지/종료 + 레벨미터
  RecordingList.tsx            # 녹음 카드 목록(상태 pill, 면접 배지), kindFilter 적용
  MeetingDetail.tsx            # 헤더(제목/날짜/상태) + 탭(타임라인/요약/화자), kind별 패널 분기
  SpeakerTimeline.tsx          # 시간대별 화자 발언 (클릭→오디오 점프), 발언 수정, 컷 토글
  SummaryPanel.tsx             # [회의] 5분류 + 액션아이템 "+ TODO" 버튼
  InterviewPanel.tsx           # [면접] Q&A(클릭→질문 시점 재생)/근거/추가 확인/레퍼런스 체크
  SpeakerEditor.tsx            # 화자 실명 입력/색상/병합/세그먼트 재할당 (면접 프리셋 지원)
  AudioPlayer.tsx              # <audio> + seek, cuts enabled 구간 skip(비파괴)
```

디자인은 `components/ui/tokens.ts`(button/typo/status pill), `ui/index.tsx`(Card/Badge/IconButton/EmptyState/SectionTitle), `ui/icons.tsx`를 쓴다. 새 색이나 커스텀 CSS 없이 Tailwind v4 인라인 클래스 + 토큰으로 그린다.

메뉴는 회의·면접 통합 단일 메뉴(사이드바 "회의" 그룹의 `녹음`)다. 종류 구분은 목록 상단 필터 탭으로 하며, 선택값은 `recordingStore.kindFilter`에 둔다 — `RecordingView`가 메뉴 전환 시 언마운트되므로 로컬 state면 필터가 초기화된다.

흐름: `idle → (start) recording → (pause/resume) → (stop) → saveAudio → process → summarize`. 녹음 중엔 경과 시간/레벨미터를 보인다. 종료하면 저장 뒤 처리와 요약이 백그라운드로 이어진다(§14).

## 9. 네이티브 의존성 / 빌드

- `@fugood/whisper.node`, `sherpa-onnx-node`, `silero-vad-node`는 **optionalDependencies**다. `electron.vite.config.ts`가 메인 번들에서 외부화하고, 코드는 lazy import + try/catch로 불러 없으면 폴백 어댑터로 내려간다. 파이프라인은 항상 끝까지 돈다.
- 화자 분리는 메인 번들과 함께 빌드되는 워커(`out/main/diarization-worker.js`, `src/main/services/diarization/worker.ts`)를 `utilityProcess`로 띄워 돌린다.
- **시스템 오디오**: 추가 패키지 없이 Electron 내장 `session.setDisplayMediaRequestHandler` + `audio: 'loopback'`을 쓴다(`src/main/services/system-audio-loopback.ts`, 앱 시작 시 창 생성 전에 등록). Electron 39+는 macOS 14.2+에서 이를 CoreAudio Tap으로 지원하며 feature flag가 필요 없다. `loopbackWithMute`는 스피커를 음소거하므로 쓰지 않는다. 시스템 오디오 권한이 없으면 에러 없이 처음부터 ended인 트랙이 오므로 렌더러(`recorderStore`)가 `readyState === 'live'`인 트랙만 쓰고, 없으면 "시스템 오디오 권한이 없어 마이크만 녹음합니다."를 안내한다. 녹음 중 시스템 트랙이 끊기면 경고만 띄우고 마이크 녹음은 계속한다.
- **마이크 제약**: `echoCancellation: true`(스피커로 나온 상대 음성이 마이크(L)에 섞이는 것 방지), `noiseSuppression: false`(§11 정책 — 노이즈 억제는 whisper WER·화자 분리 DER을 악화시킨다는 보고가 있어 입력 단계에서도 끈다).
- `package.json` `build.asarUnpack`에 `**/*.node`와 `node_modules/sherpa-onnx-darwin-arm64/**`가 있다. Whisper·화자 분리 모델은 `userData/models/`에 런타임으로 내려받는다.
- `Info.plist`(electron-builder `mac.extendInfo`): `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`.

## 10. 회의록 메뉴

요약까지 끝난 회의·면접(`meetings.status='summarized'`)을 사이드바 "회의록"(ViewId `notes`)에서 문서처럼 목록·검색·열람하고 Markdown으로 복사·저장한다. 새 테이블은 없다. `meetings` + `meeting_summaries`(1:1) 조인과 `meeting_segments`·`meeting_attendees`·`meeting_members`만 읽는다(읽기 전용).

- 파일: `src/main/services/meeting-notes.ts`(순수 함수 `buildMeetingNoteMarkdown`, `countActionItems`, `escapeLike`, `parseJsonArray`), `src/main/ipc/meeting-notes.ipc.ts`, 렌더러 `components/notes/`(`MeetingNotesView`·`MeetingNoteList`·`MeetingNoteDoc`)와 `stores/meetingNotesStore.ts`.
- IPC (preload `window.api.meetingNotes`):

| 채널 | 입력 | 출력 |
|---|---|---|
| `meetingNotes:list` | `MeetingNoteFilter?` | `MeetingNoteItem[]` (`started_at DESC, id DESC`) |
| `meetingNotes:markdown` | `id: number` | Markdown 문자열 (회의 없으면 `''`) |

- 필터: `q`는 trim 후 비면 무시하고, `%`·`_`·`\`를 이스케이프(`ESCAPE '\'`)해 문자 그대로 찾는다. `kind`는 `'all'`(기본) | `'meeting'` | `'interview'`.
- 검색 범위(부분 일치 LIKE, OR): `m.title`, `s.tldr`, `s.key_points`, `s.decisions`, `s.action_items`, `s.next_steps`, `s.qa_pairs`, 그리고 전사 `meeting_segments.text`(EXISTS 서브쿼리). JSON 컬럼은 직렬화 문자열 그대로 검색한다.
- `MeetingNoteItem` 파생 값: `key_point_count`, `decision_count`, `action_item_count`(각 JSON 배열 길이), `open_action_count`(`todo_id`가 없는 액션아이템 수), `attendee_names`(정렬은 `listAttendees`와 같다).
- Markdown 구조: `# 제목` → 메타 줄(일시·길이·종류·참석자) → 회의는 `## TL;DR`, `## 핵심 포인트`, `## 결정사항`, `## 액션아이템`(`- [ ]`/`- [x]`=할 일로 옮김, 담당·기한), `## 다음 단계` / 면접은 `## 면접 개요`, `## 질문과 답변`(`### Qn. 질문 [mm:ss]`, 답변 요약, `> 인용`), `## 역량별 근거`, `## 후속 질문`, `## 확인 필요` → 마지막 `## 전사`(`[mm:ss] **화자**: 텍스트`). 빈 섹션은 생략한다.
- 문서 화면의 [Markdown 복사]는 클립보드에, 저장은 `export:saveMarkdown`(저장 대화상자)으로 파일에 쓴다.

## 11. 무음 컷편집 (audio compaction)

**목적**: 처리 전에 긴 침묵을 잘라 (a) whisper 청크 수(28초 창에 발화가 더 촘촘히) (b) sherpa 화자분리 입력 길이 (c) 파일 크기를 줄이고, 재생 시 침묵 스킵이 필요 없게 한다. **컷편집본이 그 녹음의 파일이 된다**(사용자 결정, 원본 별도 보관 없음). 제거한 구간은 `<id>.compaction.json` 사이드카(`{version, originalMs, compactedMs, removed[], params, compactedAt}`)에 남긴다.

**구성**
- `stt/audio-compactor.ts` — 순수 함수(단위 테스트 대상): `planCompaction(speech, audioMs, opts)`, `compactPcm16(wav, dataRange, keep)`, `remapChannelEnergy(env, keep)`, `mapMsToCompacted(ms, keep)`, `speechRegionsToCompacted(speech, keep)`. 기본 파라미터는 `DEFAULT_COMPACTION_OPTIONS` 한곳에 둔다.
- `stt/vad-detect.ts` — whisper.node silero VAD 검출 공용 함수 `detectSpeechRegions(audioPath, dataRange, opts)` (컷편집·STT 공용). `opts.threshold`로 발화 확률 임계값만 덮어쓸 수 있다(미지정·범위 밖이면 0.5). **반드시 `useGpu:false`**(Metal에서 ggml_abort로 앱 즉사 이력) + `.vad-crash-guard` 센티널 유지. **`initWhisperVad`는 반드시 `nThreads: 1`을 명시한다** — 기본값이 hardware_concurrency(12)인데 silero는 0.88MB 초소형 그래프라 프레임마다 12스레드를 동기화하는 비용이 연산을 압도해 사실상 멈춘다(실측 5초 오디오: nThreads 1=33ms, 2=43ms, 4=229ms, 기본값=60초 초과 미완료·CPU 482%). nThreads 1이면 전체 파일 검출이 길이에 선형으로 약 224× 실시간(8분 2.1초, 54분 14.6초, 98분 26초). **검출은 파일 전체를 한 번에 넣는다(`detectSpeechFile`)** — 청크로 나누면 경계마다 발화가 ~0.2초씩 어긋나고 컷편집은 되돌릴 수 없으므로 나누지 않는다. 네이티브 호출 중에는 진행률을 얻을 수 없어 `estimateVadProgress(elapsedMs, audioMs, 200×)`(실측 224×보다 약간 보수적, 0.95 상한)를 1초 티커로 보고하고 완료 시 1.0으로 마감한다. 호출 중간 취소는 불가(최대 수십 초), 호출 전후에만 취소를 확인한다.
- `audio-compaction.ts` — I/O: VAD → plan → `.tmp`에 쓰고 검증 후 `rename`(원자적) → `<id>.channels.json` 재매핑 → 사이드카 기록. 어떤 실패도 `applied:false`로 흡수(취소만 전파).

**정책** (기본값 — 리서치 근거: faster-whisper VAD 기본 `min_silence_duration_ms=2000`, 편집 도구 관행, pyannote 경계 불연속 리스크)
- **VAD 임계값 이원화**: 컷편집용 VAD는 `COMPACTION_VAD_THRESHOLD = 0.35`(audio-compaction.ts), 전사용은 기본 0.5다. 컷편집은 원본을 보관하지 않아 되돌릴 수 없으므로 "발화를 놓쳐 잘라내는 것"이 "잡음을 남기는 것"보다 훨씬 비싸다(작은 목소리·원거리 화자 보호). 0.35는 기본 0.5와 NVIDIA NeMo Curator 문서의 조용한 화자용 관대한 값 0.3 사이에서 보수적으로 고른 값이며 실측 튜닝값은 아니다. 낮은 임계로 잡힌 잡음 구간을 전사하면 환각이 늘어나므로 **컷편집 발화 구간은 STT에 재사용하지 않는다** — STT 어댑터가 컷편집된 파일에 0.5로 VAD를 다시 돌린다(VAD는 실시간 대비 수백 배 빨라 비용이 작다).
- 침묵 판정은 VAD 발화 구간의 여집합. `padMs`(발화 앞뒤 여유, 200) 밖의 침묵 중 `minRemovableGapMs`(2000) 이상만 제거 대상이며, 제거 시 `keepGapMs`(600 — 화자분리 안정성을 위해 ≥0.5s)만큼의 **실제 오디오**(앞 절반은 직전 발화 뒤, 뒤 절반은 다음 발화 앞)를 남겨 룸톤을 유지한다. 디지털 무음(0)을 끼워 넣지 않는다 — whisper 환각·경계 클릭 방지. 접합부마다 `fadeMs`(8) 선형 fade-out/in을 건다(갭 길이보다 클릭이 더 위험). 파일 맨 앞/뒤 침묵은 `edgeMs`(300)만 남긴다.
- 라우드니스 정규화·하이패스·노이즈 억제는 **하지 않는다**. whisper는 [-1,1] 범위 안의 음량 차이에 대체로 불변이고, 노이즈 억제는 large 계열에서 WER을 오히려 높이며 pyannote DER도 악화시킨다는 보고가 있다(SciTePress 2024, arXiv 2603.04710, pyannote-audio #1053).
- 절감이 `minSavingsRatio` 미만이면 파일을 다시 쓰지 않는다(`applied:false`).
- 컷편집은 **첫 전체 처리에서 정확히 1회**(`audio_compacted` 멱등 가드). "빠른 재적용"(`skipTranscribe`)은 기존 세그먼트 타임스탬프를 재사용하므로 절대 컷편집하지 않는다. 이미 요약(면접 `qa_pairs.start_ms`)이 있는 회의를 전체 재처리하며 컷편집이 적용되면 그 시각을 `mapMsToCompacted`로 재매핑한다.
- 녹음 시작 화면의 "무음 구간 자동 제거"(`compact_audio`, 기본 on)로 회의별 opt-out 가능. 상세 화면은 `original_duration_ms`로 "무음 −mm:ss (n%)" 배지를 보여준다.
- `mic+system`의 채널 에너지 envelope(`<id>.channels.json`, 100ms hop)도 같은 keep 구간으로 재매핑해 화자 귀속이 어긋나지 않게 한다.

**진행률 표시**: main은 phase별 0~1을 보낸다(compact: VAD 0→0.85, 쓰기 0.95, 사이드카 1.0 / transcribe: 어댑터가 VAD를 돌리는 0→0.08 뒤 전사 0.08→1). 렌더러 `utils/processing-progress.ts`가 phase 가중치(`PHASE_WEIGHTS`: compact .04 / transcribe .60 / vad .01 / diarize .28 / merge .02 / summarize .05)로 **전체 진행률**을 계산해 바에 표시하고, phase 경과 시간을 함께 보여준다. 메시지 전용 스트림 이벤트(`progress` 없음)는 직전 진행률을 유지한다(`mergeProcessingEvent`).

## 12. 인식 보조 장치 (용어집 · 구성원)

회사 기밀을 코드에 두지 않는다. 구조만 제공하고 내용은 사용자가 입력하며, **로컬 SQLite에만** 저장된다. whisper initial_prompt는 로컬 추론에만 쓰이고, 요약 단계에서는 참석자 이름·용어가 전사록과 함께 Claude로 전송된다(전사록이 이미 가는 경로와 동일).

| 보조 장치 | 저장 | 사용처 |
|---|---|---|
| 용어집 `stt_glossary` (정답 표기 · 오인식 표기 aliases · 메모 · 우선순위) | 로컬 DB | ① `buildInitialPrompt({glossaryTerms})` — 프롬프트 **끝**에 ` 용어: A, B, C.`(최대 15개·120자, 전체 360자; whisper는 마지막 224토큰만 반영하므로 끝이 가장 중요, alias는 넣지 않는다) ② `applyGlossary(segments, rules)` 결정론적 후보정 ③ 요약 `[참고 정보]` 블록 |
| 구성원 `meeting_members` (이름 · 호칭/별칭 · 역할) + 회의별 참석자 `meeting_attendees` | 로컬 DB | ① 프롬프트 참석자 힌트(`speakerNames`에 합류) ② 녹음 시작 시 참석 인원 자동 제안 ③ `SpeakerEditor` 이름 프리셋 ④ 요약 `[참고 정보]`의 담당자 매칭 |

**후보정 규칙(`stt/glossary-correct.ts`)** — 오치환 방지가 우선: alias 2자 이상, term과 동일한 alias 제외, 긴 alias 우선. 라틴/숫자 alias는 대소문자 무시 + 양쪽 영숫자 경계. 한글 포함 alias는 경계 없음(조사 결합 허용: "링크워크를"→"LinkWork를"), 3자 이상이면 문자 사이 공백 0~1개 허용("링크 워크"). 이미 정답 표기인 부분은 재치환하지 않는다. 사용자 수정 플래그 `text_corrected`는 건드리지 않는다.

**서비스(`recognition-aids.ts`)**: `listGlossary/upsertGlossary/removeGlossary/importGlossaryText(parseGlossaryText)/listMembers/upsertMember/removeMember/setAttendees/listAttendees/loadPromptContext/buildSummaryContextBlock`. `loadPromptContext(db, meetingId)`는 켜진 용어 전체(전역)를 `priority DESC, updated_at DESC`로 읽고, 실패 시 빈 컨텍스트(throw 금지).

**UI**: 녹음 목록 헤더 "인식 보조" → `RecognitionAidsPanel`(용어집/구성원 탭, 텍스트 가져오기 `정답 | 별칭1, 별칭2 | 메모`). 녹음 시작 화면 참석자 칩, 상세 화면 참석자 칩 편집.

## 13. 파이프라인 버전과 요약 재생성

전체 처리(`!skipTranscribe`)가 merge 트랜잭션에서 `meetings.pipeline_version = CURRENT_PIPELINE_VERSION`(meeting-pipeline.ts, 현재 **3**)을 기록한다. 버전 값의 뜻: 0 = 구 파이프라인 또는 미처리, 2 = 무음 컷편집 + 용어집 후보정/프롬프트 힌트 + 참석자 힌트, 3 = 2에 더해 세그먼트 분할(maxLen) + 환각 필터 + 화자 centroid 병합 + 컷편집 VAD 이원화 + 화자 속성 승계. 빠른 재적용은 컷편집·재전사를 하지 않으므로 값을 유지한다. 파이프라인 동작이 결과에 영향을 줄 만큼 바뀌면 이 상수를 올린다.

상세 화면의 "AI 요약 다시 생성"(면접: "면접 기록 다시 정리")은 `needsFullReanalysis(meeting)`(= `pipeline_version < 2`, MeetingDetail.tsx의 `SUMMARY_PIPELINE_VERSION`)로 분기한다. 버전 2·3 회의는 모두 "요약만 재생성" 대상이다:
- **구 파이프라인 회의** → "다시 분석 후 요약 생성": 전체 재처리(컷편집 → 용어집·참석자 힌트로 재전사 → 후보정 → 화자분리) 후 자동 요약. 화자 실명·색상·사용자 라벨은 시간 겹침으로 승계되고(§5-4), 발언 단위 수정(텍스트 수정·세그먼트별 화자 지정)은 초기화된다(merge가 세그먼트를 재생성).
- **현재 파이프라인 회의** → 요약만 재생성(전사·수동 수정 보존, `[참고 정보]` 블록은 항상 반영).
"전체 다시 처리"는 버전과 무관하게 항상 재전사 + 요약 재생성이다(`recordingStore.reprocessMeeting`이 성공·전사 시 `summarizeMeeting`을 호출). 승계 규칙은 위와 같다.
참석 인원만 바꿔 재분리하는 빠른 재적용(`skipTranscribe`)은 화자 속성 승계에 더해 발언 단위 수동 보정(`text_corrected`·`speaker_corrected`)도 보존한다(§5-4).

## 14. 녹음 수명주기와 비정상 종료 복구

**불변식**: `meetings.status='recording'` 행(draft)은 렌더러 녹음기 세션과 수명이 같다. 세션이 정상 종료되면 오디오가 저장되고, 시작 실패·취소되면 행을 지우며, 세션이 비정상으로 사라지면 main이 행을 `failed`로 돌려 '녹음 중' 배지가 박제되지 않게 한다.

**구성**
- `stores/recorderStore.ts` — MediaRecorder 래퍼. `start()`는 성공 여부(boolean)를 돌려준다. `stop()`은 무한 대기하지 않는다(이미 inactive면 즉시, 요청 없는 onstop이 먼저 왔으면 보존 청크로, `STOP_TIMEOUT_MS` 안에 onstop이 없으면 남은 청크로 resolve). 결과는 `lastResult`에 남는다. onerror·예기치 않은 중단·마이크 트랙 종료는 `error` 안내를 띄우고 recording/paused를 유지해 사용자가 저장할 수 있게 한다.
- `stores/recorderSession.ts` — 세션 오케스트레이터(모듈 함수, 화면 언마운트와 무관).
  - `startSession` = `createDraft` → `start`; 실패면 `discardDraft` 후 throw.
  - `stopAndSave({process})` = `stop` → `saveRecording`(실패 시 throw) → 성공 시 즉시 `reset` → `process`면 `processAndSummarize`를 **기다리지 않고** 백그라운드 실행. 재진입 시 같은 Promise를 돌려준다. 저장 실패면 `state='stopped'`·`lastResult`를 남기고 `saveError`를 띄운다.
  - `retrySave` = 'stopped' 상태의 `lastResult`로 다시 저장. `cancelSession` = `reset` → `discardDraft`.
  - `installRecorderBridge()`(App에서 1회) — `{active: state≠'idle', draftId}`가 바뀔 때만 `recorder:state`로 main에 보고하고, main의 `recorder:command`(`stop-and-save`)를 받아 `stopAndSave` 후 `recorder:command-done`으로 결과를 돌려준다(녹음이 없으면 즉시 success).
- `RecorderControls` — 녹음·일시정지 중 '취소'는 확인 후 `cancelSession`. 'stopped'(저장 실패)에는 '다시 저장'·'버리기'. '종료 및 저장'은 저장 중 비활성.
- main `services/recording-guard.ts` + `index.ts` — 창 닫기·앱 종료 가드. `services/recording-recovery.ts` — `recoverOrphanRecordings`, `discardDraft`(`recording:discardDraft`: 오디오 없는 'recording' 행만 삭제).

- `startSession`도 재진입 가드가 있다(권한 팝업·화면 선택창 대기 중 시작 버튼 재클릭 시 draft 2개·스트림 누수 방지). 시작 버튼은 진행 중 '시작 중...'으로 비활성화된다.
- **'저장하고 닫기'의 한계**: 창을 닫으면 main의 전사 파이프라인(`recording:process`)은 계속 돌지만, 렌더러가 맡던 자동 요약(`processAndSummarize`의 요약 단계)은 실행되지 않는다. 회의는 'transcribed' 상태로 남으며 상세 화면에서 요약을 직접 실행해야 한다.

**원인과 대응**

| # | 상황 | 가드가 없을 때 생기는 문제 | 대응 |
|---|---|---|---|
| C1 | 녹음 중 창 닫기(macOS는 앱 유지) | 렌더러와 녹음이 사라지고 행은 영원히 '녹음 중' | 창 close 가드: '녹음 계속(창 숨기기)' / '저장하고 닫기' / '돌아가기'. 창이 실제로 닫히면 고아 행 복구 |
| C2 | '취소' 버튼 | 녹음기만 reset, draft 행 고아 | 확인 후 `cancelSession`이 행 삭제 |
| C3 | 시작 실패(마이크 권한 거부 등) | draft 행이 먼저 생기고 남음 | `start()`가 false → `discardDraft` |
| C4 | MediaRecorder 비정상 중단 | `stop()`이 영원히 pending, 녹음 유실 | `stop()` 즉시/타임아웃 resolve, 청크 보존, `error` 안내 |
| C5 | 종료 후 전사·요약 대기 | 수 분간 '저장 완료'+취소 상태, 저장 실패 시 blob 유실 | 저장 직후 reset·처리는 백그라운드, 실패 시 '다시 저장' |
| C6 | 녹음 중 앱 종료(Cmd+Q·트레이) | 확인 없이 유실 + 고아 행 | before-quit 가드: '저장하고 종료'(처리 없이 저장만) / '돌아가기' |
| C7 | 렌더러 크래시(render-process-gone) | C1과 같은 고아 | 가드 비활성화 + `recoverOrphanRecordings` |

**복구 규칙(`recoverOrphanRecordings(db, keepId)`)**: 앱 시작 시(`restoreStuckProcessing` 옆)와 렌더러 소멸·창 닫힘 시 실행한다. `status='recording'`이고 `id≠keepId`인 행을 `failed`로 바꾸며, 오디오가 없으면 "녹음이 비정상 종료되어 오디오가 저장되지 않았습니다. 이 항목은 삭제해도 됩니다.", 오디오가 있으면 "녹음은 저장됐지만 처리가 완료되지 않았습니다. 다시 처리해 주세요."를 에러로 남긴다. 다른 status는 건드리지 않는다.

## 15. 알려진 한계

- **언어**: `meetings.language`는 항상 `ko`이고 바꾸는 화면이 없다.
- **webm 폴백 저장분**: 렌더러의 WAV 변환이 실패해 webm으로 저장된 녹음은 컷편집이 적용되지 않는다. main에는 변환 경로가 없다.
- **신뢰도**: whisper.node 바인딩이 확률을 내보내지 않아 `confidence`가 항상 NULL이다.
- **beam search**: `beamSize: 5`를 넘기지만 whisper.node 1.0.22는 greedy로 고정해 적용되지 않는다(§5-1).
- **용어 인식**: whisper.cpp에는 hotword/keyword boosting이 없어 initial_prompt와 후보정(§12)으로만 대응한다.
