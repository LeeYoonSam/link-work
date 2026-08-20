# 릴리스 노트 — Jira 릴리스 동기화 설계

프로젝트에 Jira 릴리스(Version)를 연결하고, **동기화 버튼**으로 해당 릴리스에 묶인
작업 내용을 가져와 릴리스 노트로 보여준다.

- 관련 문서: [AI_GUARDRAILS.md](AI_GUARDRAILS.md) (외부 접근 8절)
- 관련 코드: `src/main/services/notion.ts` (외부 REST 연동 선례)

---

## 1. 범위

| 항목 | 결정 |
|------|------|
| 릴리스 노트 항목의 출처 | **Jira 단일 출처.** LinkWork 작업(`tasks`)은 릴리스 노트에 넣지 않는다 |
| 동기화 방식 | **수동 — 동기화 버튼.** 자동 훅·백그라운드 폴링 없음 |
| 앱에서 문구 편집 | **없음 (순수 미러링).** 동기화 = 항목 전체 교체 |
| 한 프로젝트의 릴리스 수 | 여러 개 가능 (버전 단위 레코드) |
| AI 대화 | **조회 도구 2종만.** 쓰기 도구 없음 |

### 왜 이 범위인가

LinkWork 작업을 함께 출처로 삼으면 작업이 수정·삭제될 때 릴리스 노트를 어떻게 따라가게 할지,
사용자가 고친 문구를 자동 동기화가 덮어써도 되는지 같은 병합 규칙이 필요해진다.
Jira 단일 출처 + 편집 없음으로 두면 그 문제군이 통째로 사라진다:

- 이슈가 릴리스에서 빠짐 → 다음 동기화에서 **사라짐**
- 이슈 제목이 바뀜 → 다음 동기화에서 **갱신됨**
- 이슈가 릴리스에 추가됨 → 다음 동기화에서 **추가됨**

"자동 추가/수정/제거"가 전체 교체 한 번으로 달성되고, **릴리스 노트는 항상 Jira와 같다**는
단순한 보장이 생긴다. 문구를 다듬고 싶으면 마크다운으로 내보내 고친다.

---

## 2. Jira 연동 리서치 결론 (2026-08 기준)

### 2.1 인증 — API 토큰 + Basic Auth

`Authorization: Basic base64(email:api_token)`, 호스트는 `https://<site>.atlassian.net`.

**가장 중요한 제약: API 토큰은 최대 1년 만료다.**
2024년 12월부터 모든 신규 Atlassian Cloud API 토큰은 1일~1년 사이의 만료일을 갖는다.
무기한 토큰은 발급할 수 없고, 그 이전에 만들어진 무기한 토큰은 2025년 3월에 소급 만료됐다.

→ **"등록하고 잊는" 연동은 불가능하다.** 만료 관리가 설계에 포함돼야 한다 (§6.2).
   Notion internal integration 토큰(만료 없음)과 결정적으로 다른 점이다.

OAuth 2.0 (3LO)은 refresh token 자동 갱신이 되지만, 사용자가 Atlassian 개발자 콘솔에서
OAuth 앱을 직접 등록해야 하고 콜백 처리가 필요하다. 개인 사용자 1명이 쓰는 앱에서는
설정 부담이 만료 갱신 부담보다 크다고 판단해 API 토큰을 택했다.

### 2.2 레이트 리밋 — 사실상 제약 없음

Atlassian 공식 문서: *"API token-based traffic is not affected by this change, and will
continue to be governed by existing burst rate limits."*

API 토큰 트래픽은 포인트 기반 시간당 쿼터(기본 65,000 points/hour)의 적용을 받지 않고
**버스트 제한만** 걸린다 — GET/POST 기본 100 req/sec. 수동 동기화 호출량은 문제가 되지 않는다.

429 응답 시 헤더: `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset`, `RateLimit-Reason`.
권장 재시도: 지수 백오프 + 지터 (2초 시작, 최대 30초, 랜덤 계수 0.7~1.3, 최대 4회).

ETag / If-None-Match 조건부 요청은 문서화되어 있지 않다 — **의존하지 않는다**.

### 2.3 사용하는 엔드포인트

| 용도 | 엔드포인트 |
|------|-----------|
| 토큰 검증 | `GET /rest/api/3/myself` |
| 프로젝트 목록 | `GET /rest/api/3/project/search` |
| 릴리스(버전) 목록 | `GET /rest/api/3/project/{projectIdOrKey}/version` — `startAt`/`maxResults` 페이지네이션, `orderBy=-releaseDate`. `PageBeanVersion` 반환 |
| 릴리스에 묶인 이슈 | `GET /rest/api/3/search/jql` — `jql=fixVersion = <versionId>` |

