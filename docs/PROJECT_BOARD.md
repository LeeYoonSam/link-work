# 프로젝트 보드 (Jira 티켓 계층 보드)

사이드바 **프로젝트** 메뉴(ViewId `projects`)는 기본 Jira 프로젝트의 티켓을 에픽 → 작업 → 하위 작업
계층으로 보여 준다. 읽기 전용이다. 편집, LinkWork DB 쓰기, 자동 AI 생성은 없다.

이전의 로컬 프로젝트·WBS 작업·일정 타임라인·Jira 프로젝트 싱크업은 모두 없앴다.
`projects`·`tasks` 테이블과 다른 테이블의 `project_id` 컬럼은 남아 있다. 백업 그룹과 과거 기록 때문이다.
이 기능은 그 테이블을 읽지도 쓰지도 않는다.

- 관련 문서: [RELEASE_NOTES.md](RELEASE_NOTES.md) (Jira 인증·`/search/jql`·페이지네이션 §2),
  [SETTINGS.md](SETTINGS.md) (Jira 연결·기본 프로젝트), [AI_GUARDRAILS.md](AI_GUARDRAILS.md) (헤드리스 AI 호출)

## 1. 범위

| 항목 | 결정 |
|---|---|
| 대상 프로젝트 | 기본 Jira 프로젝트(`jira_default_project_key`) 하나 |
| 보이는 티켓 | '할 일' 이상 상태(백로그 제외)의 열린 티켓, 최근 14일 안에 완료된 티켓, 그리고 그 조상 |
| 데이터 방향 | Jira → 화면 단방향. Jira 는 GET 만 한다. LinkWork DB 에 쓰지 않는다 |
| 편집 | 없음. 이슈를 바꾸려면 [Jira에서 열기]로 Jira 에서 한다 |
| AI 요약 | 에픽 상세 패널의 버튼을 눌렀을 때만 만든다. 결과는 main 메모리에만 둔다 |

## 2. 조회 규칙 (`src/main/services/jira-board.ts`)

미연결이면 `code: 'not_connected'`, 기본 프로젝트가 없으면 `code: 'no_default_project'` 로 실패를 돌려준다.

1. **열린 이슈**: `project = <KEY> AND statusCategory != Done ORDER BY key DESC`
2. **최근 완료**: `project = <KEY> AND statusCategory = Done AND resolved >= -14d ORDER BY resolved DESC`.
   이 조회가 실패해도 전체를 실패시키지 않는다. 빈 목록으로 두고 계속한다.
3. **자식 보강**(롤업용): 1·2 에서 나온 inScope 에픽의 직계 자식을 `parent in (…)` 로, inScope 표준 이슈
   (보강으로 들어온 것 포함)의 하위 작업을 `parent in (…)` 로 가져온다. 키는 50개씩 나눈다.
4. **조상 보강**: `parentKey` 가 결과에 없는 이슈의 부모를 `key in (…)` 로 가져온다. 최대 2회 반복한다
   (하위 작업 → 작업 → 에픽).
5. **`inScope` 판정**: `statusCategory` 가 `new` 이고 상태 이름이 백로그 이름 집합(`백로그`, `Backlog`.
   대소문자·공백 무시)에 들면 false, 그 밖은 true 다.
6. 검색마다 500건 상한(`jira.ts` 의 `MAX_SEARCH_ISSUES`). 하나라도 걸리면 `truncated: true`.
   같은 키는 처음 들어온 것만 남긴다. 형식이 틀린 키는 받지 않는다(다음 JQL 에 들어갈 수 없다).
   내 계정 ID 조회가 실패하면 `myAccountId` 를 null 로 두고 보드는 그대로 보여 준다.
7. `fields`: `summary,status,issuetype,priority,parent,assignee,duedate,updated,resolutiondate,labels,description`.
   설명은 ADF 를 평문으로 바꿔(`jira-adf.ts` 의 `adfToPlainText`) 최대 600자로 자른다.
8. 결과는 main 메모리에 5분 캐시한다. 진행 중인 요청은 합친다. `force=true` 면 캐시를 무시한다.
   Jira 자격 증명이나 기본 프로젝트가 바뀌면 `clearJiraBoardCache()` 로 비운다.
9. 수집 로직은 Jira 호출 함수를 주입받는다. 그래서 네트워크 없이 단위 테스트한다.

### 2.1 이렇게 정한 이유

- **상태 이름을 JQL 에 넣지 않는다.** 화면의 `할 일` 은 번역된 표시 이름이고 원래 이름은 `Open` 이다.
  `status = "할 일"` 은 오류 없이 0건을 돌려준다(실제 16건일 때 0건이 나온 적이 있다).
  JQL 은 번역과 무관한 `statusCategory` 로 넓게 조회하고, 응답의 `status.name` 으로 백로그만 거른다.
  카테고리만으로는 가를 수 없다. 백로그와 할 일이 같은 `new` 카테고리다.
