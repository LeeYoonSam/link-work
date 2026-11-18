# 설정 화면

흩어져 있던 설정(연동 4개, AI, 비서, 회의 녹음 보조, 백업)을 한 화면에 모은다.
저장 키와 기존 IPC 는 바꾸지 않았다. 새 IPC 는 연결 테스트용 1개뿐이다.

## 진입 경로

| 진입점 | 동작 |
|---|---|
| 사이드바 하단 "설정"(톱니) | 설정 화면(ViewId `settings`). 마지막으로 고른 섹션을 연다 |
| 오늘 > 더 보기 > "비서 설정" | `open('assistant')` |
| 캘린더 상단 "설정" | `open('integrations')` |
| 캘린더 미연결 빈 상태 카드 | [연결] 은 `GoogleCalendarConnectDialog` 를 그 자리에서 띄운다. [설정에서 관리] 는 `open('integrations')` |
| AI 대화 채팅 목록 하단 "Notion 연동", "Bitbucket 연동" | 상태 점과 라벨만 보이고, 누르면 `open('integrations')` |
| AI 대화 Claude 사용 불가 배너 | [설정 > AI에서 확인] 은 `open('ai')`. [다시 확인] 은 그대로 |
| Jira 토큰 만료·만료 임박 배너(`JiraTokenWarning`) | 문구 끝 [설정 열기]. 호출부가 `onOpenSettings` 를 주면 그 자리의 Jira 팝업을 열고(프로젝트 싱크 모달, 릴리스 화면, 릴리스 노트 카드), 없을 때만 `open('integrations')` |
| 프로젝트 싱크 모달, 릴리스 화면, 릴리스 노트 카드의 Jira 설정 | 화면을 옮기지 않는다. `JiraSettingsModal`(래퍼)이 `JiraConnectDialog` 와 기본 프로젝트 select 를 그 자리에서 띄운다. 이유: 설정 화면으로 이동하면 진행 중인 싱크 미리보기가 닫힌다 |

`useSettingsStore.open(section?)` 는 섹션을 고르고 `useProjectStore.setView('settings')` 를 호출한다.
`normalizeView('settings')` 가 `settings` 를 돌려주므로 AI 내부 링크도 설정 화면을 가리킬 수 있다.

사이드바는 `navConfig.ts` 의 `NAV_FOOTER`(현재 `settings` 1개)를 하단 고정 영역에 그린다.
`NAV_GROUPS` 와 `NAV_FOOTER` 를 합치면 모든 ViewId 가 정확히 1번씩 나온다(`navConfig.test.ts`).
사이드바의 "데이터 백업 · 복원" 버튼은 없앴다. 백업·복원은 설정 > 데이터에서 연다.

## 섹션 구조

왼쪽 섹션 목록(제목과 한 줄 설명), 오른쪽 내용 패널. 섹션 ID 는
`SettingsSectionId = 'integrations' | 'ai' | 'assistant' | 'recording' | 'data'` 이고 이 순서로 그린다.
모르는 값은 `normalizeSettingsSection` 이 `integrations` 로 바꾼다.

| 섹션 | 한 줄 설명 | 내용 |
|---|---|---|
| 연동 | 캘린더, Jira, Bitbucket, Notion을 연결합니다 | 카드 4개(Google 캘린더, Jira + 기본 프로젝트 select, Bitbucket, Notion). 위쪽에 [모두 다시 확인]. Jira 가 연결돼 있으면 기본 프로젝트 목록을 화면에 들어올 때 한 번 가져온다 |
| AI | Claude Code 상태와 AI 모델 | Claude Code 상태(`ai:status`, [다시 확인]), AI 대화 모델(`ai:setModel`), 비서 AI 브리핑 사용과 비서 요약 모델(`llmEnabled`, `llmModel`) |
| 비서 | 하루 경계, 알림, 자동 동기화 | 동작 / 시간 / 알림과 주기 3개 그룹. 토글·select 는 바로 저장, 숫자·시각은 blur 때 검증 후 저장(`assistant:saveSettings` 부분 patch). 저장에 실패한 칸은 화면 값을 실제 저장값으로 되돌린다. 같은 칸을 연달아 바꾸면 마지막 요청의 결과만 화면에 반영한다
| 회의 녹음 | 전사 정확도를 높이는 용어집과 구성원 | `RecognitionAidsPanel`. 녹음 화면에도 같은 패널이 남아 있다 |
| 데이터 | 백업과 복원(새 PC 이전) | 설명과 [백업·복원 열기]. `layout/BackupModal` 을 수정 없이 띄운다 |

## 설정 항목 표

