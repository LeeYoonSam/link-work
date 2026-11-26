# 회의 녹음 서비스 벤치마크 — 종합과 도입 목록

> 조사일 2026-11-26. 공개 자료 기반 블랙박스 분석(앱 바이너리 분해 없음).
> 서비스별 상세: [otter.md](otter.md) · [granola.md](granola.md) · [clova-note.md](clova-note.md)(다글로·Fireflies 비교 포함).
> 우리 파이프라인 기준선: [../../MEETING_RECORDING.md](../../MEETING_RECORDING.md).

## 1. 대상 선정

| 서비스 | 고른 이유 |
|---|---|
| Otter.ai | 글로벌 1위. 목소리 학습으로 회의 간 동일인을 식별한다 |
| Granola | 봇 없이 마이크+시스템 오디오를 잡는 macOS 데스크톱 앱. LinkWork와 구조가 같다. 요약 템플릿의 기준 |
| CLOVA Note | 한국어 1위. 한국어 대면 회의 화자 분리 |

## 2. 기능별 비교

### 2-1. 화자 분리 · 동일인 식별

| 항목 | Otter | Granola | CLOVA Note | LinkWork 현재 |
|---|---|---|---|---|
| 회의 내 분리 | 녹음 후 2차 패스, 임베딩 클러스터링(추론) | 음향 분리 없음. 마이크=나 / 시스템=상대 | VAD → 다중 스케일 임베딩 → spectral clustering(논문) | STT 세그먼트 위 짧은 창(≤2.25초) CAM++ 임베딩 + 자체 AHC·centroid 병합 |
| 화자 수 | 자동 | 해당 없음 | 녹음 후 참석자 수를 묻는다 | 녹음 시작 시 선택 입력. 비우고 시작하면 종료 때 묻고, 자동으로 나눈 회의는 상세 화면에서 한 번 더 확인 |
| 동일인 식별 | 태그 → 음성 프로필 → 다음 회의 자동 라벨, Rematch로 소급 | 없음(화상회의 앱의 발화자 표시를 읽어 이름을 붙임) | 기업 플랜: 지정 구간 음성 저장 → 자동 인식, 고치면 재학습 | 구성원 목소리 프로필 → 다음 회의 자동 지정·제안, 지난 회의 다시 찾기(Rematch, 표본 미생성) |
| 교정 | 화자 병합·이름 변경이 전 회의에 적용 | 해당 없음 | 수정 범위 3단계(이 구간만 / 이 구간부터 / 전체) | 수정 범위 3단계(이 구간만 / 이 구간부터 / 전체 — 전체는 화자 병합), 화자 병합 |
| 대면 회의 | 분리 품질이 약하다는 리뷰 다수 | 전원이 "나"로 묶임 | 가장 강함 | 1on1 실측 5건 모두 2명. 다인 회의 정확도는 정답 라벨이 없어 미측정 |

**교훈**: 체감 품질은 회의 내 분리 알고리즘보다 "음성 프로필 + 교정 루프 + 소급 매칭"에서 나온다(Otter). 화자 수 추정은 사용자 입력으로 대체하는 것이 가장 싸고 정확하다(CLOVA).

### 2-2. 요약 포맷

| 서비스 | 구조(위→아래) | 특징 |
|---|---|---|
| Otter | Overview → Action Items(담당자, 전사 링크) → Insights(템플릿별) → Outline(시간순 주제 챕터, 클릭 시 이동) | 결정사항 섹션이 기본에 없음 |
| Granola | (템플릿별) 예: Context → Discussion summary → Key decisions → Action items → Open questions | 사용자 메모가 뼈대. AI 보강은 회색. 불릿마다 근거 인용 |
| CLOVA Note | 키워드 칩 → 주요 주제 → 주제별 소제목 요약 → 다음 할 일 | 1차 축이 "주제(안건)" |
| Fireflies | Keywords → Overview → Notes → Time-stamped Notes → 화자별 Action Items | 타임스탬프 노트 |
| LinkWork 현재 | 키워드 → 내 메모 → TL;DR → 결정사항 → 액션아이템 → 미결 질문 → 주제별 요약 | 항목마다 근거 시각, 요약 형식 4종(기본·1:1·스탠드업·리뷰·회고)을 요약할 때 자동 선택, 요약 기반 자동 제목, 녹음 중 메모를 주제에 배정 |

