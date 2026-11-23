# 프로젝트 화면 (Jira 티켓·릴리스·문서)

사이드바 **프로젝트** 메뉴(ViewId `projects`)는 기본 Jira 프로젝트를 탭 3개로 보여 준다(§6).

- **티켓** 탭(이 문서의 중심, "프로젝트 보드"): 티켓을 에픽 → 작업 → 하위 작업 계층으로 보여 준다.
- **릴리스** 탭: 릴리스 노트다. 규칙은 [RELEASE_NOTES.md](RELEASE_NOTES.md) 를 따른다.
- **문서** 탭: 티켓에 연결된 웹링크·첨부·본문 링크·연결 이슈를 모아 보여 준다(§2.2).

릴리스와 문서는 사이드바 메뉴가 아니라 이 화면의 탭이다. 로컬 `documents` 테이블은 이 화면이 읽지 않는다.

모두 읽기 전용이다. Jira 이슈 편집과 자동 AI 생성은 없다.
가져온 티켓은 로컬 DB 의 보드 캐시 테이블 2개에 저장한다. 에픽 AI 요약은 세 번째 테이블 `jira_epic_summaries` 에 저장한다. 화면을 열면 저장본을 먼저 보여 주고,
이어서 Jira 에서 바뀐 티켓만 받아 갱신한다.

`projects`·`tasks` 테이블과 다른 테이블의 `project_id` 컬럼은 백업 그룹과 과거 기록 때문에 남아 있다.
이 기능은 그 테이블을 읽지도 쓰지도 않는다.

- 관련 문서: [RELEASE_NOTES.md](RELEASE_NOTES.md) (Jira 인증·`/search/jql`·페이지네이션 §2),
  [SETTINGS.md](SETTINGS.md) (Jira 연결·기본 프로젝트), [AI_GUARDRAILS.md](AI_GUARDRAILS.md) (헤드리스 AI 호출)

## 1. 범위

| 항목 | 결정 |
|---|---|
| 대상 프로젝트 | 기본 Jira 프로젝트(`jira_default_project_key`) 하나 |
| 보이는 티켓 | '할 일' 이상 상태(백로그 제외)의 열린 티켓, 최근 14일 안에 완료된 티켓, 그리고 그 조상 |
| 데이터 방향 | Jira → 로컬 캐시 → 화면 단방향. Jira 는 GET 만 한다. DB 는 보드 테이블 3개(캐시 2개 + 에픽 AI 요약, §3)에만 쓴다 |
| 편집 | 없음. 이슈를 바꾸려면 [Jira에서 열기]로 Jira 에서 한다 |
| AI 요약 | 에픽 상세 패널의 버튼을 눌렀을 때만 만든다. 결과는 로컬 DB `jira_epic_summaries` 에 에픽당 1행으로 저장한다(§5.1). Jira 에 되쓰지 않는다 |
| AI 대화 | 상세 패널의 [AI 대화로 열기]가 티켓 키만 담은 질문으로 새 AI 대화를 연다(§6.2) |
| 연결 문서 | 동기화 때 모아 `JiraBoardIssue.links` 로 저장한다(§2.2). 첨부는 목록만 보여 주고 브라우저로 연다. 앱에서 내려받지 않는다 |
| 저장 | 받은 티켓은 `jira_board_issues`·`jira_board_sync` 에 저장한다. Jira 에서 다시 받을 수 있는 캐시라 백업하지 않는다 |

## 2. 전체 수집 규칙 (`src/main/services/jira-board.ts`)

`full` 동기화(§4)가 이 규칙으로 스냅샷 전체를 모은다.

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
7. `fields`: `summary,status,issuetype,priority,parent,assignee,duedate,updated,resolutiondate,labels,description,attachment,issuelinks,fixVersions`.
   설명은 ADF 를 평문으로 바꿔(`jira-adf.ts` 의 `adfToPlainText`) 최대 600자로 자른다.
8. 결과는 로컬 DB 에 저장한다(§3). 메모리 TTL 캐시는 없다. 진행 중인 요청은 합친다.
9. 수집 로직은 Jira 호출 함수를 주입받는다. 그래서 네트워크 없이 단위 테스트한다.

### 2.1 이렇게 정한 이유

- **상태 이름을 JQL 에 넣지 않는다.** 화면의 `할 일` 은 번역된 표시 이름이고 원래 이름은 `Open` 이다.
  `status = "할 일"` 은 오류 없이 0건을 돌려준다.
  JQL 은 번역과 무관한 `statusCategory` 로 넓게 조회하고, 응답의 `status.name` 으로 백로그만 거른다.
  카테고리만으로는 가를 수 없다. 백로그와 할 일이 같은 `new` 카테고리다.
- **화이트리스트가 아니라 백로그 블랙리스트다.** 워크플로마다 '할 일' 계열 이름이 다르다.
  허용 이름을 나열하면 모르는 이름의 티켓이 조용히 빠진다.
- **`/rest/api/3/search/jql` 커서 페이지네이션만 쓴다.** 구 `/rest/api/3/search` 는 제거됐다(410).
- **JQL 에 넣는 키는 삽입 직전에 정규식으로 검증한다.** 프로젝트 키 `/^[A-Z][A-Z0-9_]*$/`,
  이슈 키 `/^[A-Z][A-Z0-9_]*-\d+$/`. 저장된 값이나 응답의 키도 예외가 아니다.
- **자식·조상 보강을 따로 한다.** 백로그 상태 에픽 아래의 '할 일' 작업은 1번 조회에 나오지만 부모는
  범위 밖이다. 부모를 가져와야 트리가 끊기지 않는다. 롤업 분모를 맞추려면 범위 안 에픽의 자식도 필요하다.

### 2.2 연결 문서 수집 (`links`)

동기화 때 모은다. 문서 탭이 한 번에 모아 보여 줘야 하기 때문이다. 조립은 `jira-board.ts` 의
`searchLinksOf`(검색 응답에서 바로 나오는 3종)와 `attachWebLinks`(웹링크)가 한다.

