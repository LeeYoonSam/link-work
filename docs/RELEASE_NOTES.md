# 릴리스 노트 — Jira 릴리스 동기화 설계

Jira 릴리스(Version)를 가져와 그 릴리스에 묶인 작업 내용을 릴리스 노트로 보여준다.

> 초안에서 한 번 뒤집힌 곳이 있다. 처음에는 프로젝트에 릴리스를 **연결**하는 구조였는데,
> 대응 프로젝트가 없는 릴리스가 목록에서 사라지고 같은 배포 버전을 쓰는 프로젝트 수만큼 같은
> 릴리스가 중복으로 뜨는 문제가 드러나 **Jira 릴리스 하나당 한 행**으로 바꿨다 (§3).
> 아래 본문은 바뀐 뒤의 구조를 기준으로 한다.

- 관련 문서: [AI_GUARDRAILS.md](AI_GUARDRAILS.md) (외부 접근 8절)
- 관련 코드: `src/main/services/notion.ts` (외부 REST 연동 선례)

---

## 1. 범위

| 항목 | 결정 |
|------|------|
| 릴리스 노트 항목의 출처 | **Jira 단일 출처.** LinkWork 작업(`tasks`)은 릴리스 노트에 넣지 않는다 |
| 동기화 방식 | **수동 — 동기화 버튼.** 자동 훅·백그라운드 폴링 없음 |
| 앱에서 문구 편집 | **없음 (순수 미러링).** 동기화 = 항목 전체 교체 |
| 릴리스와 프로젝트의 관계 | **없음.** 릴리스 노트는 Jira 릴리스 하나당 한 행이며 프로젝트에 속하지 않는다 (§3) |
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

**릴리스 노트는 프로젝트에 속하지 않는다.** 처음에는 `project_id`로 프로젝트에 묶었는데
두 방향으로 어긋났다. 대응 프로젝트가 없는 릴리스는 Jira에 멀쩡히 있어도 목록에 나타나지
않았고(4.163.0·4.159.0·4.158.0), 반대로 같은 배포 버전을 쓰는 프로젝트가 셋이면 같은 릴리스가
목록에 세 번 떴다. 릴리스는 Jira의 것이지 프로젝트의 것이 아니므로 **릴리스 하나당 한 행**이다.

```sql
CREATE TABLE IF NOT EXISTS release_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

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
  UNIQUE (jira_project_key, jira_version_id)
);

CREATE TABLE IF NOT EXISTS release_note_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_note_id INTEGER NOT NULL,
  issue_key TEXT NOT NULL,                   -- ICA-8678
  issue_type TEXT,                           -- Story / Bug / Task
  status TEXT,                               -- 닫힘 / 해결됨 / 처리중 / 할 일
  resolution TEXT,                           -- 완료 / NULL(미해결)
  summary TEXT NOT NULL,
  parent_key TEXT,                           -- 상위 이슈 키 (있으면 하위로 들여쓰기)
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (release_note_id) REFERENCES release_notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_release_note_items_note
  ON release_note_items(release_note_id);
```

`UNIQUE (jira_project_key, jira_version_id)`가 같은 릴리스를 두 번 가져오는 것을 막는다.

### 3.1 프로젝트와 이어 보는 법 — 배포 버전 이름 대조

저장된 연결이 없으므로, 프로젝트 상세의 Release Notes 카드는 그 프로젝트의
`projects.deploy_version`과 **이름이 같은** 릴리스를 조회 시점에 찾아 읽기만 한다
(`listReleaseNotes(deployVersion)`). 배포 버전을 바꾸면 짝지어 보이는 릴리스도 따라 바뀐다.

`deploy_version`은 한 칸에 여러 버전이 적힐 수 있다 — 실제 데이터에 `2.8.1 , 4.155.0`
(작가앱·구매자앱 동시 배포)이 있다. `splitDeployVersions`가 쉼표·슬래시·줄바꿈으로 나눠
각각 맞춰 본다. 공백으로는 나누지 않는다: `4.164.0 (핫픽스)`를 쪼개면 엉뚱한 릴리스에 걸린다.

### 3.2 마이그레이션

`project_id`를 걷어낼 때 중복 행을 합친다. 남길 행은 **가져온 이슈가 가장 많은 것**이다 —
중복 행들은 같은 릴리스를 가리키므로 내용이 같아야 하지만, 이슈 조회 상한(§4.4)에 걸려
어떤 행은 메타만 있을 수 있다. SQLite에는 컬럼 제약만 바꾸는 ALTER가 없어 테이블을 다시
만드는데, 이때 **FK를 꺼야 한다.** 켠 채로 `DROP TABLE`하면 `release_note_items`가
CASCADE로 함께 지워진다. `migrateReleaseNotesDropProject`가 이 순서를 지킨다.

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

### 4.4 전체 동기화 — 진입점은 Jira다

`syncAllReleases`는 기본 Jira 프로젝트의 릴리스 목록을 받아 하나씩 훑는다.
**LinkWork 프로젝트를 전혀 보지 않는다** (§3).

- Jira에서 보관(archive)한 릴리스는 새로 끌어오지 않는다. 의도적으로 치운 것이기 때문이다.
  이미 목록에 있는 것은 사용자가 보고 있을 수 있으므로 그대로 두고 갱신한다.