**공통 패턴**: ① 주제(안건)별 묶음 ② 각 항목에 전사 시각(근거) 링크 ③ 미결 질문(Open questions) 분리 ④ 회의 유형별 템플릿.

## 3. 실측 진단 (LinkWork)

- 사용자 녹음은 전부 `source='mic'`(대면). 항상 sherpa 경로를 탄다.
- 배포 앱(Electron 43)의 화자분리 워커가 입력 약 6~10분 이상에서 크래시한다. 스택: `onnxruntime 1.24.4 ArmKleidiAI::MlasConv → operator new → Chromium allocator → SIGTRAP`. 180·360초는 통과, 600초는 종료 코드 133. 일반 Node 22에서는 같은 코드가 정상이다. 크래시하면 `diarizeWithFallback`이 `none`(화자 1명)으로 강등한다.
- 같은 런타임에서 `SpeakerEmbeddingExtractor` 단독은 120초 입력까지 정상이다.
- 모델 능력은 충분하다: 19분 1on1에서 주요 두 화자 centroid 코사인 0.57(명확히 구분). 다만 원시 결과에 조각 화자가 13명 섞인다.

## 4. 도입 목록

우선순위: P0 = 첫 작업에서 구현, P1 = 다음 작업, P2 = 검토. 상태 열은 지금 코드 기준이다.

| # | 기술 | 출처 | 난이도 | 우선 | 기대 효과 | 상태 |
|---|---|---|---|---|---|---|
| 1 | 화자분리 크래시 우회: 네이티브 입력을 짧은 창으로 제한하고 클러스터링을 앱이 직접 수행 | 실측 진단 | 중 | P0 | 대면 회의 화자 1명 강등 해소 | 구현 |
| 2 | 구성원 음성 프로필: 화자에 구성원을 지정하면 centroid 임베딩을 저장·누적 | Otter, CLOVA | 중 | P0 | 회의 간 동일인 식별의 기반 | 구현 |
| 3 | open-set 자동 매칭 + "추정" 표시 + "이 사람 아님" 교정 | Otter | 중 | P0 | 다음 회의부터 이름 자동 지정 | 구현 |
| 4 | 주제별 요약(챕터) + 항목마다 `[mm:ss]` 근거 시각 | CLOVA, Otter, Granola | 중 | P0 | 긴 회의 탐색성, 요약 신뢰도 | 구현 |
| 5 | 미결 질문(Open questions) 섹션 | Granola | 하 | P0 | 결정과 미결의 구분 | 구현 |
| 6 | 키워드 칩 | CLOVA, Fireflies | 하 | P0 | 훑어보기, 검색 | 구현 |
| 7 | 화자 수정 범위 3단계(이 구간만 / 이후 / 전체) | CLOVA | 하 | P1 | 한 클러스터에 두 사람이 섞인 경우를 한 번에 교정 | 구현 |
| 8 | 녹음 종료 시 참석 인원 확인 | CLOVA | 하 | P1 | 화자 수 추정 오류 제거 | 구현 |
| 9 | 발화 점유율 | Otter, CLOVA | 하 | P1 | 1on1·회의 진행 회고 | 구현 |
| 10 | 회의 유형별 템플릿(1on1·스탠드업·리뷰 등, 섹션별 지시문) | Granola, Otter, CLOVA | 중 | P1 | 회의 성격에 맞는 정리 | 구현 — 요약할 때 자동 선택(수동 고정 → 사용자 제목 → 같은 호출에서 모델), 요약 화면에서 바꿔 고정 |
| 11 | 녹음 중 북마크·메모 → 요약의 뼈대로 사용, AI 보강과 시각 구분 | Granola, CLOVA | 중 | P1 | 사용자 의도 반영 | 구현 |
| 12 | 과거 회의 소급 매칭(Rematch) | Otter | 하 | P1 | 등록 이전 회의에도 이름 부여 | 구현 |
| 13 | 회의 간 AI 질의(범위 지정, 출처 표시) | Otter, Granola | 상 | P2 | 회의 기록 재활용 | 구현 |
| 14 | 화상회의 앱 발화자 표시 읽기(손쉬운 사용 API) | Granola | 상 | P2 | 원격 다자 회의 실명 | 보류 — 원격 다자 회의 데이터 없음, 서명 불안정(표 아래 단락) |
| 15 | 화자 라벨 평가 세트 구축 후 모델 교체 검토(다중 스케일·spectral) | CLOVA | 상 | P2 | 정확도 상한 개선 | 평가 경로만 — 라벨 DER 전이라 모델은 바꾸지 않음. 라벨 없는 비교에서 ERes2NetV2는 통과, WeSpeaker는 탈락 |