| 종류(`kind`) | 출처 | `title` | `source` |
|---|---|---|---|
| `web` | 웹링크(remotelink). `jira.ts` 의 `listRemoteLinks` 가 `GET /rest/api/3/issue/{key}/remotelink` 를 부른다 | 웹링크 제목. 없으면 URL | `linkSourceOf(url)` |
| `attachment` | 검색 응답의 `attachment`. url 은 첨부 content URL. mimeType·크기·생성 시각을 둔다 | 파일 이름 | `'첨부'` |
| `description` | 설명 ADF 안의 링크(`jira-adf.ts` 의 `extractAdfLinks`). 링크 mark, inline·block·embed 카드, 맨 URL 텍스트 | 링크 텍스트. 비었거나 URL 이면 추정 이름 | `linkSourceOf(url)` |
| `issue` | 검색 응답의 `issuelinks`. url 은 그 이슈의 Jira browse URL. 관계 이름·상대 이슈 키·상태를 둔다 | `KEY 요약`(요약이 없으면 `KEY`) | `'Jira'` |

- `linkSourceOf(url)` 은 `guessLinkName` 규칙(Notion 문서, Figma, Google 문서, Confluence, 그 밖은 호스트명)을 쓰되,
  Jira 이슈 URL 은 키와 무관하게 `'Jira'` 로 묶는다. 출처 필터가 이슈 키마다 갈리지 않게 하기 위해서다.
- `mergeLinks` 가 http(s) URL 만 남기고 같은 이슈 안의 같은 URL 은 처음 것만 남긴다. 순서는 web → attachment → description → issue 다.
  그래서 본문 링크와 연결 이슈가 같은 URL 이면 본문 링크가 남는다.
- **웹링크 대상**(`isWebLinkTarget`): inScope 인 에픽·표준 이슈만(하위 작업 제외). 에픽을 먼저 세워
  한 번의 동기화에서 최대 `WEB_LINK_MAX_ISSUES`(150)건, 동시 `WEB_LINK_CONCURRENCY`(4)건을 묻는다.
- 이슈별 웹링크 조회 실패는 무시한다. 전체·증분 모두 조회가 실패했거나 상한 밖인 이슈는 저장된 웹링크를 유지한다
  (저장본을 `attachWebLinks` 의 fallback 으로 넘긴다). 저장된 것도 없으면 빈 목록이다.
  - 전체 동기화: 대상 전부를 다시 묻는다.
  - 증분 동기화: 이번에 바뀐 이슈만 다시 묻는다. 바뀌지 않은 이슈는 저장본을 그대로 쓴다.
- 옛 저장 행(JSON 에 `links`·`fixVersions` 가 없음)은 읽을 때 빈 배열로 채우고 옛 행으로 센다(`parseStoredIssueRow`).
  그런 행이 하나라도 있으면 다음 `auto` 동기화가 `full` 로 돈다. 한 번이면 채워진다.

## 3. 저장 구조

```sql
CREATE TABLE IF NOT EXISTS jira_board_issues (
  project_key TEXT NOT NULL,      -- 보드 기준 프로젝트(기본 Jira 프로젝트 키)
  issue_key   TEXT NOT NULL,
  data        TEXT NOT NULL,      -- JiraBoardIssue JSON
  updated     TEXT NOT NULL,      -- Jira updated (ISO)
  synced_at   TEXT NOT NULL,      -- 이 행을 마지막으로 Jira 에서 받은 시각 (ISO)
  PRIMARY KEY (project_key, issue_key)
);
CREATE TABLE IF NOT EXISTS jira_board_sync (
  project_key        TEXT PRIMARY KEY,
  my_account_id      TEXT,
  last_full_sync_at  TEXT,         -- 마지막 전체 동기화 시작 시각 (ISO)
  last_sync_at       TEXT,         -- 마지막 동기화(전체·증분) 시작 시각 (ISO). 증분 기준점
  truncated          INTEGER NOT NULL DEFAULT 0,
  recent_done_days   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jira_epic_summaries (
  project_key   TEXT NOT NULL,
  epic_key      TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,     -- 날짜 + 에픽·자손 상태 지문의 SHA-256
  data          TEXT NOT NULL,     -- JiraEpicAiSummary JSON
  generated_at  TEXT NOT NULL,     -- 요약을 만든 시각 (ISO)
  PRIMARY KEY (project_key, epic_key)
);
```

- 저장·읽기는 `src/main/services/jira-board-store.ts` 가 한다. DB 핸들을 주입받는다.
  읽기 `readStoredBoard`, 전체 교체 `replaceStoredBoard`, 증분 upsert `upsertStoredIssues`, 비우기 `clearStoredBoards`(세 테이블 전부).
  에픽 요약은 `readEpicSummary`·`writeEpicSummary` 다. 사라진 에픽의 요약 삭제는 `replaceStoredBoard` 안에서 한다.
  `jira-board.ts` 는 이 함수들을 `JiraBoardStorePort` 로 주입받아 테스트에서 바꿔 끼운다.
- 행은 `project_key` 로 나뉜다. 기본 프로젝트를 바꿔도 다른 프로젝트의 행과 섞이지 않는다.
- `data` JSON 이 깨졌거나 모양이 틀린 행은 버리고 계속한다. throw 하지 않는다.
- 스냅샷은 저장 행으로 조립한다. `fetchedAt` 은 `last_sync_at`, `lastFullSyncAt` 은 `last_full_sync_at` 이다.
  `inScope` 같은 파생 값은 저장된 JSON 을 그대로 쓴다. 상태가 바뀐 이슈는 증분에서 새 JSON 으로 덮인다.
- `jira_epic_summaries` 는 전체 동기화의 이슈 교체와 따로 둔다. 교체 때 지워지지 않는다. 대신 `replaceStoredBoard` 가 같은 트랜잭션에서 보드에서 사라진 에픽의 요약을 지운다.
- 세 테이블은 백업 대상이 아니다(`backup-groups.ts` 의 `NON_GROUP_TABLES`, `CACHE_TABLES`). 백업 사본에서는 행을 지운다(`backup-service.ts` 의 `stripCaches`).
  복원으로 Jira 계정(사이트·이메일)이 바뀌면 현재 캐시도 함께 지운다(`CREDENTIAL_BUNDLES` 의 jira `credentialTables`). 캐시가 비면 다음 화면 진입 때 전체 동기화가 돈다.

