# 개인 비서와 오늘 화면

이 문서는 지금 코드가 하는 일만 설명한다. 지난 설계와 이력은 git 기록에 있다.

## 1. 범위

비서는 메인 프로세스의 작은 모듈 묶음이다. 지금 하는 일은 5가지다.

| 기능 | 요약 | 절 |
|------|------|----|
| 회의 전 브리핑 | 회의 시작 전에 지난 회의·미완료 액션아이템을 모아 알림을 보내고, 오늘 화면에 본문을 보인다 | §7 |
| 아침 자동 동기화 | 하루 1회 설정 시각 뒤에 Jira 릴리스를 동기화한다 | §8 |
| 비서 설정 | 날짜 경계·AI 브리핑·첫 화면·로그인 시 실행 등 10개 | §4 |
| 알림 클릭 이동 | 회의 브리핑 알림과 트레이 '오늘 보기'가 메인 창의 오늘 화면을 연다 | §6.3 |
| 오늘 화면 페이로드 | 오늘 대시보드가 읽는 비서 이벤트·설정·연결 상태 | §11, §12 |
| 나에게 온 요청 | Jira 할당·멘션 댓글과 Bitbucket 리뷰 요청을 모아 오늘 화면에 보이고, 할 일로 바꾸거나 처리함으로 지운다 | §11.6 |

비서와 함께 두는 모듈이 2개 더 있다. 일정·할 일 알림(§9)과 트레이 위젯(§10)이다. 둘은 비서 스케줄러와 별개로 돈다.

오늘 화면(§11)은 렌더러가 규칙으로 조립하는 읽기용 대시보드다. 계획을 만들거나 조작하지 않는다.

## 2. 파일

| 파일 | 역할 |
|------|------|
| `src/main/services/assistant-types.ts` | 메인의 비서 공유 타입 |
| `src/main/services/assistant-day.ts` | 논리 날짜·로컬 시각 변환. 순수 모듈 |
| `src/main/services/assistant-settings.ts` | 설정 키·기본값·검증. 순수 모듈 |
| `src/main/services/assistant-schema.ts` | 비서 테이블 DDL과 컬럼 보강 |
| `src/main/services/assistant-store.ts` | 설정·비서 이벤트 읽기·쓰기 |
| `src/main/services/assistant-schedule.ts` | 회의 브리핑·아침 동기화 판정. 순수 모듈 |
| `src/main/services/assistant-sources.ts` | 회의 브리핑 맥락 수집. DB 읽기만 한다 |
| `src/main/services/assistant-meeting.ts` | 제목 매칭·규칙 본문·알림 문구. 순수 모듈 |
| `src/main/services/assistant-briefing.ts` | 회의 브리핑 LLM 프롬프트·스키마·호출 |
| `src/main/services/assistant-service.ts` | 흐름 조정. IPC 와 스케줄러가 부르는 진입점 |
| `src/main/services/assistant-scheduler.ts` | 60초 틱·잠자기 복귀·알림 발송·창 이동 |
| `src/main/services/morning-sync.ts` | 아침 자동 동기화 실행기와 상태 읽기 |
| `src/main/services/writing-style.ts` | AI 글쓰기 규칙과 비서 말투 규칙 |
| `src/main/services/notification.ts` | 일정·할 일 알림 |
| `src/main/services/tray-widget.ts` | 메뉴 막대 트레이 아이콘과 패널 창 |
| `src/main/ipc/assistant.ipc.ts` | `assistant:*` IPC |
| `src/main/ipc/morning-sync.ipc.ts` | `morningSync:status` IPC |
| `src/main/services/request-inbox.ts` | 나에게 온 요청 동기화·할 일로 바꾸기·처리함 |
| `src/main/services/request-inbox-store.ts` | `request_inbox` 읽기·쓰기(병합·정리). electron 을 쓰지 않는다 |
| `src/main/ipc/request-inbox.ipc.ts` | `inbox:*` IPC |
| `src/renderer/src/stores/inboxStore.ts` | 나에게 온 요청 스냅샷·할 일로·처리함 |
| `src/renderer/src/components/today/RequestInboxCard.tsx` | '나에게 온 요청' 카드 |
| `src/renderer/src/stores/assistantStore.ts` | 오늘 페이로드·알림 focus·브리핑 다시 만들기 |
| `src/renderer/src/stores/todayStore.ts` | 오늘 대시보드 데이터 불러오기와 캘린더 범위 |
| `src/renderer/src/stores/morningSyncStore.ts` | 아침 동기화 상태와 '새 릴리스' 배지 |
| `src/renderer/src/components/today/` | 오늘 대시보드 화면과 순수 모델 |
| `src/renderer/src/components/today/yesterdayModel.ts` | 직전 근무일 구간(`previousWorkRange`)과 로컬 시각 파싱. 순수 모듈 |
| `src/renderer/src/components/today/shareModel.ts` | '업무 공유' 카드의 어제·오늘 행 조립과 공유용 글. 순수 모듈 |
| `src/renderer/src/components/today/WorkShareCard.tsx` | '업무 공유' 카드(어제 / 오늘 2열) |
| `src/renderer/src/components/dashboard/HomeOverview.tsx` | 오늘 화면 아래의 중요 메모 구역 |
| `src/renderer/src/components/tray/TrayPanel.tsx` | 트레이 패널 화면 |

연결 지점: `src/main/index.ts` 가 IPC 를 등록하고 `startNotificationService()`, `startAssistantScheduler(...)`, `createTrayWidget(...)` 를 부른다. 종료(`before-quit`)에서 셋을 멈춘다. `src/main/db/schema.ts` 가 `ASSISTANT_SCHEMA` 와 `migrateAssistantSchema` 를 실행한다.

## 3. 논리 날짜

- `logicalDate(now, rollover)`: 현재 시각이 날짜 경계(`dayRollover`, 기본 `04:00`)보다 이르면 전날이다. 경계 형식이 틀리면 `04:00` 을 쓴다.
- 비서 이벤트의 `plan_date`, 회의 브리핑의 '오늘', 아침 동기화의 날짜는 모두 논리 날짜다.
- 시각은 로컬 `'YYYY-MM-DD HH:mm:ss'` 문자열로 저장한다(`toLocalDateTime`). 저장소는 다른 형식을 받으면 throw 한다.
- `isoToLocalDateTime` 은 시간대가 붙은 ISO 를 로컬 시각으로 바꾼다. Jira 식 `+0900` 오프셋도 읽는다.
- 오늘 대시보드(§11)는 논리 날짜가 아니라 로컬 달력 날짜(`boardModel.localDate`)를 쓴다.

## 4. 설정

설정은 `app_settings` 의 `assistant_*` 행이다. `assistant-settings.ts` 가 키·기본값·검증의 유일한 정의처다.

