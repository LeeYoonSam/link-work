# 회의 녹음과 회의록

> 회의 녹음 기능(녹음 → 전사 → 화자 분리 → AI 요약 → 할 일 등록)과 회의록 메뉴의 계약 문서다.
> 데이터 모델 · IPC 채널 · 어댑터 인터페이스를 바꾸면 이 문서를 함께 고친다.

## 0. 목표와 결정

- **STT**: 로컬 Whisper(`@fugood/whisper.node` + `large-v3-turbo` q8_0)와 whisper.node 내장 silero VAD(`ggml-silero-v5.1.2.bin`). 두 모델은 첫 사용 때 `userData/models/`로 내려받는다(`stt/model-manager.ts`). API 키를 쓰지 않는다.
- **녹음 소스**: 마이크 + 시스템 오디오. 녹음은 **마이크=L / 시스템=R 스테레오**로 받고, 저장할 때 전사용 16kHz mono WAV와 L/R 에너지 envelope(`<id>.channels.json`, 100ms hop)로 나눈다. 원본 스테레오는 남지 않는다. envelope로 모델 없이도 2화자(나/상대)를 얻는다.
- **화자 분리**: 다자 자동 분리 + **수동 보정**. `sherpa-onnx-node`의 화자 임베딩 모델(CAM++)만 쓰고, 클러스터링은 앱이 직접 한다(§5-3). 네이티브 입력은 호출당 2.25초 이하로 제한한다(배포 Electron 크래시 회피).
- **목소리 등록**: 화자에 구성원 이름을 지정하면 그 화자의 목소리 임베딩을 구성원 표본으로 저장하고, 다음 회의부터 같은 목소리를 자동으로 그 구성원으로 지정·제안한다(§5-4). 등록 전에 처리한 지난 회의에도 다시 찾기(Rematch)로 적용한다. 표본은 로컬 DB에만 둔다.
- **범위**: 녹음(녹음 중 메모·북마크) → 전사 → 시간대별 타임라인(발화 점유율, 화자 교정 범위 3단계) → AI 요약(요약 형식 4종 자동 선택, 자동 제목, 키워드·TL;DR·결정사항·액션아이템·미결 질문·주제별 요약) → 액션아이템을 할 일로 등록. 녹음 종류는 회의 하나다(면접 같은 별도 종류는 없다). AI 대화에서 여러 회의의 기록을 검색해 질문할 수 있다(§6-3).
- **AI 요약**: Claude Code 구독 로그인(`query()`, 모델 `SUMMARY_MODEL` = `claude-opus-5-5`)을 쓴다. 추가 과금이 없다. 오디오는 외부로 보내지 않고 전사 텍스트만 보낸다.

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
                                                   3) Diar (diarization/)→ 세그먼트 위 짧은 창(≤2.25초) 임베딩 → 자체 AHC
                                                      → speaker turns + 화자별 목소리 centroid (+ note 안내) → 후처리
                                                   4) merge → segments[] + speakers[] (최근접 귀속 + 화자 속성 승계
                                                      + 목소리 매칭·저장, voiceprint.ts)
                                                   진행률: recording:stream 이벤트
                                                          │
                          recording:summarize ──► meeting-summary.ts
                                                   Claude query(전사 → 회의 요약 JSON + 형식·제목)
                                                          │
                          recording:actionItemToTodo ──► todos 행 추가
```

**설계 원칙**
1. **컷편집 뒤에는 비파괴**: 녹음 파일은 첫 처리 직전 **무음 컷편집을 정확히 1회** 거쳐 교체되고(§11, 컷편집본이 그 녹음의 파일이 된다), 그 뒤로는 바뀌지 않는다. 제거한 구간은 `<id>.compaction.json` 사이드카에 남긴다. 짧은 침묵 컷은 `meeting_cuts` 메타데이터로만 저장한다(`enabled` 토글). 화자 보정은 `segments`/`speakers`에 반영하되 시간축(`start_ms`)은 보존한다.
2. **시간은 항상 (컷편집된) 파일의 절대 ms**다.
3. **어댑터 패턴**: STT/화자 분리/VAD는 인터페이스로 추상화한다. 네이티브 엔진이 없거나 실패하면 **폴백 어댑터**로 내려가며, 앱은 항상 빌드·동작한다.
4. **화자 자동 분리는 "초안"**이다. 수동 보정 도구를 1급 기능으로 둔다.

## 2. 데이터 모델 (SQLite)

`meetings`·`meeting_speakers`·`meeting_segments`·`meeting_cuts`·`meeting_summaries`·`meeting_marks`는 `src/main/db/schema.ts`, 인식 보조 테이블(`stt_glossary`·`meeting_members`·`meeting_attendees`)은 `src/main/services/recognition-aids.ts`의 `RECOGNITION_AIDS_SCHEMA`가 만든다. 목소리 테이블(`meeting_speaker_voices`·`member_voice_samples`)과 `meeting_speakers`의 구성원 연결 컬럼은 `src/main/services/voiceprint.ts`의 `VOICEPRINT_SCHEMA`·`applyVoiceprintSchema`가 만들고, `schema.ts`가 `RECOGNITION_AIDS_SCHEMA` 뒤에 실행한다(`meeting_members`를 FK로 가리키므로). 모두 `CREATE TABLE IF NOT EXISTS`이고, 뒤에 붙은 컬럼은 `PRAGMA table_info` 확인 후 `ALTER TABLE`로 추가한다.

```sql
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '제목 없는 회의',
  title_auto INTEGER NOT NULL DEFAULT 0,      -- 1=시스템이 붙인 제목(기본 제목·요약 제목, 요약이 바꿀 수 있다), 0=사용자 제목(§6-1)
  kind TEXT NOT NULL DEFAULT 'meeting',       -- 항상 'meeting'. 코드는 이 값으로 분기하지 않는다
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
  summary_template TEXT,                      -- 사용자가 고정한 요약 형식(MeetingTemplateId, §6-1). NULL=자동(사용자 제목 규칙 또는 요약 호출에서 모델이 고름)
  speakers_confirmed INTEGER NOT NULL DEFAULT 0, -- 사용자가 화자 수를 확인했는지(§8). 이 열을 ALTER 로 붙일 때 기존 회의는 모두 1
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
  -- 구성원 연결(§5-4). 뒤에 붙은 컬럼이라 ALTER TABLE 로 추가한다
  member_id INTEGER,                          -- meeting_members.id (FK 없음, 구성원 삭제 시 코드가 NULL 로)
  member_source TEXT,                         -- NULL | 'manual'(사용자 지정·확정) | 'auto'(목소리 자동 지정) | 'suggested'(제안만)
  match_score REAL,                           -- auto/suggested 때 코사인 유사도
  rejected_member_ids TEXT NOT NULL DEFAULT '[]', -- JSON number[] "이 사람 아님"으로 거절한 구성원
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
  tldr TEXT,                                  -- 회의 결론 2~3문장
  key_points TEXT,                            -- JSON string[]. 구버전 요약에만 값이 있고 새 요약은 '[]'
  decisions TEXT,                             -- JSON SummaryTextItem[] (구버전 요약은 string[])
  action_items TEXT,                          -- JSON ActionItem[]
  next_steps TEXT,                            -- JSON string[]. 구버전 요약에만 값이 있고 새 요약은 '[]'
  -- 옛 면접 요약 값. 백업 호환(DATA_BACKUP.md)을 위해 컬럼과 값만 남고 코드는 읽거나 쓰지 않는다
  qa_pairs TEXT,
  competencies TEXT,
  follow_ups TEXT,
  fact_checks TEXT,
  model TEXT,
  generated_at TEXT DEFAULT (datetime('now','localtime')),
  -- migrateMeetingSummaryFormatColumns 가 ALTER TABLE 로 붙인다. 컬럼이 생기기 전 요약 행은 NULL(빈 배열로 읽는다)
  topics TEXT,                                -- JSON SummaryTopic[] 주제별 요약
  open_questions TEXT,                        -- JSON SummaryTextItem[] 미결 질문
  keywords TEXT,                              -- JSON string[] 키워드(최대 10)
  template_id TEXT,                           -- 이 요약에 실제로 쓴 요약 형식(§6-1). NULL=형식 도입 이전 요약
  template_source TEXT,                       -- 형식을 정한 경로 'manual'|'title'|'auto'(§6-1). NULL=도입 이전 요약
  template_reason TEXT,                       -- 형식 선택 이유. title=`제목의 "<일치 문자열>"`, auto=모델이 쓴 한 문장, manual=NULL
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

-- ── 메모·북마크 (§6-1, §8): 녹음 중(live)·재생 중(post)에 사용자가 남긴 메모. text=''이면 북마크 ──
CREATE TABLE IF NOT EXISTS meeting_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  raw_ms INTEGER NOT NULL,                    -- 녹음 경과 시각(일시정지 제외). 한 번 정하면 바뀌지 않는다
  at_ms INTEGER NOT NULL,                     -- 현재 오디오 시간축 시각. live 메모는 컷편집 때 raw_ms 로 다시 계산한다(§11)
  text TEXT NOT NULL DEFAULT '',              -- 최대 500자(MARK_TEXT_MAX). ''=북마크
  origin TEXT NOT NULL DEFAULT 'live',        -- 'live'(녹음 중) | 'post'(상세 화면에서 추가, 이미 현재 시간축)
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_meeting_marks_meeting ON meeting_marks(meeting_id, at_ms);

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

