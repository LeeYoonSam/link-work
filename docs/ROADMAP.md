# 기능 로드맵

아직 만들지 않은 기능 후보와 그 순서다. 위에서부터 차례로 진행한다.

- 기능을 다 만들면 이 문서에서 그 항목을 지우고, 동작은 해당 구역 문서(`docs/docs-map.json`)에 쓴다. 이 문서에 완료 이력을 쌓지 않는다.
- 진행 중인 항목은 상태 칸에 `진행 중`이라고 쓴다.
- 점수·순서를 바꾸면 표와 근거를 함께 고친다.

## 1. 점수 기준 (100점)

| 항목 | 배점 | 보는 것 |
|---|---|---|
| 근거 | 25 | 기능이 줄이려는 문제가 연구·측정 데이터로 확인되는가 |
| 빈도·효과 | 25 | Jira·Slack·Bitbucket·캘린더·회의 중심의 실제 업무에서 얼마나 자주 쓰고 얼마나 아끼는가 |
| 자동화 | 25 | 손으로 하던 일을 얼마나 없애는가 |
| 구현 용이성 | 25 | 지금 있는 연동·DB·컴포넌트를 재활용하는가 |
| 감점 | − | 일부러 걷어낸 방향과 충돌하는가 |

감점 근거: 오늘 화면은 계획 조작 UI(하루 시작·퇴근·집중 등)를 두지 않는다(`src/renderer/src/components/today/TodayView.test.tsx`가 단언한다). 사용자가 직접 계획을 세우게 하는 기능보다 자동으로 모아 주는 기능을 앞에 둔다.

## 2. 순서

| 순서 | 기능 | 점수 | 근거/빈도/자동화/구현 | 상태 |
|---|---|---|---|---|
| 1 | 나에게 온 요청 모아보기 | 85 | 23/24/22/16 | 진행 중 |
| 2 | 전역 단축키 빠른 캡처 | 83 | 20/23/16/24 | 대기 |
| 3 | PR 리뷰 대기 알림 | 79 | 21/19/20/19 | 대기 |
| 4 | 주간 업무 보고 자동 초안 | 81 | 18/18/23/22 | 대기 |
| 5 | 통합 검색 + 명령 팔레트 | 78 | 22/21/14/21 | 대기 |
| 6 | 회의 후속 조치 보내기·남의 액션 추적 | 74 | 19/19/20/16 | 대기 |
| 7 | 배포 준비 경고 | 70 | 12/15/21/22 | 대기 |
| 8 | 회의 녹음 시작 제안 | 69 | 14/20/20/15 | 대기 |
| 9 | 반복 할 일 | 69 | 10/17/20/22 | 대기 |
| 10 | 사람별 "다음에 물어볼 것" | 62 | 15/14/15/18 | 대기 |
| 11 | 회의 부하 리포트 | 62 | 16/8/18/20 | 대기 |
| 보류 | 집중 시간 보호 | 57 (−5) | 18/14/17/13 | 보류 |
| 보류 | 빈 시간 할 일 배치(타임블로킹) | 55 (−10) | 20/15/16/14 | 보류 |
| 보류 | 퇴근 정리 루틴 | 54 (−15) | 21/18/10/20 | 보류 |

3번(PR 알림)은 점수가 4번보다 낮지만 1·2번과 같은 "흩어진 입력을 한곳에 모으기" 묶음이라 먼저 한다. 1·2·3번은 할 일 모델과 출처 링크(`source_link`)를 함께 쓴다.

## 3. 항목

### 3.1 나에게 온 요청 모아보기

- **내용**: Slack 멘션, Jira 할당·멘션 댓글, Bitbucket 리뷰 요청을 한 목록에 모은다. 한 번 눌러 할 일로 바꾸고 출처 링크를 저장한다. 이미 할 일로 바꾼 요청과 처리한 요청은 다시 보이지 않는다.
- **현재**: Jira 할당·멘션 댓글과 Bitbucket 리뷰 요청은 오늘 화면 '나에게 온 요청' 카드로 있다(`docs/ASSISTANT.md` §11.6). 남은 것은 Slack 멘션이다.
- **재활용**: 요청 목록·처리 상태(`src/main/services/request-inbox.ts`, `request_inbox` 테이블)에 원본 하나를 더한다.
- **주의**: Slack 은 앱에 직접 연동이 없다. AI 대화가 claude.ai Slack 커넥터로 읽기만 하고, 검색 도구는 가드레일이 막는다(`docs/AI_GUARDRAILS.md` §8.9). Slack 멘션을 모으려면 Slack 사용자 토큰 연동을 새로 붙여야 한다.
- **근거**: 업무 중 약 2분마다(하루 275회) 회의·메일·메신저로 끊긴다(Microsoft Work Trend Index 2025, M365 텔레메트리). 하루 약 1,200회 앱을 오가며 업무시간의 약 9%를 재집중에 쓴다(HBR 2022, 137명).