`/project/{key}/versions`(복수형, 비페이지네이션)도 있지만 버전이 많은 프로젝트에서 응답이
무한정 커지므로 **페이지네이션 버전(`/version`)을 쓴다.**

### 2.4 반드시 피해야 할 것 — 구 검색 엔드포인트

**`GET|POST /rest/api/3/search`는 제거됐다.** 2024-10-31 deprecation 공지 → 2025년 중
단계적 차단 → 2025년 10월 말 전면 차단. 현재 호출하면 `410 Gone`이 반환된다.

반드시 `/rest/api/3/search/jql`을 쓴다. 구 엔드포인트와 달라진 점:

- **`fields`를 명시해야 한다.** 생략하면 필드가 거의 오지 않는다
  → 이 기능에 필요한 것만: `summary,issuetype,status,resolution,parent`
- **페이지네이션이 커서 기반**이다 — `startAt`/`total`이 없고 `nextPageToken`을 돌려받아
  다음 요청에 실어 보낸다. **토큰이 없으면 마지막 페이지**
- `nextPageToken`의 유효기간은 7일 (한 번의 동기화 안에서만 쓰므로 무관)

> 커뮤니티에 "`/search/jql`이 deprecated"라는 제목의 글이 있으나 이는 구 `/search`와의 혼동이다.
> `/search/jql`이 현재 권장 엔드포인트다.

### 2.5 매칭 키 — 버전 ID로 고정한다

Jira 버전 **이름은 언제든 바뀔 수 있다**(`v1.2.0` → `1.2.0 (hotfix)`).
이름으로 연결하면 이름이 바뀌는 순간 동기화가 조용히 끊긴다.

→ 연결은 **`jira_version_id`(불변 숫자 ID)**로 저장하고, 이름은 표시용 캐시로 함께 저장해
   동기화할 때마다 갱신한다. JQL도 ID로 조립하므로 이름 이스케이프 문제가 없다:
   `fixVersion = 10042 ORDER BY issuetype, key`

릴리스 노트에 필요한 값은 전부 표준 필드이므로 **커스텀 필드(`customfield_XXXXX`)에
의존하지 않는다** — 사이트마다 ID가 달라 이름으로 유추할 수 없기 때문이다.

### 2.6 근거