| 필드 | 저장 키 | 기본값 | 허용 값 | 쓰는 곳 |
|------|---------|--------|---------|---------|
| `enabled` | `assistant_enabled` | `true` | bool | 회의 브리핑 판정 |
| `dayRollover` | `assistant_day_rollover` | `04:00` | `HH:mm` | 논리 날짜 |
| `llmEnabled` | `assistant_llm_enabled` | `true` | bool | 회의 브리핑 AI 본문 |
| `llmModel` | `assistant_llm_model` | `sonnet` | `opus`·`sonnet`·`haiku` | 회의 브리핑 AI 본문 |
| `openAtLogin` | `assistant_open_at_login` | `false` | bool | 로그인 항목 |
| `meetingLeadMin` | `assistant_meeting_lead_min` | `15` | 정수 1~120 | 회의 브리핑 시각 |
| `startView` | `assistant_start_view` | `today` | `today`·`projects`·`calendar` | 앱 첫 화면 |
| `meetingBriefingEnabled` | `assistant_meeting_briefing_enabled` | `true` | bool | 회의 브리핑 판정 |
| `morningSyncEnabled` | `assistant_morning_sync_enabled` | `true` | bool | 아침 동기화 판정 |
| `morningSyncTime` | `assistant_morning_sync_time` | `08:00` | `HH:mm` | 아침 동기화 판정 |

- 읽기(`parseAssistantSettings`): 없는 키와 형식이 틀린 값은 기본값이다. 표에 없는 옛 키(제거된 기능의 설정 행)는 무시한다. 옛 `startView` 값 `auto`·`dashboard` 는 허용 값이 아니므로 `today` 로 읽는다. DB 행은 다시 쓰지 않는다.
- 쓰기(`serializeAssistantSettingsPatch`): 모르는 키나 잘못된 값이 하나라도 있으면 throw 하고 아무것도 쓰지 않는다. 쓰기는 트랜잭션 1개다.
- `openAtLogin` 이 바뀌면 `saveSettings` 가 `app.setLoginItemSettings` 를 부른다. 스케줄러는 시작할 때 값이 켜져 있고 패키지 실행이면 다시 맞춘다. 개발 실행은 로그인 항목에 넣지 않는다.
- `startView` 는 렌더러 `App.tsx` 가 `resolveStartView` 로 읽는다. 판정 중에 사용자가 화면을 옮기면 결과를 버린다.
- 화면: 설정 화면의 비서 섹션(`components/settings/sections/AssistantSection.tsx`)이 10개 필드를 모두 보인다. 폼 헬퍼는 `components/settings/assistantSettingsForm.ts` 다.

## 5. 저장

`assistant-schema.ts` 의 `ASSISTANT_SCHEMA` 가 테이블 4개를 만든다.

| 테이블 | 지금 쓰임 |
|--------|-----------|
| `assistant_events` | 회의 브리핑과 아침 동기화가 읽고 쓴다 |
| `daily_plans` | 제거된 하루 계획 기능의 과거 기록. 비서 코드는 읽거나 쓰지 않는다 |
| `plan_items` | 위와 같다 |
| `assistant_exclusions` | 제거된 '계속 제외' 기능의 과거 기록. 비서 코드는 읽거나 쓰지 않는다 |

- 나에게 온 요청은 `request_inbox` 테이블에 둔다(DDL 은 `schema.ts` 의 `REQUEST_INBOX_SCHEMA`, §11.6). 처리 상태를 들고 있어 백업 그룹 `work` 에 든다.
- 과거 기록 3개 테이블은 백업 그룹 `work` 에 들어 있다(`backup-groups.ts`). 백업 복원(`backup-restore-db.ts`)은 `plan_items.candidate_id` 를 맞춘다.
- `migrateAssistantSchema(db)` 는 옛 DB 에 없는 `daily_plans`·`plan_items` 컬럼을 더한다. 여러 번 실행해도 결과가 같다.

### 5.1 `assistant_events`

| 컬럼 | 뜻 |
|------|----|
| `id` | 정수 기본 키(AUTOINCREMENT) |
| `event_key` | UNIQUE. 같은 일을 두 번 하지 않게 하는 키 |
| `kind` | 이벤트 종류 |
| `plan_date` | 논리 날짜 |
| `scheduled_at`·`fired_at` | 예정 시각·실행 시각 |
| `status` | `sent`·`late`·`skipped`·`failed`·`logged` |
| `ref_id` | 회의 브리핑이면 캘린더 일정 id |
| `payload` | JSON 본문 |
| `response`·`responded_at` | 응답 본문·응답 시각. 지금 코드는 쓰지 않는다. 새 행은 null 이다 |
| `created_at` | 행을 만든 로컬 시각. 기본값 `datetime('now','localtime')` |

인덱스 `idx_assistant_events_date` 가 `(plan_date, kind)` 를 덮는다.

| kind | event_key | status | payload |
|------|-----------|--------|---------|
| `meeting_briefing` | `meeting_briefing:<논리 날짜>:<캘린더 일정 id>` | `sent`·`late`·`skipped`·`failed` | `MeetingBriefingPayload`, `skipped` 이면 `{ reason }` |
| `morning_sync` | `morning_sync:<논리 날짜>` | `logged` | `MorningSyncPayload` |

- `AssistantEventKind` 의 나머지 값(`start_nudge`·`plan_update`·`checkin`·`command`·`today_briefing`)은 제거된 기능이 남긴 과거 행을 읽으려고 둔다. 새 행을 만들지 않는다.
- `insertEvent` 는 `ON CONFLICT(event_key) DO NOTHING` 이다. 충돌하면 `null` 을 돌려준다. 호출자는 `null` 이면 알림을 보내지 않는다.
- `updateEventPayload` 는 payload 만 바꾼다. 상태·시각 컬럼은 그대로 둔다.

## 6. 스케줄러

`assistant-scheduler.ts` 는 비서의 부수 효과(타이머·알림·창 이동)를 맡는다.

### 6.1 틱

- `startAssistantScheduler(deps)` 가 60초(`TICK_MS`) 간격 타이머를 건다. `powerMonitor` 의 `resume`·`unlock-screen` 에서도 틱을 1번 돈다(`wake = true`).
- 틱 1회(`runTick`)의 순서:
  1. 회의 브리핑 판정·저장(`runDueMeetingBriefings`)과 알림 발송(§7.6). `dueInFlight` 로 동시에 1개만 돈다.
  2. 주입한 `onTick(wake, now)` 을 기다리지 않고 부른다. 앞 단계가 실패해도 부른다. `index.ts` 는 여기에 `runMorningSyncIfDue`(§8)를 넣는다. 스케줄러는 아침 동기화 모듈을 import 하지 않는다.
- 모든 처리기는 try/catch 로 감싼다. 백업 복원 중 DB 가 닫혀 있어도 메인 프로세스가 죽지 않는다.

### 6.2 변경 알림

`assistant-service.ts` 가 회의 브리핑 행을 만들거나 AI 본문이 끝나면 `AssistantChangedEvent { date, reason: 'meeting' }` 를 낸다. 스케줄러가 이를 메인 창에 `assistant:changed` 로 보낸다. 렌더러 `stores/dataSync.ts` 는 이 이벤트를 받으면 `assistantStore.load()` 를 부른다.

### 6.3 알림 클릭 이동