### 3.2 전역 단축키 빠른 캡처

- **내용**: 어느 앱에서든 단축키로 할 일·메모 입력창을 띄운다. 선택한 텍스트와 앞쪽 브라우저 URL을 출처로 붙인다.
- **재활용**: `src/renderer/src/components/todo/QuickAddInput.tsx`, `src/renderer/src/components/todo/todoParse.ts`, 트레이 패널 창(`src/main/services/tray-widget.ts`). 지금 코드에 전역 단축키는 없다.
- **근거**: 끝나지 않은 일은 머릿속에서 계속 끼어들지만, 계획을 적어 두면 그 인지 부담이 사라진다(Masicampo & Baumeister, 2011, JPSP).

### 3.3 PR 리뷰 대기 알림

- **내용**: 내가 리뷰할 PR, 승인됐지만 머지 안 된 내 PR이 정한 시간을 넘기면 알린다. 오늘 화면에 리뷰 행으로 보인다.
- **재활용**: 나에게 온 요청의 리뷰 요청 조회(`src/main/services/bitbucket.ts` 의 `listReviewRequests`), 알림(`src/main/services/notification.ts`), 업무 공유 카드의 리뷰 행(`src/renderer/src/components/today/shareModel.ts`). 내 PR 의 승인→머지 대기는 아직 읽지 않는다.
- **근거**: Microsoft의 주기적 넛지 봇이 PR 8,500건의 해결 시간을 60% 줄였다. 승인→머지 대기만 줄여도 리뷰가 29~63% 빨라진다(arXiv 2203.05048, 리뷰 약 57만 건).

### 3.4 주간 업무 보고 자동 초안

- **내용**: 업무 공유 카드를 주 단위로 넓힌다. 완료한 할 일, Jira 상태 전이, 회의 결정, 배포를 모아 주간 보고 초안을 만든다.
- **재활용**: `src/renderer/src/components/today/shareModel.ts`, `src/renderer/src/components/today/WorkShareCard.tsx`, 회의 요약, 릴리스 동기화.
- **근거**: 업무시간의 약 60%가 상태 확인·공유 같은 일에 관한 일이다(Asana Anatomy of Work, 업체 조사). 작은 진척이 업무 동기의 가장 큰 요인이다(Amabile & Kramer, 일지 11,637건).

### 3.5 통합 검색 + 명령 팔레트

- **내용**: ⌘K 로 할 일·메모·회의 전사·로컬 Jira·릴리스를 한 번에 찾고, 같은 입력창에서 화면 이동·기능 실행을 한다. SQLite FTS5 색인을 쓴다.
- **재활용**: 앱 내 링크(`src/renderer/src/utils/openInternalLink.ts`), 메뉴 정의(`src/renderer/src/components/layout/navConfig.ts`).
- **근거**: 업무시간의 25%를 답을 찾는 데 쓴다(Atlassian State of Teams 2025, 12,000명, 업체 조사).

### 3.6 회의 후속 조치 보내기·남의 액션 추적

- **내용**: 회의 요약을 Slack·Notion·Jira 댓글 초안으로 만들고 승인하면 보낸다. 다른 사람 담당 액션아이템은 기다리는 중으로 추적하고 다음 회의 브리핑에 상태를 붙인다.
- **주의**: 외부 쓰기다. `docs/AI_GUARDRAILS.md`의 승인 흐름을 넓혀야 한다.
- **근거**: 액션아이템이 제대로 추적된다는 응답이 절반이 안 된다(iBabs 2024, 2,000명+). 40%가 회의 후속 메모를 받지 못한다(Calendly 2024).

### 3.7 배포 준비 경고

- **내용**: 다음 배포 버전에 묶인 티켓 중 미완료·리뷰 중인 것을 배포 전날 알린다.
- **재활용**: 릴리스 동기화(`src/main/services/release-note-sync.ts`), 오늘 화면 배포 카드(`src/renderer/src/components/today/releaseModel.ts`).
- **근거**: 업무 특화 기능이라 외부 연구 근거는 약하다. 이미 있는 데이터로 만들 수 있어 구현 점수가 높다.