| 항목 | 섹션 | 저장 위치 | IPC |
|---|---|---|---|
| Google OAuth Client ID / Secret | 연동 > Google 캘린더 팝업 | `app_settings.google_client_id`(평문), `google_client_secret`(safeStorage) | `calendar:saveSettings`, `calendar:status` |
| Google 계정 연결(OAuth 토큰) | 연동 > Google 캘린더 | `auth_tokens`(provider='google', safeStorage). 범위 `calendar.readonly`, 콜백 `http://localhost:8945/callback` | `calendar:auth`, `calendar:disconnect` |
| Jira 사이트 URL, 이메일, API 토큰, 만료일 | 연동 > Jira 팝업 | `jira_site_url`, `jira_email`, `jira_api_token`(safeStorage), `jira_token_expires_at`, `jira_account_name` | `jira:status`, `jira:saveCredentials`(저장 전 `/myself` 검증), `jira:disconnect` |
| Jira 기본 프로젝트 | 연동 > Jira 카드 | `jira_default_project_key` | `jira:listProjects`, `jira:setDefaultProject` |
| Bitbucket 이메일, API token | 연동 > Bitbucket 팝업 | `bitbucket_email`(평문), `bitbucket_api_token`(safeStorage) | `ai:bitbucketStatus`, `ai:bitbucketSaveToken`(`/user` 검증), `ai:bitbucketDisconnect` |
| Notion 토큰 | 연동 > Notion 팝업 | `notion_token`(safeStorage) | `ai:notionStatus`, `ai:notionSaveToken`(`/users/me` 검증), `ai:notionDisconnect` |
| Claude Code 사용 가능 여부 | AI | 저장값 없음(`~/.claude.json` 읽기) | `ai:status` |
| AI 대화 모델 | AI(입력창 아래 select 와 같은 값) | `ai_model`, `ai_model_labels` | `ai:getModel`, `ai:setModel`, `ai:getModelOptions` |
| 비서 설정(`assistant_*` 키) | 비서, AI(AI 브리핑·요약 모델) | `app_settings.assistant_*` | `assistant:getSettings`, `assistant:saveSettings` |
| 용어집·구성원 | 회의 녹음 | 인식 보조 테이블 | `recognitionAids:*` |
| 백업·복원 | 데이터 | zip 파일(비밀값은 사본에서 지움) | `backup:*` |

설정 화면 대상이 아닌 것: 채팅별 쓰기 모드(`ai_chats.write_mode`, 입력창 아래 select), 녹음 세션별 무음 압축, STT 모델(고정).

## 연동 카드 상태

순수 함수 `toCardState`(`components/settings/integrationStatus.ts`)가 아래 순서로 판정한다.

| 상태 | 조건 | 배지 | 원클릭 액션 |
|---|---|---|---|
| 확인 중 | 상태를 아직 받지 못함 | 회색 스피너 | 없음 |
| 인증 실패 | 마지막 연결 테스트 결과가 `auth_failed` | 빨강 | [다시 연결], [해제] |
| 만료됨 / 만료 임박 | Jira `expired` / `expiringSoon` | 빨강 / 주황, 만료일 | [토큰 교체] |
| 연결됨 | `connected` | 초록, 계정, "마지막 확인 hh:mm" | [연결 테스트], [변경], [해제](확인 창) |
| 확인 실패 | 연결돼 있으나 테스트 결과가 `unreachable` | 초록 + 주황 보조 문구 "네트워크 확인 실패" | [연결 테스트] |
| 설정 필요 | Google `hasCredentials=false` | 회색 | [연결](자격 증명 입력 → 저장 → OAuth 한 번에) |
| 연결 안 됨 | 그 밖. Google 은 `hasCredentials && !connected` | 회색 | [연결]. Google 은 [Google 로그인] 으로 바로 `calendar:auth` |

"마지막 확인"은 이번 세션의 [연결 테스트]·[모두 다시 확인] 결과의 `checkedAt` 이다. 렌더러 스토어 메모리에만 두고 DB 키를 늘리지 않는다.
설정 화면에 들어올 때는 기존 status IPC 만 `Promise.allSettled` 로 병렬 조회하고, 연결 검증 호출은 버튼을 눌렀을 때만 한다(예외: Jira 가 연결돼 있으면 기본 프로젝트 목록을 한 번 가져온다). 한 연동의 상태 조회가 실패해도 나머지는 채우고, 실패한 항목만 오류 문구를 단다.

## 토큰 등록 팝업 구성

모든 연동 팝업은 공통 껍데기 `ConnectDialog` 를 쓴다.

1. 제목과 용도 한 줄
2. 필요한 권한 표(범위 → 왜 필요한지)
   - Bitbucket: `read:repository:bitbucket`(필수, 저장소 파일 읽기), `read:pullrequest:bitbucket`(권장, PR 링크 읽기), `read:user:bitbucket`(권장, 연결 계정 이름 표시). 쓰기 범위는 필요 없다
   - Jira: Atlassian API token. 범위 없음, 계정 권한 그대로 읽기만 사용. 만료일은 발급할 때 정한 날짜
   - Notion: 내부 통합의 "콘텐츠 읽기" 권한, 페이지 ⋯ → 연결에서 통합 추가. claude.ai 커넥터 대안 안내
   - Google: `calendar.readonly`. redirect URI `http://localhost:8945/callback` 과 [복사]