- 이슈까지 받는 것은 **버전이 높은 쪽 `MAX_ISSUE_FETCH_PER_SYNC`(40)건**까지다. 릴리스당 Jira
  호출이 2회(버전 메타 + 이슈 검색)라 전부 받으면 몇 분씩 걸린다(실측 216건). 나머지는 릴리스만
  저장돼 목록에 "아직 동기화하지 않았습니다"로 남고, 행의 동기화 버튼으로 개별로 받는다.
- 이미 받아 뒀는지는 상한 계산에 넣지 않는다. 넣으면 개별 동기화로 받아 둔 릴리스가 쌓일수록
  전체 동기화가 계속 느려지고, 몇 건을 받을지도 실행할 때마다 달라진다.
- 한 릴리스의 실패가 나머지를 막지 않는다. 결과는 동기화 / 이슈 보류 / 실패로 나눠 돌려주고
  화면이 세 갈래를 그대로 보여준다 — 이슈 보류를 감추면 "가져왔는데 왜 내용이 비었지"가 된다.

### 4.5 목록 정렬 — 릴리스일이 아니라 버전 번호

`sortReleaseNotes`가 **시맨틱 버전 내림차순**으로 세운다. 릴리스일로 세우면 두 가지가
어긋난다. 날짜가 아직 안 잡힌 버전은 비교할 값이 없어 목록 꼭대기나 끝으로 튕기고(릴리스일이
빈 4.46.0이 실제로 최상단에 앉았다), Jira에서 릴리스일을 나중에 손보면 같은 목록이 다시 흔들린다.

정렬을 SQL이 아니라 JS에서 하는 이유는 **문자열 비교로는 버전을 잴 수 없기** 때문이다.
사전순으로는 `4.46.0`이 `4.166.0`보다 커서 낮은 버전이 맨 위에 앉는다. `compareVersionDesc`가
마디를 숫자로 갈라 앞에서부터 잰다. 화면 목록과 AI 도구(§7)가 같은 함수를 쓴다 — 같은 질문에
화면과 AI가 다른 순서로 답하면 안 된다.

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
| `list_release_notes` | 릴리스 노트 목록 — 버전, 릴리스 여부, 항목 수, 마지막 동기화 시각. `version`으로 버전 이름 부분 검색 |
| `get_release_note` | 단건 상세 — 이슈 키·유형·상태·제목 목록 |

- **Jira를 직접 호출하지 않는다.** 이미 동기화된 로컬 DB만 읽으므로 AI 대화가 느려지거나
  토큰 상태에 영향받지 않는다
- 릴리스는 프로젝트에 묶여 있지 않으므로(§3) 프로젝트로 거르는 인자가 없다. 특정 프로젝트의
  릴리스를 찾으려면 그 프로젝트의 `deploy_version`을 먼저 확인해 `version`으로 넘긴다 —
  도구 설명에 이 경로를 적어 두었다
- 도구가 반환하는 이슈 제목은 **신뢰할 수 없는 외부 입력**이다 (가드레일 6절).
  기존 도구와 같이 결과는 표시용 데이터로만 취급되며, 조회 전용이라 인젝션이 성공해도
  피해 범위는 "잘못된 답변 표시"로 한정된다
- `TOOL_LABELS`에 한국어 라벨 추가 (`릴리스 노트 조회` 등)

---

## 8. UI

### 8.1 화면 둘 — Releases와 프로젝트 상세 카드

사이드바 **Releases**가 전체 목록이다. 프로젝트로 묶지 않고 버전 내림차순으로 한 줄씩
늘어놓으며(§4.5), 상단에 버전 검색과 전체 동기화 버튼을 둔다. 연결된 릴리스가 0건이어도 전체
동기화 버튼은 보여야 한다 — 버튼이 행 안에만 있으면 막다른 상태가 된다.

**프로젝트 상세의 Release Notes 카드**는 배포 버전과 이름이 같은 릴리스를 찾아 읽기만 한다
(§3.1). 연결·해제 조작은 없다. 배포 버전이 비어 있으면 그 사실과 채워야 할 곳을 알려준다 —
짝을 찾는 유일한 단서이기 때문이다.

행(`ReleaseNoteRow`)은 두 화면이 함께 쓴다. 같은 규칙(0건 명시·실패 표시·상한 안내·계층
들여쓰기)이 두 곳에 복제되면 한쪽만 고쳐져 어긋난다.

- 행 어디를 눌러도 이슈가 펼쳐진다. 화살표 버튼도 남긴다 — 키보드로 여닫는 통로이자
  펼침/접힘 상태 표시다. 동기화·내보내기 버튼은 클릭이 위로 새지 않도록 막는다
- 항목은 이슈 유형별로 묶어 표시하고, `parent_key`가 있으면 상위 아래로 들여쓴다
  (`TaskList`의 1단계 계층 표시와 같은 방식)
- 이슈 상태 뱃지는 중요도 순으로 색을 달리한다: 완료(연한 초록) < 진행(파랑) < 미착수(앰버)
  < 중단(빨강). 릴리스에 묶인 이슈는 거의 다 끝난 것이라(실측 160건 중 148건이 '닫힘')
  완료를 진하게 칠하면 정작 손봐야 할 항목이 묻힌다. 워크플로를 모르는 상태는 회색으로 둔다
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
4. UI — 연동 설정, Releases 목록·검색, 동기화 버튼, 항목 표시
5. 마크다운 내보내기 + 테스트
6. AI 조회 도구 2종 + 가드레일 문서 갱신