### 3.8 회의 녹음 시작 제안

- **내용**: 캘린더 회의 시작 시각에(가능하면 화상회의 앱 실행 감지와 함께) 알림을 보내고, 한 번 눌러 녹음하며 그 일정에 연결한다.
- **주의**: macOS 마이크 사용 감지는 제약이 있다. 시각 기반 제안부터 한다.

### 3.9 반복 할 일

- **내용**: 주간 보고·월말 정산 같은 정기 업무를 규칙대로 만든다. 지금 할 일에는 반복 개념이 없다.

### 3.10 사람별 "다음에 물어볼 것"

- **내용**: 사람마다 적어 둔 메모를 그 사람이 참석하는 회의 전 브리핑에 붙인다.
- **근거**: 상황 단서와 묶은 실행 의도는 목표 달성을 높인다(Gollwitzer & Sheeran 2006 메타분석, d = 0.65).

### 3.11 회의 부하 리포트

- **내용**: 주간 회의 시간과 회의 없는 연속 시간 비율을 보인다.
- **근거**: 회의의 50%가 9~11시·13~15시에 몰린다(Microsoft Work Trend Index 2025).

### 3.12 보류 항목

근거는 있지만 오늘 화면에서 걷어낸 계획 조작 UI와 겹쳐 보류한다. 다시 꺼낸다면 화면 의식(ritual) 없이 자동 요약만 하는 형태로 한다.

- **집중 시간 보호**: 캘린더 집중 블록 자동 생성·알림 묶음. 보호된 집중 시간이 웰빙을 높였다(Microsoft Research, "Focused Time Saves Nine", 6주 실험).
- **빈 시간 할 일 배치**: 회의 사이 빈 시간에 할 일을 배치. 실행 의도 효과(d = 0.65)가 근거지만, 자동 배치가 며칠 뒤 어지러워진다는 사용 후기가 있다.
- **퇴근 정리 루틴**: 미완료 이월·내일 첫 작업 지정. 계획 작성이 미완료 목표의 인지 부담을 없앤다(Masicampo & Baumeister, 2011).

## 4. 근거 신뢰도

- 학술 연구: HBR 앱 전환 연구, Masicampo & Baumeister, Gollwitzer & Sheeran, Amabile & Kramer, arXiv 코드 리뷰 연구, Microsoft Research 집중 시간 실험.
- 업체 텔레메트리·설문(방향 참고용): Microsoft Work Trend Index, Atlassian, Asana, iBabs, Calendly.
- 흔히 인용되는 "중단 뒤 회복 23분"은 원 논문을 확인하지 못해 점수 근거에서 뺐다.

## 5. 출처

- [Microsoft WTI – Breaking down the infinite workday](https://microsoft.com/en-us/worklab/work-trend-index/breaking-down-infinite-workday)
- [HBR – How Much Time and Energy Do We Waste Toggling Between Applications?](https://store.hbr.org/product/how-much-time-and-energy-do-we-waste-toggling-between-applications/H0777V)
- [Atlassian State of Teams 2025](https://www.atlassian.com/blog/state-of-teams-2025)
- [Asana – Why work about work is bad](https://asana.com/resources/why-work-about-work-is-bad)
- [Masicampo & Baumeister 2011](https://pubmed.ncbi.nlm.nih.gov/21688924/)
- [Implementation Intentions (NCI 요약)](https://cancercontrol.cancer.gov/brp/research/constructs/implementation-intentions)
- [Amabile – How small wins unleash creativity](https://www.library.hbs.edu/working-knowledge/how-small-wins-unleash-creativity)
- [Mining Code Review Data to Understand Waiting Times (arXiv 2203.05048)](https://arxiv.org/abs/2203.05048)
- [Code velocity·넛지 봇 인용 논문 (arXiv 2311.02489)](https://arxiv.org/pdf/2311.02489v1)
- [Microsoft Research – Focused Time Saves Nine](https://microsoft.com/en-us/research/uploads/prod/2023/07/Focus_Time__CHIWork_.pdf)
- [iBabs 2024 Global Meeting Survey](https://www.ibabs.com/en/board-management/global-meeting-survey/)
- [Calendly 2024 State of Meetings](https://calendly.com/resources/guides/2024-state-of-meetings-report.html)