- `navigateToToday(focus?)` 는 메인 창을 복원·표시·포커스하고 `assistant:navigate` 를 보낸다. 페이로드는 `{ view: 'today', focus? }` 다.
- 창이 없거나 아직 로딩 중이면 신호를 보관한다. 창이 없으면 새 창을 만든다. 렌더러는 마운트 직후 `assistant:takePendingNavigate` 로 보관 신호를 1번 가져간다. 보관 신호는 60초가 지나면 버린다.
- 부르는 곳은 2개다. 회의 브리핑 알림 클릭(`focus: { kind: 'meeting', id: <이벤트 id> }`)과 트레이의 '오늘 보기'(focus 없음)다.
- 렌더러 `App.tsx` 는 이동 신호를 받으면 오늘 화면으로 바꾸고 `assistantStore.setFocus` 를 부른다. 오늘 화면은 `meeting` focus 만 쓴다(§11.5).

## 7. 회의 전 브리핑

회의 시작 `meetingLeadMin` 분 전에 알림을 보내고, 오늘 화면의 일정 카드에 본문을 펼친다.

### 7.1 대상 회의

- `getTodayEvents()`(Google 캘린더 5분 캐시)를 읽는다. 조회 실패는 이전 캐시로, 예외는 '일정 없음'으로 본다.
- 기본 캘린더 일정만 본다(`isOwnCalendarEvent`). 추가로 고른 캘린더(Tech 등)의 회의는 사용자가 참석하지 않는 회의일 수 있어 뺀다.
- `toMeetingRef` 가 종일 일정과 시각 변환에 실패한 일정을 뺀다.
- 시작 시각의 논리 날짜가 오늘인 회의만 판정한다. 날짜 경계 앞뒤의 틱이 같은 회의를 다른 날짜 키로 두 번 보내지 않게 한다.
- 캘린더 조회는 쓰기 줄 밖에서 한다. 판정 시각은 줄 안에서 잡는다.

### 7.2 판정

`computeDueMeetingBriefings(input)` 은 순수 함수다. 입력을 바꾸지 않는다.

1. `enabled` 와 `meetingBriefingEnabled` 가 모두 켜져 있지 않으면 빈 배열이다.
2. 회의를 시작 시각 오름차순으로 정렬한다.
3. 같은 키(`meetingEventKey`)의 행이 이미 있거나 입력에 같은 id 가 두 번 있으면 건너뛴다.
4. 지금 ≥ 시작 시각이면 `skip`(`reason: 'window'`)이다.
5. 지금 < 예정 시각(시작 − `meetingLeadMin`)이면 결과에 넣지 않는다.
6. 오늘 보낸 수(`sent`·`late` 행)와 이번 틱의 발송 수의 합이 `MEETING_BRIEFING_DAILY_CAP`(6) 이상이면 `skip`(`reason: 'cap'`)이다.
7. 그 밖은 `send` 다. 예정 시각보다 `LATE_AFTER_MIN`(2분) 이상 늦으면 `late` 다.

- 회의 중인지 보지 않는다. 연속 회의에서는 다음 회의 브리핑이 앞 회의 중에 온다.
- `skip` 결과는 `skipped` 행이 된다. 다음 틱이 같은 회의를 다시 보지 않는다.
- 보낸 뒤 일정 시각이 바뀌어도 다시 보내지 않는다. 같은 키다.

### 7.3 맥락 수집

`collectMeetingContext(db, meeting)` 은 DB 를 읽기만 한다. Jira·캘린더를 부르지 않는다. throw 하지 않는다. 실패한 출처는 비우고 `errors` 에 문구를 넣는다.

| 출처 | 읽기 | 상한(`MEETING_LIMITS`) |
|------|------|------|
| 지난 회의 | `meetings` JOIN `meeting_summaries`. 회의 시작 전 90일 안(녹음 종류로 거르지 않는다) | 후보 200건, 매칭 뒤 3건 |
| 미완료 액션아이템 | 매칭된 지난 회의의 `action_items` 가운데 `todo_id` 가 없는 항목 | 10건 |

- 매칭은 `sameTitle(a, b)` 다. `normalizeTitle` 이 소문자로 바꾸고 공백·구두점·기호를 지운다. `meetings.title` 또는 `meetings.calendar_event_title` 이 같으면 매칭이다.

### 7.4 규칙 본문과 알림 문구

`assistant-meeting.ts` 가 순수하게 만든다.

```
# <회의 제목> <HH:mm>
## 지난 회의
- <MM-DD> <제목> — <tldr>        ← 없으면 '같은 제목의 지난 회의 없음'
## 미완료 액션아이템 (N)
- <text>                          ← 없으면 절을 뺀다
```

- 각 줄은 200자(`MEETING_LINE_MAX`)에서 자른다. 외부 문자열의 Markdown 링크 문법은 `escapeMarkdownText` 로 이스케이프한다.
- 알림 제목은 `<회의 제목 30자> <lead>분 전` 이고, 본문은 `미완료 액션 N건` 이다(`meetingNoticeText`).
- `hasMeetingContext` 는 지난 회의나 액션아이템이 하나라도 있으면 참이다.

### 7.5 AI 본문

- 조건: `hasContext` 이고, `llmEnabled` 이고, Claude Code 헤드리스를 쓸 수 있다(`isHeadlessAvailable`). 아니면 `llmStatus` 는 `off` 다.
- `requestLlmMeetingBriefing(input, model)` 이 `runHeadlessJson` 을 부른다. throw 하지 않고 `{ ok: false, error }` 를 돌려준다.
- 프롬프트: 맥락을 `[데이터]` 블록 안에 JSON 으로 넣는다. `neutralizeMarkers` 가 데이터 안의 블록 경계 문자열(`[데이터]`·`[명령]`·`[지시]` 와 닫는 짝)을 괄호로 바꾼다. 외부 문자열은 한 줄로 만든다.
- 시스템 프롬프트(`MEETING_SYSTEM_PROMPT`)는 `[데이터]` 에 없는 사실을 만들지 말라고 지시하고, 비서 말투 규칙(`ASSISTANT_SPEECH_RULES`, 해요체)을 붙인다.
- 출력 스키마 `MeetingBriefingSchema`: `{ headline ≤ 80자, prep ≤ 5개 × 120자, questions ≤ 3개 × 120자 }`. `meetingBriefingJsonToMarkdown` 이 `## 준비할 것`·`## 확인할 질문` Markdown 으로 바꾼다. 제목이 비면 `<회의 제목> 준비` 다.
- 모델은 `llmModel` 을 `resolveAiModelId` 로 바꾼 값이다.

### 7.6 저장과 발송 순서

`runDueMeetingBriefings` 는 서비스의 쓰기 줄(`serialized`) 안에서 아래 순서로 처리한다.

