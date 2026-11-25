# Granola 벤치마크 — 회의 녹음·화자 구분·요약 포맷

- **조사일**: 2026-11-26
- **성격**: 공개 자료 기반 블랙박스 분석이다. 공식 도움말·API 문서·블로그·릴리스 노트·보안 문서·제3자 리뷰만 썼다. 앱 바이너리 분해, 로컬 캐시 열람, 약관 위반 행위는 하지 않았다.
- **표기 규칙**: 출처 URL이 붙은 문장은 공개 자료에 적힌 사실이다. **[추론]** 표시는 관찰된 동작에서 내부 구조를 미루어 짐작한 것이다. **[제3자]** 표시는 Granola가 아닌 리뷰·커뮤니티 자료라서 정확도가 낮을 수 있다.
- **대상**: Granola(granola.ai). 봇이 회의에 들어가지 않고, 데스크톱에서 마이크와 시스템 오디오를 잡아 노트를 만드는 앱이다. macOS·Windows·iOS·Android를 지원한다.
- **비교 기준선**: LinkWork 현재 파이프라인은 [MEETING_RECORDING.md](../../MEETING_RECORDING.md) §0, §5-3, §6, §10에 있다.

## 0. 한눈에 보는 결론

| 주제 | Granola의 방식 | LinkWork에 주는 시사점 |
|---|---|---|
| 화자 구분(원격 회의) | 음향 화자분리를 하지 않는다. ① 오디오 소스(마이크=Me, 시스템=Them) ② 회의 앱 화면의 "지금 말하는 사람" 표시를 읽어 이름 부여(Speaker tags) ③ LLM이 문맥으로 추론 | "같은 사람인지 음성으로 맞히기"를 피해 간다. 원격 회의는 회의 앱의 발화자 표시를 읽는 쪽이 임베딩 클러스터링보다 정확하다 |
| 화자 구분(대면) | 데스크톱은 방 안 전원이 Me 하나로 묶인다. 모바일 앱만 Speaker A/B 익명 분리 | Granola도 대면 다자 분리는 약하다. 이 영역은 LinkWork가 따로 풀어야 한다 |
| 요약 포맷 | 고정 스키마가 아니다. 템플릿(목적·문체·섹션 목록)이 구조를 정하고, 결과는 헤딩 + 불릿 Markdown이다 | 5분류 고정 JSON을 "섹션 배열" 스키마로 넓히면 템플릿을 얹을 수 있다 |
| 사용자 메모 | 회의 중 적은 메모가 요약의 뼈대다. 메모에서 온 줄은 검정, AI가 보탠 줄은 회색 | 녹음 중 메모 입력란과 출처 표시(메모/AI)를 더하면 요약 품질과 신뢰가 함께 오른다 |
| 근거 링크 | 요약 불릿마다 돋보기 → 전사 인용 → 클릭하면 전사 위치로 이동 | 면접 요약의 `[mm:ss]` 규약을 회의 요약 불릿에도 적용하면 된다 |
| 오디오 보관 | 오디오를 저장하지 않는다. 재생 기능이 없다 | LinkWork는 로컬 WAV를 보관해 재처리·재생이 된다. 이 점은 우리가 앞선다 |

## 1. 오디오 캡처와 화자 구분

### 1-1. 봇 없는 캡처