## 4. 동기화

| 모드 | 하는 일 |
|---|---|
| `full` | §2 전체 수집을 돌리고, 그 프로젝트의 저장 행을 결과로 **교체**한다(결과에 없는 행 삭제). `last_full_sync_at`·`last_sync_at` 갱신 |
| `incremental` | `project = <KEY> AND updated >= "-<N>m" ORDER BY updated DESC`(`jira.ts` 의 `listUpdatedProjectIssues`)로 바뀐 이슈만 받아 저장 행에 **upsert** 한다. `last_sync_at` 갱신 |
| `auto` | 아래 규칙으로 full / incremental / 생략을 고른다. preload `fetch()` 의 기본값이다 |

**증분 기준.** `N = ceil((지금 − last_sync_at) / 1분) + INCREMENTAL_MARGIN_MIN(10)`. N 은 1 이상 `MAX_UPDATED_MINUTES`(7일 + 10분) 이하로 자른다.
`jira.ts` 가 N 이 정수이고 범위 안인지 검증한 뒤 JQL 에 넣는다.
기준 시각은 동기화 **시작** 시각이다.

**증분에서 저장할 이슈.** 바뀐 이슈 중 다음 하나에 드는 것만 저장한다.

1. 이미 저장돼 있다.
2. 전체 수집 기준에 든다. statusCategory 가 Done 이 아니거나, Done 이고 완료 시각이 `recentDoneDays` 일 이내다.
3. 부모가 저장돼 있거나 이번에 받아들인 이슈다(에픽의 자식, 작업의 하위 작업). 받아들인 이슈가 다시 부모가 될 수 있어 더 늘지 않을 때까지 반복한다.

그 밖(오래전 완료된 무관한 이슈가 댓글 등으로 `updated` 만 바뀐 경우)은 버린다.
새로 들어온 이슈의 부모가 저장돼 있지 않으면 §2 의 조상 보강을 쓴다. 새로 들어온 에픽·작업에 한해 자식 보강도 돈다.

**증분이 전체로 넘어가는 경우.**

- 저장된 것이 없다. 동기화 기록(`jira_board_sync` 행) 유무로 본다. 이슈가 0건인 프로젝트도 기록이 있으면 저장본이 있는 것이라 cache·증분으로 돈다.
  단 저장 행이 모두 깨져 읽은 이슈가 0건이면(`brokenRows`) 쓸 저장본이 없으니 전체로 받는다.
- `last_sync_at` 이 없거나 7일(`INCREMENTAL_MAX_AGE_MS`)보다 오래됐다.
- `last_sync_at` 이 미래다. 시계가 뒤로 간 것이라 조회 기간을 믿을 수 없다.
- 증분 조회가 상한(500건)에 걸렸다.

증분 조회가 **실패**하면 전체로 넘어가지 않고 오류를 돌려준다. 저장 데이터는 그대로 둔다.

**auto 규칙.** 위에서부터 처음 맞는 줄을 쓴다.

| 조건 | 결과 |
|---|---|
| 저장된 것이 없다(동기화 기록 없음, 또는 저장 행이 전부 깨짐) | full |
| `last_full_sync_at` 이 없거나 24시간(`AUTO_FULL_MS`) 이상 지났다 | full |
| `links`·`fixVersions` 가 없는 옛 행이 있다 | full (§2.2) |
| `last_sync_at` 이 60초(`AUTO_SKIP_MS`) 안이다 | Jira 를 부르지 않고 저장본을 돌려준다(`mode: 'cache'`) |
| `last_sync_at` 이 없거나, 미래거나, 7일보다 오래됐다 | full |
| 그 밖 | incremental |

`incremental` 을 직접 요청해도 앞의 "저장된 것이 없다"와 마지막 줄(없음·미래·7일) 조건이면 full 로 돈다. 결과의 `sync.mode` 는 실제로 돈 방식이다.

진행 중인 동기화는 프로젝트 키별로 공유한다. auto·incremental 요청은 진행 중인 요청을 방식과 관계없이 같이 기다린다.
full 요청은 진행 중인 것도 full 일 때만 같이 기다린다. auto·incremental 이 도는 중에 들어온 full 요청은 버리지 않고, 그 실행이 끝난 뒤(실패해도) 이어서 전체를 돌린다.
이때 세대는 요청 시점 것을 써서, 기다리는 사이 비우기가 있었으면 결과를 저장하지 않는다.

**비우기.** `clearJiraBoardCache()` 는 세 테이블(`jira_board_issues`·`jira_board_sync`·`jira_epic_summaries`)의 모든 행을 지우고, 진행 중인 요약 요청 표도 비운다. 세대(generation)를 올려, 비우기 전에 시작된 동기화는 결과를 저장하지 않는다.
부르는 곳은 `release-note.ipc.ts` 두 곳이다.

- `jira:saveCredentials`: 자격 증명 **저장이 성공한 뒤**. 실패하면 기존 자격 증명이 그대로라 저장본도 유효하다.
- `jira:disconnect`: 연결 해제 때.

기본 프로젝트만 바꿀 때(`jira:setDefaultProject`)는 지우지 않는다. 행이 `project_key` 로 나뉘고 같은 계정의 데이터다.

### 4.1 이렇게 정한 이유

- **증분 기준에 날짜 리터럴 대신 상대 시간(`-<N>m`)을 쓴다.** JQL 의 날짜 리터럴은 Jira 사용자 프로필
  시간대로 해석돼 로컬 시각과 어긋난다.
- **기준을 동기화 시작 시각으로 잡고 10분 여유를 둔다.** 동기화가 도는 동안 바뀐 이슈와 시계 차이를 놓치지 않는다.
  겹쳐 받은 이슈는 upsert 라 해가 없다.