1. `skip` 마다 `skipped` 행을 넣는다. `fired_at` 은 null 이다.
2. `send` 마다 맥락을 모으고 규칙 본문을 만든 뒤 행을 넣는다. AI 를 부를 예정이면 `llmStatus` 는 `pending`, 아니면 `off` 다. 충돌하면 건너뛴다.
3. 넣은 행이 있으면 `assistant:changed` 를 1번 낸다.
4. AI 본문은 백그라운드로 돈다. `runLlmSerialized`(`ai-headless.ts` 의 헤드리스 LLM 공용 줄) 안에서 실행한다. 결과는 같은 행의 payload 에 덮어쓴다. 성공이면 `done` 과 `llmMarkdown`·`llmModel`·`llmAt`, 실패면 `failed` 와 `llmError` 다. 끝나면 `assistant:changed` 를 낸다.
5. 스케줄러가 돌려받은 알림을 `Notification` 으로 보인다. `show()` 가 실패하면 그 행을 `failed` 로 바꾼다. 클릭은 `navigateToToday({ kind: 'meeting', id })` 다.

- 행 INSERT 가 알림보다 먼저다. 규칙 본문이 AI 본문보다 먼저 저장된다. AI 가 실패해도 알림과 규칙 본문은 남는다.
- 앱이 AI 도중에 꺼지면 `pending` 이 남는다. 카드의 '다시 만들기'가 이를 푼다.
- 1건의 실패가 다음 회의를 막지 않는다.

### 7.7 다시 만들기

`regenerateMeetingBriefing(eventId)` 는 버튼이 결과를 기다리는 경로다.

- 행이 없거나, `meeting_briefing` 이 아니거나, `skipped` 이거나, payload 를 읽을 수 없으면 throw 한다. `llmEnabled` 가 꺼져 있으면 throw 한다.
- 헤드리스를 쓸 수 없으면 payload 를 `failed` 로 바꾸고 오늘 페이로드를 돌려준다.
- 맥락은 지금 DB 로 다시 모은다. 규칙 본문은 그대로 둔다. `pending` 으로 바꾼 뒤 같은 LLM 경로를 돈다. 이전 AI 본문은 결과가 올 때까지 둔다.

## 8. 아침 자동 동기화

하루 1회, 설정 시각 뒤 첫 틱에 Jira 릴리스 전체 동기화(`syncAllReleases`)를 돈다. 동기화 자체의 규칙은 [RELEASE_NOTES.md](RELEASE_NOTES.md) §4.6 이다.

### 8.1 판정

`decideMorningSync(input)` 은 순수 함수다. 실행할 부분 목록을 돌려준다. 부분은 지금 `release` 하나다(`MORNING_SYNC_PARTS`).

- 실행하지 않는 경우: `morningSyncEnabled` 가 꺼짐, 이미 실행 중, 논리 날짜가 달력 날짜와 다름(날짜 경계 전 새벽), 지금이 `morningSyncTime` 보다 이름.
- 부분 상태별:

| 상태 | 다시 실행 |
|------|-----------|
| 없음 | 실행한다 |
| `ok`·`skipped` | 하지 않는다 |
| `failed` | 시도 수가 3(`MORNING_SYNC_MAX_ATTEMPTS`) 미만이고 마지막 시도 뒤 30분(`MORNING_SYNC_RETRY_MIN`)이 지났으면 |
| `running` | 15분(`MORNING_SYNC_STALE_MIN`) 넘게 낡았으면 `failed` 와 같은 규칙 |
| `deferred` | 30분이 지났으면. 시도로 세지 않는다. 지금 실행기는 이 상태를 만들지 않는다 |

### 8.2 실행

`runMorningSyncIfDue(wake, now?)` 는 throw 하지 않는다.

1. 이 프로세스에서 이미 실행 중이면 돌아간다.
2. 판정한다. 할 일이 없으면 돌아간다.
3. 오프라인(`net.isOnline()` 이 거짓)이면 돌아간다. 시도 수가 늘지 않는다.
4. 트랜잭션 안에서 다시 판정하고 오늘 행(`morning_sync:<날짜>`)을 선점한다. 행이 없으면 넣고, 있으면 고른 부분을 `running` 으로 바꾼다.
5. 부분을 실행한다. Jira 미연결이나 기본 프로젝트 없음이면 `skipped` 다. 받은 릴리스가 없고 실패만 있으면 `failed` 다. 그 밖은 `ok` 이고 새 릴리스 수(`newCount`)·갱신 수·실패 수를 남긴다. 예외는 `failed` 다.
6. payload 를 기록하고 모든 창에 `ai:dataChanged { entity: 'sync_status' }` 를 보낸다.

### 8.3 상태 표시

- `getMorningSyncStatus()` 는 `morning_sync` 행 가운데 마지막 논리 날짜의 행을 읽는다. 실행 중이 아닌데 `running` 이면 앱이 동기화 중에 꺼진 것이다. 화면에는 `failed`('동기화가 중단되었습니다.')로 보인다.
- 렌더러 `morningSyncStore` 가 `morningSync:status` 를 읽는다. `dataSync.ts` 가 앱 시작, 창 focus, `sync_status` 이벤트에서 다시 읽는다. `sync_status` 를 받았을 때 오늘 화면이 열려 있으면 `todayStore.load()` 도 부른다.
- 사이드바와 프로젝트 화면 탭은 아직 보지 않은 새 릴리스 수를 배지로 보인다(`unseenCount('release')`). 본 실행의 표식은 `localStorage` 의 `linkwork.morningSync.seen` 에 둔다. 릴리스 탭을 열면 `markSeen` 한다. 릴리스 화면의 상태 줄은 `components/release/morningStatus.ts` 가 만든다.

## 9. 일정·할 일 알림

`notification.ts` 는 비서 스케줄러와 별개의 60초 타이머다. 앱 시작 때 1번 돌고 그 뒤 60초마다 돈다.

| 대상 | 알림 시점 | 제목 |
|------|-----------|------|
| 기본 캘린더의 시간 일정(`dueEventNotifications`) | 시작까지 10~5분, 5분 미만~1분, 1분 미만~시작 뒤 1분 | `<10·5·1>분 후 일정` |
| 미완료이고 `due_reminder = 1` 이며 마감에 시각이 있는 할 일 | 마감 10~6분 전, 마감 ±1분 | `☑ TODO 10분 전`, `☑ TODO 시간` |

- 같은 알림은 한 번만 보낸다. 보낸 키는 메모리에 두고 달력 날짜가 바뀌면 비운다.
- 이 알림의 일정 조회가 `getTodayEvents` 캐시를 데운다. 회의 전 브리핑(§7.1)이 같은 캐시를 읽는다.

## 10. 트레이 위젯

- `createTrayWidget` 이 메뉴 막대 아이콘과 패널 창(340×480, 비활성 `panel` 창, 모든 스페이스·전체화면 위 표시)을 만든다. 패널은 렌더러 `#tray-panel` 해시로 `TrayPanel` 을 그린다. 창이 포커스를 잃으면 숨는다.
- 아이콘을 누르면 패널을 열고 `tray:data` 로 새 데이터를 보낸다.
- `TrayData` 는 `{ events }` 다. 선택한 캘린더의 오늘 일정과, 오늘 마감(시각 있음)이거나 오늘 완료한 할 일을 합친다. 종일 일정이 먼저, 그다음 시각순이다.
- 패널 동작: 'Open App'(`tray:openApp`, 메인 창 표시), '오늘 보기'(`tray:openToday`, §6.3), 'Refresh'(`tray:getData` 다시 읽기).