3. [발급 페이지 열기 ↗]: `https://id.atlassian.com/manage-profile/security/api-tokens`(Jira·Bitbucket), `https://www.notion.so/my-integrations`, `https://console.cloud.google.com/apis/credentials`
4. 입력 칸. 이메일은 다른 Atlassian 연동(Jira ↔ Bitbucket)에서 미리 채운다. 비밀값은 `type=password`, Enter 로 제출
5. [확인 후 저장]. 진행 중에는 "확인 중…". 검증은 기존 save IPC 가 한다(실패하면 저장하지 않음). Google 은 `saveSettings` 다음 바로 `auth`
6. 결과: 성공이면 "연결됨: {account}" 와 [닫기], 실패면 원인 문구
7. 저장 안내: "이 Mac에만 암호화 저장되며 데이터 백업에 포함되지 않습니다. 새 PC에서는 다시 연결하세요."

계약: 저장에 성공하면 입력 중이던 비밀값 state 를 비운다. 팝업은 Esc 와 [닫기]로 닫는다(저장 중에는 Esc 를 무시한다). 해제는 모든 곳에서 같은 확인 문구(`DISCONNECT_CONFIRM`)를 쓴다.

## IPC 계약(새 IPC 1개)

```ts
// preload: window.api.settings.verifyIntegration(id)
ipcRenderer.invoke('settings:verifyIntegration', id: IntegrationId): Promise<IntegrationVerifyResult>

export type IntegrationId = 'google' | 'jira' | 'bitbucket' | 'notion'
export type IntegrationVerifyCode = 'not_connected' | 'auth_failed' | 'expired' | 'unreachable' | 'unknown'
export type IntegrationVerifyResult =
  | { ok: true; account: string | null; checkedAt: string } // ISO
  | { ok: false; code: IntegrationVerifyCode; error: string; checkedAt: string }
```

- throw 하지 않는다. 결과에 비밀값을 넣지 않는다.
- 저장된 자격 증명으로 가장 가벼운 GET 1번만 보낸다: Jira `/rest/api/3/myself`, Bitbucket `/2.0/user`, Notion `/v1/users/me`, Google `calendarList.get('primary')`.
- 연결되지 않았으면 외부 호출 없이 `not_connected`, Jira 만료일이 지났으면 호출 없이 `expired`.
- 오류 분류는 `classifyVerifyError`: 401·403 → `auth_failed`, fetch 실패·타임아웃 → `unreachable`, 모르는 id → `unknown`.
- IPC 층(`settings.ipc.ts`)은 비밀값을 직접 다루지 않고 서비스의 `verifyStored*` 함수만 부른다.

추가 필드: `JiraConnectionStatus.email: string | null`. Bitbucket 팝업에 이메일을 미리 채우는 데 쓴다. 토큰은 계속 반환하지 않는다.

## 기존 설정 UI 처리

| 기존 | 처리 |
|---|---|
| AI 대화의 Notion·Bitbucket 모달 | 삭제. 버튼은 상태 점과 라벨만 남기고 설정 > 연동으로 이동 |
| AI 대화의 모델·모드 select, Claude 사용 불가 배너 | 유지 |
| `calendar/CalendarSettings.tsx` | 삭제. 미연결 빈 상태 카드와 `GoogleCalendarConnectDialog` 로 대체 |
| `project/JiraSettingsModal.tsx` | `JiraConnectDialog` 를 띄우는 얇은 래퍼. 연결돼 있으면 팝업 안에 `JiraDefaultProjectSelect` 와 [연결 해제]가 함께 나온다. props 는 그대로라 호출부 3곳은 바뀌지 않음 |
| `project/JiraTokenWarning.tsx` | 유지, 문구 끝에 [설정 열기] |
| `today/AssistantSettingsModal.tsx` | 삭제. 순수 헬퍼는 `settings/assistantSettingsForm.ts` 로 옮김 |
| 사이드바 "데이터 백업 · 복원" | 삭제. 설정 > 데이터로 옮김 |
| 녹음 화면의 용어집·구성원 패널 | 유지(설정에도 같은 컴포넌트) |

## 알려진 한계

- safeStorage 를 쓸 수 없으면 경고 없이 평문으로 저장한다(`notion.ts`, `bitbucket.ts`, `jira.ts`, `google-auth.ts`). 지금은 안내 문구만 있고 경고 표시는 후속 과제다.
- 복호화에 실패하면 암호문을 그대로 자격 증명으로 보내 401 이 난다. [연결 테스트] 가 `auth_failed` 로 드러내고 [다시 연결] 로 안내한다.
- 백업은 토큰을 지우고 `bitbucket_email`, `jira_email` 은 남긴다. 복원 뒤 카드는 "연결 안 됨"이 되고 팝업에 이메일이 미리 채워진다.