-- ── 목소리 (§5-4): 화자 임베딩. 로컬 DB에만 저장하고 렌더러·요약·모바일·Markdown 으로 내보내지 않는다 ──
CREATE TABLE IF NOT EXISTS meeting_speaker_voices ( -- 이 회의 화자의 목소리 centroid (adapter 'sherpa'일 때만)
  speaker_id INTEGER PRIMARY KEY,             -- meeting_speakers.id
  meeting_id INTEGER NOT NULL,
  embedding BLOB NOT NULL,                    -- Float32 little-endian, L2 정규화
  model TEXT NOT NULL,                        -- VOICE_EMBEDDING_MODEL (모델 + 창 설정)
  dim INTEGER NOT NULL,                       -- 192
  speech_ms INTEGER NOT NULL DEFAULT 0,       -- centroid 에 쓰인 발화 길이
  FOREIGN KEY (speaker_id) REFERENCES meeting_speakers(id) ON DELETE CASCADE,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS member_voice_samples ( -- 구성원 목소리 표본(등록한 화자 centroid 1건 = 표본 1건)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  meeting_id INTEGER,                         -- 출처 회의. 회의를 지워도 표본은 남는다(SET NULL)
  speaker_key TEXT,                           -- 출처 화자 키
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  speech_ms INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (member_id) REFERENCES meeting_members(id) ON DELETE CASCADE,
  FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_voice_samples_src ON member_voice_samples(member_id, meeting_id, speaker_key);
```

`recording:get`은 `meeting_speakers`를 `SELECT *`로 읽으므로 임베딩은 별도 테이블에 둔다(BLOB이 렌더러로 나가지 않게).

`schema.ts`의 `migrateMeetingUnify`(`applySchema` 맨 끝, 멱등)가 녹음 일원화와 제목·형식 메타를 맞춘다. 옛 백업 복원도 `applySchema`를 거치므로 같은 규칙이 적용된다([DATA_BACKUP.md](DATA_BACKUP.md)).
- `meetings.title_auto`가 없을 때만 컬럼을 붙이고, 그때 빈 제목과 기본 제목(`제목 없는 회의`·`제목 없는 면접`) 행만 1로 둔다. 다시 실행해도 사용자 제목(0)을 건드리지 않는다.
- 매번 `kind <> 'meeting'` 행(옛 면접 녹음)을 `'meeting'`으로 바꾸고, `title_auto=1`인 제목 `제목 없는 면접`을 `제목 없는 회의`로 바꾼다(사용자가 붙인 같은 문자열은 그대로 둔다). 전사·화자·요약 값은 그대로 둔다. 옛 면접 요약은 `tldr`만 TL;DR로 보이고, 다시 요약하면 회의 형식으로 새로 만든다.
- `meeting_summaries`에 `template_source`·`template_reason`이 없으면 붙인다.

## 3. 공용 타입

렌더러 타입은 `src/renderer/src/types/index.ts`에 있다: `MeetingStatus`, `MeetingSource`(`'mic' | 'mic+system'`), `Meeting`(위 `meetings` 행. `kind`는 없고 `title_auto?`가 있다), `MeetingSpeaker`, `MeetingSegment`, `MeetingCut`, `ActionItem`, `SummaryTextItem`, `SummaryTopic`, `MeetingSummary`(JSON 컬럼을 배열로 푼 형태), `MeetingDetail`, `RecordingStreamEvent`, `ChannelEnergy`, `GlossaryEntry`, `Member`, `Attendee`, `SpeakerVoiceResult`(목소리 버튼 결과), `MemberVoiceprint`(구성원별 표본 요약), `MeetingTemplateId`·`SummaryTemplateOption`(요약 형식), `MeetingMark`(메모·북마크), `ReassignScope`·`ReassignResult`(화자 교정 범위), `RematchOptions`·`RematchSpeakerPlan`·`RematchMeetingPlan`·`RematchResult`(다시 찾기), `RecordingAPI`, `RecorderBridgeAPI`, `RecognitionAidsAPI`, `MeetingNoteFilter`, `MeetingNoteItem`, `MeetingNotesAPI`.
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
  at_ms?: number | null      // 근거 발언 위치. AI 는 "mm:ss"로 답하고 main 이 ms 로 바꾼다(§6)
}

interface SummaryTextItem {  // 결정사항·미결 질문 한 항목
  text: string
  at_ms: number | null       // 구버전 문자열 결정사항은 null 로 읽는다
}

interface SummaryTopic {     // 주제별 요약 한 항목
  title: string
  start_ms: number | null    // 그 주제의 논의가 시작된 위치
  points: string[]
}

interface MeetingSummary {
  tldr: string | null
  keywords: string[]
  topics: SummaryTopic[]
  decisions: SummaryTextItem[]
  action_items: ActionItem[]
  open_questions: SummaryTextItem[]
  key_points: string[]        // 구버전 요약에만 값이 있다
  next_steps: string[]        // 구버전 요약에만 값이 있다
  template_id?: MeetingTemplateId | null // 이 요약에 쓴 형식. null=형식 도입 이전 요약
  template_source?: 'manual' | 'title' | 'auto' | null // 형식을 정한 경로(§6-1). null=도입 이전 요약
  template_reason?: string | null // 형식 선택 이유. 없으면 null
  // 옛 면접 컬럼(qa_pairs 등)은 내보내지 않는다
}

type MeetingTemplateId = 'default' | 'one_on_one' | 'standup' | 'review'

interface MeetingMark {       // meeting_marks 행
  id: number
  meeting_id: number
  raw_ms: number              // 녹음 경과(불변)
  at_ms: number               // 현재 오디오 시간축
  text: string                // ''=북마크
  origin: 'live' | 'post'
  created_at: string
  updated_at: string
}

type ReassignScope = 'one' | 'forward' | 'all'
interface ReassignResult { success: boolean; changed: number; merged: boolean; error?: string }

interface RematchOptions { meetingIds?: number[]; memberIds?: number[] }
interface RematchSpeakerPlan {
  speaker_id: number
  speaker_label: string       // meeting_speakers.label, 없으면 speaker_key
  member_id: number
  member_name: string
  source: 'auto' | 'suggested'
  score: number               // 코사인 유사도
}
interface RematchMeetingPlan { meeting_id: number; title: string; started_at: string; speakers: RematchSpeakerPlan[] }
interface RematchResult { meetings: number; auto: number; suggested: number }

interface MeetingDetail {
  meeting: Meeting
  speakers: MeetingSpeaker[]
  segments: MeetingSegment[]
  cuts: MeetingCut[]
  summary: MeetingSummary | null
  attendees: Attendee[]
  marks?: MeetingMark[]       // at_ms, id 오름차순
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
| `recording:createDraft` | `{title?, source?, expected_speakers?, attendee_ids?, compact_audio?}` | `{id}` (`status='recording'` 행. 입력은 `meeting-draft.ts` `buildDraftRow`가 정규화한다. 제목이 trim 후 비면 `제목 없는 회의`(`DEFAULT_MEETING_TITLE`)와 `title_auto=1`, 있으면 그 제목과 `title_auto=0`. `expected_speakers`는 1 이상이면 반올림 후 20 상한, 없으면 NULL. `compact_audio`는 `false`일 때만 0. `speakers_confirmed`는 참석 인원을 지정했으면 1, 아니면 0. `kind`·`summary_template` 입력은 무시하고, 행은 `kind='meeting'`·`summary_template=NULL`(자동)로 만든다) |
| `recording:discardDraft` | `id` | `{success}` (오디오가 없는 `status='recording'` 행만 지운다. 그 외는 `false`) |
| `recording:saveAudio` | `id, ArrayBuffer, {mime, durationMs}, channelEnergy?` | `{path}` (파일명 `<id>.wav`/`.ogg`/`.webm`. 채널 에너지가 있으면 `<id>.channels.json`에 쓰고 없으면 지운다. 채널 에너지 없는 `mic+system`은 `source='mic'`으로 내린다. 길이는 WAV 헤더 값을 먼저 쓴다) |
| `recording:process` | `id, {skipTranscribe?}?` | `{success, error?, transcribed?}` (`transcribed:false` = 전사 엔진이 없어 안내 세그먼트만 넣음. 렌더러는 이때 자동 요약을 건너뛴다) |
| `recording:cancel` | `id` | `{success}` (활성 파이프라인 abort, 완료는 stream phase `cancelled`) |
| `recording:summarize` | `id` | `{success, error?}` |
| `recording:rename` | `id, title` | `{success}` (trim 후 빈 제목은 `false`. 사용자 제목이므로 `title_auto=0`도 쓴다. 그 뒤 요약은 제목을 바꾸지 않는다, §6-1) |
| `recording:remove` | `id` | `{success}` |
| `recording:updateSpeaker` | `speakerId, {display_name?, color?, label?}` | `{success, member_id, enrolled}` (`display_name`을 바꾸면 구성원 연결·목소리 등록을 동기화, §5-4) |
| `recording:enrollSpeakerVoice` | `speakerId` | `{success, error?, member_id?, enrolled?, created?}` (목소리가 없거나 발화 20초 미만이면 구성원을 만들기 전에 `success:false`, "발화가 짧아 목소리를 등록할 수 없습니다(20초 이상 필요).". 이름이 구성원이 아니면 그 이름으로 구성원을 만든 뒤 등록) |
| `recording:confirmSpeakerMatch` | `speakerId` | `{success, error?, member_id?, enrolled?}` (`auto`/`suggested` → `manual`, 이름 확정, 표본 등록. 발화가 20초 미만이어도 확정·이름 지정은 하고 `enrolled:false`) |
| `recording:rejectSpeakerMatch` | `speakerId` | `{success}` (연결된 구성원이 없으면 `false`. 거절 목록에 추가, 연결 해제, `auto`였으면 이름을 비움, 그 화자의 표본 삭제) |
| `recording:reassignSegment` | `segmentId, speakerId \| null, scope?` | `ReassignResult` `{success, changed, merged, error?}` (`scope`: `one`(기본, 알 수 없는 값도 `one`) / `forward` / `all`, §5-4. 바꾼 발언은 `speaker_corrected=1`. 대상 화자가 다른 회의 소속이면 `success:false`. 이미 그 화자면 `changed:0`. `all`이고 원래 화자와 대상 화자가 모두 있으면 `recording:mergeSpeakers`와 같은 병합을 하고 `merged:true`) |
| `recording:updateSegmentText` | `segmentId, text` | `{success}` (`text_corrected=1`) |
| `recording:addSpeaker` | `meetingId, name` | `{success, id?, existed?, error?}` (같은 이름이 있으면 그 화자를 쓴다) |
| `recording:mergeSpeakers` | `meetingId, from, into` | `{success, error?}` (`speaker-correction.ts` `mergeSpeakersInMeeting`. 같은 회의의 서로 다른 화자가 아니면 `success:false`, "같은 회의의 서로 다른 화자만 합칠 수 있습니다.". 한 트랜잭션에서 목소리를 합치고(§5-4) `from`의 세그먼트를 `into`로 옮기며 `speaker_corrected=1`로 표시하고 `from` 행을 지운다) |
| `recording:toggleCut` | `cutId, enabled` | `{success}` |
| `recording:actionItemToTodo` | `meetingId, index` | `{todo_id}` |
| `recording:setExpectedSpeakers` | `id, n \| null` | `{success}` (0 이하·null 은 자동 추정. 항상 `speakers_confirmed=1`도 쓴다) |
| `recording:setAttendees` | `meetingId, memberIds[]` | `{success}` (`meeting_attendees` 교체) |
| `recording:setSummaryTemplate` | `meetingId, templateId \| null` | `{success, error?}` (`meetings.summary_template`만 저장한다. 재요약은 렌더러가 `recording:summarize`로 따로 요청한다. 없는 회의, 알 수 없는 형식이면 `success:false`. 형식 id=수동 고정, `null`=자동) |
| `recording:listSummaryTemplates` | — | `[{id, name}]` (`default`·`one_on_one`·`standup`·`review` 순, §6-1) |
| `recording:listMarks` | `meetingId` | `MeetingMark[]` (`at_ms, id` 오름차순) |
| `recording:addMark` | `{meetingId, raw_ms, text?, origin?}` | `{id}` (`raw_ms`는 0 이상 정수로 반올림하고 `at_ms`도 같은 값으로 시작한다. `text`는 trim 후 500자까지, 비면 북마크. `origin`은 `post`가 아니면 `live`. 없는 회의면 throw) |
| `recording:updateMark` | `{id, text}` | `{success}` (text 를 같은 규칙으로 정리. 비우면 북마크가 된다) |
| `recording:deleteMark` | `id` | `{success}` |
| 이벤트 `recording:stream` | (main→renderer) `RecordingStreamEvent` | — |

`recording:get`은 `attendees`와 `marks`(`listMarks`)를 함께 돌려주고, `summary`에 `template_id`·`template_source`·`template_reason`을 붙이고(옛 면접 컬럼은 내보내지 않는다), 화자마다 `has_voice`(목소리 centroid 유무), `voice_enrolled`(이 화자 목소리가 구성원 표본으로 실제 저장돼 있는지), `member_name`(연결된 구성원 이름)을 붙이고 `rejected_member_ids`를 배열로 푼다. 임베딩은 내보내지 않는다. `recording:remove`는 오디오·`<id>.channels.json`·`<id>.compaction.json`을 모두 지운다.

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
| `recognitionAids:removeMember` | `id` | `{success}` (그 구성원의 목소리 표본도 지우고, 연결된 화자의 `member_id`를 NULL 로) |
| `recognitionAids:listVoiceprints` | — | `[{member_id, sample_count, total_speech_ms, updated_at}]` |
| `recognitionAids:clearVoiceprint` | `memberId` | `{success, removed}` (그 구성원의 표본 전부 삭제) |
| `recognitionAids:previewRematch` | `RematchOptions?` | `RematchMeetingPlan[]` (DB를 바꾸지 않는다. 바뀔 화자가 있는 회의만, §5-4) |
| `recognitionAids:applyRematch` | `RematchOptions?` | `RematchResult` (한 트랜잭션 안에서 계획을 다시 세워 적용한다. 표본은 만들지 않는다) |

`RematchOptions`는 `sanitizeRematchOptions`(`recognition-aids.ipc.ts`)가 정리한다. `meetingIds`·`memberIds`는 배열일 때만 받고, 양의 안전 정수만 중복 없이 최대 500개 남긴다. 빈 배열은 "대상 없음"이라 빈 결과다. 생략하면 전체다.

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
  diarize(audioPath: string, opts: { minSpeakers?; maxSpeakers?; numSpeakers?; source?; segments?: SttSegment[]; signal?: AbortSignal; onProgress?: (ratio: number) => void }): Promise<DiarTurn[]>
}
// 구현: sherpa-adapter (창 300개마다 새 embed 워커 + 마지막 cluster 워커, chunk-runner.ts, §5-3 — 이름은 'sherpa' 유지),
//       channel-adapter (mic=L/sys=R 채널 에너지로 2화자 — 모델 불필요)
// 오케스트레이션: diarization/index.ts diarizeWithFallback(audioPath, opts)
//   → { turns, adapter, note?, voices?, embeddingModel? }
//   adapter: 'two-stage' | 'channel' | 'sherpa' | 'none'  ('none' = 빈 turns, merge 가 단일 화자 spk_0 로 귀속)
//   voices: SpeakerVoice[] { speaker_key, embedding: Float32Array(L2, 192), speech_ms } — adapter 'sherpa'일 때만.
//           channel·two-stage 는 centroid 를 내지 않는다(§15). embeddingModel = VOICE_EMBEDDING_MODEL
//   note: 사용자에게 보여줄 한국어 한 문장. 강등(모델 준비 실패·sherpa 실패·빈 결과·2-스테이지 강등)일 때만
//         채운다(diarization/notes.ts).

interface VadAdapter {
  readonly name: string
  detectSilence(audioPath: string, opts?: { minSilenceMs?: number }): Promise<VadRegion[]>
}
// vad/index.ts getVadAdapter(): silero-adapter → gap-adapter (폴백: STT 세그먼트 사이 공백으로 침묵 추정)
```

**오디오 변환**: main에는 변환 단계가 없다. 렌더러가 저장 전에 `utils/audio.ts`의 `blobToWav16kMono`(Web Audio 디코드·리샘플)로 webm/opus를 16kHz mono 16-bit WAV로 바꾸고 채널 에너지(`<id>.channels.json`)를 함께 만든다. 변환이 실패하면 원본 webm을 그대로 저장하며, 이 경우 컷편집은 적용되지 않는다(§11, WAV 전용, §15).

**파이프라인(meeting-pipeline.ts)**: `runMeetingPipeline(id, send, {skipTranscribe?})`. `recording:process`가 먼저 `status='processing'`으로 바꾼 뒤 부른다. 같은 회의의 파이프라인이 이미 돌고 있으면(`pipeline-abort.ts` `beginPipeline`) DB를 건드리지 않고 phase:error만 보낸다. `audio_path`가 없으면 `failed`로 끝난다.
0. **compact** (phase:compact, §11): `!skipTranscribe && compact_audio=1 && audio_compacted=0 && WAV`일 때만 `compactRecording` → 적용되면 파일 교체 + `duration_ms`/`original_duration_ms`/`audio_compacted=1` 갱신 + 기존 세그먼트·컷·회의 요약 근거 시각(`remapSummaryTimes`: `topics[].start_ms`, `decisions`·`action_items`·`open_questions`의 `at_ms`)·녹음 중 메모(`origin='live'`) `at_ms`(`remapLiveMarks`) 재매핑(`remapExistingTimelines`). 실패/미적용은 치명적이지 않다(원본으로 계속). 컷편집이 검출한 발화 구간은 STT에 넘기지 않는다(§11).
1. `buildInitialPrompt(...)`로 initial_prompt를 조립한다(STT 실행 여부와 무관 — 빠른 재적용의 환각 필터도 같은 값을 쓴다).
2. `stt.transcribe` → raw segments (phase:transcribe, progress) → `cleanSegments` → `filterHallucinations(segments, { prompt })` → `applyGlossary`(§12) → WAV 길이 클램프(시각을 `[0, WAV 길이]`로 자르고 빈 구간 제거). 정제 3단계는 `skipTranscribe` 경로에도 적용된다(단, 사용자가 고친 발언은 건너뜀 — §5-4).
   - `skipTranscribe`는 기존 `meeting_segments`를 재사용한다. 기존 세그먼트 끝 시각이 WAV 길이의 1.5배를 넘거나 세그먼트가 없으면 전체 재전사로 바꾼다.
   - STT 어댑터가 `manual`(whisper 미설치)이면 "전사 엔진(Whisper)이 설치되지 않았습니다…" 안내 세그먼트 1개를 넣고 `transcribed:false`를 돌려준다.
3. `vad.detectSilence(audioPath, {minSilenceMs: 500})` → cuts[] (phase:vad). 실패하면 컷 없이 계속한다. 이 VAD는 `silero-vad-node`(optional, 없으면 STT 세그먼트 사이 공백으로 추정하는 `gap-adapter`)이고, 전사·컷편집이 쓰는 whisper.node 내장 VAD와 다르다.
4. `diarizeWithFallback` → turns (phase:diarize). `note`가 있으면 스트림 메시지로 보낸다. `diarizeWithFallback` 자체가 throw하면(취소 제외) 단일 화자로 계속하고 "화자분리에 실패해 화자를 구분하지 않았습니다. (원인)"을 보낸다. 이어서 `postprocessTurns`(옵션 분기는 §5-3).
5. **merge**: 각 STT segment를 speaker_key에 귀속(§5-4 규칙). speakers[] 생성(중복 key 통합, 색상/라벨 부여 + 옛 화자 속성·구성원 연결 승계 + 목소리 자동 매칭). (phase:merge)
6. DB 저장(meeting_speakers, meeting_speaker_voices, meeting_segments, meeting_cuts — 트랜잭션으로 삭제 후 재삽입. 그래서 컷 토글 상태는 다시 처리하면 초기화된다), meeting.status='transcribed'(요약 행이 있어도 같다. 렌더러가 이어서 요약을 다시 만든다). `duration_ms`는 WAV 헤더 길이 → 마지막 세그먼트 끝 → 기존 값 순으로 정한다. 트랜잭션 직전에 마지막으로 취소를 확인해, 취소되면 기존 데이터가 그대로 남는다.
7. 실패 시 status='failed', error 기록, phase:error.
8. **취소**(`recording:cancel` → AbortSignal): 단계 경계마다 확인한다. 취소되면 요약이 있으면 `summarized`, 세그먼트가 있으면 `transcribed`, 둘 다 없으면 `failed`("사용자가 취소했습니다.")로 되돌리고 phase:cancelled를 보낸다(`restoreAfterCancel`). 화자분리 워커는 kill한다.

### 5-1. STT 전사 (stt/whisper-adapter.ts)
- 언어는 `meetings.language`(현재 항상 `ko`, 선택 UI 없음 — §15).
- 전사용 VAD: 어댑터가 (컷편집된) 파일에 silero VAD를 기본 임계값 0.5(`VAD_PARAMS.threshold`)로 직접 돌려 발화 구간만 전사한다. VAD 실패·포맷 불일치(16k/mono/16bit WAV가 아님) 시 전체 파일 전사로 폴백.
- **전사 청크**: 발화 구간을 그대로 전사하면 쉼마다 잘게 쪼개져 호출이 수백 번으로 늘고 문맥이 끊긴다. 그래서 `coalesceRegions`(`stt/vad-segmenter.ts`)가 간격 2초 이하 구간을 침묵째 합치고 28초에서 자른다(`COALESCE_OPTIONS = {joinGapMs: 2000, maxChunkMs: 28000}`). 청크마다 raw PCM을 잘라 전사하고 세그먼트 시각을 파일 절대 ms로 되돌린다. VAD 세그먼트 시각은 센티초라 ×10 한다.
- **initial_prompt**(`stt/initial-prompt.ts` `buildInitialPrompt`): 언어가 `ko`일 때만 만든다. `다음은 한국어 회의 녹음입니다.` 뒤에 ` 주제: <제목>.`(사용자 제목만. 기본 제목이거나 `title_auto=1`인 자동 제목이면 생략 — 파이프라인이 `title`로 null을 넘긴다. AI가 만든 문구로 전사를 유도하지 않는다), ` 일정: <일정 제목>.`(제목과 같으면 생략), ` 참석자: <이름들>.`(이전 처리의 화자 실명 + 참석자, 최대 5명), ` 용어: ….`(§12) 순서로 붙인다. 전체 360자를 넘기는 조각은 통째로 뺀다.
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
- **sherpa 경로 = 창 임베딩 + 자체 클러스터링.** sherpa-onnx의 `OfflineSpeakerDiarization`(pyannote 분할 + 내장 클러스터링)은 쓰지 않는다. `SpeakerEmbeddingExtractor`(CAM++)로 짧은 창의 임베딩만 뽑고, 클러스터링은 앱 코드(순수 함수)가 한다.
- **입력을 2.25초 이하로 자르는 이유**: sherpa-onnx의 일체형 분리기(`OfflineSpeakerDiarization`)는 배포 Electron(43)에서 약 6~10분 이상 입력에 onnxruntime(KleidiAI `MlasConv` → `operator new` → Chromium allocator)이 SIGTRAP으로 워커를 죽인다(180·360초 통과, 600초 종료 코드 133, 일반 Node 22에서는 정상). 그래서 일체형 분리기를 쓰지 않는다. 임베딩 추출 단독은 120초 입력까지 안전하고, 앱은 네이티브 호출 하나에 `WINDOW_MAX_SEC`(2.25초) 이하만 넣는다. 같은 이유로 WAV도 `sherpa.readWave`가 아니라 JS 디코더(`wav-pcm.ts` `decodeWavPcm16`, PCM16 mono만 받고 잘못된 헤더는 오류, 16kHz가 아니면 `embedding-diarizer.ts`가 오류)로 읽는다.
- **창 계획**(`window-plan.ts` `planWindows(segments, audioSec)`): STT 세그먼트 위에 창을 깐다. 0.5초(`MIN_SEGMENT_SEC`) 미만 세그먼트는 건너뛴다. 2.25초(`WINDOW_MAX_SEC`) 이하면 세그먼트 전체가 창 1개, 더 길면 1.5초(`WINDOW_SEC`) 창을 0.75초(`HOP_SEC`) 간격으로 깔고 마지막 창은 세그먼트 끝에 맞춘다. 창 설정과 모델을 묶은 식별자가 `VOICE_EMBEDDING_MODEL`(`3dspeaker_campplus_sv_zh_en_16k_common_advanced/w1.5h0.75`)이고, 목소리 표본은 이 값이 같을 때만 서로 비교한다.
- **알고리즘**(상수는 `window-plan.ts`·`clustering.ts` 한 곳에 둔다):
  1. 임베딩(`embedding-diarizer.ts` `extractWindowEmbeddings`, embed 워커와 cli가 같이 쓴다. 2~8단계는 `diarizeFromEmbeddings`이고 cluster 워커와 cli가 같이 쓴다): 창마다 samples를 잘라 `acceptWaveform` → `compute`(`numThreads` 2). 창 가중치는 모두 `HOP_SEC`(0.75초)다.
  2. `smoothNeighbors`: 같은 세그먼트 안 앞뒤 1개 창과 평균한 뒤 L2 정규화한다(1.5초 창의 잡음 완화).
  3. `ahcAverageLinkage`: 코사인 거리(1 − cos), average linkage, NN-chain O(n²) AHC. `cutByThreshold(CUT_THRESHOLD = 0.5)`로 자른다 — 거리 임계값이라 **클수록 화자 수가 줄어든다**.
  4. **자동 모드**: centroid 반복 병합(가장 닮은 쌍의 코사인이 0.72(`MERGE_COS`) 이상인 동안 그 쌍만 병합하고 centroid를 다시 계산) → 소수 클러스터(누적 발화 `max(15초, 전체의 2%)`(`MINOR_SEC`·`MINOR_RATIO`) 미만)의 창을 가장 가까운 주요 centroid로 재할당 → 다시 반복 병합 → 상한 10명(`MAX_AUTO_SPEAKERS`, 넘으면 가장 닮은 쌍부터 더 병합).
  5. **지정 모드**(참석 인원 N): 임계값 컷 결과가 이미 N개 미만이면 `cutByCount(N)`으로 덴드로그램을 N개로 자르고 끝낸다. 아니면 코사인 0.8(`SURE_MERGE_COS`) 이상인 쌍만 먼저 병합하고(N개 아래로는 내려가지 않는다), 그 뒤 N개가 될 때까지 주요 클러스터가 N개 이상이면 가장 작은 소수 조각을 가장 가까운 클러스터로 재할당하고, 아니면 가장 닮은 쌍을 병합한다.
  6. **대용량 가드**: 창이 4000개(`MAX_CLUSTER_WINDOWS`)를 넘으면 균등 추출한 4000개로 3~5단계를 돌리고(가중치는 n/4000배로 늘려 소수 기준이 전체 녹음 기준을 유지), 나머지 창은 가장 가까운 centroid로 붙인다(거리 행렬 ≤64MB). 결과는 결정적이다(같은 입력 → 같은 결과).
  7. `buildTurns(windows, labels)`(`turn-build.ts`): 겹친 창의 경계는 중점으로 나누고 인접한 같은 라벨을 합쳐 turns를 만든다.
  8. 산출: turns + 화자별 목소리 `{speaker_key, embedding(L2, 192차원), speech_ms}`(§5-4). `speech_ms`는 후처리 전 turns 길이 합이다.
- 인원을 지정하지 않았을 때 화자 수가 줄었다는 안내(note)는 내지 않는다. note는 강등·실패·빈 결과 때만 쓴다.
- **앱 경로 = 청크 직렬 워커**(`diarization/chunk-runner.ts` `runChunkedDiarization`, electron 을 import 하지 않고 `fork`를 주입받는다. `SherpaAdapter.diarize`가 `utilityProcess.fork(out/main/diarization-worker.js)`를 넘긴다):
  1. main은 WAV 헤더만 읽어(`wav-pcm.ts` `readWavInfo`, `decodeWavPcm16`과 같은 청크 탐색·잘린 data 규칙) 샘플 수를 구하고 `planWindowsFromWav`로 창을 계획한다. 녹음 전체를 main 메모리에 올리지 않는다.
  2. 창을 `DIAR_CHUNK_WINDOWS`(300)개씩 나눠(`planChunks`) 청크마다 embed 워커를 새로 띄운다. 워커는 자기 창이 덮는 샘플 범위만 읽고(`readWavPcm16Range`, `windowSampleRange`) 임베딩을 `number[]`로 돌려준 뒤 kill된다.
  3. 모은 임베딩으로 cluster 워커 1개가 `diarizeFromEmbeddings`를 돈다(sherpa 를 로드하지 않는다). AHC는 동기 CPU 작업이라 main에서 돌리지 않는다.
  4. 워커는 한 번에 하나만 산다(직렬). 그래서 최대 메모리가 녹음 길이가 아니라 청크 크기에 묶인다. 창 계획·임베딩 함수·클러스터링이 단일 프로세스 경로와 같고 `number[]` 전송은 Float32 → double → Float32 왕복이라 정확해서, 결과도 같다.
  - 워커 프로토콜(`worker.ts`): 요청 `op: 'embed' | 'cluster'`, 응답 `progress`(완료 창 수)·`embedded`·`clustered`·`error`. `embedded`·`clustered`는 워커가 잰 최대 RSS(`peakRssMb`)를 함께 보낸다. `SherpaAdapter.lastRunStats`가 `{chunks, peakWorkerRssMb}`를 남기고 `diarization/index.ts`가 `[diarization] chunks=…, peakWorkerRssMb=…`로 로그한다.
  - 진행률: 임베딩이 0~0.95, 클러스터링이 0.95~1이다. `DiarizeOptions.onProgress`로 받은 비율을 파이프라인이 정수 %가 바뀔 때만 phase `diarize`, 메시지 '화자 목소리 분석 중…'으로 보낸다.
  - 실패 처리: 전체 기한 30분(`DEFAULT_WORKER_TIMEOUT_MS`, 모든 워커 합계). 취소하면 현재 워커를 kill하고 `AbortError`를 낸다. 워커 오류·비정상 종료·응답 수 불일치는 reject되고, `diarizeWithFallback`이 단일 화자 폴백 note(`sherpaFailedNote`)로 내려간다. 메모리 부족은 같은 입력에서 다시 나므로 재시도하지 않는다.
- **실측**(배포 Electron 43.7.7, 이 Mac의 실제 대면 녹음, `npm run check:diar`, 자동 추정):

  | 회의 | 길이 | 세그먼트 | 창 | 최대 창 | 컷 직후 클러스터 | 최종 화자 | 처리 시간 |
  |---|---|---|---|---|---|---|---|
  | 53 (1on1) | 19.3분 | 367 | 1229 | 2.22초 | 119 | 2 | 11.9초 |
  | 50 (1on1) | 27.8분 | 505 | 1744 | 2.24초 | 83 | 2 | 18.0초 |
  | 40 (1on1) | 17.2분 | 221 | 1155 | 2.24초 | 38 | 2 | 11.9초 |
  | 45 (1on1) | 26.4분 | 412 | 1717 | 2.24초 | 51 | 2 | 17.8초 |
  | 46 (1on1) | 19.6분 | 343 | 1171 | 2.24초 | 59 | 2 | 12.0초 |
  | 51 (다인) | 61.5분 | 1079 | 3726 | 2.24초 | 187 | 4 | 40.8초 |

  처리 시간은 임베딩이 대부분이고 창당 약 10ms다. 컷 직후의 조각 클러스터는 병합·재할당이 정리한다. 1on1 5건은 모두 2명으로 나뉜다. 다인 회의(51)는 정답 화자 수를 몰라 2~8명 범위만 확인한다.
- **실측 회귀**(`scripts/diar-regress.mjs`, `npm run check:diar`): 앱 DB(읽기 전용)의 세그먼트와 녹음 파일로 `out/main/diarization-cli.js`(electron 모듈을 쓰지 않는 cli 엔트리, `--audio --segments --model [--num N] [--emit-segments 1] [--chunk N]`, stdout 마지막 줄 JSON. `--emit-segments 1`이면 결과에 세그먼트별 화자 `segments:[{start_ms, end_ms, speaker}]`를 더한다. speaker 는 후처리 뒤 `assignSpeaker`가 붙인 키다. `0`이나 빈 값이면 끈다. `--chunk N`이면 창 임베딩을 N개씩 같은 cli 자식 프로세스(내부 인자 `--embed-range a:b`)에 나눠 뽑고 클러스터링은 부모가 한다. 임베딩 값은 나누지 않을 때와 같고 결과 끝에 `chunks`(자식 수)가 붙는다)를 배포 Electron 런타임(`ELECTRON_RUN_AS_NODE=1`)에서 회의별로 돌린다. cli의 최종 화자 수는 앱과 같은 후처리(`resolvePostprocessOptions({adapter:'sherpa'})` → `postprocessTurns` → 세그먼트별 `assignSpeaker`) 뒤의 고유 화자 수다. sherpa 모듈은 `LINKWORK_SHERPA_MODULE` → 일반 해석 → 배포 앱 `app.asar` 안 순서로 찾는다. 경로는 `LINKWORK_ELECTRON`·`LINKWORK_DIAR_CLI`·`LINKWORK_USERDATA`로 바꾼다. 단언: 회의 53·50·40·45·46 최종 화자 2명, 회의 51 2~8명이고 180초 이내, 모든 실행의 최대 창 ≤2.25초, 회의 50의 화자 목소리를 프로필로 회의 53의 두 주요 화자가 각각 서로 다른 50번 화자와 코사인 ≥0.70(최적 1:1)이고 교차 쌍 ≤0.62. 실패하면 종료 코드 1, 녹음·DB·Electron·cli·모델이 없으면 2. `--only 53,50`으로 일부만 돌린다. 녹음은 사용자 데이터라 이 회귀는 이 Mac에서만 돈다.
  - 평가용 옵션: `--model <onnx>`(다른 임베딩 모델로 돌린다. 기본 모델이 아니면 회의 간 목소리 매칭 단언은 참고로만 출력하고 판정에서 뺀다. 화자 수·창 길이·처리 시간 단언은 그대로 판정한다), `--tag <이름>`(가설 파일 이름의 모델 태그, 기본은 앱 모델 `campplus` 또는 모델 파일명), `--num N`(화자 수 고정), `--dump-hyp <dir>`(cli를 `--emit-segments 1`로 돌려 회의마다 `hyp_<id>_<tag>.json`(SegLST)과 `stats_<id>_<tag>.json`(화자 수·창·처리 시간·목소리)을 쓴다. 이때 `--only`에 기대값이 없는 회의도 화자 수 단언 없이 돈다), `--chunk N`(cli `--chunk N`으로 넘긴다. 기본 0은 앱과 같은 단일 프로세스 경로).
  - 네이티브 메모리: sherpa-onnx-node 1.13.3은 창(스트림)마다 받은 네이티브 메모리를 돌려주지 않는다(GC를 강제하거나 이벤트 루프에 양보해도, 추출기를 다시 만들어도 회수되지 않고 프로세스가 끝나야 회수된다). 그래서 한 프로세스의 RSS가 창 수에 비례해 는다(CAM++ 실측 약 1.4MB/창, ERes2NetV2 약 8MB/창). 앱은 위의 청크 직렬 워커로 프로세스당 창 수를 300개로 묶는다. 회의 51(3,726창)은 embed 워커 13개를 띄우고, 워커 하나의 최대 RSS는 약 1.2~1.25GB다. 큰 후보 모델을 긴 회의에 돌리는 평가는 cli `--chunk`로 같은 방식을 쓴다.
- **메모리 실측**(`scripts/diar-mem.mjs`, `npm run check:diar-mem` = `--id 51 --chunk 300 --max-rss-mb 2048`): 빌드 엔트리 `out/main/diarization-mem-probe.js`(`diarization/mem-probe.ts`, 창 없는 Electron main)가 앱과 같은 `runChunkedDiarization` + `utilityProcess` 워커로 돈다. 스크립트는 node_modules의 Electron으로 probe를 띄우고 250ms마다 `ps`로 probe를 루트로 하는 프로세스 트리의 RSS 합을 재 최대값이 상한(2,048MB) 이하인지 판정한다. 워커가 잰 최대 RSS도 함께 보고한다. `--chunk 0`이면 창 전체를 워커 하나에 넣는다(청크 없는 메모리 특성 비교용). `--compare-cli`는 단일 프로세스 cli(`diarization-cli.js`, 청크 없음)를 함께 돌려 세그먼트 `(start_ms, end_ms, speaker)` 완전 일치, 목소리 개수·`speaker_key` 일치, 임베딩 최대 절대 차 ≤1e-6을 확인한다. 종료 코드 0=통과, 1=초과·불일치·실행 실패, 2=준비물(DB·녹음·모델·out 빌드) 없음. 녹음은 사용자 데이터라 이 Mac에서만 돈다.
  - `check:diar`는 정답 라벨 없이 도는 **구조 회귀 관문**이다(화자 수·창 길이·처리 시간·목소리 매칭). 화자 귀속 정확도(DER)는 평가 하네스(`scripts/eval/`, [scripts/eval/README.md](../scripts/eval/README.md))가 정답 라벨로 잰다.
- **후처리 옵션 분기**(`speaker-assign.ts`의 `resolvePostprocessOptions({ adapter, expectedSpeakers })`, `postprocess.ts`는 그대로):
  | 조건 | smoothing | 소수 화자 흡수 |
  |---|---|---|
  | adapter `channel`/`two-stage` | 같은 화자 병합만(`minTurnMs 0, sandwichMs 0, gapFillMs 500`) — 채널 에너지로 확정한 짧은 발화 보존 | 끔 |
  | 그 외(sherpa 등) | `minTurnMs 200, sandwichMs 300, gapFillMs 500` — 같은 화자 사이에 낀 "네" 같은 짧은 응답 보존 | 켬(`minRatio 0.02, minDurationMs 60000`) |
  | 참석 인원 지정(`expected_speakers > 0`) | 위 adapter 기준 | 끔(지정 인원이 9→5처럼 줄어드는 현상 방지) |

### 5-4. merge — 화자 귀속, 속성 승계, 목소리 매칭 (speaker-assign.ts, speaker-carryover.ts, voiceprint.ts)
- **귀속(`assignSpeaker`)**: 겹침이 가장 큰 turn의 화자. 겹침이 같으면 먼저 나온 turn. 어떤 turn과도 겹치지 않으면 **시간상 가장 가까운 turn**(구간 사이 간격 최소)의 화자. turns가 없으면 `spk_0`.
- **화자 속성 승계(`planSpeakerCarryover`)**: merge 트랜잭션이 지우기 직전의 옛 세그먼트(시간 + speaker_id)와 새 귀속 결과(시간 + speaker_key)를 시간 겹침으로 대조한다. 새 화자 키마다 겹침이 가장 큰 옛 화자가 새 화자 발화 시간의 **과반(>50%)**을 차지하면 그 옛 화자의 `display_name`·`color`·사용자가 바꾼 `label`(키·순서로 만든 기본 라벨과 다를 때)을 이어받는다. 한 옛 화자는 겹침이 가장 큰 새 화자 한 명에게만 승계한다. 승계 대상이 없는 새 화자는 기본값(`resolveSpeakerMeta`). 전체 재처리·빠른 재적용 모두 적용된다. 이번 처리에서 컷편집이 적용됐으면 옛 세그먼트 시각은 이미 `remapExistingTimelines`가 새 타임라인으로 옮겨 두었다.
- **빠른 재적용(`skipTranscribe`) 전용 — 수동 보정 보존**:
  - `text_corrected=1` 세그먼트는 정제·환각 필터·용어집 후보정을 건너뛰고 원문 그대로 유지하며, 플래그도 1로 다시 저장한다.
  - `speaker_corrected=1` 세그먼트는 자동 귀속을 무시하고 사용자가 지정했던 옛 화자를 유지한다(`matchCorrectedSpeakers` + `planSpeakerRows`). 그 옛 화자가 승계로 새 화자에 매핑됐으면 그 새 화자 행에, 아니면 옛 행을 별도 화자 행으로 다시 만들어(`speaker_key`·`label`·`display_name`·`color` 보존) 연결하고 `speaker_corrected=1`로 저장한다. 정제가 세그먼트를 병합·삭제하므로 정제 전후 대응은 시간 기준(겹침이 새 세그먼트 길이의 과반)이며, 대응을 못 찾으면 그 보정 정보는 버린다.
  - 기존 전사가 오디오 길이와 어긋나 전체 재전사로 폴백하면 수동 보정 보존은 하지 않는다(속성 승계만 시도).
- **목소리 매칭과 등록**(`src/main/services/voiceprint.ts`): 화자분리가 낸 화자별 centroid를 `meeting_speaker_voices`에 저장하고(adapter `sherpa`일 때만), 구성원 표본(`member_voice_samples`)과 대조한다. 순수 함수는 `encodeEmbedding`/`decodeEmbedding`, `buildMemberProfile`, `planVoiceMatches`, `combineCentroids`다.
  - **구성원 프로필**: 저장하지 않고 매칭 때 계산한다. 같은 `model`(`VOICE_EMBEDDING_MODEL`)의 최근 표본 20개(`PROFILE_MAX_SAMPLES`)를 `min(speech_ms, 300초)`(`PROFILE_WEIGHT_CAP_MS`) 가중 평균한 뒤 L2 정규화한다. 모델이 다른 표본은 매칭에서 뺀다.
  - **자동 매칭(`planVoiceMatches`, merge 단계, `applyMeetingVoices`)**: 대상은 centroid가 있고 `speech_ms` ≥ 10초(`MATCH_MIN_SPEECH_MS`)이며 이름(승계 포함)이 없는 새 화자다. 후보는 표본이 있는 켜진 구성원이고, 회의에 참석자가 지정돼 있으면 참석자로 좁히며, 이 회의의 다른 화자에 이미 연결된 구성원과 그 화자의 `rejected_member_ids`는 뺀다. 점수(코사인) 내림차순으로 탐욕 1:1 배정한다. 점수 ≥ 0.70(`AUTO_MATCH_MIN`)이고 그 화자의 2순위 후보와 차이 ≥ 0.08(`AUTO_MATCH_MARGIN`)이면 `auto`(`display_name` = 구성원 이름), 0.60(`SUGGEST_MATCH_MIN`) 이상인데 `auto`에 못 미치면 `suggested`(`display_name`은 비워 둔다). 하나라도 지정·제안하면 스트림 메시지 "목소리로 화자 지정 N명, 제안 M명"을 보낸다.
  - **임계값 근거**(실측, 배포 Electron, 1on1 녹음): 회의 50의 화자 목소리를 프로필로 회의 53의 두 화자를 대조하면 같은 사람 쌍은 0.76·0.80, 다른 사람 쌍은 0.41·0.43이다(`npm run check:diar`가 매칭 ≥0.70·교차 ≤0.62를 매번 확인한다). 같은 회의 안 두 화자 centroid의 유사도는 0.55(회의 53)·0.59(회의 50)다. 그래서 자동 지정은 0.70, 제안은 0.60에 두고, 두 후보가 비슷하면(차 < 0.08) 자동 지정하지 않는다.
  - **등록(수동, `syncSpeakerEnrollment`)**: 화자 이름(`display_name`)을 켜진 구성원의 이름이나 별칭과 같게(앞뒤 공백·대소문자 무시) 지정하면 그 구성원에 연결하고(`member_source='manual'`), 그 화자의 centroid를 표본으로 upsert한다(`speech_ms` ≥ 20초(`ENROLL_MIN_SPEECH_MS`)일 때만, 출처 `(member_id, meeting_id, speaker_key)`당 1건). 이름을 지우거나 구성원이 아닌 이름으로 바꾸면 연결과 그 표본을 지운다. 구성원이 아닌 이름은 [목소리 등록] 버튼(`recording:enrollSpeakerVoice`)으로 구성원을 만든 뒤 등록한다. 이 버튼은 그 화자의 목소리가 없거나 발화가 20초 미만이면 구성원을 만들지 않고 거절한다(`SHORT_VOICE_ERROR`).
  - **자동 지정은 표본으로 등록하지 않는다.** 사용자가 [맞음] 버튼(`recording:confirmSpeakerMatch`)을 눌러야 `manual`이 되고 표본이 생긴다(발화 20초 미만이면 확정·이름 지정만 하고 표본은 만들지 않는다). [이 사람 아님] 버튼(`recording:rejectSpeakerMatch`)은 거절 목록에 넣고 연결을 끊는다.
  - **재처리 승계**: `planSpeakerCarryover`가 옛 화자를 이어받은 새 화자는 옛 행의 `rejected_member_ids`를 이어받는다. 승계한 이름이 구성원 이름이면 그 구성원에 연결한다 — 옛 연결이 같은 구성원의 `auto`였으면 `auto`와 점수를 그대로 두고(사용자가 확정하지 않았다), 아니면 `manual`로 연결하고 이 회의에서 온 그 구성원의 표본을 새 centroid로 바꾼다. 새 centroid가 없거나 발화 20초 미만이면 옛 표본을 그대로 두고 출처 `speaker_key`만 새 화자 키로 옮긴다. 승계한 이름이 구성원이 아니면 연결하지 않는다.
  - **수동 병합**(`recording:mergeSpeakers` → `speaker-correction.ts` `mergeSpeakersInMeeting` → `mergeSpeakerVoices`, 같은 회의의 서로 다른 두 화자만): 두 화자의 centroid를 `speech_ms` 가중 평균해 남는 화자에 두고, 없어지는 화자에서 온 표본은 지운다. 남는 화자가 `manual`로 연결돼 있으면 합친 centroid로 표본을 갱신한다.
  - **화자 교정 범위**(`recording:reassignSegment` → `speaker-correction.ts` `reassignSegments`): 발언 하나를 기준으로 범위 3단계를 고른다. 범위 계산은 순수 함수 `planReassign`이다(렌더러 `utils/speakerScope.ts`의 `planReassignIds`가 같은 규칙으로 안내 문구의 발언 수를 센다). 정렬은 `(start_ms, sort_order, id)`이고, 화자 없음(`NULL`)끼리도 같은 화자로 본다.
    - `one`(이 구간만): 그 발언만 바꾼다.
    - `forward`(이 구간부터): 기준 발언과 같은 화자의 발언 중 기준 발언과 같거나 뒤에 있는 것을 모두 바꾼다.
    - `all`(전체): 기준 발언과 같은 화자의 발언을 모두 바꾼다. 원래 화자와 대상 화자가 모두 있으면 수동 병합과 같은 경로(`mergeSpeakersInMeeting`)를 타고 원래 화자 행이 없어진다. 어느 한쪽이 화자 없음이면 발언만 옮긴다.
    - 바뀐 발언은 모두 `speaker_corrected=1`이라 빠른 재적용이 이 지정을 보존한다. `one`·`forward`는 화자 centroid를 다시 계산하지 않는다(오디오 없이는 계산할 수 없다). 섞인 화자의 centroid는 섞인 채 남는다(§15).
  - **다시 찾기(Rematch, `planRematch`·`applyRematch`)**: 지금 등록된 구성원 목소리로 지난 회의의 이름 없는 화자를 다시 매칭한다. 매칭 규칙은 자동 매칭의 `planVoiceMatches`를 그대로 쓴다.
    - 대상 회의: `status`가 `transcribed`·`summarized`(`meetingIds`를 주면 그 안), `started_at` 내림차순.
    - 대상 화자: 목소리 centroid가 있고, 이름(`display_name`)이 비어 있고, `member_source`가 NULL 또는 `suggested`인 화자. 대상이 아닌 화자에 연결된 구성원은 그 회의의 후보에서 뺀다. 참석자가 지정된 회의는 참석자로 좁히고, 화자별 `rejected_member_ids`를 지킨다.
    - 목소리 모델(`meeting_speaker_voices.model`)별로 프로필을 따로 계산한다. 한 모델 묶음에서 고른 구성원은 같은 회의의 다음 묶음에서 다시 고르지 않는다.
    - `memberIds`는 전체 구성원으로 계획한 뒤 결과만 거른다. 좁혀서 계획하면 2순위 점수 차가 커져 자동 지정이 늘기 때문이다.
    - 지금 상태와 같은 결과(같은 구성원·같은 source)는 계획에서 뺀다.
    - 적용은 2단계다. 미리 보기(`recognitionAids:previewRematch`)로 바뀔 화자 목록을 보여 주고, 적용(`recognitionAids:applyRematch`)은 트랜잭션 안에서 같은 조건으로 계획을 다시 세워 쓴다. `auto`는 연결·점수와 함께 `display_name`을 구성원 이름으로 채우고, `suggested`는 연결·점수만 쓴다. 같은 회의에서 이번에 다른 화자에게 간 구성원을 `suggested`로 가리키던 화자는 그 제안(`member_id`·`member_source`·`match_score`)을 지운다. 한 회의에서 한 구성원이 두 화자에 연결되지 않게 하기 위해서다.
    - **표본(`member_voice_samples`)은 만들지 않는다.** 이미 만든 요약의 화자 이름은 요약을 다시 만들어야 반영된다.
  - **실패 격리**: `applyMeetingVoices`는 merge 트랜잭션 안의 SAVEPOINT로 감싼다. 목소리 저장·승계·자동 매칭이 실패하면 그 단계만 되돌리고 스트림 메시지 "목소리 저장·매칭을 건너뛰었습니다. (원인)"을 보낸 뒤 전사·화자 저장을 계속한다.
  - 회의를 지워도 표본은 남는다(`meeting_id` SET NULL). 구성원을 지우면 그 표본도 지워지고, 연결된 화자의 `member_id`·`member_source`·`match_score`는 NULL이 된다(이름은 남는다). [목소리 삭제]는 표본만 지우고 화자 연결은 둔다.

## 6. AI 요약 (meeting-summary.ts)

Claude Agent SDK의 `query()`를 Claude Code 구독 로그인으로 부른다. SDK lazy load, 실행 파일 찾기, 환경 변수 정리, `toFriendlyError`(미로그인·미설치 안내)는 `ai-agent.ts`와 같은 방식으로 이 파일 안에 따로 둔다. 요약은 데이터 조회가 아니라 변환이므로 도구를 모두 끈다(`tools: []`, `allowedTools: []`, `settingSources: []`, MCP 없음). 모델은 `SUMMARY_MODEL`(`claude-opus-5-5`), `maxTurns: 3`, `cwd`는 `userData`다. 구독 로그인만 쓰도록 자식 프로세스 환경에서 `ANTHROPIC_API_KEY`·`ANTHROPIC_AUTH_TOKEN`·`CLAUDE_CODE_USE_BEDROCK`·`CLAUDE_CODE_USE_VERTEX`를 뺀다. `claude` 실행 파일은 `/opt/homebrew/bin`·`/usr/local/bin`·`~/.local/bin`·`~/.claude/local` 순으로 찾는다.

- 입력: 전사본을 `[mm:ss] 화자명: 텍스트` 줄로 직렬화한다(`formatTranscriptLines`, 화자명은 `display_name` → `label` → `화자`, 빈 발언 제외). 세그먼트가 없거나 텍스트가 모두 비면 Claude를 부르지 않고 오류로 끝난다. 전사 예산은 80,000자(`MAX_TRANSCRIPT_CHARS`)에서 `[사용자 메모]` 블록 길이를 뺀 값이다. 넘으면 `fitTranscript(lines, {lineStartMs, keepRanges, reserveChars})`가 줄을 시간순으로 균등 샘플링해 앞·중간·끝을 모두 남기고, 끝에 발췌본이라는 안내를 붙인다. 메모가 있으면 각 메모 시각 앞 90초~뒤 10초(`[at_ms − 90000, at_ms + 10000]`)에 시작하는 줄은 샘플링에서 빼지 않고 고정으로 넣고, 나머지 예산으로 다른 줄을 균등 샘플링한다. 고정 줄만으로 예산을 넘으면 고정 없이 균등 샘플링한다.
- 전사록 앞의 `contextBlock`은 `[참고 정보]` 블록(`buildSummaryContextBlock(loadPromptContext(db, meetingId))`, 참석자·용어집, §12)과 `[사용자 메모]` 블록(`buildMarksBlock(listMarks(db, meetingId))`, `recognition-aids.ts`)을 빈 줄로 이은 것이다. 빈 블록은 생략한다. `SummarySpec.buildPrompt(transcript, contextBlock)`.
  - `[사용자 메모]` 블록: 메모를 `at_ms` 순으로 `[mm:ss] 메모`(북마크는 `(북마크)`) 한 줄씩 쓴다. 메모 안의 줄바꿈·연속 공백은 공백 하나로 바꾼다. 최대 200줄(`MARKS_BLOCK_MAX_LINES`)·8,000자(`MARKS_BLOCK_MAX_CHARS`)이고, 잘리면 마지막 줄에 `(메모 N개 중 M개만 표시)`를 붙인다. 시각은 전사 줄과 같은 현재 오디오 시간축이다.
- 시스템 프롬프트: `buildMeetingSpec(plan).systemPrompt`. 원칙 블록 → 형식 블록(고정 모드는 `[회의 형식]` + 형식별 출력 키, 자동 모드는 `[회의 형식 고르기]` + 출력 키 + 메타 키, §6-1) 순서다.
  - 원칙: 전사록에 없는 내용 금지(불확실하면 빈 배열·null). 시각은 근거 전사 줄의 `mm:ss`를 그대로 복사하고 계산·추정하지 않는다(못 찾으면 null). 화자명이 `화자 1` 같은 기본 라벨이면 실명을 추측하지 않고 문장 주어·assignee로 쓰지 않는다. assignee는 전사록에 이름으로 드러날 때만 채운다(`[참고 정보]`의 참석자는 표기 맞춤용). 같은 내용을 여러 키에 반복하지 않는다. `[사용자 메모]`는 사용자가 중요하다고 표시한 지점이라 각 메모 시각 앞 90초~뒤 10초 전사를 먼저 보고 알맞은 키에 반영하되, 메모 문구를 사실로 단정하지 않고 시각은 메모가 아니라 근거 전사 줄에서 복사한다.
  - 출력 키: `title`(30자 이하 명사구, §6-2), `tldr`(결론 2~3문장), `keywords`(핵심 명사구 5~10개), `topics`(`[{title, start, points}]` 시간순 주제 3~8개, 10분 미만 회의는 1~3개, points 2~5개), `decisions`(`[{text, at}]`), `action_items`(`[{text, assignee, due, at}]`), `open_questions`(`[{text, at}]` 회의 안에서 답이 나오지 않은 질문). 자동 모드는 `template_id`·`template_reason`을 더한다(§6-1). 옛 `key_points`는 주제별 요약으로, `next_steps`는 액션아이템·미결 질문으로 흡수해 새 요약은 둘 다 `[]`다.
  - 요약 시스템 프롬프트는 공통 조각 `src/main/services/writing-style.ts`의 ASD-STE100 글쓰기 규칙과 JSON 보조 안내를 포함하고, "순수 JSON만 출력" 문장을 마지막에 둔다. `keywords`·`title`·`template_id`가 명사구나 값이라 글쓰기 규칙의 문장 규칙을 적용하지 않는다고 덧붙인다.
- 출력 파싱: 응답에서 JSON 블록 추출(`extractJson`, 코드펜스 허용) → zod 검증·정규화(`validate`) → `meeting_summaries` upsert. 메타 키 `title`·`template_id`·`template_reason`은 문자열이 아니어도 요약 전체를 실패시키지 않고 형식 밖 값처럼 처리한다(`title: null`, 자동 모드 `template_id`는 `default`, 이유는 NULL). upsert는 형식 메타(`template_id`·`template_source`·`template_reason`, §6-1)를 함께 남긴다.
  - **할 일 연결 승계**(`carryTodoIds`): 재요약 전 행의 `action_items`에서 `todo_id`가 있는 항목을 읽어, 소문자로 바꾸고 공백·문장부호·기호를 뺀 문장이 같은 새 항목에 `todo_id`를 옮긴다. 옛 항목 하나는 새 항목 하나에만 옮긴다. 그래서 형식을 바꾸거나 메모를 반영해 다시 요약해도 이미 할 일로 옮긴 항목이 다시 등록 대상이 되지 않는다.
  - 정규화: 문자열 trim, 빈 text·title 항목 제거. `at`·`start`는 `parseTimestamp`로 `at_ms`·`start_ms`가 된다. `keywords`는 앞 `#` 제거·중복 제거·최대 10개. `topics`는 최대 12개·points 최대 8개, 모든 `start_ms`가 있으면 오름차순 정렬. 개수 하한은 프롬프트로만 요구하고 스키마로 강제하지 않는다(짧은 회의의 요약이 파싱 실패로 버려지지 않게).
  - `decisions`·`open_questions`는 문자열 항목도 받아 `at_ms: null`로 바꾼다.
- **타임스탬프 규약**: AI에게 ms 정수를 만들게 하지 않는다. 전사 줄의 `[mm:ss]`를 그대로 돌려받아 `summary-spec.ts`의 `parseTimestamp`가 ms로 환산한다. 받는 형식은 `mm:ss`(분 1~3자리, 초 00~59), `h:mm:ss`, 대괄호로 감싼 `[mm:ss]`다. 그 밖의 형식(`00:75`, `3분 12초`)과 빈 값은 `null`이고, 화면은 시각 버튼·표기를 숨긴다. 회귀 테스트: `summary-spec.test.ts`.
- 실측: `LINKWORK_LIVE_SUMMARY_ID=<회의 id> npx vitest run src/main/services/meeting-summary.live.test.ts`가 실제 회의 전사로 claude CLI를 불러 주제 수(3~8)·points 수(≥2)·키워드 수(5~10)·시각 범위·시각이 전사 줄에 있는 비율(≥90%)·주제 시간순·기본 라벨 담당자 0건을 단언한다. 환경변수가 없으면 건너뛴다. DB는 `sqlite3 -readonly`로 읽고 응답 본문은 쓰지 않는다.
- 진행률: phase:summarize(응답 메시지마다 0.1→0.7, 파싱 0.8), 완료 시 phase:done. 성공하면 `meetings.status='summarized'`로 바꾸고, 시스템 제목이면 요약 제목으로 바꾼 뒤(§6-2) `logActivity('meeting', 'update', …, '요약 생성')`을 남긴다(비서 스케줄러가 새 액션아이템을 반영한다). 실패하면 친절한 오류 문구(미로그인·미설치·결제·사용량 한도)로 바꿔 보낸다. 파싱 실패 문구에는 원본 응답 앞 500자를 붙인다.

### 6-1. 요약 스펙과 요약 형식 (SummarySpec, meeting-templates.ts)

실행 인프라(`summary-spec.ts`의 `SummarySpec`: 시스템 프롬프트·사용자 프롬프트·검증·저장)는 하나이고, 녹음은 모두 회의 요약 스펙 `buildMeetingSpec(plan)`(`meeting-summary.ts`)을 쓴다. 출력 키는 키워드·TL;DR·주제별 요약·결정사항·액션아이템·미결 질문과 제목(§6-2)이다. 저장은 회의 컬럼만 쓰고 옛 면접 컬럼(`qa_pairs`·`competencies`·`follow_ups`·`fact_checks`)은 건드리지 않는다.

**요약 형식(`src/main/services/meeting-templates.ts`)**: 형식은 지시문만 바꾼다. 출력 키와 스키마는 모든 형식이 같다. 형식은 코드 상수 4종이다.

| id | 이름 | `[회의 형식]` 목적 | 주제 이름 후보 | 키 보조 지시 | 사용자 제목 판별(대소문자 무시) |
|---|---|---|---|---|---|
| `default` | 기본 | 없음 | 없음 | 없음 | 맞는 형식이 없을 때 |
| `one_on_one` | 1:1 | 두 사람의 현재 상태·진행·막힌 점·피드백·성장 | 체크인, 진행 상황, 막힌 점, 피드백, 성장·커리어 | tldr: 상대의 현재 상태와 핵심 약속 / action_items: 양쪽이 한 약속 모두 | `1on1`, `1:1`, `1-on-1`, `원온원`, `일대일` |
| `standup` | 스탠드업 | 사람별 지난 진행·오늘 할 일·블로커 | 지난 진행, 오늘 할 일, 블로커 | open_questions: 해결 담당이 정해지지 않은 블로커 | `스탠드업`, `데일리`, `daily`, `standup`, `스크럼` |
| `review` | 리뷰·회고 | 검토 대상·잘된 점·문제점과 원인·개선안 | 검토 대상, 잘된 점, 문제점·원인, 개선안 | decisions: 승인·반려·보류 판정 명시 | `리뷰`, `review`, `회고`, `retro`, `KPT`, `포스트모템`, `post-mortem` |

- **형식 결정 순서**(`resolveTemplatePlan({explicit, title, titleAuto})` → `TemplatePlan`). Claude 호출은 어느 경우나 요약 1회다.
  1. `meetings.summary_template`이 알려진 id면 그 형식으로 고정한다(`default` 포함). source `manual`, 이유 NULL.
  2. 아니면 사용자 제목(`title_auto=0`, 비어 있지 않고 `DEFAULT_MEETING_TITLE`이 아님)을 `one_on_one` → `standup` → `review` 순으로 판별해 먼저 맞는 형식으로 고정한다. source `title`, 이유 `제목의 "<일치 문자열>"`. 시스템 제목(`title_auto=1`, 기본 제목·자동 제목)에는 적용하지 않는다(자동 제목이 다음 형식을 정하는 자기 강화 방지).
  3. 둘 다 아니면 자동 모드다(source `auto`). 같은 요약 호출에서 모델이 전사 내용을 보고 형식을 고른다.
- **고정 모드 프롬프트**: 원칙 블록 → `[회의 형식]` 블록(`buildTemplateBlock`, 기본 형식은 없음) → 출력 키 블록(`buildOutputKeys(template)`) 순서다.
  - `[회의 형식]` 블록: 목적 문장과 "topics의 title은 가능하면 다음 이름 중 실제로 다뤄진 것만 그대로 쓰라, 다뤄지지 않은 이름은 만들지 말라, 목록에 없는 논의는 자유 제목으로 추가하라"는 줄이다.
  - 키 보조 지시: 형식의 `keyHints`가 있는 키마다 그 키 줄(과 하위 줄) 바로 뒤에 `  - 이 회의 유형: …` 한 줄을 넣는다. 기본 형식의 출력 키 블록은 `MEETING_OUTPUT_KEYS` 그대로다.
- **자동 모드 프롬프트**: 원칙 블록 → `[회의 형식 고르기]` 블록(`buildTemplateSelectionBlock`) → `MEETING_OUTPUT_KEYS` + `AUTO_TEMPLATE_OUTPUT_KEYS` 순서다.
  - `[회의 형식 고르기]`: 형식마다 선택 기준 한 줄(`selectHint`)과, `default`가 아닌 형식마다 목적·주제 이름 후보·키 보조 지시를 적는다. 제목보다 대화 내용을 따르고, 뚜렷하게 맞는 형식이 없으면 `default`를 고르고, 고른 형식의 지시를 따르라고 한다.
  - 메타 출력 키: `template_id`(`default`·`one_on_one`·`standup`·`review` 중 하나)와 `template_reason`(근거 한 문장, 50자 이하)을 JSON 맨 앞에 쓰게 한다.
  - 사용자 제목(`title_auto=0`, 기본 제목 아님)이 있으면 사용자 프롬프트 맨 앞에 `회의 제목(사용자 입력, 참고용): <제목>` 줄을 넣는다. 이 줄 길이도 전사 예산에서 뺀다. 시스템 제목은 넣지 않는다.
  - `MEETING_SPEC`은 자동 모드 스펙(`buildMeetingSpec({mode:'auto'})`)이다.
- **저장**(`meeting_summaries`): `template_id`=실제로 쓴 형식(자동 모드에서 허용 목록 밖 id나 빈 값이면 `default`), `template_source`=`manual`|`title`|`auto`, `template_reason`=고정 모드는 위 이유, 자동 모드는 모델 이유를 trim해 80코드포인트까지(허용 목록 밖 id면 NULL).
- 형식 목록은 `listTemplateOptions()`(`recording:listSummaryTemplates`)로 렌더러에 준다. 녹음 시작 화면에는 형식 선택이 없다. 요약 탭에서 형식을 보고 바꾼다(§8).

### 6-2. 요약 기반 자동 제목

- **판정 플래그** `meetings.title_auto`: 1이면 시스템이 붙인 제목(기본 제목 `제목 없는 회의` 또는 요약 제목)이라 요약이 바꿀 수 있다. 0이면 사용자 제목이라 절대 덮지 않는다. `recording:createDraft`는 제목이 비면 1, 입력이 있으면 0이고, `recording:rename`은 언제나 0으로 쓴다(§4). 기존 행은 `migrateMeetingUnify`가 컬럼을 붙일 때 기본·빈 제목만 1로 둔다(§2). 요약 제목에는 패턴이 없어서 제목 문자열만으로는 "자동 제목인지"를 판정할 수 없기 때문에 플래그를 둔다.
- **생성**: 같은 요약 호출의 출력 키 `title`(30자 이하 명사구, 날짜와 "회의"·"미팅" 같은 일반어 제외)을 `normalizeSummaryTitle`로 정리한다. 첫 줄만 쓰고, 제목 전체를 감싼 따옴표·괄호 쌍(`""`·`''`·`“”`·`‘’`·`「」`·`『』`·`[]`·`()`)과 끝 문장부호(`.`·`。`·`!`·`?`)를 벗기고(`결제 개편 (2차)`·`[Q3] 로드맵`·`(주)카카오`처럼 제목 일부인 괄호는 남긴다), 공백을 1칸으로 줄여 30코드포인트에서 자른다. 비었거나 `제목 없는 회의`면 쓰지 않는다(`title: null`).
- **적용**: `status='summarized'`로 바꾼 뒤, 요약 시작 때 읽은 `title_auto`가 1이고 제목이 있으면 `applyAutoTitle`이 `UPDATE meetings SET title=? … WHERE id=? AND title_auto=1 AND title<>?`를 실행한다. 조건부 UPDATE라서 요약 도중 사용자가 이름을 바꾸면(rename이 먼저 0으로 바꿈) 덮지 않는다. `title_auto`는 1로 남으므로 다시 요약하면 다시 갱신한다. 실제로 바뀌었을 때만 활동 기록(`logActivity`)에 새 제목을 쓴다.
- **자동 제목을 쓰지 않는 곳**: whisper initial_prompt의 주제(§5-1)와 형식 정규식(§6-1), 자동 모드의 `회의 제목(사용자 입력, 참고용)` 줄. AI가 만든 문구가 다음 전사·형식 판단을 유도하지 않게 한다.
- **제목 소비처**: 녹음 목록·상세는 요약 뒤 목록을 다시 불러 갱신한다(§8). 회의록·Markdown·내보내기 파일명(§10), AI 회의 도구(§6-3), 비서의 지난 회의 매칭([ASSISTANT.md](ASSISTANT.md))은 `meetings.title`을 그대로 쓴다.

### 6-3. AI 대화의 회의 질의

AI 대화는 읽기 전용 도구 `search_meetings`(여러 회의의 요약·전사 검색)와 `get_meeting_excerpt`(한 회의의 요약 또는 최대 10분 구간 원문)로 회의 기록을 읽는다(정의 `src/main/services/ai-meeting-tools.ts`). 녹음 종류 구분이 없으므로 옛 면접 녹음(현재 `kind='meeting'`)도 검색 대상이다. 도구 결과의 출처 링크 `linkwork://recording/{id}/at/{ms}`를 누르면 녹음 상세를 열고 타임라인 탭에서 그 시각부터 재생한다(§8). 도구·상한·가드레일은 [AI_CHAT_ARCHITECTURE.md](AI_CHAT_ARCHITECTURE.md) 8.1절, [AI_GUARDRAILS.md](AI_GUARDRAILS.md) 8.10절에 있다.

## 7. 액션아이템 → 할 일

`recording:actionItemToTodo(meetingId, index)`: `summary.action_items[index]`로 `todos` 행을 직접 만든다(`title=text`, `priority='medium'`). `due`가 `YYYY-MM-DD`(시각 허용) 형식일 때만 `due_date`에 넣고, 아니면 원문을 notes에 남긴다. notes는 `회의에서 추출: <회의 제목>`, `담당: <assignee>`, `기한: <원문>` 줄로 만든다. `source_link`에는 그 회의의 회의록 링크 `linkwork://note/{meetingId}`를 넣는다(할 일 행의 출처 칩이 회의록 메뉴에서 그 회의를 연다). 만든 `todo_id`를 그 항목에 기록해 다시 등록하지 않게 하고(항목의 다른 필드는 `at_ms`를 포함해 그대로 둔다. 재요약 뒤에도 같은 문장의 항목이 이어받는다, §6), 할 일 이력(`saveTodoHistory(…, 'create')`)과 `logActivity('todo', 'create', …)`를 남긴다. 자동 등록하지 않고 사용자가 버튼을 눌러야 한다(오탐 방지).

## 8. 렌더러 구조

```
stores/recorderStore.ts        # MediaRecorder 래퍼·캡처 상태(idle|recording|paused|stopped)·레벨미터 (§14)
stores/recorderSession.ts      # 녹음 세션 수명주기 오케스트레이션 (§14)
stores/recordingStore.ts       # 목록/상세/처리 상태/스트림 구독, 재생 이동 예약(pendingSeek), 화자 교정 범위·요약 형식·메모 액션. summarizeMeeting은 성공·실패와 무관하게 끝나면 fetchMeetings → refreshCurrent(자동 제목 반영)
stores/recognitionAidsStore.ts # 용어집·구성원 CRUD, 구성원별 목소리 표본 요약 (§12), 다시 찾기 previewRematch·applyRematch
utils/audio.ts                 # blobToWav16kMono, 채널 에너지 추출
utils/processing-progress.ts   # phase 가중치로 전체 진행률 계산 (§11)
utils/speakerScope.ts          # planReassignIds·SCOPE_LABELS — 화자 교정 범위(main planReassign 과 같은 규칙)
utils/talkShare.ts             # computeTalkShare·formatTalkMs — 발화 점유율(main meeting-notes.ts 와 같은 규칙·같은 테스트 표)
utils/assignMarksToTopics.ts   # 메모를 요약 주제 구간에 배정
utils/speakerCountPrompt.ts    # 상세 화면 참석 인원 확인 배너 노출 조건
components/recording/
  RecordingView.tsx            # 좌: [새 녹음]으로 여는 녹음 컨트롤 + "인식 보조" 패널 토글 + 목록, 우: 상세
  RecognitionAidsPanel.tsx     # 용어집/구성원 탭 편집 + 텍스트 가져오기, 구성원별 "목소리 N건" + [목소리 삭제] + [지난 회의에서 찾기], 구성원 탭의 [등록된 목소리로 지난 회의 다시 찾기] (§12). 설정 > 회의 녹음에도 같은 패널이 있다
  RematchDialog.tsx            # 다시 찾기 미리 보기(회의·화자·자동/제안 수) → [적용] (§5-4)
  RecorderControls.tsx         # 소스 선택 + 참석자 칩 + 참석 인원(비우면 자동, 참석자 수로 제안) + 무음 제거 체크, 시작/일시정지/종료 + 레벨미터, 녹음 중 메모·북마크, 종료 시 참석 인원 확인. 입력 → startSession 입력은 buildStartSessionInput
  RecordingList.tsx            # 녹음 카드 목록(상태 pill, 길이, 일정 제목, 처리 중 전체 진행 바 + 취소). 비면 '녹음이 없습니다'와 첫 녹음 안내
  MeetingDetail.tsx            # 헤더(제목 편집/'자동 제목' 배지/날짜/상태/무음 배지/참석자 칩) + 참석 인원 확인 배너 + 재처리 메뉴 + 처리 진행률·취소 + 실패 배너 + 탭(타임라인/요약/화자), 화자 탭의 "화자 다시 분리", 재생 이동 예약 소비
  SpeakerTimeline.tsx          # 발화 점유율(막대 + 화자별 시간·비율·발언 횟수) + 미니 타임라인(재생 위치, 클릭·드래그 시킹) + 발언 목록(클릭→오디오 점프, 재생 중 자동 스크롤, 범위를 고른 화자 재할당·새 화자 즉석 추가, 발언 수정) + 컷 토글
  SummaryPanel.tsx             # 형식 배지(+선택 경로·이유)·형식 바꿔 다시 요약 → 키워드 칩(표시 전용)→내 메모→TL;DR→핵심 포인트(구버전)→결정사항→액션아이템("+ TODO")→미결 질문→다음 단계(구버전)→주제별 요약(주제마다 배정된 내 메모). onSeek(MeetingDetail의 handleSeek)가 있고 시각이 있으면 항목마다 시각 버튼("이 시점부터 듣기", 클릭→그 시점 재생)
  SpeakerEditor.tsx            # 화자 실명 입력/색상/병합, 이름 프리셋(참석자 이름, 중복 제거, 최대 8개, buildNamePresets), 목소리 매칭 배지·확인/거절·등록, 이름 없는 화자의 [등록된 목소리로 다시 찾기]
  AudioPlayer.tsx              # <audio src="linkwork-media://audio/<파일명>"> + seek(메타데이터 로드 전 시킹은 loadedmetadata 까지 보류), cuts enabled 구간 skip(비파괴)
```

디자인은 `components/ui/tokens.ts`(button/typo/status pill), `ui/index.tsx`(Card/Badge/IconButton/EmptyState/SectionTitle), `ui/icons.tsx`를 쓴다. 새 색이나 커스텀 CSS 없이 Tailwind v4 인라인 클래스 + 토큰으로 그린다.

**오디오 재생**: main `index.ts`의 `linkwork-media` 프로토콜이 `userData/recordings/<파일명>`(basename만 받아 경로 탈출 차단)을 스트리밍한다. `<audio>` 시킹이 보내는 HTTP Range 요청을 206 Partial Content로 돌려준다.

**상세 화면 재처리 메뉴**(`MeetingDetail`, 오디오가 있고 녹음 중이 아닐 때):
- 화자 다시 분리: 참석 인원(1~20, 비우면 자동)을 `recording:setExpectedSpeakers`로 저장한 뒤 빠른 재적용.
- AI 요약 다시 생성(구 파이프라인 회의는 '다시 분석 후 요약 생성'): §13 분기.
- 전체 다시 처리: 재전사 포함, 요약도 다시 만든다.
- 빠른 재적용: 재전사 없이 정제·화자분리만(`skipTranscribe`). 전사가 나오면 요약도 다시 만든다.
- 처리 중에는 전체 진행률·단계 경과 시간·메시지와 [취소] 버튼(`recording:cancel`)를 보인다. `failed`면 오류 문구와 [다시 처리]를 보인다.

**화자 탭의 목소리 UX**(§5-4):
- `SpeakerEditor` 화자 행: `auto` → "목소리로 자동 지정 · 82%" 배지 + [맞음] [이 사람 아님]. `suggested` → "혹시 OOO?" + [지정] [아님]. `manual`이고 `voice_enrolled`(표본이 실제로 있음) → "목소리 등록됨". 이름은 있는데 구성원이 아니고 `has_voice` → [목소리 등록].
- `MeetingDetail` 화자 탭(`canRediarize`): `source='mic'`, 상태 `transcribed`/`summarized`이고 `has_voice`인 화자가 하나도 없으면(새 화자분리 이전에 처리했거나 분리에 실패한 회의) "화자 다시 분리" 버튼을 보인다. 누르면 `reprocessMeeting(id, true)` — 빠른 재적용(`skipTranscribe`: 재전사·컷편집 없음, `pipeline_version` 유지, 발언 단위 수동 보정과 화자 속성 보존, §5-4)으로 화자분리만 다시 돌리고 이어서 요약을 다시 만든다. 버튼 옆에 요약도 다시 만든다는 문구를 보인다.

**녹음 시작·녹음 중**(`RecorderControls`):
- 녹음 종류 선택·동의 체크·요약 형식 선택·제목 입력이 없다. 새 녹음은 `제목 없는 회의`(`title_auto=1`)로 만들어지고, 요약이 끝나면 요약 제목으로 바뀐다(§6-2). 형식은 요약할 때 정한다(§6-1).
- **메모·북마크**(녹음·일시정지 중): 입력란에 메모를 쓰고 Enter로 저장한다. 메모 시각(`raw_ms`)은 빈 입력란에 첫 글자를 쓴 순간의 녹음 경과 시간(일시정지 제외)이다. [북마크] 버튼이나 B 키는 지금 시각의 빈 메모를 남긴다. B 키는 녹음 중이고 글 입력 요소에 포커스가 없을 때만 동작한다(이 화면이 떠 있을 때만 듣는다. 전역 단축키가 아니다). 저장은 `recording:addMark`(`origin='live'`)이고 최근 메모 3개를 보여 준다.
- **종료 시 참석 인원 확인**(`shouldAskHeadcountOnStop({speakersInput})`): 참석 인원을 비워 두고 시작했으면 [종료 및 저장]을 누를 때 "참석 인원은 몇 명이었나요?"를 버튼 자리에 띄운다(녹음은 계속된다). 2~6 칩이나 1~20 입력을 고르면 `recording:setExpectedSpeakers`로 저장한 뒤 종료·처리한다. [모르겠어요 · 자동]은 자동 추정으로 종료하고, [녹음 계속]은 닫는다. 창 닫기·앱 종료 가드의 저장 경로(§14)는 묻지 않는다.

**상세 화면 참석 인원 확인 배너**(`MeetingDetail`, `speakerCountPrompt`): `speakers_confirmed=0`이고 `expected_speakers`가 NULL이고 상태가 `transcribed`/`summarized`이고 발언이 있으면 "화자를 자동으로 N명으로 나눴습니다. 실제 참석 인원이 맞나요?"를 머리에 띄운다(N = 발언이 있는 화자 수, 최소 1). [맞아요]는 N을 저장한다. 다른 수를 넣고 [명으로 다시 나누기]를 누르면 저장한 뒤 빠른 재적용으로 다시 나누고 요약도 다시 만든다. 닫기는 `setExpectedSpeakers(null)`이라 자동 추정을 둔 채 확인으로 친다. 처리 중에는 보이지 않는다.

**헤더 제목**(`MeetingDetail`): `title_auto=1`이고 상태가 `summarized`이고 제목이 비어 있지 않고 `제목 없는 회의`가 아니면 제목 옆에 '자동 제목' 배지를 단다(`showsAutoTitleBadge`). 제목 편집을 저장하면 `recording:rename`이 `title_auto=0`으로 바꿔 그 뒤 요약이 덮지 않는다. 자동 제목은 글자를 바꾸지 않고 저장해도 rename을 불러 사용자 제목으로 굳힌다(`shouldRenameTitle`).

**요약 탭**(`SummaryPanel`):
- 맨 위에 `형식: <이름><경로>` 배지가 있다. 이름은 `summary.template_id`(NULL이면 기본), 경로는 `templateSourceSuffix(template_source)`로 ` · 자동`(auto)·` · 제목 기준`(title)·` · 직접 선택`(manual)이고 NULL이면 없다. 이유가 있으면 옆에 `자동 선택 이유: …`(auto) 또는 `제목 기준: …`(title)를 보인다.
- "형식 바꿔 다시 요약" 셀렉트는 `자동(내용으로 판단)`(`meetings.summary_template`이 NULL) + 형식 목록이다. 값을 고르면 확인창("현재 요약을 덮어씁니다. 할 일로 옮긴 항목은 같은 문장이면 연결을 유지합니다." 뒤에 형식이면 "이 회의는 그 형식으로 고정됩니다.", 자동이면 "내용으로 형식을 다시 고릅니다.") 뒤에 `recording:setSummaryTemplate`으로 저장하고 다시 요약한다. 형식을 고르면 그 회의는 수동 고정(source `manual`)이다.
- 메모가 있으면 **내 메모** 섹션에 메모 원문을 `[mm:ss]` 시각 버튼(그 시점부터 재생)과 함께 보이고, 북마크는 칩으로 보인다. 메모마다 인라인 수정(Enter 저장·Esc 취소, 비우면 북마크)·삭제가 있고, [+ 메모 추가]는 지금 재생 위치(`currentMs`)에 `origin='post'` 메모를 더한다.
- 메모를 더하거나 고치거나 지우면 자동으로 다시 요약하지 않고 [메모를 반영해 다시 요약] 버튼을 보인다.
- 메모가 있는 회의는 AI가 만든 줄에 회색 `AI` 표식을 달고, 머리에 `▌내 메모 · AI 요약` 범례를 둔다. 주제별 요약의 각 주제 카드 아래에 그 주제 구간에 배정된 메모를 노란 왼쪽 강조선으로 보인다. 배정은 렌더러가 결정론적으로 한다(`assignMarksToTopics`): 주제 i의 구간은 `[start_i, start_{i+1})`이고 마지막 주제는 끝이 없으며, 첫 주제 앞 메모는 첫 주제에 둔다. 주제 시각이 하나라도 없거나 오름차순이 아니면 배정하지 않는다(내 메모 섹션에만 보인다).

**타임라인 탭**(`SpeakerTimeline`):
- **발화 점유율**: 화자별 발화 시간(세그먼트 길이 합), 비율, 발언 횟수(같은 화자가 이어진 묶음 수)를 막대와 줄로 보인다. 규칙은 §10의 Markdown과 같다(`computeTalkShare`).
- **화자 교정 범위**: 화자 칩을 누르면 드롭다운 위에 [이 구간만] [이 구간부터] [전체] 범위 버튼과 "<화자> 발언 N개를 바꿉니다" 안내가 있다(열 때마다 `이 구간만`). 대상 화자(또는 새 화자 즉석 추가)를 고르면 `recording:reassignSegment(segmentId, speakerId, scope)`를 부르고 상세를 새로 읽는다. `전체`에서 두 화자가 모두 있으면 화자 병합이 된다는 표시가 붙는다.

**다시 찾기(Rematch) 진입점 3곳**: ① 화자 탭(`SpeakerEditor`): 목소리가 있는데 이름이 빈 화자가 있으면(`shouldOfferRematch`) [등록된 목소리로 다시 찾기], 그 회의만(`meetingIds: [id]`). ② 인식 보조 > 구성원: [등록된 목소리로 지난 회의 다시 찾기], 전체(표본이 있는 구성원이 하나도 없으면 비활성). ③ 구성원 행: [지난 회의에서 찾기], 그 구성원만(`memberIds: [id]`). 세 곳 모두 `RematchDialog`가 미리 보기(회의 수·화자 수·자동·제안 수, 회의별 화자 → 구성원 목록)를 보이고 [적용]을 누르면 적용한다. 안내 문구는 "자동 지정은 이름까지 붙이고, 제안은 화자 탭에서 확인을 기다립니다. 목소리 표본은 새로 만들지 않습니다. 이미 만든 요약의 화자 이름은 요약을 다시 만들면 반영됩니다."다. 적용 뒤 구성원 목록을 다시 읽고 열린 회의를 새로 읽는다.

**재생 위치로 열기**: `linkwork://recording/{id}/at/{ms}`(AI 대화의 회의 출처 링크, §6-3)는 `openInternalLink`가 `recordingStore.setPendingSeek({meetingId, ms})`로 예약한 뒤 녹음 상세를 연다. `ms`는 0 이상 86,400,000 미만의 정수만 받고, 아니면 시각 없이 녹음만 연다. `MeetingDetail`은 그 회의의 오디오가 있으면 예약을 꺼내 타임라인 탭으로 바꾸고 그 시각부터 재생한다. 오디오가 아직 없으면 예약을 남겨 둔다.

메뉴는 사이드바 "회의" 그룹의 `녹음` 하나다. 녹음 종류 구분과 종류 필터는 없다.

흐름: `idle → (start) recording → (pause/resume) → (stop) → saveAudio → process → summarize`. 녹음 중엔 경과 시간/레벨미터를 보인다. 종료하면 저장 뒤 처리와 요약이 백그라운드로 이어진다(§14).

## 9. 네이티브 의존성 / 빌드

- `@fugood/whisper.node`, `sherpa-onnx-node`, `silero-vad-node`는 **optionalDependencies**다. `electron.vite.config.ts`가 메인 번들에서 외부화하고, 코드는 lazy import + try/catch로 불러 없으면 폴백 어댑터로 내려간다. 파이프라인은 항상 끝까지 돈다.
- 화자 분리는 메인 번들과 함께 빌드되는 워커(`out/main/diarization-worker.js`, `src/main/services/diarization/worker.ts`)를 `utilityProcess`로 띄워 돌린다. `electron.vite.config.ts`는 실측 회귀용 cli 엔트리(`out/main/diarization-cli.js`, `src/main/services/diarization/cli.ts`)와 메모리 실측 probe 엔트리(`out/main/diarization-mem-probe.js`, `src/main/services/diarization/mem-probe.ts`, 창 없는 Electron main)도 만든다. 엔트리들이 함께 쓰는 코드는 `out/main/chunks/`에 나뉘어 나온다. cli는 electron 모듈을 쓰지 않아 `ELECTRON_RUN_AS_NODE=1`로 배포 앱 바이너리에서 돌릴 수 있다(§5-3).
- **시스템 오디오**: 추가 패키지 없이 Electron 내장 `session.setDisplayMediaRequestHandler` + `audio: 'loopback'`을 쓴다(`src/main/services/system-audio-loopback.ts`, 앱 시작 시 창 생성 전에 등록). Electron 39+는 macOS 14.2+에서 이를 CoreAudio Tap으로 지원하며 feature flag가 필요 없다. `loopbackWithMute`는 스피커를 음소거하므로 쓰지 않는다. 시스템 오디오 권한이 없으면 에러 없이 처음부터 ended인 트랙이 오므로 렌더러(`recorderStore`)가 `readyState === 'live'`인 트랙만 쓰고, 없으면 "시스템 오디오 권한이 없어 마이크만 녹음합니다."를 안내한다. 녹음 중 시스템 트랙이 끊기면 경고만 띄우고 마이크 녹음은 계속한다.
- **마이크 제약**: `echoCancellation: true`(스피커로 나온 상대 음성이 마이크(L)에 섞이는 것 방지), `noiseSuppression: false`(§11 정책 — 노이즈 억제는 whisper WER·화자 분리 DER을 악화시킨다는 보고가 있어 입력 단계에서도 끈다).
- `package.json` `build.asarUnpack`에 `**/*.node`와 `node_modules/sherpa-onnx-darwin-arm64/**`가 있다. Whisper 모델과 화자 임베딩 모델(`sherpa-embedding.onnx`, CAM++ 28MB)은 `userData/models/`에 런타임으로 내려받는다. 화자분리에 pyannote 분할 모델은 필요 없다(`areDiarizationModelsReady`·`ensureDiarizationModels`는 임베딩 모델만 본다).
- `Info.plist`(electron-builder `mac.extendInfo`): `NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`.

## 10. 회의록 메뉴

요약까지 끝난 회의(`meetings.status='summarized'`)를 사이드바 "회의록"(ViewId `notes`)에서 문서처럼 목록·검색·열람하고 Markdown으로 복사·저장한다. 새 테이블은 없다. `meetings` + `meeting_summaries`(1:1) 조인과 `meeting_segments`·`meeting_attendees`·`meeting_members`·`meeting_marks`만 읽는다(읽기 전용).

- 파일: `src/main/services/meeting-notes.ts`(순수 함수 `buildMeetingNoteMarkdown`, `countActionItems`, `escapeLike`, `parseJsonArray`, 요약 읽기 정규화 `parseTextItems`·`parseTopics`·`parseKeywords`, 컷편집용 `remapSummaryTimes`, 발화 점유율 `computeTalkShare`), `src/main/ipc/meeting-notes.ipc.ts`, 렌더러 `components/notes/`(`MeetingNotesView`·`MeetingNoteList`·`MeetingNoteDoc`)와 `stores/meetingNotesStore.ts`.
- IPC (preload `window.api.meetingNotes`):

| 채널 | 입력 | 출력 |
|---|---|---|
| `meetingNotes:list` | `MeetingNoteFilter?` | `MeetingNoteItem[]` (`started_at DESC, id DESC`) |
| `meetingNotes:markdown` | `id: number` | Markdown 문자열 (회의 없으면 `''`) |

- 필터: `q`는 trim 후 비면 무시하고, `%`·`_`·`\`를 이스케이프(`ESCAPE '\'`)해 문자 그대로 찾는다. 필터는 `{q?}`뿐이고, 옛 `kind` 값이 와도 무시한다. 목록 항목(`MeetingNoteItem`)에 `kind`는 없다. 종류 필터·배지는 없다.
- 요약 읽기 정규화: 저장된 JSON은 요약 시점의 형식을 그대로 담으므로, 읽는 쪽(`recording.ipc.ts`의 `mapSummary`, `meetingNotes:markdown`)은 `parseTextItems`(문자열과 `{text, at_ms}` 혼재 → `{text, at_ms}`), `parseTopics`, `parseKeywords`로 한 형태로 맞춘다. 컬럼이 NULL이거나 JSON이 깨졌으면 빈 배열이다.
- 검색 범위(부분 일치 LIKE, OR): `m.title`, `s.tldr`, `s.key_points`, `s.decisions`, `s.action_items`, `s.next_steps`, `s.topics`, `s.open_questions`, `s.keywords`, 그리고 전사 `meeting_segments.text`(EXISTS 서브쿼리). JSON 컬럼은 직렬화 문자열 그대로 검색한다.
- `MeetingNoteItem` 파생 값: `key_point_count`, `decision_count`, `action_item_count`(각 JSON 배열 길이), `open_action_count`(`todo_id`가 없는 액션아이템 수), `attendee_names`(정렬은 `listAttendees`와 같다).
- Markdown 구조: `# 제목` → 메타 줄(일시·길이·참석자) → `## 키워드`(`a · b · c` 한 줄), `## TL;DR`, `## 핵심 포인트`(구버전 요약만), `## 결정사항`, `## 액션아이템`(`- [ ]`/`- [x]`=할 일로 옮김, 담당·기한), `## 미결 질문`, `## 다음 단계`(구버전 요약만), `## 주제별 요약`(`### n. 제목 [mm:ss]` + 포인트 불릿) → `## 내 메모`, `## 발화 점유율` → 마지막 `## 전사`(`[mm:ss] **화자**: 텍스트`). 빈 섹션은 생략한다.
  - `## 내 메모`: 메모를 `at_ms` 순으로 `- [mm:ss] 메모`(북마크는 `(북마크)`) 한 줄씩 쓴다.
  - `## 발화 점유율`: 화자가 있는 줄이 2개 이상일 때만 넣는다. 줄은 `- 이름: mm:ss (n%) · 발언 k회`다. 규칙(`computeTalkShare`, 렌더러 `utils/talkShare.ts`와 같은 규칙·같은 테스트 표): 길이 0인 세그먼트는 무시하고, 발화 시간은 세그먼트 길이(`end_ms − start_ms`) 합, 발언 횟수는 시간순으로 같은 화자가 이어진 묶음 수다. 비율은 최대 나머지 방식으로 합을 정확히 100으로 맞춘다. 줄은 발화 시간 내림차순(같으면 화자 순서)이고, 화자 없는 세그먼트는 `미지정` 줄로 맨 뒤에 둔다. 컷 구간은 따로 빼지 않는다. 결정사항·액션아이템·미결 질문·주제 제목은 시각이 있으면 끝에 전사 섹션과 같은 표기의 ` [mm:ss]`를 붙이고, 없으면 붙이지 않는다. 구버전 요약(새 필드 없음)의 출력은 새 필드가 생기기 전과 같다.
- 회의록 문서 화면(`MeetingNoteDoc`)은 요약 섹션과 전사를 같은 순서로 그리고(`## 내 메모`·`## 발화 점유율`은 Markdown 내보내기에만 있다), 시각은 회색 `mm:ss` 텍스트로만 보인다(오디오 없음). 상세 화면의 요약 탭(`SummaryPanel`)은 시각을 버튼으로 그려 누르면 그 시점부터 재생한다. 키워드 칩은 표시 전용이다.
- 문서 화면의 [Markdown 복사]는 클립보드에, 저장은 `export:saveMarkdown`(저장 대화상자)으로 파일에 쓴다.

## 11. 무음 컷편집 (audio compaction)

**목적**: 처리 전에 긴 침묵을 잘라 (a) whisper 청크 수(28초 창에 발화가 더 촘촘히) (b) 처리할 오디오 길이 (c) 파일 크기를 줄이고, 재생 시 침묵 스킵이 필요 없게 한다. **컷편집본이 그 녹음의 파일이 된다**(사용자 결정, 원본 별도 보관 없음). 제거한 구간은 `<id>.compaction.json` 사이드카(`{version, originalMs, compactedMs, removed[], params, compactedAt}`)에 남긴다.

**구성**
- `stt/audio-compactor.ts` — 순수 함수(단위 테스트 대상): `planCompaction(speech, audioMs, opts)`, `compactPcm16(wav, dataRange, keep)`, `remapChannelEnergy(env, keep)`, `mapMsToCompacted(ms, keep)`, `speechRegionsToCompacted(speech, keep)`. 기본 파라미터는 `DEFAULT_COMPACTION_OPTIONS` 한곳에 둔다.
- `stt/vad-detect.ts` — whisper.node silero VAD 검출 공용 함수 `detectSpeechRegions(audioPath, dataRange, opts)` (컷편집·STT 공용). `opts.threshold`로 발화 확률 임계값만 덮어쓸 수 있다(미지정·범위 밖이면 0.5). **반드시 `useGpu:false`**(Metal에서 ggml_abort로 앱 즉사 이력) + `.vad-crash-guard` 센티널 유지. **`initWhisperVad`는 반드시 `nThreads: 1`을 명시한다** — 기본값이 hardware_concurrency(12)인데 silero는 0.88MB 초소형 그래프라 프레임마다 12스레드를 동기화하는 비용이 연산을 압도해 사실상 멈춘다(실측 5초 오디오: nThreads 1=33ms, 2=43ms, 4=229ms, 기본값=60초 초과 미완료·CPU 482%). nThreads 1이면 전체 파일 검출이 길이에 선형으로 약 224× 실시간(8분 2.1초, 54분 14.6초, 98분 26초). **검출은 파일 전체를 한 번에 넣는다(`detectSpeechFile`)** — 청크로 나누면 경계마다 발화가 ~0.2초씩 어긋나고 컷편집은 되돌릴 수 없으므로 나누지 않는다. 네이티브 호출 중에는 진행률을 얻을 수 없어 `estimateVadProgress(elapsedMs, audioMs, 200×)`(실측 224×보다 약간 보수적, 0.95 상한)를 1초 티커로 보고하고 완료 시 1.0으로 마감한다. 호출 중간 취소는 불가(최대 수십 초), 호출 전후에만 취소를 확인한다.
- `audio-compaction.ts` — I/O: VAD → plan → `.tmp`에 쓰고 검증 후 `rename`(원자적) → `<id>.channels.json` 재매핑 → 사이드카 기록. 어떤 실패도 `applied:false`로 흡수(취소만 전파).

**정책** (기본값 — 리서치 근거: faster-whisper VAD 기본 `min_silence_duration_ms=2000`, 편집 도구 관행, pyannote 경계 불연속 리스크)
- **VAD 임계값 이원화**: 컷편집용 VAD는 `COMPACTION_VAD_THRESHOLD = 0.35`(audio-compaction.ts), 전사용은 기본 0.5다. 컷편집은 원본을 보관하지 않아 되돌릴 수 없으므로 "발화를 놓쳐 잘라내는 것"이 "잡음을 남기는 것"보다 훨씬 비싸다(작은 목소리·원거리 화자 보호). 0.35는 기본 0.5와 NVIDIA NeMo Curator 문서의 조용한 화자용 관대한 값 0.3 사이에서 보수적으로 고른 값이며 실측 튜닝값은 아니다. 낮은 임계로 잡힌 잡음 구간을 전사하면 환각이 늘어나므로 **컷편집 발화 구간은 STT에 재사용하지 않는다** — STT 어댑터가 컷편집된 파일에 0.5로 VAD를 다시 돌린다(VAD는 실시간 대비 수백 배 빨라 비용이 작다).
- 침묵 판정은 VAD 발화 구간의 여집합. `padMs`(발화 앞뒤 여유, 200) 밖의 침묵 중 `minRemovableGapMs`(2000) 이상만 제거 대상이며, 제거 시 `keepGapMs`(600 — 화자분리 안정성을 위해 ≥0.5s)만큼의 **실제 오디오**(앞 절반은 직전 발화 뒤, 뒤 절반은 다음 발화 앞)를 남겨 룸톤을 유지한다. 디지털 무음(0)을 끼워 넣지 않는다 — whisper 환각·경계 클릭 방지. 접합부마다 `fadeMs`(8) 선형 fade-out/in을 건다(갭 길이보다 클릭이 더 위험). 파일 맨 앞/뒤 침묵은 `edgeMs`(300)만 남긴다.
- 라우드니스 정규화·하이패스·노이즈 억제는 **하지 않는다**. whisper는 [-1,1] 범위 안의 음량 차이에 대체로 불변이고, 노이즈 억제는 large 계열에서 WER을 오히려 높이며 pyannote DER도 악화시킨다는 보고가 있다(SciTePress 2024, arXiv 2603.04710, pyannote-audio #1053).
- 절감이 `minSavingsRatio` 미만이면 파일을 다시 쓰지 않는다(`applied:false`).
- 컷편집은 **첫 전체 처리에서 정확히 1회**(`audio_compacted` 멱등 가드). "빠른 재적용"(`skipTranscribe`)은 기존 세그먼트 타임스탬프를 재사용하므로 절대 컷편집하지 않는다. 이미 요약(근거 시각)이 있는 회의를 전체 재처리하며 컷편집이 적용되면 그 시각을 `mapMsToCompacted`로 재매핑한다.
- **녹음 중 메모**: 녹음 중 메모(`meeting_marks.origin='live'`)의 시각은 녹음 경과 시간(`raw_ms`)이라 컷편집 전 시간축이다. 컷편집이 적용되면 `remapLiveMarks`가 `at_ms = mapMsToCompacted(raw_ms, keep)`로 다시 계산한다. `raw_ms`에서 계산하므로 여러 번 돌려도 결과가 같다. 상세 화면에서 더한 메모(`origin='post'`)는 이미 현재 시간축이라 재매핑하지 않는다. 재매핑이 실패해도 처리는 계속한다.
- 녹음 시작 화면의 "무음 구간 자동 제거"(`compact_audio`, 기본 on)로 회의별 opt-out 가능. 상세 화면은 `original_duration_ms`로 "무음 −mm:ss (n%)" 배지를 보여준다.
- `mic+system`의 채널 에너지 envelope(`<id>.channels.json`, 100ms hop)도 같은 keep 구간으로 재매핑해 화자 귀속이 어긋나지 않게 한다.

**진행률 표시**: main은 phase별 0~1을 보낸다(compact: VAD 0→0.85, 쓰기 0.95, 사이드카 1.0 / transcribe: 어댑터가 VAD를 돌리는 0→0.08 뒤 전사 0.08→1). 렌더러 `utils/processing-progress.ts`가 phase 가중치(`PHASE_WEIGHTS`: compact .04 / transcribe .60 / vad .01 / diarize .28 / merge .02 / summarize .05)로 **전체 진행률**을 계산해 바에 표시하고, phase 경과 시간을 함께 보여준다. 메시지 전용 스트림 이벤트(`progress` 없음)는 직전 진행률을 유지한다(`mergeProcessingEvent`).

## 12. 인식 보조 장치 (용어집 · 구성원)

회사 기밀을 코드에 두지 않는다. 구조만 제공하고 내용은 사용자가 입력하며, **로컬 SQLite에만** 저장된다. whisper initial_prompt는 로컬 추론에만 쓰이고, 요약 단계에서는 참석자 이름·용어와 사용자 메모(`[사용자 메모]` 블록, §6) 문구가 전사록과 함께 Claude로 전송된다(전사록이 이미 가는 경로와 동일).

| 보조 장치 | 저장 | 사용처 |
|---|---|---|
| 용어집 `stt_glossary` (정답 표기 · 오인식 표기 aliases · 메모 · 우선순위) | 로컬 DB | ① `buildInitialPrompt({glossaryTerms})` — 프롬프트 **끝**에 ` 용어: A, B, C.`(최대 15개·120자, 전체 360자; whisper는 마지막 224토큰만 반영하므로 끝이 가장 중요, alias는 넣지 않는다) ② `applyGlossary(segments, rules)` 결정론적 후보정 ③ 요약 `[참고 정보]` 블록 |
| 구성원 `meeting_members` (이름 · 호칭/별칭 · 역할) + 회의별 참석자 `meeting_attendees` | 로컬 DB | ① 프롬프트 참석자 힌트(`speakerNames`에 합류) ② 녹음 시작 시 참석 인원 자동 제안 ③ `SpeakerEditor` 이름 프리셋 ④ 요약 `[참고 정보]`의 담당자 매칭 ⑤ 목소리 매칭 후보(참석자가 있으면 참석자로 좁힘) |
| 목소리 표본 `member_voice_samples` (구성원별 화자 centroid) + 회의 화자 목소리 `meeting_speaker_voices` | 로컬 DB | 다음 회의의 화자 자동 지정·제안, 지난 회의 다시 찾기(§5-4) |

**목소리 표본**: 사용자가 화자에 구성원 이름을 지정하거나 [목소리 등록]·[맞음]을 누를 때만 만든다(동의 없는 수집 없음, 자동 지정과 다시 찾기는 표본을 만들지 않는다). 192차원 임베딩이며 오디오는 담지 않는다. **로컬 SQLite에만** 저장하고, 요약 프롬프트·휴대폰 열람·회의록 Markdown·렌더러 IPC 응답 어디에도 넣지 않는다(렌더러는 `has_voice`·표본 건수만 받는다). 데이터 백업 파일에는 회의 그룹으로 포함된다([DATA_BACKUP.md](DATA_BACKUP.md)). 구성원 탭의 [목소리 삭제] 버튼(`recognitionAids:clearVoiceprint`)로 그 구성원의 표본을 모두 지운다.

**후보정 규칙(`stt/glossary-correct.ts`)** — 오치환 방지가 우선: alias 2자 이상, term과 동일한 alias 제외, 긴 alias 우선. 라틴/숫자 alias는 대소문자 무시 + 양쪽 영숫자 경계. 한글 포함 alias는 경계 없음(조사 결합 허용: "링크워크를"→"LinkWork를"), 3자 이상이면 문자 사이 공백 0~1개 허용("링크 워크"). 이미 정답 표기인 부분은 재치환하지 않는다. 사용자 수정 플래그 `text_corrected`는 건드리지 않는다.

**서비스(`recognition-aids.ts`)**: `listGlossary/upsertGlossary/removeGlossary/importGlossaryText(parseGlossaryText)/listMembers/upsertMember/removeMember/setAttendees/listAttendees/loadPromptContext/buildSummaryContextBlock`. 목소리 표본 조회·삭제는 `voiceprint.ts`에 있다. `loadPromptContext(db, meetingId)`는 켜진 용어 전체(전역)를 `priority DESC, updated_at DESC`로 읽고, 실패 시 빈 컨텍스트(throw 금지).

**UI**: 녹음 목록 헤더 "인식 보조" → `RecognitionAidsPanel`(용어집/구성원 탭, 텍스트 가져오기 `정답 | 별칭1, 별칭2 | 메모`, 구성원별 "목소리 N건" + [목소리 삭제]).

**지난 회의 다시 찾기**: 구성원 탭의 [등록된 목소리로 지난 회의 다시 찾기] 버튼(전체 대상)과 구성원 행의 [지난 회의에서 찾기] 버튼(그 구성원만)이 지금 등록된 목소리로 지난 회의의 이름 없는 화자를 다시 찾는다. 미리 보기 뒤 적용하고, 표본은 만들지 않는다(규칙 §5-4, 화면 §8). 녹음 시작 화면 참석자 칩, 상세 화면 참석자 칩 편집.

## 13. 파이프라인 버전과 요약 재생성

전체 처리(`!skipTranscribe`)가 merge 트랜잭션에서 `meetings.pipeline_version = CURRENT_PIPELINE_VERSION`(meeting-pipeline.ts, 현재 **4**)을 기록한다. 버전 값의 뜻: 0 = 구 파이프라인 또는 미처리, 2 = 무음 컷편집 + 용어집 후보정/프롬프트 힌트 + 참석자 힌트, 3 = 2에 더해 세그먼트 분할(maxLen) + 환각 필터 + 화자 centroid 병합 + 컷편집 VAD 이원화 + 화자 속성 승계, 4 = 3에 더해 창 임베딩 화자분리(§5-3) + 목소리 매칭(§5-4). 빠른 재적용은 컷편집·재전사를 하지 않으므로 값을 유지한다. 파이프라인 동작이 결과에 영향을 줄 만큼 바뀌면 이 상수를 올린다.

상세 화면의 "AI 요약 다시 생성"은 `needsFullReanalysis(meeting)`(= `pipeline_version < 2`, MeetingDetail.tsx의 `SUMMARY_PIPELINE_VERSION`)로 분기한다. 버전 2 이상 회의는 모두 "요약만 재생성" 대상이다:
- **구 파이프라인 회의** → "다시 분석 후 요약 생성": 전체 재처리(컷편집 → 용어집·참석자 힌트로 재전사 → 후보정 → 화자분리) 후 자동 요약. 화자 실명·색상·사용자 라벨은 시간 겹침으로 승계되고(§5-4), 발언 단위 수정(텍스트 수정·세그먼트별 화자 지정)은 초기화된다(merge가 세그먼트를 재생성).
- **현재 파이프라인 회의** → 요약만 재생성(전사·수동 수정 보존, `[참고 정보]` 블록은 항상 반영).
"전체 다시 처리"는 버전과 무관하게 항상 재전사 + 요약 재생성이다(`recordingStore.reprocessMeeting`이 성공·전사 시 `summarizeMeeting`을 호출). 승계 규칙은 위와 같다.
버전 3 이하 회의를 일괄로 다시 처리하지는 않는다. 화자 탭의 "화자 다시 분리"(§8)가 목소리가 없는 마이크 녹음에만 보여, 사용자가 회의별로 빠른 재적용(재전사 없음)으로 화자만 다시 나눈다.
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
- **겹침 발화**: 창 하나에 화자 한 명만 배정한다. 두 사람이 동시에 말한 구간은 한쪽으로 간다.
- **세그먼트 안 화자 교대**: 창은 STT 세그먼트 안에만 깔고 귀속은 세그먼트 단위다. 한 세그먼트 안에서 화자가 바뀌면 한 명으로 귀속된다(세그먼트를 짧게 자르는 것으로 완화, §5-1).
- **채널·2-스테이지 경로의 목소리**: `mic+system` 채널 분리와 2-스테이지 경로는 centroid를 내지 않아 목소리 매칭·등록이 되지 않는다.
- **범위 교정과 centroid**: `recording:reassignSegment`의 `one`·`forward` 범위로 화자를 바꿔도 화자 centroid는 갱신하지 않는다. 화자 병합(`all` 범위의 병합 포함)만 centroid를 합친다. 정확한 centroid가 필요하면 참석 인원을 지정해 다시 나눈다.
- **다인 회의 화자 수**: 3명 이상 회의에서 자동 추정 화자 수가 실제와 다를 수 있다. 참석 인원을 지정하면(녹음 시작 화면, 종료 시 확인, 상세 화면의 확인 배너·재분리 메뉴 — 모두 `recording:setExpectedSpeakers`) 그 수로 정확히 나눈다 — 다인 회의는 지정을 권장한다.
- **정확도 근거**: 정답 화자 라벨이 있는 녹음은 1on1(2명)뿐이다. 다인 회의의 화자 수·귀속 정확도는 측정하지 못했다.