## 11. 오늘 대시보드

오늘 화면(`components/today/TodayView.tsx`)은 오늘 챙길 것과 팀에 공유할 업무를 한눈에 읽는 화면이다. 화면에서 직접 하는 동작은 할 일 체크·빠른 추가, 받은 요청의 할 일로·처리함, 이동 링크, 회의 브리핑 펼침, 업무 공유 복사, 새로고침(↻)뿐이다.

### 11.1 데이터

- 조립은 렌더러 순수 모델이 한다. `todayModel.ts` 의 `buildTodayDashboard` 가 헤드라인·카드 행·신호를 만들고, `releaseModel.ts` 의 `resolveNextRelease` 가 다음 배포를 판정한다. 메인의 집계 IPC 는 없다.
- 입력: `todayStore.events`(캘린더), `todoStore`(진행 중·완료 할 일), `jiraBoardStore.snapshot`(Jira 보드), `releaseNoteStore.allNotes`(릴리스), `assistantStore.today`(회의 브리핑 이벤트·연결 상태·AI 가능 여부), `inboxStore.snapshot`(나에게 온 요청, §11.6).
- 캘린더는 `calendar:range` 로 오늘 0시부터 21일(`CALENDAR_RANGE_DAYS`)을 받는다. 다음 주 배포·QA 일정까지 보려는 범위다.
- 다음 배포 판정 규칙은 [RELEASE_NOTES.md](RELEASE_NOTES.md) §8.4 '오늘 화면의 다음 배포 판정'이다.
- '업무 공유' 카드는 `shareModel.ts` 의 `buildWorkShare` 가 조립한다. 데일리 스탠드업에서 팀에 공유할 작업 완료·작업 중·작업 예정·회의·리뷰를 모은다. 새 IPC 없이 렌더러에 있는 값만 쓴다. 카드와 복사 글은 이것을 '어제'(지난 근무일 완료·지난 회의)와 '오늘'(작업 중·작업 예정·오늘 회의·오늘 완료)로 나눠 보인다. 어제 쪽 제목(`pastTitle`)은 구간이 하루면 '어제', 여러 날이면 '지난 근무일 이후' 다.
  - 기간(`yesterdayModel.ts` 의 `previousWorkRange`): 직전 평일 0시 ~ 오늘 0시. 월요일은 금~일, 일요일은 금~토, 그 밖(토요일 포함)은 어제 하루다.
  - 작업 완료: 내 담당 Jira 티켓(`jiraBoardStore.snapshot` 의 `myAccountId`) 중 `resolvedAt` 이, 할 일(`todoStore.activeTodos`·`completedTodos`) 중 `completed_at` 이 직전 평일 0시 ~ 지금 안인 것. 오늘 0시 전에 완료한 것은 어제 쪽 작업 완료(`done`), 오늘 0시 이후에 완료한 것은 오늘 쪽 오늘 완료(`doneToday`)로 나뉜다. 둘 다 작업 중·작업 예정에서는 빠진다.
  - 작업 중: 상태 분류가 진행 중인 내 Jira 티켓 전부(완료에 든 것 제외). 옆에 Jira 상태 이름을 붙인다. Jira 는 마지막 갱신 시각만 있어 기간 중에 실제로 만졌는지는 보지 않는다.
  - 작업 예정: 기한이 오늘까지(지난 것 포함)인 미완료 할 일(지난 것 먼저, 그다음 우선순위. 지난 것은 '기한 지남' 을 붙인다)과 백로그가 아닌(`inScope`) '할 일' 상태의 내 Jira 티켓(기한 있는 것 먼저 기한순).
  - 회의·리뷰: 직전 근무일 구간의 `todayStore.pastEvents` 와 오늘의 `todayStore.events` 중 종일이 아닌 일정, 그리고 `todayStore.meetingNotes`(회의록 목록, `meetingNotes:list`). 회의록 시작 시각이 일정 시작 10분 전 ~ 일정 끝 안이면 그 일정에 회의록과 한 줄 요약(tldr)을 붙이고, 붙지 않은 구간 안 회의록은 따로 행이 된다. 제목에 PRD·리뷰·review 가 있으면 리뷰로 표시한다. 요일 표기는 지난 구간이 하루면 '어제', 여러 날이면 요일, 오늘은 '오늘' 이다.
  - Jira 스냅샷이나 내 계정을 모르면 Jira 항목 없이 할 일·회의만 모으고 카드에 안내 한 줄을 보인다(카드 전체가 0건이면 빈 상태 문구만 보인다).

### 11.2 갱신

- 화면 진입: `todayStore.load()`. 비서·할 일·Jira 보드·릴리스·캘린더(오늘 범위와 지난 근무일 범위)·회의록 목록·나에게 온 요청을 함께 읽는다. 캐시를 허용한다. 나에게 온 요청은 저장본을 먼저 보이고, 메인이 10분 안의 재동기화를 거른다(§11.6). 지난 근무일 일정과 회의록은 실패하면 직전 값을 그대로 둔다.
- ↻: `todayStore.refresh()`. 캘린더를 강제로 다시 받고, Jira 보드는 증분 동기화, 릴리스는 변경분 동기화, 나에게 온 요청은 원본 동기화를 강제한다(30초 안의 연타만 거른다).
- 하나가 실패해도 나머지는 반영한다. 늦게 끝난 옛 요청은 새 결과를 덮지 않는다.
- `stores/dataSync.ts`: 창 focus(30초 간격 제한)와 아침 동기화 완료 때 오늘 화면이 열려 있으면 `todayStore.load()` 를 부른다. `assistant:changed` 는 `assistantStore.load()` 를 부른다.
- 화면의 '지금'은 60초마다 다시 읽는다.

### 11.3 배치

- 좁은 창은 한 열이다. DOM 순서는 헤더 → 다음 배포 → 나에게 온 요청 → 내 Jira 작업 → 할 일 → 업무 공유 → 일정 → 중요 메모다.
- 본문 컨테이너 폭이 1000px 이상(`@min-[1000px]`)이면 같은 DOM 을 격자로 옮긴다. 일정은 왼쪽 좁은 열(sticky, 헤더 아래 네 행에 걸침)에, 오른쪽에 다음 배포, 그 아래 오른쪽 두 열 전체 폭으로 나에게 온 요청, 그 아래 [내 Jira 작업 | 할 일], 그 아래 오른쪽 두 열 전체 폭으로 업무 공유를 둔다.
- 나에게 온 요청은 Jira·Bitbucket 이 둘 다 연결되지 않았으면 칸째 그리지 않고, 아래 카드를 한 행씩 올린다(일정 열은 세 행에 걸친다. `TodayView.tsx` 의 `gridRows`).
- 헤더는 날짜, 마지막 동기화 시각, ↻, 헤드라인 1줄, 오류 줄이다. 캘린더 미연결은 일정 카드가 안내하므로 오류 줄에 쓰지 않는다.
- 시각 상수(위계·severity 색과 모양·행 모양)는 `todayTokens.ts` 에만 둔다. severity 는 색과 모양을 함께 쓴다: critical 빨강 ◆, warn 앰버 ▲, info 파랑 ●.