- **화이트리스트가 아니라 백로그 블랙리스트다.** 워크플로마다 '할 일' 계열 이름이 다르다.
  허용 이름을 나열하면 모르는 이름의 티켓이 조용히 빠진다.
- **`/rest/api/3/search/jql` 커서 페이지네이션만 쓴다.** 구 `/rest/api/3/search` 는 제거됐다(410).
- **JQL 에 넣는 키는 삽입 직전에 정규식으로 검증한다.** 프로젝트 키 `/^[A-Z][A-Z0-9_]*$/`,
  이슈 키 `/^[A-Z][A-Z0-9_]*-\d+$/`. 저장된 값이나 응답의 키도 예외가 아니다.
- **자식·조상 보강을 따로 한다.** 백로그 상태 에픽 아래의 '할 일' 작업은 1번 조회에 나오지만 부모는
  범위 밖이다. 부모를 가져와야 트리가 끊기지 않는다. 롤업 분모를 맞추려면 범위 안 에픽의 자식도 필요하다.

## 3. 타입·IPC 계약

main 은 `src/main/services/jira-board.ts` 에서 export 하고, renderer 는 `src/renderer/src/types/index.ts` 에
같은 모양으로 미러한다. 한쪽만 바꾸면 보드가 조용히 빈 값을 그린다.

```ts
type JiraIssueLevel = 'epic' | 'standard' | 'subtask'
type JiraStatusCategory = 'new' | 'indeterminate' | 'done'

interface JiraBoardIssue {
  key: string
  summary: string
  issueType: string            // Jira 표시 이름 (에픽, 작업, 버그, 하위 작업 …)
  level: JiraIssueLevel
  status: string               // 세부 상태 이름 (표시용)
  statusCategory: JiraStatusCategory
  inScope: boolean             // '할 일' 이상인가. false = 백로그
  priority: string | null
  parentKey: string | null
  parentSummary: string | null
  assigneeAccountId: string | null
  assigneeName: string | null
  duedate: string | null       // YYYY-MM-DD
  updated: string              // ISO
  resolvedAt: string | null    // resolutiondate
  labels: string[]
  excerpt: string | null       // 설명 평문 발췌, 최대 600자
}

interface JiraBoardSnapshot {
  projectKey: string
  myAccountId: string | null
  issues: JiraBoardIssue[]     // 키 중복 없음
  truncated: boolean
  recentDoneDays: number       // 최근 완료로 포함한 기간(일)
  fetchedAt: string            // ISO
}

interface JiraEpicAiSummary {
  epicKey: string
  headline: string             // 한 문장
  bullets: string[]            // 2~4개: 진행 상황·남은 일·위험
  generatedAt: string          // ISO
}
```

IPC 는 throw 하지 않고 `{ success, … }` 로 감싼다.

| 채널 | preload | 응답 |
|---|---|---|
| `jiraBoard:fetch` | `window.api.jiraBoard.fetch(force?)` | `{ success: true, snapshot }` 또는 `{ success: false, error, code?: 'not_connected' \| 'no_default_project' }` |
| `jiraBoard:summarizeEpic` | `window.api.jiraBoard.summarizeEpic(epicKey)` | `{ success: true, summary }` 또는 `{ success: false, error }` |

- 이슈 열기는 기존 `window.api.jira.openIssue(key)` 를 쓴다.
- "설정에서 연결" 버튼은 설정 화면으로 이동한다(navigationStore 의 `setView('settings')`).

### 3.1 에픽 AI 요약 (`jiraBoard:summarizeEpic`)

- 캐시된 스냅샷에서 에픽과 자손(키·제목·상태·담당·기한·발췌)을 모아 `runHeadlessJson`(`ai-headless.ts`)으로
  `{ headline, bullets }` 를 받는다. 모델은 sonnet(`resolveAiModelId('sonnet')`), 타임아웃은 60초다.
  프롬프트에 넣는 자손은 최대 150건, 자손 발췌는 200자까지다. 응답의 bullets 는 4개까지만 쓴다.
- 스냅샷에 없는 키, 에픽이 아닌 키는 오류다. 이슈 키는 정규식으로 검증한다.
- 결과는 `epicKey` 와 자손 상태 지문으로 main 메모리에 캐시한다. 자손 상태가 바뀌면 다시 만든다.
- 도구 권한을 주지 않는다(JSON 응답만). DB 에 쓰지 않는다.

## 4. 화면

화면 루트는 `src/renderer/src/components/project/ProjectBoardView.tsx` 다. 순수 계산(트리 구성, 롤업, 필터,
정렬, 보이는 행 평탄화, 키보드 포커스 이동, 요약 타일, 우선순위 표기)은 같은 폴더의 `boardModel.ts` 에 두고,
상태는 `stores/jiraBoardStore.ts` 가 들고 있다.