> **#14 보류와 재검토 조건**
>
> - **보류 사유**: ① 원격 다자 회의 실데이터가 없다(녹음 45건 중 `mic+system`은 1건). ② 구성원·참석자·캘린더 연결이 0건이라 캘린더 참석자를 화자에 매핑하는 축소안도 효과가 없다. 축소안도 보류한다. ③ 배포 서명이 ad-hoc(`package.json` deploy 스크립트의 `codesign --sign -`)이라 재배포마다 손쉬운 사용(TCC) 권한이 무효가 될 수 있다.
> - **재검토 조건(둘 다 충족)**: ① 최근 30일 원격 다자 회의가 5건 이상. ② 재배포 뒤에도 TCC 권한이 유지되는 안정 서명.
> - **판정 쿼리**(결과가 5 이상이면 ①을 충족한다. 착수 때 컬럼 이름을 `src/main/db/schema.ts`와 대조한다. `sys_N`은 2-스테이지 화자분리가 시스템 쪽 화자에 붙이는 키다):
>
>   ```bash
>   sqlite3 -readonly ~/Library/Application\ Support/linkwork/linkwork.db "select count(*) from meetings m where m.source='mic+system' and m.created_at>=date('now','-30 day') and (m.expected_speakers>=3 or (select count(distinct speaker_key) from meeting_speakers s where s.meeting_id=m.id and s.speaker_key glob 'sys_[0-9]*')>=2)"
>   ```
>
> - **착수 골격**: Swift CLI 자식 프로세스가 화상회의 앱 창의 발화자 표시를 JSONL로 낸다. 앱별 일치 문자열은 `adapters.json`에 둔다. 녹음 일시정지 보정용 시각 표시 IPC(예: clockMark)와 손쉬운 사용 API 지연 보정 상수(AX_LAG_MS)를 둔다. 결과는 시스템 쪽 화자(`sys_N`)에만 `suggested`로 겹치고, `display_name`은 자동으로 확정하지 않는다. 헬퍼가 죽으면 최대 3회 다시 띄운다. 채팅·자막 노드는 순회하지 않는다.

**구현 상태**: #1~#6은 구현했다. 녹음 종류는 회의 하나다(면접 종류는 없앴다, decisions.md F2). #7~#13은 구현했다([decisions.md](decisions.md), 계약은 [../../MEETING_RECORDING.md](../../MEETING_RECORDING.md)·[../../AI_CHAT_ARCHITECTURE.md](../../AI_CHAT_ARCHITECTURE.md)·[../../AI_GUARDRAILS.md](../../AI_GUARDRAILS.md)). #14는 보류다(바로 위 단락). #15는 평가 경로만 만들었다(앱 기본 모델·임계값은 그대로, 절차는 [../../../scripts/eval/README.md](../../../scripts/eval/README.md)). 라벨 없는 1차 비교(회의 7건)에서 ERes2NetV2는 기준을 통과했고(margin은 CAM++보다 좁고 회의 51 처리 162초), WeSpeaker ResNet34_LM은 1on1 5건을 모두 1명으로 나눠 탈락했다. 처음에 난 크래시는 sherpa-onnx-node의 창별 네이티브 메모리 누적 때문이었고, 평가 cli를 `--chunk`로 나눠 돌려 없앴다. 앱 화자분리 워커도 같은 이유로 창 300개마다 새 워커를 띄워 최대 메모리를 묶는다(decisions.md F1). 교체 판정 기준은 decisions.md #15에 있다.

**하지 않을 것**: 오디오를 외부 서버로 보내는 STT·화자 분리(로컬 우선 정책), 동의 없는 음성 프로필 수집(Otter BIPA 소송 사례 — 프로필은 사용자가 이름을 지정할 때만 만들고 로컬에만 둔다).