| 카드 | 내용 | 이동 |
|------|------|------|
| 다음 배포(`ReleaseCard`) | 버전·D-day·날짜, 개발─QA─배포 단계 선, 내 작업 막대, 이슈 행(위험 행 전부 + 3행) | 이슈 키 → 그 이슈, '외 n건' → 릴리스 탭 |
| 나에게 온 요청(`RequestInboxCard`) | 요청 시각 최신순 6행(`INBOX_VISIBLE`), 넘으면 '외 n건 더 보기' 로 펼친다. 행: 종류(담당·멘션·리뷰) · 출처(Jira 키 또는 'repo #번호') · 제목, 멘션이면 댓글 앞부분, 요청자·상대 시각, [할 일로]·[처리함]. 0건이면 '새로 온 요청이 없어요'. 원본 오류와 Bitbucket 워크스페이스 미지정만 카드 아래 한 줄로 알린다. 워크스페이스가 정해져 있고 오류가 없으면, 또 미연결이면 아무 줄도 없다 | 출처 → 원본(Jira 이슈·댓글, Bitbucket PR)을 브라우저로, 안내 줄의 '설정 →' → 설정 > 연동(Bitbucket 카드에 워크스페이스 칸이 있다) |
| 내 Jira 작업(`JiraWorkCard`) | 지남 → 오늘 마감 → 진행 중 → 리뷰·QA → 나머지, 7행. 다음 배포 카드에 보인 이슈는 뺀다 | 이슈 키 → 그 이슈, '외 n건' → 티켓 탭, 미연결이면 설정 > 연동 |
| 할 일(`TodoCard`) | 지남 → 오늘 → 마감 있음 → 마감 없음, 6행. 체크, 빠른 추가(Enter. 빈 값·한글 조합 중은 무시, 자연어 인식 — 아래), 오늘 완료 수 | 제목 → 할 일 화면의 그 항목, '외 n건' → 할 일 화면 |
| 업무 공유(`WorkShareCard`) | 제목·건수·오늘 날짜와 '복사'. 본문은 어제 / 오늘 2열이다(카드 폭 560px 미만이면 1열로 쌓는다. 어제 열은 옅은 배경과 구분선으로 갈린다). 어제 열: `pastTitle`·기간, 지난 근무일에 완료한 항목(이슈는 키·제목, 할 일은 제목)을 한 줄씩 말줄임, 그 아래 지난 회의를 '시각 제목'(여러 날이면 요일 포함) 한 줄씩. 메모·요약·배지는 없다. 상한은 완료 8(`PAST_DONE_LIMIT`)·회의 5(`PAST_MEETING_LIMIT`). 오늘 열: 작업 중 → 작업 예정 → 회의·리뷰 → 오늘 완료 섹션. 행 옆에 흐린 메모(상태 이름·'기한 지남', 오늘 완료는 메모 없음), 회의는 시각·제목, 리뷰면 '리뷰' 배지, 회의록이 있으면 한 줄 요약. 섹션마다 8행(`SHARE_SECTION_LIMIT`). 상한을 넘으면 '외 n건'. 빈 섹션은 그리지 않고, 한 열이 통째로 비면 그 열에 흐린 한 줄('<pastTitle> 완료한 작업이 없어요.' / '진행 중·예정 작업이 없어요.')을 보인다. 0건이면 '공유할 작업이 없어요' 와 비활성 복사 버튼. Jira 를 모르면 안내 한 줄 | 이슈 → 그 이슈, 할 일 → 할 일 화면의 그 항목, 회의록이 있는 회의 → 회의록 화면의 그 회의록 |
| 일정(`ScheduleCard`) | 종일 칩(릴리스·QA 종일 일정 제외), 시간 일정 행(지난 일정 흐림), '지금' 선, 회의 전 브리핑 펼침, 내일 1줄. 기본 캘린더가 아닌 일정은 꼬리표를 붙인다 | '캘린더 →', 미연결이면 설정 > 연동 |
| 중요 메모(`HomeMemos`) | 중요 메모 전문. 0건이면 그리지 않는다 | — |

- 마감이 지난 행과 배포 위험 행은 행 상한과 무관하게 늘 보인다.
- 할 일 카드의 묶음(지남·오늘·그 뒤·없음)과 마감 글자는 할 일 화면과 같은 공용 모델(`components/todo/todoModel.ts` 의 `todoBucket`·`todoDueText`)이 정한다. 마감 글자는 지남이면 'M/D 지남'(빨강), 오늘이면 '오늘'(앰버), 그 밖은 'M/D'(회색)이다.
- 할 일 빠른 추가는 할 일 화면과 같은 자연어 인식(`components/todo/todoParse.ts` 의 `parseTodoInput`)을 거쳐 `TodoInput` 으로 `todoStore.createTodo` 를 부른다. 날짜(오늘·내일·모레·요일·`M/D` 등)·시각(`3시`·`15:30`·오전/오후)·우선순위(`!높음`·`p1` 등)·`#태그`(이미 있는 태그 이름만, `todoStore.tags`)를 알아보고 나머지를 제목으로 둔다. 시각이 있으면 알림(`due_reminder`)을 켠다. 날짜를 적지 않으면 마감을 오늘(시각 없음)로 둔다. 예: `내일 3시 회의 준비 !높음` → 제목 '회의 준비', 마감 내일 15:00, 우선순위 높음.
- 입력하는 동안 입력 아래에 알아본 내용을 한 줄로 보인다(`todayModel.ts` 의 `todoInputSummary`, 예: '내일 15:00 · 높음'). 알아본 것이 없으면 그리지 않는다. 추가에 성공하면 입력을 비우고, 실패하면 입력을 그대로 두고 카드 안에 실패 문구를 보인다.
- 신호(§11.4)에 올라간 이슈·할 일은 다음 배포·내 Jira 작업·할 일 카드 행에 앰버 점 표식만 붙인다.
- 업무 공유의 '복사' 는 팀 공유용 평문(`workShareText`)을 클립보드에 쓰고 토스트로 알린다. 화면 상한과 무관하게 전부 담는다. 형식은 첫 줄 '업무 공유 · <오늘 날짜>', 빈 줄, '■ <pastTitle> · <기간>' 아래 완료 항목('- 키 제목' 또는 '- 제목')과 지난 회의 한 줄('- 회의: 제목, 제목'), 빈 줄, '■ 오늘' 아래 '[작업 중]'·'[작업 예정]'·'[회의·리뷰]'·'[오늘 완료]' 묶음이다. 메모가 있으면 '(메모)' 를 붙이고, 오늘 회의는 '- 시각 제목' 이다. 빈 묶음은 뺀다.

### 11.4 신호와 헤드라인

신호는 `buildTodayDashboard` 가 규칙으로 만든다. 문구와 근거(ref)도 규칙이 붙인다. LLM 으로 다듬지 않는다. 데스크톱 오늘 화면은 신호 패널을 그리지 않는다. 신호는 카드 행 강조(`signaled`, §11.3)와 휴대폰 열람의 '지금 챙길 것'([MOBILE_VIEW.md](MOBILE_VIEW.md))에 쓰인다. 헤드라인은 신호와 같은 사실(배포·마감·회의)에서 따로 만든다.