- 데스크톱 앱이 기기에서 직접 오디오를 잡는다. 봇이 통화에 들어가지 않는다. Zoom, Google Meet, Microsoft Teams, 그 밖의 VoIP 앱에서 동작한다. (https://docs.granola.ai/help-center/taking-notes/transcription)
- 특정 앱의 소리만 골라 잡지 못한다. 시스템 오디오 전체를 한 스트림으로 잡는다. 회의 중 음악을 틀면 전사에 섞인다. (같은 문서)
- macOS 권한은 마이크, 그리고 "화면 및 시스템 오디오 녹음" 두 가지다. (https://docs.granola.ai/help-center/troubleshooting/transcription-issues)
- 오디오는 마이크·시스템 오디오에서 전사 제공자에게 실시간으로 넘어간다. 오디오·영상 파일을 저장하지 않아 나중에 재생할 수 없다. 미리 녹음된 파일(MP3 등) 가져오기도 지원하지 않는다. (https://docs.granola.ai/help-center/taking-notes/transcription)
- 전사 제공자는 보안 페이지에 Deepgram과 AssemblyAI가 예시로 적혀 있다. 요약 모델은 OpenAI와 Anthropic 모델을 섞어 쓴다. (https://www.granola.ai/security , https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes)
- iOS 베타는 한때 AssemblyAI를 썼고, macOS 정식 앱은 "다른 전사 서비스"를 쓴다고 사고 보고서에 적혀 있다. (https://docs.granola.ai/help-center/policies/security-reports/post-mortem-assembly-ai-api-key-exposure) **[추론]** 데스크톱의 실시간 스트리밍 전사는 Deepgram 계열, 모바일의 사후 일괄 전사 + 화자분리는 AssemblyAI 계열일 가능성이 높다.
- 데이터는 미국 AWS에 저장하고, 노트는 기기에 캐시해 오프라인에서도 열고 고칠 수 있다. (https://docs.granola.ai/help-center/consent-security-privacy/security-privacy-data-faqs)

### 1-2. "나/상대" 구분 — 소스 기반

- 전사 패널의 말풍선은 소스별로 색이 다르다. 회색(왼쪽)은 시스템 오디오, 초록(오른쪽)은 내 마이크다. Speaker tags가 없으면 마이크는 **Me**, 시스템 오디오는 **Them**으로 표시한다. (https://docs.granola.ai/help-center/taking-notes/transcription)
- 공개 API의 전사 항목도 같은 구조다. `speaker.source`는 `microphone` 또는 `speaker`, `attribution`은 `me` 또는 `them`이다. 이름을 알아냈을 때만 `name`이 붙고, 휴대폰·워치 녹음에서만 익명 `diarization_label`(Speaker A 등)이 붙는다. (https://docs.granola.ai/api-reference/get-note)
- 스피커로 통화 소리를 내면 마이크가 그 소리를 다시 잡는다. Granola는 이 에코를 마이크 쪽에서 걸러 낸다. Windows의 Teams 데스크톱 앱에서는 이 필터가 통하지 않아 같은 말이 회색·초록에 두 번 나온다고 문서가 밝힌다. (https://docs.granola.ai/help-center/troubleshooting/transcription-issues)
- **[추론]** 두 채널을 따로 스트리밍 전사하고, 시스템 오디오를 기준 신호로 삼아 마이크 채널에 에코 제거(AEC)를 건다. "Teams가 소리를 내는 방식을 감지하지 못한다"는 설명은 기준 신호 기반 AEC의 전형적인 실패 양상이다.
- LinkWork의 mic=L / system=R 채널 분리(`src/main/services/diarization/channel-adapter.ts`)와 원리가 같다.

### 1-3. 다자 회의의 상대방 여러 명 — Speaker tags

Granola는 "Them" 채널을 음성 특징으로 나누지 않는다. 회의 앱이 화면에 보여 주는 정보를 읽는다.

- Speaker tags는 참가자의 표시 이름을 전사 위에 붙인다. Google Meet, Zoom, Microsoft Teams를 macOS·Windows에서 지원한다. (https://docs.granola.ai/help-center/taking-notes/speaker-attribution)
- 원리는 문서에 그대로 적혀 있다. "회의 앱이 보여 주는 참가자 이름과 active-speaker(현재 발화자) 정보를 쓴다. 손쉬운 사용(Accessibility)으로 앱 인터페이스에서 이 정보를 읽고, Meet 확장 프로그램은 Google Meet에서 읽는다." (같은 문서)
- 설정 경로는 두 가지다.
  - **손쉬운 사용 권한(macOS)**: 한 번 허용하면 Meet(Chrome)·Zoom 데스크톱 앱·Teams 데스크톱 앱에 모두 적용된다. Windows는 별도 권한이 필요 없다. Zoom·Teams의 웹 클라이언트는 지원하지 않는다. (https://docs.granola.ai/help-center/taking-notes/speaker-attribution-zoom , https://docs.granola.ai/help-center/taking-notes/speaker-attribution-teams)
  - **Chrome 확장 프로그램**: Google Meet 전용이다. Chrome과 Chromium 계열(Edge, Arc, Brave)에서 동작하고, 데스크톱 앱이 켜져 있어야 연결된다. (https://docs.granola.ai/help-center/taking-notes/speaker-attribution-google-meet)
- 한계도 문서에 있다. (https://docs.granola.ai/help-center/taking-notes/speaker-attribution)
  - 회의실 장비 하나로 여러 명이 말하면 개인을 구분하지 못한다.
  - 여러 명이 동시에 말하면 일부 구간을 올바른 사람에게 붙이지 못한다.
  - 회의 앱이 발화자를 뚜렷이 표시하지 않은 순간은 이름이 비어 있다.
  - 전사 중에만 적용된다. 지난 전사에 소급해 이름을 붙이지 못한다.
  - 표시 이름이 다르면 이름도 틀린다.
- **[추론]** 내부 구조는 "발화자 표시 이벤트 스트림(시각, 이름)"과 "시스템 채널 전사 조각(시각, 텍스트)"의 시간 정렬이다. 소급 적용이 안 된다는 점이 근거다. 오디오를 저장하지 않으므로 음성으로 다시 분석할 재료가 없고, 발화자 표시는 그 순간에만 존재한다.
- **[추론]** 화자 임베딩(성문)이나 회의 간 "같은 목소리 인식"은 쓰지 않는다. 공개 문서 어디에도 음성 등록·성문 언급이 없고, 오디오 미보관 정책과도 맞지 않는다.

### 1-4. 캘린더 참석자와 이름

- 요약 생성의 입력은 네 가지다. 전사, 사용자가 적은 메모, 캘린더 이벤트의 맥락, 프로필 정보(Settings > Profile). (https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes)
- Speaker tags가 없어도 "AI가 전사의 문맥 단서로 화자를 대체로 잘 추론한다"고 문서가 말한다. 이름이 틀리면 노트에서 직접 고치거나 Chat에 고쳐 달라고 한다. (https://docs.granola.ai/help-center/taking-notes/speaker-attribution)
- **[추론]** 캘린더 참석자 명단은 전사 줄에 이름을 붙이는 데 쓰지 않는다. 요약 프롬프트의 맥락으로만 들어간다. LLM이 "Me/Them 전사 + 참석자 명단 + 호칭 단서"로 액션아이템 담당자 같은 이름을 채운다. 2명 통화(나 + 상대 1명)에서는 Them이 곧 그 참석자라서 정확하고, 다자 통화에서는 오귀속이 생긴다. 5인 통화에서 인용을 다른 사람에게 붙였다는 리뷰가 있다. **[제3자]** (https://undercorrect.com/reviews/granola)
- 캘린더 참석자는 People·Companies 디렉터리로도 쌓인다. 프로필 사진·직함·회사 정보를 자동으로 보강하고, 사람·회사별로 지난 노트를 모아 본다. 수동 추가는 안 된다. (https://docs.granola.ai/help-center/people-and-companies)
- 용어 인식 보조는 Personal jargon(개인 30개)과 Workspace jargon(50개)이다. 용어를 전사 모델에 하나씩 넘겨 인식 확률을 올리는 방식이고, 단어 치환은 하지 않는다. 회사 이름과 참석자 이름은 넣지 않아도 된다고 한다. (https://docs.granola.ai/help-center/customising-granola/customising-transcription) **[추론]** 참석자 이름은 캘린더에서 자동으로 키워드 부스팅에 들어간다.

### 1-5. 대면 회의(마이크 하나)

- 데스크톱: 초록 말풍선은 "나, 그리고 같은 방에 있는 모든 사람"이다. 방 안 사람들은 구분되지 않는다. (https://docs.granola.ai/help-center/troubleshooting/transcription-issues) 노트북을 탁자 가운데에 두라고 안내한다. (https://www.granola.ai/blog/how-to-record-a-meeting-and-have-ai-summarize-it-zoom-teams-google-meet-and-in-person)
- 모바일(iOS·Android): 휴대폰 마이크 하나로 녹음하고, 전사는 **Speaker A, Speaker B…** 익명 라벨로 화자를 나눈다. 오디오는 회의 중 임시로 캐시하고 전사가 끝나면 지운다. 전사는 회의가 끝난 뒤에 처리한다. (https://docs.granola.ai/help-center/ios/transcription)
- 화자 구분이 틀릴 때에 대한 Granola의 입장: "화자 식별이 100% 정확하지 않아도 enhanced notes가 대화의 맥락을 대체로 잘 이해한다." (같은 문서) 즉 전사의 화자 라벨 정확도를 올리는 대신 요약 단계의 LLM에 맡긴다.
- 익명 라벨에 이름을 붙이는 화면은 공개 자료에서 찾지 못했다.

### 1-6. LinkWork와 비교

| 항목 | Granola | LinkWork |
|---|---|---|
| 나/상대 | 소스 기반 Me/Them | 같다(mic=L / system=R) |
| 원격 다자 | 회의 앱의 발화자 표시 읽기 → 실명 | sherpa 임베딩 클러스터링 + 인원 지정 + 수동 보정 |
| 대면 다자 | 데스크톱은 구분 없음, 모바일만 익명 분리 | sherpa 분리(과분할 문제 있음) |
| 회의 간 동일인 인식 | 없음(이름은 회의 앱 표시 이름으로 매번 새로 얻음) | 없음 |
| 오디오 보관 | 안 함 → 재분리 불가 | 로컬 보관 → 재분리·재전사 가능 |
| 화자 오류 대응 | LLM 문맥 추론 + Chat으로 이름 수정 | `SpeakerEditor` 수동 보정 |

핵심 관찰: Granola는 "같은 사람인지 음성으로 인식"하는 문제를 풀지 않았다. 문제를 다른 신호(회의 앱 UI)로 바꿔 풀었고, 남는 오차는 LLM과 사용자 수정에 넘겼다.

## 2. 요약 포맷 — Enhanced notes

### 2-1. 생성 흐름

1. 회의 중: 빈 노트 편집기에 사용자가 메모를 적는다. 전사는 뒤에서 진행되고 패널로 숨겨져 있다.
2. 회의 종료 감지 또는 수동 중지 → 자동으로 요약 노트를 만든다. (https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes)
3. 입력: 전사 + 사용자 메모 + 캘린더 이벤트 맥락 + 프로필. 템플릿을 골랐으면 템플릿이 구조를 정한다.
4. 결과: **Enhanced** 탭에 요약 노트, **My notes** 탭에 원본 메모가 따로 남는다. 메모를 고친 뒤 다시 생성하면 고친 내용이 반영된다.

사용자 메모의 역할: "적은 메모는 반드시 넣어야 할 중요한 내용으로 본다." 오타·약어는 알아서 고친다. 메모가 없어도 전사와 회의 기본 정보만으로 만든다. (https://docs.granola.ai/help-center/taking-notes/taking-notes-in-granola)

메모로 구조를 유도하는 방법: `# Agenda`, `# Key Moments` 같은 헤딩, `-` 불릿, 체크박스를 메모에 쓰면 최종 노트 구조가 그것을 따른다. 이미지(JPEG/PNG)도 붙일 수 있다. (같은 문서)

공식 블로그의 메모 예시 (https://www.granola.ai/blog/get-the-best-from-granola):

```
decision: ship the smaller version on Friday
I don't buy the timeline
ask Priya about churn
follow up with the revised numbers
```

헤딩 예시는 `# Decisions`, `# Questions`, `# Next steps`다.

### 2-2. 출력 구조

- **형식**: Markdown이다. 공개 API가 `summary_markdown`(요약)과 `private_notes_markdown`(사용자 메모)을 따로 돌려준다. (https://docs.granola.ai/api-reference/get-note)
- API 문서에 실린 요약 예시(원문 그대로):

  ```markdown
  ## Quarterly Yoghurt Budget Review

  The quarterly yoghurt budget review was a success.

  - Spent **$100,000** on yoghurt
  - Made **$150,000** in profit
  ```

- **섹션**: 헤딩 아래 불릿이 붙는 구조다. 템플릿이 없으면 "Auto"가 회의 내용에 맞춰 섹션을 정한다. (https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes) 영업 소개 통화에서 관찰된 섹션 이름은 About them, Key takeaways, Decision-making insights, Budget & Timeline, Next Steps다. **[제3자]** (https://cdn.jsdelivr.net/npm/@agent-native/core@0.124.6/corpus/templates/clips/desktop/design-refs/granola-ux.md)
- **[추론]** Auto 모드는 "TL;DR → 고정 분류" 방식이 아니라 "주제별 헤딩 → 사실 불릿 → 마지막에 Next steps/Action items" 방식이다. 회의마다 헤딩 이름이 달라진다.
- **사용자 메모와 AI 보강의 시각 구분**: 사용자 메모에서 온 줄은 **검정**, Granola가 보탠 줄은 **회색**이다. 회색 줄을 사용자가 고치면 검정으로 바뀐다(작성자가 사용자로 넘어간다는 뜻). (https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes , https://www.granola.ai/docs/docs/101/afteryourmeeting/editing-your-enhanced-notes)
- **근거 링크**: 줄에 마우스를 올리면 돋보기가 나온다. 누르면 "짧은 요약 + 그 줄의 근거가 된 전사 인용들"이 뜨고, 인용을 누르면 전사의 그 위치로 이동한다. (https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes) 공유받은 사람도 웹에서 줄 위에 마우스를 올려 전사 맥락을 본다. 다만 전체 전사는 웹에서 보이지 않는다. (https://docs.granola.ai/help-center/sharing/sharing-notes)
- **[추론]** 돋보기 내용은 미리 저장한 인용 링크가 아니라, 누르는 순간 "이 불릿 + 전사"로 LLM을 다시 불러 만드는 지연 생성일 가능성이 있다. "짧은 요약"이 함께 나오는 점이 근거다. 어느 쪽인지는 공개 자료로 확정하지 못했다.
- **재생성**: Chat에 "next steps를 더 자세히", "시간순으로 다시 정리"처럼 지시하거나, 다른 템플릿을 고르거나, 같은 템플릿으로 다시 돌린다. 회의마다 따로 처리하므로 한 노트의 수정은 다음 회의에 영향을 주지 않는다. (https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes)
- **내보내기**: "Copy enhanced notes"가 요약과 노트 링크를 Markdown으로 복사한다(전사 제외). 전체 내보내기는 CSV다(제목·요약·전사). (https://docs.granola.ai/help-center/sharing/sharing-notes , https://docs.granola.ai/help-center/sharing/exporting-notes)
- **요약 언어**: English 고정 또는 Auto(회의에서 가장 많이 쓴 언어). (https://docs.granola.ai/help-center/customising-granola/multi-language)

공개 자료에서 실제 사용자의 enhanced note 전문은 얻지 못했다. 아래는 위 사실들로 **재구성한 형태 예시**다(실제 출력 인용이 아니다). 굵은 줄이 사용자 메모에서 온 줄(검정), 나머지가 AI가 보탠 줄(회색)에 해당한다.

```markdown
### About them
- Series B 물류 SaaS, 직원 120명
- 현재 회의록은 수작업으로 Notion에 정리

### Key takeaways
- **가격이 가장 큰 걸림돌**
  - 좌석당 과금보다 사용량 과금을 선호
- 보안 검토에 SOC 2 보고서가 필요

### Next Steps
- **수정 견적 금요일까지 보내기**
- Priya가 보안 담당자를 다음 통화에 초대
```

### 2-3. 템플릿

**동작 방식** (https://docs.granola.ai/help-center/taking-notes/customise-notes-with-templates)

- 회의 중: 메모에서 `/`를 눌러 템플릿을 고른다. 요약 생성 때 그 템플릿을 쓴다.
- 회의 후: Enhanced 탭의 드롭다운에서 다른 템플릿을 고르면 그 형식으로 다시 만든다.
- 기본 제공 템플릿은 "All templates…" 아래 범주별로 있다. 빠른 선택 목록은 내 템플릿, 즐겨찾기, 팀 템플릿, 자주 쓰는 것 순으로 보여 준다.
- 사용자 템플릿은 처음에 "Private to me"이고, 같은 이메일 도메인 사람들에게 공유할 수 있다.
- 2024-10 개편 때 기본 템플릿 29개, 회의 제목·설명·참석자 역할·과거 패턴으로 템플릿을 추천하는 기능을 발표했다. (https://www.granola.ai/updates/upgraded-meeting-note-templates)

**템플릿 하나의 구성 요소** — 문서가 권하는 네 가지다.

| 요소 | 내용 | 문서의 예시 |
|---|---|---|
| 목적과 맥락 | 이 회의에서 얻으려는 것, 배경 | "This is a user interview to understand what the user thinks about Granola, an AI note-taking tool for meetings." |
| 길이와 문체 | 얼마나 자세히, 무엇을 강조할지 | "Include plenty of detail, quotes, numbers, and data wherever mentioned. Focus more on what they said than what I said." |
| 구조(섹션) | 섹션 제목 목록. 섹션마다 세부 지시문을 넣을 수 있다 | 섹션: Key discussion points, Decisions made, Action items. 섹션 안 지시: "Who introduced Granola to the team and how did they share it?" |
| 반복 개선 | 실제 회의에 적용해 보고 섹션을 다듬는다 | — |

**[추론]** 템플릿의 데이터 모델은 `{ 이름, 전체 지시문(목적·문체), 섹션[{ 제목, 섹션 지시문 }], 공개 범위 }`다. 요약 프롬프트에는 "섹션 제목 = 출력 헤딩, 섹션 지시문 = 그 헤딩 아래 무엇을 뽑을지"로 들어간다. Granola 블로그도 "섹션 헤더가 AI의 맥락 단서가 된다. Verbatim quotes 섹션이면 인용을, Action items 섹션이면 약속을 뽑는다"고 설명한다. (https://www.granola.ai/blog/meeting-note-templates-by-type)

**템플릿 목록과 섹션 구성**

기본 템플릿 29개의 전체 목록과 섹션은 앱 안에서만 볼 수 있고 공개 문서에 없다. 아래 표는 출처 등급을 나눠 모은 것이다.

이름이 공식 자료로 확인된 것:

| 템플릿 | 출처 |
|---|---|
| Auto(기본) | https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes |
| Customer Discovery, Sprint Planning, One-on-Ones, Investor Updates, Project Kick-Off, Pipeline Review | https://www.granola.ai/updates/upgraded-meeting-note-templates |
| 범주 예시: sales calls, 1:1s, stand-ups, interviews, sales pitches | https://docs.granola.ai/help-center/taking-notes/customise-notes-with-templates |
| 1 to 1, Stand-Up, Weekly Team Meeting **[제3자]** | https://zapier.com/blog/granola-ai/ |

Granola 공식 블로그가 회의 유형별로 권하는 섹션 구성(기본 템플릿의 정확한 섹션인지는 확인되지 않았다. 공식이 권하는 구조라는 점에서 가장 믿을 만하다) (https://www.granola.ai/blog/meeting-note-templates-by-type):

| 회의 유형 | 섹션 |
|---|---|
| Meeting recap(팀 싱크 범용) | Context / Discussion summary / Key decisions / Action items / Open questions |
| 1-on-1 | Personal check-in / Progress and priorities / Blockers / Feedback exchange / Development and growth / Commitments |
| Sprint·Stand-up | Progress since last meeting / Blockers / Next steps |
| Customer discovery interview | Interview goals / Participant background / Warm-up questions / Problem exploration / Root cause probes / Existing alternatives / Verbatim quotes / Behavioral observations / Hypotheses tested / Next steps |
| Sales discovery(제품팀용) | Pain points / Current tools / Success criteria / Feature gaps |
| Sales meeting | Company context / Key stakeholders / Pain points / BANT / Competitor awareness / Feature requests / Objections / Next steps |
| Post-mortem | Project summary and context / What went well / What didn't go as planned / Root cause analysis / Lessons learned with action items / Preventive measures / Follow-up procedures |
| Usability testing | Task scenarios tested / Observed friction / Verbal think-aloud notes / Severity rating |

같은 블로그 계열의 추가 구성 (https://www.granola.ai/blog/meeting-recipes-repeatable-formats):

| 회의 유형 | 섹션 |
|---|---|
| Meeting summary | Metadata / Key discussion points / Decisions / Action items / Open questions / Next steps |
| Customer interview | Participant context / Problem statement / Key observations / Current workarounds / Product signals / Roadmap connection / Follow-up needed |
| PRD kickoff·review | Problem recap / Goals and non-goals / Key decisions / Open questions with owners / Gaps and blockers / Next steps |
| IC memo(투자 심사) | Investment thesis / Company and market / Team / Financials / Key risks / Deal terms / Due diligence status / Recommendation |

커뮤니티 자료가 적은 기본 템플릿 섹션 **[제3자, 미검증]** (https://raw.githubusercontent.com/jeremylongshore/claude-code-plugins-plus-skills/HEAD/plugins/saas-packs/granola-pack/skills/granola-core-workflow-a/SKILL.md):

| 템플릿 | 섹션 |
|---|---|
| 1-on-1 | Check-in / Updates / Discussion / Action Items |
| Stand-up | Progress / Blockers / Priorities |
| Discovery Call | Budget / Authority / Need / Timeline |
| Sprint Planning | Sprint goals / Velocity / Backlog / Risks |
| Weekly Team | Updates / Decisions / Action Items |
| Interview Debrief | Candidate assessment / Strengths / Concerns |
| Project Kick-Off | Goals / Scope / Timeline / RACI |
| Pipeline Review | Deal status / Next steps / Risks |
| Design Crit | Feedback / Requested changes / Approvals |

다른 리뷰는 기본 템플릿을 Sales call, One-on-one, Internal sync, Customer feedback, Project kickoff로 적었다. 사용자 템플릿은 "원하는 섹션을 평문 단락으로 적는" 식이라고 한다. **[제3자]** (https://undercorrect.com/reviews/granola)

여러 출처에 공통으로 나타나는 패턴:

- 섹션은 3~10개다. 짧은 정기 회의(stand-up)는 3개, 조사·영업은 8~10개다.
- 거의 모든 템플릿이 마지막에 Next steps 또는 Action items를 둔다.
- 범용 요약은 Context → Discussion → Decisions → Action items → Open questions 순이다. LinkWork의 5분류와 겹치지만 **Open questions(미결 질문)**이 따로 있고 TL;DR이 없다.
- 대외 회의(고객·영업)는 상대방 정보 섹션(About them, Company context, Participant background)과 **Verbatim quotes(원문 인용)** 섹션을 둔다.

### 2-4. 템플릿과 레시피의 차이

| | 템플릿 | 레시피 |
|---|---|---|
| 실행 시점 | 요약 노트 생성(enhance) 때 | 그 뒤 Chat에서 |
| 역할 | 노트의 구조를 정한다 | 노트·전사에서 산출물을 뽑는다(메일, PRD, 코칭 등) |
| 범위 | 회의 1건 | 회의 1건 또는 여러 건(폴더·사람·회사) |

(https://www.granola.ai/blog/meeting-recipes-repeatable-formats)

## 3. 기타 핵심 기능

### 3-1. 회의 중 UX

- **시작**: 캘린더 알림을 누르거나, 시작 시각이 지난 회의를 열거나, New Note를 누르면 전사가 시작된다. 미리 열어 둔 회의는 예정 시각에 자동으로 시작한다. 노트를 열지 않은 회의는 뒤에서 전사하지 않는다. (https://docs.granola.ai/help-center/taking-notes/transcription)
- **표시**: 노트 아래 초록색 막대가 움직인다. 다른 앱이 앞에 있으면 화면 오른쪽에 떠 있는 표시가 나온다. (같은 문서)
- **자동 종료**: 전사 길이, 회의 앱이 아직 켜져 있는지(마이크 점유), 캘린더 종료 시각을 함께 보고 통화 종료를 판단한다. 15분간 새 오디오가 없거나 컴퓨터가 잠들어도 멈춘다. 연달아 회의하면 두 회의가 한 전사로 합쳐질 수 있다. (같은 문서)
- **이어 녹음**: 요약이 끝난 뒤에도 Resume으로 같은 노트에 전사를 덧붙이고 다시 생성할 수 있다. (같은 문서)
- **실시간 전사**: 패널에서 실시간으로 보인다. 검색, 전체 복사, 조각 단위 복사·삭제가 된다. (같은 문서)
- **화면 공유 스냅샷**: 상대가 공유한 화면을 자동으로 캡처해 노트에 붙이고 요약 품질에 쓴다(macOS 14 이상). (https://docs.granola.ai/help-center/taking-notes/capture-shared-screens)
- **회의 중 Chat**: "What did I miss?", "What are we still disagreeing about?" 같은 질문을 실시간 전사에 던진다. (https://www.granola.ai/blog/get-the-best-from-granola)

### 3-2. Chat (Ask Granola)

- 범위는 여는 위치가 정한다. 홈 화면은 전체 노트, 회의 화면은 그 회의, 폴더는 폴더 안, 체크박스로 고른 회의들, 사람·회사 뷰. (https://docs.granola.ai/help-center/getting-more-from-your-notes/chatting-with-your-meetings)
- 노트 다시 쓰기: 더 자세히·간단히, 이름 고치기, 액션아이템 담당자 바꾸기, 번역. 노트에서 글을 선택하고 Chat을 열면 그 부분만 고친다. (같은 문서)
- 파일을 올려 회의 밖 맥락을 줄 수 있다. 무료 플랜은 최근 30일 노트만 검색한다. (같은 문서)
- 2026-04에 에이전트형 Chat으로 다시 만들었다. 노트 검색이 빨라지고 답변에 인라인 인용이 붙는다. (https://www.granola.ai/updates)
- Chat에서 바로 실행하는 작업: Gmail 후속 메일, Slack 메시지, Google Calendar 일정 만들기. 초안을 보여 주고 사용자가 확인해야 실행된다. (https://docs.granola.ai/help-center/getting-more-from-your-notes/workflows-in-chat)
- **[추론]** 여러 회의에 걸친 질문은 "요약 노트 검색 → 필요한 회의의 전사 구간 조회"의 2단 구조다. MCP 도구 구성이 그대로 보여 준다: `search_meetings`, `search_transcripts`(타임스탬프가 붙은 구절 반환), `get_meetings`, `get_meeting_transcript`. (https://docs.granola.ai/help-center/sharing/integrations/mcp)

### 3-3. 레시피(저장 프롬프트)

- Chat 입력란에서 `/`로 부른다. 변수·치환이 없는 정적 프롬프트다. "Single meeting"용과 "Multiple meetings"용을 따로 만든다. (https://docs.granola.ai/help-center/getting-more-from-your-notes/recipes)
- 이름이 확인된 레시피: Coach me, Prep me, Write a brief, Improve our sales process (https://www.granola.ai/blog/say-hello-to-recipes), List actions, Write follow-up email, Draft project plan (https://www.granola.ai/blog/meeting-recipes-repeatable-formats), Gather product feedback, Weekly revenue review (https://docs.granola.ai/help-center/sharing/customer-calls).
- 작성 요령: 할 일을 먼저 밝힌다, 규칙을 목록으로 준다, 회사·역할 맥락을 한 번 적어 둔다, 원하는 형식의 예시를 붙인다. (https://docs.granola.ai/help-center/getting-more-from-your-notes/writing-effective-recipes)

### 3-4. 회의 전·후 자동화

- **Briefs(회의 전 브리프)**: 밤사이 다음 날의 외부 회의를 준비한다. 같은 사람·회사와의 지난 노트, 팀 공유 노트, 웹, 캘린더 안건, (연결했다면) Gmail에서 2~3개 불릿을 만든다. 쓸 만한 정보가 없으면 만들지 않는다. (https://docs.granola.ai/help-center/taking-notes/pre-meeting-briefs)
- **후속 메일 초안**: 외부 참석자가 있고 10명 이하인 회의 뒤에 자동으로 초안을 만든다. Slack이 주 채널이거나 다른 사람이 후속을 맡았으면 만들지 않는다. (https://docs.granola.ai/help-center/taking-notes/follow-up-emails)
- **Agent brief**: 회의에서 사용자의 현재 우선순위, 주요 관계, 프로젝트, 용어집, 습관, 소통 방식을 뽑아 매일 밤 갱신한다. 연결한 AI 도구가 MCP로 읽는다. (https://docs.granola.ai/help-center/customising-granola/agent-brief)

### 3-5. 공유·폴더·연동

- **폴더와 스페이스**: 개인 공간(My notes)과 팀 공간이 있다. 노트 하나가 여러 폴더에 들어갈 수 있다. 반복 회의는 한 번 폴더에 넣으면 이후 회차를 자동으로 넣는다. 폴더 설명이 Chat의 맥락으로 쓰인다. (https://docs.granola.ai/help-center/sharing/folders/spaces-and-folders)
- **연동**: Slack(노트별 전송 또는 폴더에 들어오면 자동 게시), Notion(전용 데이터베이스에 저장), CRM(Attio, HubSpot, Pipedrive, Affinity — 사람·회사·거래 레코드에 매칭), Zapier, MCP, 공개 API, 웹훅. (https://docs.granola.ai/help-center/sharing/integrations/integrations-with-granola)
- **Customer calls**: 외부 영업·고객 통화를 자동으로 감지해 팀 공용 뷰에 모은다. 민감한 내용이 감지되면 자동 공유하지 않는다. (https://docs.granola.ai/help-center/sharing/customer-calls)

### 3-6. 언어 지원

- 데스크톱 31개, 모바일 17개 언어를 지원한다. **한국어는 데스크톱·모바일 모두 지원한다.** 앱 화면은 영어뿐이다. (https://docs.granola.ai/help-center/customising-granola/multi-language)
- 전사 언어 설정은 "English(best quality)"와 "Auto"다. Auto는 한 회의 안에서 언어가 섞여도 전사하고, 자주 쓰는 언어를 10개까지 지정해 감지를 돕는다. 지난 회의를 다른 언어로 다시 전사할 수는 없다. (같은 문서)
- 실시간 번역은 없다. 요약 언어를 따로 정하거나 Chat에 번역을 시킨다. (같은 문서)
- 영어·스페인어 밖에서는 요약 품질이 크게 떨어진다는 리뷰가 있다. **[제3자]** (https://undercorrect.com/reviews/granola)

### 3-7. 리뷰에서 반복되는 약점 **[제3자]**

- 기술 회의 요약이 명사 나열로 줄어 추론·의존 관계가 빠진다. 한 달에 두 번쯤 내용을 지어내거나 잘못 귀속한다("Q4 약속 안 함"이 "Q4 출시 약속"으로 요약된 사례). (https://undercorrect.com/reviews/granola)
- 다자 통화에서 화자 구분이 약하다는 지적이 Speaker tags 이전 리뷰에 많다. (https://zapier.com/blog/granola-ai/)

## 4. LinkWork 도입 후보

LinkWork의 전제: 로컬 우선, 오프라인 STT(whisper), 구독 Claude로 요약, 오디오 로컬 보관.

### 4-1. 화자 구분

| # | 기능 | 기술 방안 | 난이도 | 기대 효과 |
|---|---|---|---|---|
| A1 | 회의 앱 발화자 표시 읽기(Speaker tags 방식) | 녹음 중 macOS 손쉬운 사용 API(AXUIElement)로 Zoom·Teams 데스크톱 앱과 Chrome의 Meet 창에서 "현재 발화자 이름"을 주기적으로 읽어 (시각, 이름) 이벤트로 저장한다. 전사 뒤 시스템 채널 세그먼트에 시간 겹침으로 이름을 붙인다. Electron에는 네이티브 헬퍼(Swift 바이너리 또는 N-API 애드온)가 필요하다. 귀속은 `src/main/services/speaker-assign.ts`의 turn 귀속 로직을 그대로 쓸 수 있다 — 발화자 이벤트를 turn으로 넣으면 된다 | 상 | 원격 다자 회의에서 클러스터링 없이 실명 귀속. "같은 사람인지" 문제가 사라진다. 앱 UI가 바뀌면 깨지므로 앱별 어댑터와 실패 시 기존 폴백 체인이 필요하다 |
| A2 | Meet 전용 브라우저 확장 | Chrome 확장이 Meet DOM의 발화자 표시를 읽어 로컬 앱으로 보낸다(로컬 HTTP 또는 네이티브 메시징). `src/main/services/mobile`의 로컬 HTTP 서버 경험을 재사용할 수 있다 | 중 | 손쉬운 사용 권한 없이 Meet를 지원한다. Meet만 해당 |
| A3 | LLM 문맥 기반 화자 이름 추론 | 전사(익명 화자 라벨) + 참석자 명단(`meeting_attendees`) + 호칭 단서를 Claude에 주고 "화자 키 → 이름" 매핑과 근거를 JSON으로 받는다. 결과는 `SpeakerEditor`에 "제안"으로 보여 주고 사용자가 확정한다. `src/main/services/recognition-aids.ts`의 맥락 블록을 재사용한다 | 하 | 수동 이름 지정 수고를 줄인다. 오디오 품질과 무관하게 동작한다. 클러스터 자체가 틀리면 고치지 못한다 |
| A4 | LLM으로 과분할 클러스터 병합 제안 | A3의 연장이다. "spk_3과 spk_7은 같은 사람으로 보인다(같은 주제를 1인칭으로 이어 말함)" 같은 병합 후보를 받아 사용자 확인 뒤 병합한다 | 중 | 임베딩이 놓친 동일인 병합을 문맥으로 보완한다. 사용자 문제 ①에 직접 대응한다 |
| A5 | 요약 단계에서 화자 오류 흡수 | 요약 프롬프트에 "화자 라벨은 틀릴 수 있다. 문맥과 참석자 명단으로 담당자를 판단하라"를 넣는다. `src/main/services/meeting-summary.ts`의 프롬프트만 바꾼다 | 하 | 전사의 화자 오류가 액션아이템 담당자 오류로 번지는 것을 줄인다. Granola가 실제로 기대는 방식이다 |
| A6 | 마이크 채널 에코 제거 | 스피커 사용 시 마이크에 섞인 시스템 소리를 제거한다. 시스템 채널을 기준 신호로 쓰는 AEC(WebRTC AEC3 등)를 녹음 뒤 오프라인으로 건다. 또는 두 채널 전사의 중복 문장을 시간·텍스트 유사도로 지운다(간이 방식) | 중(간이 방식은 하) | 헤드폰 없이 녹음할 때 "나/상대" 오귀속과 중복 전사를 없앤다 |
| A7 | 회의 간 동일인 인식(성문 등록) | Granola에는 없는 기능이다. LinkWork는 오디오와 CAM++ 임베딩을 로컬에 갖고 있으므로, 사용자가 이름을 확정한 화자의 centroid를 구성원(`meeting_members`)에 저장하고 다음 회의의 클러스터 centroid와 코사인 유사도로 맞출 수 있다. `src/main/services/diarization/embedding-merge.ts`의 centroid 계산을 재사용한다 | 상 | 대면 회의처럼 A1이 통하지 않는 경우의 해법이다. 생체 정보라서 동의·삭제 화면이 필요하다 |

권장 순서: A5 → A3 → A6(간이) → A1 → A4 → A7. A1이 효과가 가장 크지만 네이티브 작업이 필요하다. A3·A5는 프롬프트와 화면만 고치면 된다.

### 4-2. 요약 포맷

| # | 기능 | 기술 방안 | 난이도 | 기대 효과 |
|---|---|---|---|---|
| B1 | 섹션 배열 요약 스키마 | 5분류 고정 키 대신 `sections: [{ heading, bullets: [{ text, source, at }] }]` + `action_items`(기존 유지)로 받는다. `src/main/services/summary-spec.ts`에 새 스펙을 더하고 `src/main/services/meeting-notes.ts`의 Markdown 생성과 `src/renderer/src/components/recording/SummaryPanel.tsx` 표시를 섹션 반복으로 바꾼다. 기존 5분류는 "기본 템플릿"으로 표현할 수 있다 | 중 | 템플릿(B2)의 전제다. 회의 유형에 맞는 구조를 낼 수 있다 |
| B2 | 회의 유형 템플릿 | 템플릿 = `{ 이름, 목적·문체 지시문, 섹션[{ 제목, 지시문 }] }`. 로컬 DB에 저장한다. 기본 제공 후보: 범용(Context / Discussion / Key decisions / Action items / Open questions), 1-on-1, 스탠드업, 스프린트 계획, 회고·포스트모템, 고객 인터뷰, 프로젝트 킥오프. 섹션 구성은 §2-3 표를 그대로 쓴다. 면접은 기존 `INTERVIEW_SPEC`을 유지한다 | 중 | 사용자 요구 ②에 직접 대응한다. 재요약 때 템플릿만 바꿔 다시 만들 수 있다(오디오·전사가 로컬에 있어 비용이 없다) |
| B3 | 템플릿 자동 추천 | 회의 제목·참석 인원·캘린더 이벤트로 규칙 기반 추천을 한다(예: 제목에 "1:1", "스탠드업", "회고"). 캘린더 연동은 `src/main/services/google-calendar.ts`에 있다 | 하 | 고르는 수고를 줄인다 |
| B4 | 녹음 중 메모 → 요약의 뼈대 | 녹음 화면에 메모 입력란을 두고 줄마다 입력 시각을 저장한다. 요약 프롬프트에 `[사용자 메모]` 블록으로 넣고 "메모의 각 줄을 반드시 반영하고, 메모의 헤딩을 섹션 구조로 써라"를 지시한다. 메모 시각은 전사의 해당 구간을 가리키는 단서가 된다 | 중 | Granola의 핵심 차별점이다. 요약이 "모델이 중요하다고 본 것"이 아니라 "내가 중요하다고 본 것" 중심이 된다 |
| B5 | 메모/AI 출처 표시 | 불릿마다 `source`(`note` 또는 `ai`)를 받아 색으로 구분한다. 사용자가 AI 줄을 고치면 `note`로 바꾼다 | 하(B1 뒤) | 무엇을 검토해야 하는지 한눈에 보인다. 환각 검토 범위가 줄어든다 |
| B6 | 불릿별 근거 타임스탬프 | 불릿마다 `at`(`mm:ss`)을 받는다. 면접 요약의 타임스탬프 규약(`src/main/services/interview-summary.ts`의 `parseTimestamp`)을 재사용한다. 누르면 전사 위치로 이동하고 오디오를 그 지점부터 재생한다 | 하(B1 뒤) | 근거 확인이 한 번에 된다. Granola는 오디오가 없어 인용만 보여 주지만 LinkWork는 **재생까지** 된다 |
| B7 | Open questions·Verbatim quotes 섹션 | 범용 템플릿에 "미결 질문", 대외 회의 템플릿에 "원문 인용" 섹션을 더한다 | 하(B2 뒤) | 결정되지 않은 것이 결정사항에 섞이는 오류를 줄인다. 리뷰가 지적한 "약속 안 함 → 약속함" 왜곡을 막는 장치다 |
| B8 | 대화로 요약 고치기 | "다음 단계를 더 자세히", "시간순으로" 같은 지시와 현재 요약 + 전사를 Claude에 넘겨 다시 받는다. 선택한 섹션만 고치는 모드를 둔다 | 중 | 재생성을 반복하지 않고 원하는 형태로 맞춘다 |

### 4-3. 기타

| # | 기능 | 기술 방안 | 난이도 | 기대 효과 |
|---|---|---|---|---|
| C1 | 회의 1건 Q&A | 전사 + 요약을 맥락으로 Claude에 질문한다. AI 대화 메뉴의 도구로 "회의 전사 조회"를 더하는 방법도 있다(`src/main/services/ai-tools.ts`) | 중 | "그때 누가 뭐라고 했지"를 전사를 뒤지지 않고 찾는다 |
| C2 | 여러 회의 질문 | 1단계로 요약·제목을 SQLite에서 검색하고(회의록 메뉴의 LIKE 검색이 이미 있다), 2단계로 추린 회의의 전사 구간을 넣는다. 전사 전문 검색은 SQLite FTS5를 쓴다 | 중 | 주간 정리, "이번 주에 내가 약속한 일" 같은 질문이 된다 |
| C3 | 레시피(저장 프롬프트) | 이름 + 프롬프트 + 범위(1건/여러 건)를 로컬에 저장하고 C1·C2 입력란에서 `/`로 부른다 | 하(C1 뒤) | 후속 메일, 주간 보고, 코칭 같은 반복 작업을 한 번에 실행한다 |
| C4 | 회의 전 브리프 | 다음 회의의 참석자·제목으로 지난 회의록을 찾아 "지난번 미결 사항·내 액션아이템"을 2~3줄로 만든다. 오늘 화면의 비서 흐름(`src/main/services/assistant-meeting.ts`)에 얹는다 | 중 | 연속 회의에서 준비 시간을 줄인다 |
| C5 | 자동 종료 판단 | 캘린더 종료 시각 + 무음 지속 시간(VAD가 이미 있다) + 회의 앱의 마이크 점유 해제를 함께 본다 | 중 | 끄는 것을 잊어 녹음이 길어지는 일을 막는다 |
| C6 | 반복 회의 자동 분류 | 캘린더 반복 이벤트 ID가 같으면 같은 묶음(폴더·태그)으로 넣고 템플릿·참석자를 이어받는다 | 하 | 정기 회의의 설정 반복을 없앤다 |
| C7 | 화면 공유 스냅샷 | 녹음 중 일정 간격 또는 화면 변화가 클 때 회의 창을 캡처해 시각과 함께 저장하고, 요약 때 이미지로 Claude에 넘긴다 | 상 | 슬라이드 내용이 요약에 들어간다. 권한·용량·동의 부담이 크다 |
| C8 | 실시간 전사 | whisper를 VAD 조각 단위로 녹음 중에 돌려 미리보기를 보여 준다. 최종 전사는 지금처럼 녹음 뒤 전체를 다시 돌린다 | 상 | 회의 중 "방금 뭐라고 했지" 확인과 회의 중 Q&A의 전제다. CPU 부담이 있다 |
| C9 | 다국어·혼용 | `meetings.language`가 `ko` 고정이다. 언어 선택(자동 포함)과 요약 언어 설정을 더한다 | 하 | 영어 회의·혼용 회의를 지원한다 |

### 4-4. 따라 하지 않을 것

- **오디오 미보관**: Granola의 선택은 클라우드 서비스의 개인정보 부담 때문이다. LinkWork는 로컬 저장이라 보관이 장점이다(재전사, 재분리, 근거 재생, 컷편집).
- **클라우드 스트리밍 STT**: 로컬 우선 원칙과 맞지 않는다.
- **웹 정보로 참석자 프로필 보강**: 개인 업무 앱의 범위를 넘는다.

## 5. 조사 한계

- 기본 템플릿 29개의 전체 이름과 각 섹션의 원문은 앱 안에만 있어 확인하지 못했다. §2-3의 섹션 구성은 공식 블로그의 권장 구조와 제3자 자료다.
- 실제 사용자의 enhanced note 전문은 공개 자료에서 얻지 못했다. §2-2의 예시는 재구성이다.
- Speaker tags의 출시일은 릴리스 노트(https://www.granola.ai/updates)에 없다. 도움말에는 조사일 기준으로 실려 있다. 그 이전에 쓰인 리뷰는 "데스크톱에 화자 이름이 없다"고 적는다.
- 에코 제거, 전사 제공자 배치, 돋보기의 생성 시점은 추론이다.