- **하루 한 번은 전체로 정리한다.** 삭제·이동되거나 범위 밖으로 나간 이슈는 `updated` 검색에 나오지 않는다.
  증분만으로는 저장본에서 지울 수 없다.
- **60초 안 재진입은 Jira 를 부르지 않는다.** 화면에 다시 들어올 때마다 `load()` 가 돈다. 연속 진입이 Jira 호출로 이어지지 않게 한다.
- **증분 실패는 전체로 넘기지 않는다.** 네트워크·인증 문제라면 전체 수집도 실패한다. 저장본을 지키고 오류만 알린다.
- **계정이 바뀌면 전부 지운다.** 계정마다 볼 수 있는 이슈가 다르다. 다른 계정의 데이터가 남지 않게 한다.

## 5. 타입·IPC 계약

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
  fixVersions: { id: string; name: string }[]   // 릴리스 탭의 jira_version_id 와 대응
  links: JiraIssueLink[]       // §2.2. 이슈 안에서 url 중복 없음
}

type JiraIssueLinkKind = 'web' | 'attachment' | 'description' | 'issue'

interface JiraIssueLink {
  kind: JiraIssueLinkKind
  title: string
  url: string                  // http(s)
  source: string               // 출처 추정 라벨
  issueKey?: string            // kind === 'issue'
  relation?: string
  issueStatus?: string
  mimeType?: string | null     // kind === 'attachment'
  size?: number | null
  createdAt?: string | null
}

interface JiraBoardSnapshot {
  projectKey: string
  myAccountId: string | null
  issues: JiraBoardIssue[]     // 키 중복 없음
  truncated: boolean
  recentDoneDays: number       // 최근 완료로 포함한 기간(일)
  fetchedAt: string            // 마지막 동기화(전체·증분) 시작 시각. ISO
  lastFullSyncAt: string | null // 마지막 전체 동기화 시각. ISO
}

type JiraBoardSyncMode = 'auto' | 'incremental' | 'full'