- [Project versions API group](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-project-versions/)
- [Issue search API group](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)
- [API tokens will now have a maximum one-year expiry](https://community.atlassian.com/forums/Jira-articles/API-tokens-will-now-have-a-maximum-one-year-expiry/ba-p/2880029)
- [Manage API tokens for your Atlassian account](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)
- [Avoiding Pitfalls: Migration to Enhanced JQL APIs](https://community.atlassian.com/forums/Jira-articles/Avoiding-Pitfalls-A-Guide-to-Smooth-Migration-to-Enhanced-JQL/ba-p/2985433)

---

## 3. 데이터 모델

```sql
CREATE TABLE IF NOT EXISTS release_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,

  -- Jira 릴리스 연결 (§2.5 — id가 매칭 키, 이름은 표시용 캐시)
  jira_project_key TEXT NOT NULL,
  jira_version_id TEXT NOT NULL,
  version_name TEXT NOT NULL,
  description TEXT,                          -- Jira 버전 설명
  released INTEGER NOT NULL DEFAULT 0,       -- Jira released 플래그
  archived INTEGER NOT NULL DEFAULT 0,
  release_date TEXT,                         -- Jira releaseDate (YYYY-MM-DD)
  start_date TEXT,                           -- Jira startDate

  last_synced_at TEXT,                       -- NULL이면 아직 한 번도 동기화 안 됨
  last_sync_error TEXT,                      -- 마지막 실패 사유 (성공 시 NULL로 초기화)

  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, jira_version_id)
);

CREATE TABLE IF NOT EXISTS release_note_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_note_id INTEGER NOT NULL,
  issue_key TEXT NOT NULL,                   -- ICA-8678
  issue_type TEXT,                           -- Story / Bug / Task
  status TEXT,                               -- 완료 / 진행 중
  resolution TEXT,                           -- 해결됨 / NULL(미해결)
  summary TEXT NOT NULL,
  parent_key TEXT,                           -- 상위 이슈 키 (있으면 하위로 들여쓰기)
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (release_note_id) REFERENCES release_notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_release_note_items_note
  ON release_note_items(release_note_id);
```

`UNIQUE (project_id, jira_version_id)`가 같은 릴리스를 한 프로젝트에 두 번 연결하는 것을 막는다.
신규 테이블이라 `initDatabase()`의 `CREATE TABLE IF NOT EXISTS`로 충분하고 마이그레이션 분기가 없다.

`projects.deploy_version`은 그대로 둔다. 릴리스를 연결할 때 비어 있으면 Jira 버전 이름을
채워 넣을지 **제안만** 하고, 자동으로 덮어쓰지 않는다.

---

## 4. 동기화 동작

### 4.1 순서 — 조회를 모두 끝낸 뒤에 쓴다

```
1. Jira에서 버전 메타 조회      GET /rest/api/3/version/{id}
2. Jira에서 이슈 전체 조회      GET /rest/api/3/search/jql  (nextPageToken 루프)
   ── 여기까지 실패하면 DB를 건드리지 않고 중단 ──
3. 트랜잭션 시작
     UPDATE release_notes  (버전 메타 + last_synced_at, last_sync_error = NULL)
     DELETE FROM release_note_items WHERE release_note_id = ?
     INSERT 새 항목들
   트랜잭션 커밋
```

**조회를 전부 마친 뒤에 삭제·삽입한다.** 네트워크 오류나 401이 중간에 나도 기존 릴리스 노트가
그대로 남는다. `DELETE`를 먼저 하고 조회하다 실패하면 데이터가 사라지는데, 이 순서가 그것을 막는다.
`better-sqlite3`의 동기 트랜잭션(`db.transaction(...)`)으로 감싸 부분 반영도 없앤다.

### 4.2 결과가 0건일 때

Jira가 0건을 반환하는 것은 **정상 상태일 수 있다**(아직 이슈를 릴리스에 붙이지 않음).
따라서 0건도 그대로 반영하되, UI에 "Jira에서 가져온 이슈: 0건"으로 **명시**해서
"동기화가 실패한 것"과 구분되게 한다. 실패는 항상 `last_sync_error`와 오류 메시지로 드러난다.

### 4.3 상한

한 릴리스에 이슈가 비정상적으로 많아도 앱이 멈추지 않도록 **최대 500건**까지만 가져오고,
초과 시 UI에 "상위 500건만 표시" 안내를 띄운다 (페이지당 100건, 최대 5페이지).

---

## 5. Jira 서비스 (`src/main/services/jira.ts`)

`notion.ts` 패턴을 따른다. **Jira REST 호출은 전부 이 파일에만 둔다** — 엔드포인트가
또 바뀌어도(구 `/search` 제거 전례) 수정 지점이 하나다.

```
app_settings 키:
  jira_site_url          https://<site>.atlassian.net
  jira_email             계정 이메일
  jira_api_token         safeStorage 암호화 (notion_token과 동일 방식)
  jira_token_expires_at  만료일 YYYY-MM-DD — §6.2
```

- 저장 시 `GET /rest/api/3/myself`로 **검증에 성공해야만** 기록한다
- renderer에는 **연결 여부·계정 표시명·만료일만** 노출하고 토큰 값은 내보내지 않는다
- 요청 타임아웃 15초
- 오류 매핑 (한국어 메시지):
  - `401` → 토큰이 만료됐거나 유효하지 않음, 재등록 안내
  - `403` → 해당 Jira 프로젝트 접근 권한 없음
  - `404` → 프로젝트/버전을 찾을 수 없음 (Jira에서 삭제됐을 수 있음)
  - `410` → 제거된 엔드포인트 호출 (코드 버그 — 발생 시 즉시 드러나야 함)
  - `429` → `Retry-After` 존중 백오프 후 재시도 (최대 4회)

---

## 6. 지속성 보장 장치

### 6.1 실패가 데이터를 훼손하지 않는다

§4.1의 "조회 완료 후 쓰기" 순서 + 트랜잭션. 실패하면 직전 동기화 결과가 그대로 남고
`last_synced_at`도 갱신되지 않아, 화면에 "마지막 동기화: N일 전"이 정확히 유지된다.

### 6.2 토큰 만료 대응 (§2.1)

API 토큰이 1년 안에 반드시 만료되므로:

- 토큰 등록 시 **만료일을 함께 입력**받아 저장
- 만료 **30일 전부터** 설정과 릴리스 노트 화면에 갱신 안내 배너
- 만료 후 401이 오면 연결 상태를 "만료됨"으로 표시하고 재등록을 안내

조용히 실패해서 "왜 동기화가 안 되지" 상태로 방치되는 것을 막는 것이 목적이다.

---

## 7. AI 대화 — 조회 도구 2종

`ai-tools.ts`에 추가하고 `LINKWORK_TOOL_NAMES`(자동 허용)에 등재한다.
읽기 전용 커넥션(`getAiReadOnlyDatabase`)만 쓰므로 쓰기 게이트가 필요 없다.

| 도구 | 용도 |
|------|------|
| `list_release_notes` | 릴리스 노트 목록 — 프로젝트, 버전, 릴리스 여부, 항목 수, 마지막 동기화 시각 |
| `get_release_note` | 단건 상세 — 이슈 키·유형·상태·제목 목록 |

- **Jira를 직접 호출하지 않는다.** 이미 동기화된 로컬 DB만 읽으므로 AI 대화가 느려지거나
  토큰 상태에 영향받지 않는다
- 도구가 반환하는 이슈 제목은 **신뢰할 수 없는 외부 입력**이다 (가드레일 6절).
  기존 도구와 같이 결과는 표시용 데이터로만 취급되며, 조회 전용이라 인젝션이 성공해도
  피해 범위는 "잘못된 답변 표시"로 한정된다
- `TOOL_LABELS`에 한국어 라벨 추가 (`릴리스 노트 조회` 등)

---

## 8. UI

### 8.1 프로젝트 상세 — Release Notes 카드

- 연결된 릴리스가 없으면: "Jira 릴리스 연결" 버튼
- 연결 시: Jira 프로젝트 키 선택 → 버전 목록 조회 → 버전 선택 (미출시 버전 우선 표시)
- 연결 후: 버전별 카드에 **동기화 버튼**, 마지막 동기화 시각, 항목 수
- 항목은 이슈 유형별로 묶어 표시하고, `parent_key`가 있으면 상위 아래로 들여쓴다
  (`TaskList`의 1단계 계층 표시와 같은 방식)
- 이슈 키 칩은 `tokens.ts`의 `taskTag.issue` 스타일을 재사용해 기존 작업 목록과 톤을 맞춘다
- 이슈 키 클릭 시 Jira 티켓 URL을 외부 브라우저로 연다

### 8.2 내보내기

릴리스 노트 마크다운 생성 → 기존 `export:saveMarkdown` IPC 재사용.
`notionExport.ts`와 같이 **순수 함수 + 단위 테스트** 패턴으로 만든다.

### 8.3 Jira 연동 설정

AI 대화의 Notion 연동 UI와 같은 자리에 사이트 URL·이메일·토큰·만료일 입력.
연결 상태와 만료 임박 경고를 함께 표시한다.

---

## 9. 완료 조건 (기계 판정)

| 조건 | 판정 |
|------|------|
| 단위 테스트 | `npx vitest run` 종료 코드 0, 실패 0건 |
| 타입체크 | `npm run typecheck` 에러 0건 |
| 빌드 | `npm run build` 종료 코드 0 |

신규 테스트 필수 항목:

1. **`jira.test.ts`** (fetch 모킹)
   - `nextPageToken` 페이지네이션 루프가 토큰이 사라지면 종료하는지
   - 500건 상한에서 멈추는지
   - `PageBeanVersion` 파싱 (`startAt`/`maxResults`/`isLast`)
   - 401/403/404/410/429 → 한국어 메시지 매핑
   - 429 백오프가 `Retry-After`를 존중하는지
2. **`release-note-sync.test.ts`**
   - 이슈 조회 실패 시 기존 항목이 **그대로 남는지** (§4.1의 핵심 보장)
   - 성공 시 항목이 전체 교체되는지 (이전 항목 잔존 없음)
   - 0건 결과가 정상 반영되는지
3. **`releaseNoteExport.test.ts`**
   - 이슈 유형별 그룹핑, 하위 이슈 들여쓰기, 빈 릴리스 처리

---

## 10. 구현 순서

1. 스키마 + 타입 + `jira.ts`(토큰 저장·검증·오류 매핑) + 테스트
2. 버전/이슈 조회 + 동기화 로직 + 테스트
3. IPC(`release-note.ipc.ts`) + preload + store
4. UI — 연동 설정, 릴리스 연결, 동기화 버튼, 항목 표시
5. 마크다운 내보내기 + 테스트
6. AI 조회 도구 2종 + 가드레일 문서 갱신