| kind | 조건 | severity |
|------|------|----------|
| `release_risk` | 다음 배포가 Jira 릴리스와 연결됨, 내 계정 id 를 앎, 위험 이슈(`releaseRiskKeys`)가 있음. 1건으로 합친다 | D-1 이하 critical, 그 밖 warn |
| `release_day` | 오늘이 배포일 | warn |
| `overdue` | 마감 지난 내 Jira, 마감 지난 할 일. 각각 1건 | warn |
| `meeting_soon` | 시작까지 0 < 분 ≤ 60 인 가장 가까운 기본 캘린더 일정. 문구는 절대 시각 | info |
| `due_today` | 오늘 마감인 Jira·할 일을 합쳐 1건 | info |
| `qa_start` | 오늘이 QA 시작일이고 배포일이 아님 | info |

- 정렬은 severity → 위 표의 순서다. 상위 3건(`SIGNAL_LIMIT`)이 보이는 신호(`signals`), 나머지는 `hiddenSignals` 다. `meeting_soon` 은 상한 안에 한 자리를 보장받는다. 카드 행 강조는 보이는 신호의 근거만 쓴다.
- 신호 문구에는 상대 시간을 넣지 않는다. `meeting_soon` 의 'n분 뒤'는 그리는 화면이 붙인다.
- 근거 칩(`visibleRefs`)은 배포 칩을 늘 남기고 나머지를 4개(`SIGNAL_REF_DISPLAY_LIMIT`)까지 보인다.
- 헤드라인은 1줄, 80자 이하다. 배포 상황(오늘 배포·QA 시작·QA 중·D-n) 뒤에 위험 미완 수 → 마감 지남 수 → 오늘 마감 수 → 오늘 회의 수 가운데 첫 번째를 붙인다.
- 요약 1줄(`summaryLine`) '회의 n · 오늘 마감 n · 배포 D-n'은 신호가 없을 때 신호 대신 보인다. 해당 없는 조각은 뺀다.
- 미연결 영역을 '없음'으로 단정하지 않는다. 캘린더·Jira 가 미연결이면 연결을 안내하는 문구를 쓴다. Jira 를 셀 수 없으면 마감 건수는 '할 일' 건수라고 밝힌다.
- 버전 매칭에 실패하면 `release_risk` 를 만들지 않는다. 배포 카드는 Jira 를 몰라서 다음 배포를 모르는 경우(`releaseUnknown`)와 정말 없는 경우를 구분해 보인다.

### 11.5 회의 브리핑 표시

- `meetingBriefings(events)` 가 `meeting_briefing` 행 가운데 `sent`·`late`·`failed` 를 고른다. `skipped` 는 보이지 않는다.
- 일정 행과의 짝은 `payload.meeting.id === CalendarEvent.id` 다. 일정 행이 없는 회의의 브리핑은 보이지 않는다.
- 기본으로 펼치는 것은 아직 시작하지 않은 가장 가까운 회의 중 브리핑이 있는 1건이다. 사용자가 한 번 접거나 펼치면 그 뒤로는 사용자 선택을 따른다.
- 배지는 `llmStatus` 가 `done` 이면 'AI 브리핑', 아니면 '규칙 브리핑'이다. 본문은 `llmMarkdown`, 없으면 규칙 본문(첫 제목 줄 제외)이다. `pending` 이면 '만드는 중' 안내, `failed` 면 경고와 `llmError` 를 보인다.
- '다시 만들기'는 `aiAvailable` 이고 `llmEnabled` 일 때 쓸 수 있다. 행 단위로 중복 클릭을 막는다.
- 알림 클릭 focus 가 `meeting` 이면 `meeting-briefing-<eventId>` 를 펼치고 스크롤한다. 그 밖의 focus kind 는 무시한다.

### 11.6 나에게 온 요청

다른 사람이 나에게 보낸 요청을 한곳에 모은다. 원본은 읽기만 하고, 처리 상태는 로컬 `request_inbox` 에 둔다. Slack 멘션은 아직 모으지 않는다(앱에 Slack 연동이 없다).

| 종류 | 원본 | 조건 | 행 id |
|------|------|------|------|
| 담당(`assigned`) | Jira `search/jql` | 미완료, 내 담당, 최근 7일(`REQUEST_WINDOW_DAYS`) 안에 나에게 할당됐거나 만들어진 이슈. 그 기간에 스스로 담당자를 바꾼 것(`BY currentUser()`)과 내가 만든 이슈는 뺀다. 요청자 칸은 보고자다 | `jira:assigned:<키>` |
| 멘션(`mention`) | Jira `search/jql` | `comment ~ "<내 accountId>"` 로 최근 7일 갱신된 후보를 찾고, 댓글 ADF 의 mention 노드가 나를 가리키는지 다시 본다. 내가 쓴 댓글과 7일보다 오래된 댓글은 뺀다. 이슈당 가장 최근 1건 | `jira:mention:<키>:<댓글 id>` |
| 리뷰(`review`) | Bitbucket Cloud | 설정한 워크스페이스에서 최근 갱신된 저장소 30개(`REVIEW_REPO_LIMIT`)의 열린 PR 중 나를 리뷰어로 둔 것(BBQL `reviewers.uuid`, `read:user` 가 없으면 Jira accountId 로 `reviewers.account_id`). 내가 이미 승인했거나 변경 요청한 PR 은 뺀다. 승인 확인(PR 상세 GET)은 40개(`REVIEW_DETAIL_LIMIT`)까지이고, 이미 할 일로 바꾸거나 처리한 PR 은 확인하지 않는다 | `bitbucket:review:<ws>/<repo>#<번호>` |