interface JiraBoardSyncInfo {
  mode: 'full' | 'incremental' | 'cache'   // 실제로 돈 방식. cache = Jira 를 부르지 않음
  changed: number                          // 새로 저장하거나 덮어쓴 이슈 수. cache 면 0
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
| `jiraBoard:cached` | `window.api.jiraBoard.cached()` | `{ success: true, snapshot: JiraBoardSnapshot \| null }` 또는 `{ success: false, error, code? }`. DB 만 읽고 Jira 를 부르지 않는다. 미연결·기본 프로젝트 미설정이면 `fetch` 와 같은 `code` |
| `jiraBoard:fetch` | `window.api.jiraBoard.fetch(mode?)`. 기본 `'auto'` | `{ success: true, snapshot, sync: JiraBoardSyncInfo }` 또는 `{ success: false, error, code?: 'not_connected' \| 'no_default_project' }`. 모르는 mode 는 `잘못된 동기화 방식입니다.` 오류 |
| `jiraBoard:summarizeEpic` | `window.api.jiraBoard.summarizeEpic(epicKey)` | `{ success: true, summary }` 또는 `{ success: false, error }` |
| `jiraBoard:openLink` | `window.api.jiraBoard.openLink(url)` | http(s)이고 현재 기본 프로젝트의 저장 스냅샷에서 어떤 이슈 `links` 에 든 URL 일 때만 기본 브라우저로 연다. `jira-board.ipc.ts` 의 `openJiraBoardLink` 가 `utils/open-target.ts` 의 `resolveOpenTarget` 과 `isKnownJiraBoardLink` 로 확인한다. `{ success: true }` 또는 `{ success: false, error }` |

- 이슈 열기는 기존 `window.api.jira.openIssue(key)` 를 쓴다.
- "설정에서 연결" 버튼은 설정 화면으로 이동한다(navigationStore 의 `setView('settings')`).

### 5.1 에픽 AI 요약 (`jiraBoard:summarizeEpic`)

- 로컬 DB 에 저장된 스냅샷에서 에픽과 자손(키·제목·상태·담당·기한·발췌)을 모아 `runHeadlessJson`(`ai-headless.ts`)으로
  `{ headline, bullets }` 를 받는다. 모델은 sonnet(`resolveAiModelId('sonnet')`), 타임아웃은 60초다.
  프롬프트에 넣는 자손은 최대 150건, 자손 발췌는 200자까지다. 응답의 bullets 는 4개까지만 쓴다.
- 저장본을 읽으므로 앱을 다시 켠 직후에도 동작한다.
- 스냅샷에 없는 키, 에픽이 아닌 키는 오류다. 이슈 키는 정규식으로 검증한다.
- 호출은 헤드리스 LLM 직렬화 줄 `runLlmSerialized`(`ai-headless.ts`)를 거친다(`runEpicSummaryJson`). 회의 전 브리핑 같은 다른 헤드리스 작업이 도는 중이면 BUSY 로 실패하지 않고 끝나기를 기다렸다가 실행한다.
- 도구 권한을 주지 않는다(JSON 응답만). Jira 에 되쓰지 않는다. 입력은 로컬 스냅샷뿐이다.

저장 규칙은 다음과 같다.

| 규칙 | 내용 |
|---|---|
| 저장 위치 | `jira_epic_summaries`, 에픽당 1행(`project_key`, `epic_key` 기본 키). 다시 만들면 덮어쓴다 |
| 지문 | 오늘 날짜(앱 시계의 로컬 날짜, 프롬프트의 today 와 같은 값)와, 에픽과 자손의 `키:상태:담당 accountId:기한:제목` 줄을 정렬해 이은 문자열의 SHA-256 |
| 재사용 | 저장본의 지문이 지금 스냅샷의 지문과 같으면 LLM 을 부르지 않고 저장본을 돌려준다. 앱을 다시 켠 뒤에도 같다 |
| 다시 만들기 | 날짜가 바뀌거나, 자손의 상태·담당·기한·제목이 바뀌거나, 자손이 늘고 줄면 지문이 달라져 다시 만들고 같은 행을 덮어쓴다. 요약에 "기한 지남" 같은 날짜 의존 문장이 있어서 날짜를 지문에 넣는다. 우선순위·설명 발췌만 바뀌면 같은 날에는 저장본이 나온다 |
| 겹친 요청 | 같은 `프로젝트#에픽#지문` 의 요청이 진행 중이면 그 결과를 같이 기다린다. LLM 은 한 번만 부른다 |
| 상한 | 프로젝트당 50행(`MAX_STORED_EPIC_SUMMARIES`). 넘으면 `generated_at` 이 오래된 것부터 지운다 |
| 사라진 에픽 | 전체 동기화(`replaceStoredBoard`) 때 보드에 없는 에픽의 요약을 지운다 |
| 연동 해제·계정 변경 | `clearJiraBoardCache()` 가 전부 지운다. 기다리는 사이 비우기가 있었으면(세대가 바뀌었으면) 만든 요약을 저장하지 않는다 |
| 깨진 행 | JSON 이 깨졌거나 에픽 키가 다르면 없는 것으로 보고 다시 만든다 |
| 저장 실패 | 만든 요약은 그대로 보여 준다. 다음 버튼에서 다시 만든다 |
| 백업 | 캐시 테이블로 취급한다. 백업 사본에서 행을 지우고, 복원으로 Jira 계정이 바뀌면 지운다([DATA_BACKUP.md](DATA_BACKUP.md)) |

## 6. 화면

### 6.0 탭 구조

- 화면 루트는 `src/renderer/src/components/project/ProjectsPage.tsx` 다(default export, props 없음). 탭 바(티켓 / 릴리스 / 문서) 아래에 선택한 탭만 마운트한다.
  티켓 = `ProjectBoardView`, 릴리스 = `components/release/ReleasesView`, 문서 = `DocsTab`.
- 탭 바는 APG 탭 패턴을 따른다(`nextTabId`). ←/→ 는 순환 이동, Home/End 는 처음·끝 탭이다.
- 탭 상태는 `navigationStore` 의 `projectsTab`(`'tickets' | 'releases' | 'docs'`, 기본 `'tickets'`)이다.
  `openProjectsTab(tab)` 은 화면과 탭을 한 번의 set 으로 바꾼다. 링크 포커스 요청이 다른 탭에서 버려지지 않게 하기 위해서다.
  `setView` 는 탭을 건드리지 않아 마지막 탭을 기억한다.
- 링크: `linkwork://view/projects` 를 명시적으로 열면 티켓 탭이 열린다(옛 `linkwork://project/…` 도 같다). 사이드바로 메뉴에 들어올 때(`setView`)만 마지막 탭을 기억한다.
  옛 이름 별칭: `linkwork://view/releases` → 릴리스 탭, `view/documents`·`document/{id}` → 문서 탭, `release/{id}` → 릴리스 탭 + 그 릴리스 포커스.
- 새 릴리스 배지(아침 동기화)는 사이드바 프로젝트 메뉴(`Sidebar.tsx` 의 `MORNING_BADGE_PART`)와 릴리스 탭 라벨에 단다.
  본 처리(`markSeen('release')`)는 릴리스 탭이 열릴 때만 한다(`ProjectsPage` 의 `shouldMarkReleasesSeen`, `ReleasesView` 마운트). 티켓 탭만 보면 배지가 남는다.
- 티켓 탭과 문서 탭은 같은 보드 store(새로고침·마지막 동기화 표시)를 쓴다. `ProjectsPage` 가 마운트될 때 보드 `load()` 를 부른다. 릴리스 탭부터 열어도 티켓의 `fixVersions` 와 "보드에서 보기"가 쓸 저장본이 올라온다.

### 6.0.1 티켓 ↔ 릴리스

- 티켓 행과 상세 패널에 `fixVersions` 칩을 보인다. 칩을 누르면 `projectNav.ts` 의 `openReleaseForVersion` 이 릴리스 탭을 열고,
  릴리스 목록에서 `jira_version_id` 가 같은 릴리스를 찾아 `focusStore` 의 release 포커스를 요청한다. 목록에 없으면 릴리스 탭만 연다.
- 툴바 필터에 "릴리스"(등장한 fixVersion 이름 다중 선택, "릴리스 없음" 포함)가 있다.
- 릴리스 탭의 항목 행(`ReleaseNoteRow`)에서 "보드에서 보기"를 누르면 `jiraBoardStore.revealIssue(key)` 로 그 이슈를 선택·펼치고 티켓 탭으로 간다. 이슈가 보드 스냅샷에 없으면 이 동작을 숨긴다.
  - 이전 완료 잎이라 숨겨졌으면 '완료 모두 숨김'을 끄고 '이전 완료 보기'를 켠다. 필터에 가려졌으면 그 이슈를 가리는 조건만 푼다.
  - 푼 조건은 화면용 필터(`filter`)에만 적용한다. 저장용 필터(`savedFilter`)는 사용자가 직접 바꾼 키만 반영하고 localStorage 에는 이것만 저장한다.
    그래서 그 뒤 펼침·정렬을 바꿔 다시 저장해도 풀린 조건이 저장되지 않는다. 펼침은 저장한다.
  - 필터를 바꿨으면 티켓 탭 위에 안내 줄(`revealNotice`)을 띄운다. 예: "PROJ-3를 보여 주려고 '내 담당만' 조건을 풀었어요. 이번에만 적용돼요".

### 6.0.2 문서 탭

- 루트는 `DocsTab.tsx`, 순수 모델은 `docsModel.ts`(`buildDocsView`, `mergeLinks`, `matchesDoc`, `relatedDocs`, `isDocGroupOpen`)다.
- 티켓 트리의 그룹(에픽 → 티켓, 에픽 없음·범위 밖)을 그대로 받아, 보드에 보이는 이슈(inScope 와 그 조상)의 `links` 를 묶는다.
- 그룹 안에서 문서(웹링크·첨부·본문 링크)를 위에, 연결 이슈를 아래에 관계 이름 순으로 둔다. 연결 이슈가 많아도 문서가 묻히지 않게 하기 위해서다.
- 출처 라벨은 첨부면 `'첨부'`, 그 밖은 저장된 `source`(비면 `'기타'`)다.
- 행: 출처 아이콘·라벨, 제목, 종류 배지(웹링크/첨부/본문/연결 이슈), 연결 이슈면 관계와 상태, 출처 티켓 키 칩(누르면 티켓 탭의 그 이슈로 이동), 열기(`jiraBoard.openLink`).
- 같은 그룹 안에서 같은 URL 은 한 번만 보이고 "n개 티켓에서 연결"로 합친다.
- 필터: 검색(제목·URL·출처 티켓 키·그룹의 에픽 키), 종류, 출처, "내 담당만"(티켓 탭과 같은 값). 내 담당만이 켜지면 내 담당 티켓에서 온 링크만 남긴다.
- 출처 필터의 후보는 종류·출처 필터를 모두 빼고(검색·내 담당만은 적용) 등장한 라벨을 건수 많은 순으로 보인다. 하나를 고른 뒤에도 다른 출처를 더 고를 수 있게 하기 위해서다.
  이미 고른 출처는 검색에 가려져 0건이어도 후보에 남긴다. 해제할 체크박스가 사라지면 안 되기 때문이다.
- 상단 종류별 건수는 종류 필터를 빼고 센다. 종류 토글의 숫자가 "이 종류를 켜면 몇 건"이어야 해서다.
- 그룹 접기: 그룹 헤더 왼쪽 chevron 단추(`aria-expanded`)로 그룹을 접고 편다. 접으면 헤더(아이콘·에픽 키·제목·건수)만 남고 문서·연결 이슈 목록은 그리지 않는다.
  목록 위 "모두 접기"/"모두 펴기" 단추는 지금 보이는 그룹 전체에 적용한다. 보이는 그룹이 모두 접혀 있으면 "모두 펴기", 아니면 "모두 접기"로 보인다.
- 기본은 펼침이다. 접힘은 localStorage `linkwork.jiraBoard.prefs` 의 `docsCollapsed`(그룹 id → 접힘)에 저장되고 티켓 탭의 펼침과 따로 관리한다.
- 검색어가 있으면(공백만은 검색 아님) 저장된 접힘을 무시하고 모두 펼친다. 접힌 그룹 안의 검색 결과가 숨으면 안 되고, 상세 패널의 "문서 탭에서 모두 보기"가 검색어로 이 탭을 열기 때문이다.
  이때 그룹 단추와 모두 접기/펴기 단추는 막고 "검색 중에는 모두 펼쳐 보여요"를 안내한다. 종류·출처 필터만 있으면 접힘을 그대로 따른다.
- 0건이면 "연결된 문서가 없어요 — Jira 티켓에 웹링크를 추가하거나 본문에 링크를 넣으면 여기에 모여요".
- 티켓 상세 패널의 "관련 문서" 절은 그 이슈와 하위 목록의 `links` 를 보인다. 에픽·가상 그룹이면 보이는 자손 것까지 합쳐 URL 중복을 뺀다.
  최대 6건(`RELATED_LIMIT`)만 보이고 "문서 탭에서 모두 보기"는 그 키를 검색어로 문서 탭을 연다(`openDocsFor`). 에픽 키로 찾으면 그 에픽 그룹 전체가 나온다.

### 6.0.3 티켓 탭

티켓 탭의 루트는 `src/renderer/src/components/project/ProjectBoardView.tsx` 다. 순수 계산(트리 구성, 롤업, 필터,
정렬, 보이는 행 평탄화, 키보드 포커스 이동, 요약 타일, 우선순위 표기)은 같은 폴더의 `boardModel.ts` 에 두고,
상태는 `stores/jiraBoardStore.ts` 가 들고 있다.

구조는 위에서 아래로 다음과 같다.

1. 요약 타일
2. 툴바: 검색, 상태·유형 필터, 내 담당만, 완료 숨김, 정렬, 모두 펼치기/접기, 새로고침·전체 다시 받기와 마지막 동기화 시각
3. 에픽 그룹 트리(에픽 → 자식 → 하위 작업)와 오른쪽 상세 패널. 창이 좁으면 상세를 선택한 행 아래에 펼친다

### 6.1 불러오기와 동기화

- 화면을 열면 `cached()` 로 저장본을 먼저 그린다. 저장본이 있으면 첫 로딩 문구 없이 바로 보인다.
  이어서 `fetch('auto')` 결과로 바꾼다. 동기화 중에는 "갱신 중…"을 보인다.
- 동기화가 실패해도 저장본은 그대로 보이고 오류 배너만 뜬다.
- 새로고침 버튼은 `fetch('incremental')`, 그 옆 "동기화 옵션" 메뉴의 "전체 다시 받기"는 `fetch('full')` 이다(`BoardControls.tsx`). 티켓 탭과 문서 탭이 같이 쓴다.
- "전체 다시 받기"는 동기화 중에도 고를 수 있다. main 이 진행 중인 동기화 뒤에 전체를 이어 돌리고(§4), 끝날 때까지 "갱신 중…"이 남는다.
- 동기화 결과를 한 줄로 알린다(`boardModel.ts` 의 `syncResultText`). 실제로 돈 방식(`sync.mode`)을 말한다: "n건 갱신" / "변경 없음" / "전체 동기화". `mode: 'cache'` 면 알리지 않는다.
  "전체 다시 받기"를 요청했는데 전체가 돌지 않았으면 "… · 전체 다시 받기가 끝나지 않았어요. 다시 시도해 주세요"를 붙인다(store 의 `lastSyncRequested`).
- 마지막 동기화 시각의 툴팁에 마지막 전체 동기화 시각을 보인다.
- 펼침·선택 상태는 이슈 키 기준이라 스냅샷이 바뀌어도 유지된다.

### 6.2 표시 규칙

- `inScope` 이슈와 그 조상만 그린다. `inScope=false` 인 잎(백로그 자식)은 숨기고, 에픽 메타에 "백로그 n건"으로만 센다.
- 조상이 `inScope=false` 면 상태 배지를 흐리게 그린다.
- 에픽 롤업: 분모는 inScope 직계 자식 수, 분자는 `done` 직계 자식 수다. 하위 작업은 세지 않는다.
  3구간 막대에 숫자 텍스트를 붙인다. 색에만 의존하지 않는다.
- 상태 색은 `statusCategory` 로 정하고, 배지 글자는 세부 상태 이름이다. 리뷰와 QA 는 카테고리가 같아 이름으로만 구분된다.
- "내 담당만"은 기본으로 켜져 있다. 켜져 있어도 일치 항목의 조상은 흐리게 남긴다.
- 닫힌 항목(`statusCategory === 'done'`)은 묶음 행(`kind: 'fold'`)으로 모아 기본으로 접는다. 진행 중 작업과 섞여 헷갈리지 않게 하기 위해서다.
  - 닫힘 판정: 이슈 자신이 닫혔고 보이는 하위작업도 모두 닫혀야 닫힘 묶음 대상이다. 열린 하위작업을 가진 닫힌 티켓은 열린 쪽에 남는다 — 진행 중 하위작업이 묶음 속에 숨지 않게 한다.
  - 닫힌 상위 티켓: 에픽이 닫혔고 보이는 자식도 모두 닫힘 대상인 그룹이 열린 그룹과 섞여 있으면, 열린 그룹 뒤에 "닫힌 상위 티켓 n건" 섹션 행(level 1, id `CLOSED_SECTION_ID`)을 둔다. 펼치면 닫힌 그룹들이 level 1 로 이어지고, 그룹 자체는 접혀 있다.
  - 닫힘 묶음: 한 부모 아래에 닫힌 자식이 2개 이상이고 열린 자식이 1개 이상이면, 열린 자식 뒤에 "닫힘 n건" 행(자식과 같은 level, id `doneFoldId(부모 id)`)을 두고 닫힌 자식을 그 아래로 모은다.
  - 묶음 행은 선택 대상이 아니다. 행을 누르거나 Enter·→/← 를 누르면 펼침만 바뀌고 상세는 열리지 않는다. 펼침 상태는 다른 행처럼 `expanded` 에 묶음 id 로 저장한다.
  - 검색어, 상태 분류, 세부 상태, 유형, 릴리스 필터 중 하나라도 걸려 있으면 묶지 않는다(`shouldFoldDone`). 내 담당만·완료 모두 숨김·이전 완료 보기는 묶음을 유지한다. 찾으려고 거른 결과가 묶음 속에 숨으면 안 되기 때문이다.
  - "모두 펼치기/접기"는 묶음 행도 함께 펼치고 접는다. "보드에서 보기"는 조상을 펼친 뒤에도 그 이슈가 묶음 속에 숨어 있을 때만 감싼 묶음·섹션을 펼친다(보이는 이슈면 사용자가 접어 둔 묶음은 그대로 둔다).
  - 포커스된 행이 접힌 묶음 속으로 사라지면 그 이슈를 감싼 묶음 행 → 부모 → 조부모의 묶음 행 → 그룹 → 닫힌 상위 티켓 섹션 순으로 보이는 첫 행에 포커스를 옮긴다.
- 상세 패널: 메타, 설명 발췌, 하위 목록, [Jira에서 열기], [할 일로 만들기], [AI 대화로 열기]. 에픽이면 [AI 요약] 버튼이 있고, 결과에 "AI 요약 · 시각"을 붙인다.
- [할 일로 만들기]: `openIssueTodo` 가 할 일 빠른 추가 팝오버(`quickAddStore.open`)를 "[KEY] 요약" 과 출처 링크(티켓 웹 주소 `{siteUrl}/browse/{KEY}`)로 채워 연다. 할 일은 사용자가 팝오버에서 Enter 로 저장한다. 사이트 주소는 Jira 연결 상태(`releaseNoteStore.jiraStatus.siteUrl`)에서 읽고, 모르거나 https 가 아니면 버튼을 숨긴다.
- [AI 대화로 열기]: [Jira에서 열기] 옆에 있다. 누르면 `openIssueChat` 이 `aiChatStore.startChatWith(prompt, { writeMode: 'ask' })` 로 새 AI 대화를 열고 질문을 보낸다. 이 대화에서 AI 가 할 일·메모를 쓰려면 승인 카드를 거친다
  (AI 를 쓸 수 없으면 보내지 않고 AI 화면만 연다. [AI_CHAT_ARCHITECTURE.md](AI_CHAT_ARCHITECTURE.md) 6.1절).
  - 질문은 `aiChatPromptFor(key, isEpic)` 가 만든다. 에픽과 에픽 가상 그룹은 "Jira 에픽 {key} 와 하위 티켓의 현재 상태를 읽고, 내가 할 일의 일정 초안을 제안해줘. 할 일로 만들기 전에 먼저 초안을 보여줘." 이다. 그 밖의 티켓은 "Jira 티켓 {key} 의 내용과 최근 진행 상황을 읽고 정리해줘." 이다.
  - **질문에는 티켓 키만 넣는다.** 제목·설명은 넣지 않는다. 사용자 메시지에 Jira 원문을 넣으면 그 안의 지시문이 사용자 지시처럼 다뤄진다. 내용은 AI 가 Jira 도구로 읽는다(신뢰할 수 없는 입력으로 다뤄진다).

### 6.3 상태별 화면

| 상태 | 화면 |
|---|---|
| Jira 미연결 | 안내와 [설정에서 연결] |
| 기본 프로젝트 미설정 | 안내와 [설정에서 연결] |
| 첫 로딩 | 저장본이 없을 때만 불러오는 중 안내. 다시 조회할 때는 기존 목록을 유지한다 |
| 오류 | 상단 배너와 [다시 시도]. 저장본이나 이전 결과가 있으면 유지한다 |
| 0건 | 할 일 이상 상태의 티켓이 없다는 안내 |
| 필터 0건 | 조건에 맞는 티켓이 없다는 안내와 필터 지우기 |
| truncated | 목록 위에 일부만 가져왔다는 안내 |

## 7. 가드레일

- **Jira 는 GET 만.** 새 코드는 `jira.ts` 의 요청 함수를 거치고 `fetch` 를 직접 부르지 않는다.
  확인: `grep -n "method:" src/main/services/jira.ts` 가 전부 `'GET'`,
  `grep -n "fetch(" src/main/services/jira-board.ts src/main/services/jira-board-store.ts src/main/ipc/jira-board.ipc.ts` 가 0줄.
- **DB 는 보드 테이블 3개에만 쓴다.** `jira_board_issues`·`jira_board_sync`·`jira_epic_summaries` 밖의 테이블에는 쓰지 않는다.
  세 테이블은 Jira 에서 다시 받거나 버튼으로 다시 만들 수 있는 캐시라 백업하지 않는다.
- **JQL 에 넣는 값은 삽입 직전에 검증한다.** 프로젝트·이슈 키는 정규식, 증분의 분 수 N 은 정수 검사다.
- **웹링크 GET 은 상한 안에서만.** 웹링크는 이슈마다 GET 1회라 대상(inScope 에픽·표준 이슈), 동기화당 150건, 동시 4건으로 묶는다.
- **링크 열기는 저장된 URL 만.** `jiraBoard:openLink` 는 http(s)이고 저장 스냅샷의 `links` 에 든 URL 만 연다. renderer 가 임의 URL 을 열게 하지 않는다. 첨부는 내려받지 않고 브라우저로 넘긴다.
- **AI 요약은 버튼으로만.** 보드를 열거나 새로고침할 때 자동으로 만들지 않는다.
  Jira 에서 온 제목·설명은 신뢰할 수 없는 입력이라 요약 호출에 도구 권한을 주지 않는다.
- **AI 대화 질문에는 티켓 키만.** [AI 대화로 열기]는 제목·설명을 질문에 넣지 않는다(`IssueDetailPanel.test.tsx` 가 고정한다).

## 8. 아침 자동 동기화와의 관계

아침 자동 동기화는 릴리스 파트만 돈다(`MORNING_SYNC_PARTS = ['release']`). 상태 조회는
`morningSync:status`(`window.api.morningSync.status()`)다. 옛 `morning_sync` 이벤트 payload 에 남은
`project` 파트는 무시한다. 프로젝트 보드는 아침 자동 동기화를 쓰지 않는다. 화면을 열 때(`auto`)와 새로고침할 때 동기화한다.

## 9. 테스트 위치

| 파일 | 다루는 것 |
|---|---|
| `src/main/services/jira-board.test.ts` | 전체 수집 규칙(JQL·보강·inScope·상한), 동기화 모드(증분 upsert·저장 대상 선별, 전체로 넘어가는 조건, auto 의 60초 생략·24시간 전체·옛 행 전체, 실패 시 저장본 보존, 비우기), 링크 조립(종류별·중복 제거·http(s)만), 웹링크 대상·상한·실패 무시·증분 유지, AI 요약. Jira 호출 함수와 저장소를 주입해 네트워크 없이 돈다 |
| `src/main/services/jira-board-store.test.ts` | 저장·읽기·전체 교체·증분 upsert·비우기, 깨진 행 무시, 옛 행 채우기와 `legacyRows`, 쓰기 오류 시 되돌리기, 에픽 AI 요약 저장(덮어쓰기·50행 상한·사라진 에픽 삭제·비우기) |
| `src/renderer/src/components/project/IssueDetailPanel.test.tsx` | [AI 대화로 열기] 버튼 표시와 질문 문구(`aiChatPromptFor`), 질문에 제목·설명이 없음, [할 일로 만들기] 표시 조건(사이트 주소)과 미리 채울 값 |
| `src/main/ipc/jira-board.ipc.test.ts` | `fetch` 의 mode 검증, `cached`, `summarizeEpic` 전달, `openLink` 가 저장 스냅샷에 없는 URL·비 http(s)·문자열 아닌 값을 거부 |
| `src/main/services/jira-adf.test.ts` | ADF → 평문 변환, 링크 추출(`extractAdfLinks`), 출처 이름 추정(`guessLinkName`) |
| `src/renderer/src/components/project/boardModel.test.ts` | 트리 구성, 롤업, 필터(릴리스 필터 포함), 정렬, 평탄화, 키보드 이동, 요약 타일, 우선순위 표기 |
| `src/renderer/src/components/project/docsModel.test.ts` | 문서 탭의 묶기, 같은 URL 합치기, 연결 이슈 분리, 종류별 건수, 검색·출처·내 담당 필터, 그룹 펼침 판정(기본 펼침·저장된 접힘·검색 중 모두 펼침) |
| `src/renderer/src/components/project/DocsTab.test.tsx` | 문서 탭의 상태별 화면, 묶음·합치기 표시, 종류별 건수, 빈 안내, 그룹 접기(`aria-expanded`·접힌 그룹은 헤더만)·모두 접기/펴기·검색 중 접힘 무시 |
| `src/renderer/src/components/project/ProjectsPage.test.tsx` | 탭 바와 선택 탭만 마운트, 릴리스 탭 배지, 탭 전환, 릴리스 탭에서만 markSeen |
| `src/renderer/src/components/project/IssueTree.keyboard.test.tsx` | 트리 키 처리가 상세 패널 버튼의 키를 가로채지 않음 |
| `src/renderer/src/stores/jiraBoardStore.test.ts` | load(저장본 먼저·동기화·중복 방지·늦은 응답·오류 코드), AI 요약 상태, 필터·펼침·문서 탭 접힘·선택과 localStorage, `revealIssue`(보드에서 보기) |
| `src/renderer/src/components/project/ProjectBoardView.test.tsx` | 상태별 화면(§6.3), 트리의 펼침·aria·백로그 숨김·roving tabindex |