구조는 위에서 아래로 다음과 같다.

1. 요약 타일
2. 툴바: 검색, 상태·유형 필터, 내 담당만, 완료 숨김, 정렬, 모두 펼치기/접기, 새로고침과 마지막 동기화 시각
3. 에픽 그룹 트리(에픽 → 자식 → 하위 작업)와 오른쪽 상세 패널. 창이 좁으면 상세를 선택한 행 아래에 펼친다

### 4.1 표시 규칙

- `inScope` 이슈와 그 조상만 그린다. `inScope=false` 인 잎(백로그 자식)은 숨기고, 에픽 메타에 "백로그 n건"으로만 센다.
- 조상이 `inScope=false` 면 상태 배지를 흐리게 그린다.
- 에픽 롤업: 분모는 inScope 직계 자식 수, 분자는 `done` 직계 자식 수다. 하위 작업은 세지 않는다.
  3구간 막대에 숫자 텍스트를 붙인다. 색에만 의존하지 않는다.
- 상태 색은 `statusCategory` 로 정하고, 배지 글자는 세부 상태 이름이다. 리뷰와 QA 는 카테고리가 같아 이름으로만 구분된다.
- "내 담당만"은 기본으로 켜져 있다. 켜져 있어도 일치 항목의 조상은 흐리게 남긴다.
- 상세 패널: 메타, 설명 발췌, 하위 목록, [Jira에서 열기]. 에픽이면 [AI 요약] 버튼이 있고, 결과에 "AI 요약 · 시각"을 붙인다.

### 4.2 상태별 화면

| 상태 | 화면 |
|---|---|
| Jira 미연결 | 안내와 [설정에서 연결] |
| 기본 프로젝트 미설정 | 안내와 [설정에서 연결] |
| 첫 로딩 | 불러오는 중 안내. 다시 조회할 때는 기존 목록을 유지한다 |
| 오류 | 상단 배너와 [다시 시도]. 이전 결과가 있으면 유지한다 |
| 0건 | 할 일 이상 상태의 티켓이 없다는 안내 |
| 필터 0건 | 조건에 맞는 티켓이 없다는 안내와 필터 지우기 |
| truncated | 목록 위에 일부만 가져왔다는 안내 |

## 5. 가드레일

- **Jira 는 GET 만.** 새 코드는 `jira.ts` 의 요청 함수를 거치고 `fetch` 를 직접 부르지 않는다.
  확인: `grep -n "method:" src/main/services/jira.ts` 가 전부 `'GET'`,
  `grep -n "fetch(" src/main/services/jira-board.ts src/main/ipc/jira-board.ipc.ts` 가 0줄.
- **DB 에 쓰지 않는다.** 스냅샷과 AI 요약은 main 메모리 캐시뿐이다.
- **AI 요약은 버튼으로만.** 보드를 열거나 새로고침할 때 자동으로 만들지 않는다.
  Jira 에서 온 제목·설명은 신뢰할 수 없는 입력이라 요약 호출에 도구 권한을 주지 않는다.

## 6. 아침 자동 동기화와의 관계

아침 자동 동기화는 이제 릴리스 파트만 돈다(`MORNING_SYNC_PARTS = ['release']`). 상태 조회는
`morningSync:status`(`window.api.morningSync.status()`)다. 옛 `morning_sync` 이벤트 payload 에 남은
`project` 파트는 무시한다. 프로젝트 보드는 자동 동기화를 쓰지 않고, 화면을 열 때와 새로고침할 때 조회한다.

## 7. 테스트 위치

| 파일 | 다루는 것 |
|---|---|
| `src/main/services/jira-board.test.ts` | 조회 규칙(JQL·보강·inScope·상한·캐시). Jira 호출 함수를 주입해 네트워크 없이 돈다 |
| `src/main/ipc/jira-board.ipc.test.ts` | IPC 인자 전달(`force` 는 true 일 때만, 에픽 키는 서비스 검증으로) |
| `src/main/services/jira-adf.test.ts` | ADF → 평문 변환 |
| `src/renderer/src/components/project/boardModel.test.ts` | 트리 구성, 롤업, 필터, 정렬, 평탄화, 키보드 이동, 요약 타일, 우선순위 표기 |
| `src/renderer/src/stores/jiraBoardStore.test.ts` | load(강제·중복 방지·늦은 응답·오류 코드), AI 요약 상태, 필터·펼침·선택과 localStorage |
| `src/renderer/src/components/project/ProjectBoardView.test.tsx` | 상태별 화면(§4.2), 트리의 펼침·aria·백로그 숨김·roving tabindex |