- 상한: Jira 종류별 100건, Bitbucket 동시 요청 5개, 저장소당 PR 목록 1페이지(50건). 다음 페이지가 남거나 일부 저장소가 실패하면 그 조회는 미완료다. 저장소 일부의 403 은 그 저장소 실패로 세고, 모든 저장소가 403 일 때만 `read:pullrequest` 범위 부족으로 알린다.
- 동기화(`syncRequestInbox`): 화면 진입·focus 재로드는 마지막 동기화 10분(`MIN_SYNC_INTERVAL_MS`) 안이면 저장본만 돌려준다. Bitbucket 은 동기화 1번에 수십 번 GET 하고 시간당 요청 한도를 AI 조회와 나눠 쓰기 때문이다. ↻ 는 30초(`FORCE_MIN_INTERVAL_MS`) 안의 연타만 거른다. Bitbucket 워크스페이스를 저장하면(`markRequestInboxStale`) 다음 자동 동기화는 간격과 무관하게 돈다. 실행 중이면 그 결과를 함께 기다린다. Jira 가 먼저 돌고(내 accountId 를 동기화마다 `/myself` 로 다시 읽는다) Bitbucket 이 뒤따른다. 한 원본이 실패해도 다른 원본은 반영하고, 실패한 원본은 카드에 오류 한 줄로 알린다.
- 병합(`mergeFetchedRequests`): 새 요청은 `open` 으로 넣는다. 이미 있는 행은 제목·링크·요청자·미리보기·`last_seen_at` 만 고치고 상태는 그대로 둔다. 조회가 잘리거나 일부 실패하지 않았을 때만 이번에 잡히지 않은 `open` 행을 지운다(원본에서 사라진 요청: 승인·머지·완료·담당 변경·기간 지남).
- 할 일로(`inbox:toTodo`): 제목 '[키] 제목'(멘션은 뒤에 '댓글 답하기', 리뷰는 '[리뷰] repo #번호 제목'), 출처 링크는 원본 주소, 마감은 오늘(오늘 화면 빠른 추가와 같다)로 할 일을 만들고 같은 트랜잭션에서 요청을 `todo` 로 둔다. 할 일 출처 칩은 Bitbucket PR 이면 'repo #번호' 다.
- 처리함(`inbox:dismiss`): 요청을 `dismissed` 로 둔다. `todo`·`dismissed` 는 다시 잡혀도 보이지 않는다. 마지막으로 조회에 잡힌 지 30일(`HANDLED_KEEP_DAYS`)이 지나면 행을 지운다. 이 정리는 그 원본 조회가 온전했을 때만 그 원본 행에 한다.
- 연결을 끊었거나 워크스페이스를 지운 원본의 저장 행은 보이지 않는다(행은 남는다).
- 원본 열기(`inbox:open`)는 렌더러가 보낸 주소를 쓰지 않는다. id 로 저장된 행의 https 주소를 꺼내 `open-target` 검사를 거쳐 연다.
- Bitbucket 워크스페이스와 필요한 token 범위는 [SETTINGS.md](SETTINGS.md) 의 Bitbucket 카드에 있다. 상태 `not_connected`(미연결)·`no_workspace`(워크스페이스 없음)·`error`·`ok` 를 원본별로 돌려준다.

## 12. IPC 계약

인자 형식은 서비스가 검증한다. 렌더러 값은 신뢰하지 않는다.

| 채널 | 요청 | 응답 |
|------|------|------|
| `assistant:getToday` | `()` | `{ success: true; today: TodayPayload } \| { success: false; error }` |
| `assistant:regenerateMeetingBriefing` | `(eventId: number)` | `{ success: true; today: TodayPayload } \| { success: false; error }` |
| `assistant:getSettings` | `()` | `AssistantSettings`. 감싸지 않는다 |
| `assistant:saveSettings` | `(patch)` | `{ success: true; settings } \| { success: false; error }` |
| `assistant:takePendingNavigate` | `()` | `{ success: true; pending: AssistantNavigateEvent \| null } \| { success: false; error }` |
| `morningSync:status` | `()` | `{ success: true; status: MorningSyncStatus } \| { success: false; error }` |
| `inbox:cached` | `()` | `{ success: true; snapshot: RequestInboxSnapshot } \| { success: false; error }`. 원본을 부르지 않는다 |
| `inbox:sync` | `(force: boolean)` | 위와 같다. 마지막 동기화 10분(force 면 30초) 안의 재호출은 저장본 |
| `inbox:toTodo` | `(id: string, dueDate: 'YYYY-MM-DD' \| null)` | `{ success: true; todoId } \| { success: false; error }` |
| `inbox:dismiss` | `(id: string)` | `{ success: true } \| { success: false; error }` |
| `inbox:open` | `(id: string)` | `{ success: true } \| { success: false; error }` |
| `tray:getData` | `()` | `TrayData` |
| `tray:openApp` | `()` | 없음 |
| `tray:openToday` | `()` | 없음 |

| 이벤트(메인 → 렌더러) | 페이로드 |
|------|------|
| `assistant:navigate` | `AssistantNavigateEvent` |
| `assistant:changed` | `AssistantChangedEvent { date, reason: 'meeting' }` |
| `tray:data` | `TrayData` |
| `ai:dataChanged` | 아침 동기화는 `{ entity: 'sync_status' }` 를 보낸다 |

`TodayPayload` 는 `{ events: AssistantEvent[]; settings; aiAvailable; calendarConnected }` 다. `events` 는 오늘 논리 날짜의 비서 이벤트 전부다. 연결 상태와 헤드리스 가능 여부는 부를 때마다 실제 값으로 읽고, 읽다가 실패하면 `false` 다. `RequestInboxSnapshot` 은 `{ items: RequestInboxItem[]; jira: InboxSourceStatus; bitbucket: InboxSourceStatus; syncedAt }` 다. preload 는 `window.api.assistant`·`window.api.morningSync`·`window.api.tray`·`window.api.inbox` 로 노출한다. 렌더러 타입은 `src/renderer/src/types/index.ts` 에 있다.

## 13. 불변식

- **실패 격리**: 스케줄러 처리기, `runMorningSyncIfDue`, `collectMeetingContext`, `requestLlmMeetingBriefing`, AI 본문 백그라운드 작업은 throw 하지 않는다. 실패는 로그·`errors`·payload 의 상태로 남는다.
- **쓰기 범위**: 나에게 온 요청은 `request_inbox` 와, 할 일로 바꿀 때 `todos`(이력 포함)만 쓴다. Jira·Bitbucket 에는 GET 만 한다. 비서 서비스·저장소는 비서 테이블과 `assistant_*` 설정만 쓴다. 지난 회의·할 일 같은 원본 테이블은 읽기만 한다. 아침 동기화는 예외로 릴리스 동기화를 부르며, 그래서 파일 이름에 `assistant-` 를 붙이지 않았다.
- **순수 모듈**: `assistant-day.ts`·`assistant-settings.ts`·`assistant-schedule.ts`·`assistant-meeting.ts`·`todayModel.ts`·`releaseModel.ts` 는 DB·네트워크·전역 시각을 쓰지 않는다. 시각은 인자로 받는다.
- **한 번만**: 회의 브리핑과 아침 동기화는 `event_key` UNIQUE 로 하루 1번을 보장한다. 행 INSERT 가 알림보다 먼저다.
- **직렬화**: 회의 브리핑 쓰기는 서비스의 쓰기 줄 하나로 처리한다. 헤드리스 LLM 호출은 `runLlmSerialized` 로 한 번에 하나씩 돈다. 회의 브리핑 판정은 `dueInFlight`, 아침 동기화는 모듈의 `inFlight` 로 동시에 1개만 돈다.
- **AI 입력 격리**: 외부 문자열은 `[데이터]` 블록 안에만 넣는다. 출력은 zod 스키마로 검증하고 길이를 제한한다. 헤드리스 실행의 도구 차단은 `ai-headless.ts` 가 맡는다.
- **말투**: 비서가 만드는 AI 문장은 해요체다. 규칙은 `writing-style.ts` 의 `ASSISTANT_SPEECH_RULES` 가 유일한 정의처다. AI 대화·회의 요약은 같은 파일의 `WRITING_STYLE_RULES` 를 쓴다.
- **거짓 경보 방어**: 오늘 대시보드는 연결되지 않은 데이터로 위험이나 '없음'을 말하지 않는다(§11.4).
