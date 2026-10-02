# 프로젝트 싱크업 — Jira 동기화 규칙

Jira에서 **내게 할당된 `할 일` 상태 이슈**를 읽어 LinkWork 프로젝트·작업·문서로 반영한다.
싱크업 규칙과 코드를 수정할 때는 이 문서를 단일 기준으로 삼는다. 규칙을 바꾸려면 이 문서부터 고친다 (§12).

- 관련 문서: [RELEASE_NOTES.md](RELEASE_NOTES.md) (Jira 인증·`/search/jql`·페이지네이션 §2),
  [AI_GUARDRAILS.md](AI_GUARDRAILS.md)
- 작업 스킬: `/project-sync` (`.claude/skills/project-sync/SKILL.md`),
  검증 에이전트: `sync-verifier` (`.claude/agents/sync-verifier.md`)

---

## 1. 범위

| 항목 | 결정 |
|------|------|
| 데이터 방향 | **Jira → LinkWork 단방향.** Jira는 GET만, 쓰기는 LinkWork DB에만 |
| 실행 방식 | **수동.** 미리보기(preview)로 계획을 보여준 뒤 사용자가 **고른 항목만** 적용(apply) (R9) |
| 기존 데이터 | **삭제 없음.** 기본은 추가·전진만이고, 기존 프로젝트를 덮어쓰는 것은 사용자가 확인한 강제 업데이트(R10)뿐이다 |
| 대상 | 기본 Jira 프로젝트(app_settings `jira_default_project_key`) 하나 |

### 1.1 Jira 데이터 형태 (예시)

- 이슈 타입: `에픽` / `작업` / `하위 작업`(`issuetype.subtask=true`). 계층은 에픽 → 작업 → 하위 작업.
- 상태 이름: `백로그`, `할 일`, `처리중`, 완료 계열. `statusCategory.key`는 `new`(백로그·할 일) / `indeterminate` / `done`.
- Sustain 에픽 예: `[Android/Sus] Sprint 10` (PROJ-1892) — 그 아래 `작업`들이 Sustain 작업.
- QA 에픽 예: `안드로이드QA-2099` (PROJ-1054) — 하위 예: `안드로이드 앱 v1.0.0 QA`.
- 일반 에픽 예: `알림센터 개편` (PROJ-1855) — 에픽은 `처리중`이지만 하위에 `할 일` 작업이 있다.
- 에픽 없는 `작업`도 있다(대부분 백로그).

---

## 2. 대상 수집

트리거 이슈 JQL:

```
project = <기본 프로젝트 키> AND assignee = currentUser() AND statusCategory = "To Do" ORDER BY key DESC
```

응답에서 상태 이름이 `할 일`(번역 전 이름 `Open`·`To Do` 포함)인 이슈만 트리거로 남긴다.
`ORDER BY key DESC`인 이유: 500건 상한(`MAX_SYNC_ISSUES`)이 상태 이름 필터보다 먼저 걸리므로, 상한에 닿으면 최신 이슈부터 남게 한다.

- `/rest/api/3/search/jql`(커서 페이지네이션, `fields` 명시)만 쓴다. 구 `/rest/api/3/search`는 제거됐다(410).
- 필요한 fields: `summary,status,issuetype,parent,assignee,duedate,labels,description,issuelinks`.
- JQL에 넣는 키는 삽입 전에 정규식으로 검증한다 — 프로젝트 키 `/^[A-Z][A-Z0-9_]*$/`, 이슈 키 `/^[A-Z][A-Z0-9_]*-\d+$/`.
- **상태 이름을 JQL에 넣지 않는다.** 화면의 `할 일`은 번역된 표시 이름이고 원래 이름은 `Open`이라, `status = "할 일"`은 오류 없이 0건을 돌려준다(실제 16건일 때 0건 — 싱크업이 "동기화할 것 없음"으로 조용히 끝났던 원인). JQL은 번역과 무관한 `statusCategory`로 넓게 조회하고, 응답의 `status.name`을 `SYNC_TRIGGER_STATUS`(및 번역 전 이름)와 비교한다. 카테고리만으로는 가를 수 없다 — 백로그도 같은 카테고리다.
- 계획의 `triggerCount`는 이렇게 남은 트리거 수다(하위 작업 트리거는 세지 않는다 — §3 "미리보기 표시"). 미리보기에 표시해, "변경 없음"이 조회 0건 때문인지 이미 최신이라서인지 구분하게 한다.
- 검색 한 번에 `MAX_SYNC_ISSUES = 500`건까지 가져온다(트리거·조상·자손 검색마다 따로 적용). 상한에 걸리면 계획을 `truncated: true`로 표시하고, 미리보기는 "Jira 조회 상한에 걸려 최근 이슈 일부만 가져왔습니다. 오래된 할 일 이슈는 목록에 없을 수 있습니다."를 띄운다.
- 트리거를 받은 뒤 분류에 필요한 조상(부모 작업·에픽)을 키로 조회하고, 프로젝트가 될 이슈의 자손(에픽 → 작업 → 하위 작업, Sustain 작업 → 하위 작업)과 원격 링크를 조회한다.
  원격 링크 조회가 실패하면 그 이슈만 빈 목록으로 두고 계속 진행한다.

---

## 3. 동기화 규칙

규칙 ID(R1~R10)는 테스트 이름에 그대로 들어간다(`project-sync-plan.test.ts`). 규칙을 바꾸면 같은 ID의 테스트도 함께 바꾼다.

| ID | 규칙 | 이유 |
|----|------|------|
| R1 | **에픽 = 프로젝트.** 트리거가 에픽이거나 일반 에픽(비-Sustain, 비-QA) 아래의 작업/하위 작업이면 그 에픽 1개가 프로젝트 1개. 같은 에픽의 트리거가 여럿이어도 프로젝트는 하나 | 기존 LinkWork 관례가 에픽 단위 프로젝트다. 트리거마다 만들면 같은 일이 여러 프로젝트로 쪼개진다 |
| R2 | **Sustain 작업 = 개별 프로젝트.** 에픽 요약이 Sustain 패턴(`/\bsus(tain(ing)?)?\b/i`)이면 에픽은 프로젝트가 되지 않고, 그 아래 `할 일` 트리거 작업 각각이 프로젝트가 된다. 트리거가 Sustain 작업의 하위 작업이면 부모 작업이 프로젝트. Sustain 에픽 자체만 트리거면 아무것도 만들지 않고 skipped에도 넣지 않는다(무시) | Sustain 에픽은 스프린트 묶음일 뿐 하나의 일이 아니다. 실제 추적 단위는 그 아래 작업이다 |
| R3 | **QA 제외.** 다음은 만들지 않고 `skipped(reason='qa')` — 이슈 타입 이름에 QA 포함(대소문자 무시), 요약이 QA 패턴(`/QA/`, 대소문자 구분)인 에픽과 그 모든 하위, 부모 작업이 QA 티켓인 하위 작업. 작업 레벨 QA 판정은 에픽이 QA 에픽이거나, 이슈 타입이 QA이거나, labels에 `QA`(대소문자 무시)가 있을 때. 일반 에픽 아래의 `[포인트] 셀프 QA`처럼 **요약만** QA인 작업은 제외하지 않는다 | QA 티켓은 개발 프로젝트가 아니라 QA 일정으로 관리한다. 요약 매칭을 작업까지 넓히면 개발 작업의 일부인 셀프 QA까지 빠진다 |
| R4 | **수동 프로젝트 보존.** 매칭되지 않은 기존 프로젝트·작업·문서는 어떤 필드도 수정·삭제하지 않는다. 싱크업은 삭제를 절대 하지 않는다 | 사용자가 직접 만든 데이터가 Jira 상태 때문에 바뀌거나 사라지면 안 된다 |
| R5 | **동일 작업이면 기존 프로젝트 업데이트.** 매칭 우선순위(§4)로 찾으면 `jira_issue_key`를 백필하고 업데이트한다. 업데이트는 두 경로다 — `force=false`면 보수 경로(§5, 빈 칸 채우기·상태 전진만), `force=true`면 강제 경로(R10). Sustain 작업은 추가로, §4의 1단계(jira_key) 매칭이 실패하면 **2·3단계보다 먼저** 어떤 기존 프로젝트의 task에 그 키가 있는지(`tasks.jira_issue_key` 일치, 또는 이름에 `(KEY)`/`[KEY]`) 보고, 있으면 새 프로젝트를 만들지 않고 `skipped(reason='tracked_in_project', detail=프로젝트 이름)` | 이미 수동으로 만든 프로젝트를 중복 생성하지 않기 위해. 묶음 Sus 프로젝트에서 작업으로 추적 중인 티켓도 중복이다. 추적 확인을 문서 매칭보다 먼저 하는 이유는, 묶음 프로젝트에도 그 작업의 browse 문서가 붙어 있어 문서 매칭이 먼저 돌면 묶음 프로젝트 전체가 티켓 하나의 키로 백필되기 때문이다 |
| R6 | **하위 작업·문서·링크 가져오기.** 작업 구조는 §6, 문서는 §7 | 프로젝트 상세에서 Jira를 열지 않고도 할 일과 참고 문서를 볼 수 있게 |
| R7 | **신규 프로젝트 기본값.** name=Jira 요약, description=ADF 본문의 평문(없으면 null), `jira_issue_key`=KEY, `dev_start_date`=오늘(로컬), `dev_end_date`=Jira duedate(오늘 이후일 때) 없으면 오늘+13일, QA/배포 날짜는 `calculateQaDates`, status=`scheduled`, priority=null | projects의 날짜 컬럼이 NOT NULL이라 기본값이 필요하다. 2주 기본 기간 뒤 사용자가 조정한다 |
| R8 | **멱등성.** 같은 Jira 스냅샷·같은 선택으로 두 번 적용하면 두 번째는 생성·추가·덮어쓰기 0건(action 전부 `unchanged`). 강제 업데이트도 마찬가지다 | 싱크업을 몇 번 눌러도 중복이 쌓이지 않아야 한다 |
| R9 | **선택 적용.** apply는 `selection: { jiraKey, force, projectId }[]`를 받아 **고른 항목만** 쓴다. 고르지 않은 항목도 계획 단계의 매칭에는 참여하고(프로젝트를 "차지"), 쓰기 직전에 걸러진다. 빈 선택, 형식이 잘못된 선택, 미리보기 계획에 없는 키는 오류로 거부한다. 선택의 `projectId`(미리보기 항목 값 그대로)가 적용 시 재계획 결과와 다른 항목이 하나라도 있으면 **아무것도 쓰지 않고** `미리보기 이후 프로젝트가 바뀌었습니다…` 오류 — 사용자가 확인한 것과 다른 프로젝트에 쓰지 않게. 쓰기 순서는 선택 순서가 아니라 계획 순서다 | 사용자 요구 — 무조건 전부 적용하지 않고 고른 것만. 미선택 항목을 계획 전에 빼면 매칭이 달라져 미리보기에서 본 대상과 적용 대상이 어긋난다 |
| R10 | **기존 프로젝트 강제 업데이트.** 기존 프로젝트에 매칭된 항목(`projectId !== null`)은 UI에서 **기본 선택 해제** + "이미 추가된 프로젝트입니다" 경고. 체크하면 확인 팝업을 거쳐 `force=true`로 넘긴다. 덮어쓰는 것: 프로젝트 name·description(Jira 본문이 비었으면 유지), 매칭된 작업의 name·status(**역행 허용**)·end_date(Jira duedate가 있을 때만). 유지하는 것: 프로젝트 날짜·status·priority·deploy_version, Jira에 매칭되지 않은 수동 작업·문서. 새 작업·문서 추가와 키 백필은 보수 경로와 같다. 삭제는 없고, 바뀔 값이 없으면 `unchanged`(멱등). 미리보기 항목의 `forceTasks`는 이름·상태·마감일 중 하나라도 바뀌는 기존 작업의 `{ before, after }` 이름 목록(키 백필만 일어나는 작업은 제외)이고, 확인 팝업이 이 목록을 보여 준다. `forceChanges` = 이름 바뀜 1 + 설명 바뀜 1 + `forceTasks.length` | 사용자 요구 — 이미 있는 프로젝트는 실수로 덮지 않게 기본은 손대지 않고, 원할 때만 확인을 거쳐 Jira 내용으로 맞춘다. 덮는 범위는 Jira에 원본이 있는 필드로 한정한다 |

에픽 없는 비-Sustain 트리거 작업은 프로젝트를 만들지 않고 `skipped(reason='no_epic')`로 보고한다.

**미리보기 표시.** 미리보기는 프로젝트 단위라 **하위 작업 트리거**는 `skipped`와 `triggerCount`에 넣지 않는다.
가져오기에는 영향이 없다 — 하위 작업 트리거도 분류(부모 작업 기준)와 작업 가져오기(§6)는 그대로 한다.

**보수 경로와 UI.** `force=false`인 기존 항목은 R5 보수 경로(§5)로 쓰인다. 이 코드 경로는 남아 있지만, 현재 UI는 기존 항목을 고르면 항상 `force=true`로 보내므로 쓰지 않는다.

---

## 4. 기존 프로젝트 매칭 우선순위 (R5)

1. `projects.jira_issue_key = KEY`
2. 그 프로젝트의 documents 중 URL이 `/browse/<KEY>`로 끝나는 것(쿼리·해시 제외, 정확히 그 키)
3. 이름 일치 — 프로젝트 이름과 Jira 요약 양쪽을 선두 `[태그]`들과 제목으로 나누고, 둘 다 trim·소문자·공백 축약으로 정규화한다.
   제목이 같아야 하고, **양쪽 모두** 태그가 있으면 태그 집합도 같아야 한다(`[Android] 크래시 수정` ≠ `[iOS] 크래시 수정`).
   한쪽만 태그가 있으면 사람이 붙인 분류 태그로 보고 제목만 비교한다.

- Sustain 작업은 1단계가 실패하면 2·3단계 전에 R5의 `tracked_in_project` 확인을 먼저 한다. 에픽은 1 → 2 → 3 순서 그대로다.
- 이미 다른 Jira 키가 연결된 프로젝트는 2·3단계(문서 URL·이름) 후보에서 빠진다 — 다른 이슈의 프로젝트를 다시 붙잡지 않게.
- status가 `completed`·`cancelled`인 프로젝트는 3단계(이름) 후보에서 빠진다. 1·2단계는 상태와 무관하다. 여기서 status는 DB 저장값이 아니라 **화면에 보이는 유효 상태**다 — 자동 상태(`status_manual=0`) 프로젝트는 저장값이 생성 시점 그대로라, 프로젝트 목록과 같은 `applyProjectAutoStatus`로 날짜에서 다시 계산해 판정한다.
- 한 번의 실행에서 기존 프로젝트 하나는 계획 항목 하나에만 매칭된다.

2·3으로 매칭되면 `jira_issue_key`를 백필해 다음부터 1로 찾는다. 계획 항목의 `matchedBy`는
`jira_key` / `document_url` / `name` / null(생성).

---

## 5. 업데이트 시 덮어쓰지 않는 것 (보수 경로, `force=false`)

강제 경로(`force=true`)에서 덮어쓰는 필드는 R10에 있다. 아래 표는 보수 경로 기준이다.

| 대상 | 규칙 |
|------|------|
| 프로젝트 name·날짜·status·priority·deploy_version | **덮어쓰지 않는다** |
| 프로젝트 description | 비어 있을 때만 채운다 |
| 작업 | 없는 것만 추가. 기존 작업 이름은 덮어쓰지 않는다 |
| 작업 status | **앞으로만** 이동(pending → in_progress → done). 되돌리지 않는다 |
| 문서 | 없는 것만 추가. 같은 Jira 사이트의 browse URL은 이슈 키로 비교(쿼리·해시 무시), 그 외는 끝 슬래시만 무시한 URL로 비교 |

적용 단계의 UPDATE(키 백필·description 채우기)는 WHERE에 "비어 있을 때만" 조건을 한 번 더 건다 — 계획과 쓰기 사이에 값이 채워졌어도 덮어쓰지 않게.

---

## 6. 작업 구조 (R6)

- **담당자 필터**(작업·하위 작업 공통): 내게 할당된 것 + 미할당. 트리거 이슈 자신은 항상 포함한다.
- **에픽 프로젝트**: 에픽의 자식 `작업`(QA 제외) → 최상위 task. 그 `하위 작업`(QA 타입 제외) → 자식 task(`parent_task_id`).
  남의 작업이라도 포함될 하위 작업이 있으면 계층을 유지하려고 그 작업도 함께 가져온다. done 이슈도 가져온다.
- **Sustain 프로젝트**: 그 작업의 `하위 작업`(같은 담당자 필터) → 최상위 task.
- 작업 매칭: `tasks.jira_issue_key` → 없으면 같은 프로젝트에서 키가 비어 있는 task 중 이름에 `(KEY)`/`[KEY]` 포함 여부(매칭되면 키 백필).
- 신규 task 이름: `<요약> (<KEY>)` — 기존 수동 작업명 관례와 같다.
- 상태 매핑: `statusCategory` new → pending, indeterminate → in_progress, done → done.
- Jira duedate가 있으면 `end_date`에만 넣는다.
- tasks는 1단계 계층만 허용하므로 하위 작업 아래 단계는 없다.

---

## 7. 문서·링크 수집 출처 (R6)

프로젝트가 된 이슈 **본인의 것만** 수집한다(자식 작업의 링크는 수집하지 않는다). type=`link`, http/https만.

| 출처 | 문서 이름 | URL |
|------|-----------|-----|
| (a) 프로젝트 이슈 자신 | 에픽: `Epic (KEY) 요약` / Sustain: `Jira 티켓 (KEY)` | `<siteUrl>/browse/KEY` |
| (b) remote links (`GET /rest/api/3/issue/{key}/remotelink`) | `object.title` | `object.url` |
| (c) issuelinks의 연결 이슈 | `<링크타입> (KEY) 요약` | browse URL |
| (d) description(ADF) 안의 URL — link mark, inlineCard/blockCard/embedCard, 텍스트 속 http(s) URL | 호스트로 추정: notion → `Notion 문서`, figma → `Figma`, docs.google → `Google 문서`, atlassian.net/wiki → `Confluence`, 그 외 호스트명. link mark 텍스트가 URL이 아니면 그 텍스트 | 추출한 URL |

---

## 8. 가드레일

- **Jira는 GET만.** 모든 Jira REST 호출은 `src/main/services/jira.ts`에 있고 `method: 'GET'`만 쓴다.
  확인: `grep -n "method:" src/main/services/jira.ts`가 전부 `'GET'`.
- **삭제 금지.** 싱크업 경로에 프로젝트·작업·문서 DELETE가 없다.
- **수동 프로젝트 불변.** 매칭되지 않은 행은 읽기만 한다 (R4).
- **고른 것만 쓴다.** 선택에 없는 항목에는 어떤 쓰기도 하지 않는다 (R9). selection은 renderer 값이라 main에서 다시 검증한다.
- **덮어쓰기는 확인 후에만.** 값을 덮어쓰는 UPDATE는 `force=true`일 때만 돌고, 대상 컬럼은 R10의 필드로 한정한다.
- **멱등.** 재적용 시 변화 0건 (R8).
- **계획은 순수 함수.** `project-sync-plan.ts`·`project-sync-adf.ts`는 electron·better-sqlite3·`../db`를 import하지 않는다 —
  Jira 스냅샷과 DB 스냅샷만으로 계획을 만들어 픽스처로 규칙을 검증할 수 있게.
- **적용은 트랜잭션.** Jira 조회를 끝낸 뒤 한 트랜잭션으로 적용하므로 중간 실패 시 DB가 반쯤 바뀌지 않는다.

---

## 9. 파일 지도

| 파일 | 역할 |
|------|------|
| `src/main/services/jira.ts` | Jira 조회 함수(GET만). JQL 키 검증, `/search/jql` 페이지네이션, `MAX_SYNC_ISSUES`·`SYNC_TRIGGER_STATUS` 상수 |
| `src/main/services/project-sync-plan.ts` | **순수 함수** — 분류(R1~R3)·매칭(R5)·diff(R6)·신규 기본값(R7)·선택 검증과 선택 항목 거르기(R9)·강제 업데이트 내용(R10) |
| `src/main/services/project-sync-adf.ts` | **순수 함수** — ADF → 평문, ADF 속 링크 추출과 호스트별 이름 추정 |
| `src/main/services/project-sync.ts` | 오케스트레이션 — Jira fetch → 스냅샷, DB 읽기 → 계획, 트랜잭션 적용, 활동 로그. preview는 **항상 새로 조회**해 스냅샷을 캐시하고, apply는 그 캐시로 **현재 DB 기준 재계획** 후 적용한다. apply는 Jira를 다시 조회하지 않는다 — 캐시가 없거나 10분이 지났으면 `미리보기가 만료되었습니다…` 오류(사용자가 보지 않은 계획이 반영되지 않게) |
| `src/main/db/database.ts` | 마이그레이션 — `projects.jira_issue_key TEXT`, `tasks.jira_issue_key TEXT` (CREATE TABLE과 ALTER 둘 다) |
| `src/main/ipc/project-sync.ipc.ts` | IPC 핸들러, `src/main/index.ts`에서 등록 |
| `src/main/ipc/release-note.ipc.ts` | Jira 자격 저장·연결 해제·기본 프로젝트 변경 시 싱크업 미리보기 캐시를 비운다 — 다른 계정·프로젝트의 미리보기가 적용되지 않게 |
| `src/main/services/project-sync-plan.test.ts` | 규칙 테스트 — 이름에 `R1`~`R10` 포함 |
| `src/main/services/project-sync.test.ts` | DB 적용·멱등성·수동 프로젝트 보존 — better-sqlite3를 `node:sqlite` 인메모리 shim으로 바꿔 실제 스키마로 검증 (`release-note-sync.test.ts` 패턴) |
| `src/main/services/__fixtures__/project-sync/` | 실제 Jira 응답 형태를 본뜬 픽스처 |
| `src/renderer/src/stores/projectSyncStore.ts` | 미리보기·선택 상태. 기본 선택은 새 프로젝트 항목만, 기존 항목은 확인 후 선택되고 `force=true`로 보낸다 (R9·R10) |
| `src/renderer/src/components/project/ProjectSyncModal.tsx` | 미리보기 모달 — 항목 체크박스, 기존 항목 경고, 덮어쓰기 확인 팝업(`forceChanges`와 `forceTasks` 목록 표시) |
| `src/renderer/src/components/project/ProjectSyncModal.test.tsx` | 렌더러 미리보기·선택·적용 모달 테스트 |

---

## 10. IPC 계약

| 채널 | preload | 반환 |
|------|---------|------|
| `projectSync:preview` | `window.api.projectSync.preview()` | `{ success: true, plan: ProjectSyncPlan } \| { success: false, error: string }` |
| `projectSync:apply` | `window.api.projectSync.apply(selection: ProjectSyncSelection[])` | `{ success: true, result: ProjectSyncResult } \| { success: false, error: string }` |

```ts
export type ProjectSyncSkipReason = 'qa' | 'no_epic' | 'tracked_in_project'
export interface ProjectSyncSelection {
  jiraKey: string
  force: boolean                    // 기존 프로젝트 항목 강제 업데이트(R10). create 항목에는 의미 없음
  projectId: number | null          // 미리보기 항목의 projectId 그대로. 재계획 결과와 다르면 거부
}
export interface ProjectSyncPlanItem {
  jiraKey: string
  summary: string
  kind: 'epic' | 'sustain'
  action: 'create' | 'update' | 'unchanged'
  projectId: number | null          // create면 null
  projectName: string               // 기존 프로젝트 이름 또는 생성될 이름
  matchedBy: 'jira_key' | 'document_url' | 'name' | null
  newTasks: number
  updatedTasks: number              // status 전진 또는 키 백필이 일어나는 기존 작업 수
  newDocuments: number
  forceChanges: number              // 이름 1 + 설명 1 + forceTasks.length. create 항목은 0
  forceTasks: ProjectSyncForceTask[] // 강제 업데이트로 이름·상태·마감일이 바뀌는 기존 작업. create 항목은 []
}
export interface ProjectSyncForceTask {
  before: string                    // 현재 작업 이름
  after: string                     // Jira 기준 이름
}
export interface ProjectSyncSkipped {
  jiraKey: string
  summary: string
  reason: ProjectSyncSkipReason
  detail: string | null
}
export interface ProjectSyncPlan {
  items: ProjectSyncPlanItem[]
  skipped: ProjectSyncSkipped[]
  truncated: boolean                // Jira 조회 상한에 걸림
  triggerCount: number              // Jira에서 찾은 트리거 이슈 수 (하위 작업 제외)
  fetchedAt: string                 // ISO
}
export interface ProjectSyncResult {
  created: number
  updated: number
  unchanged: number
  tasksAdded: number
  tasksUpdated: number
  documentsAdded: number
  skipped: ProjectSyncSkipped[]
}
```

에러 메시지는 한국어로, 사용자가 취할 조치를 담는다(Jira 미연결, 기본 프로젝트 키 미설정, 미리보기 만료,
빈 선택 `적용할 항목을 선택해 주세요.`, 미리보기에 없는 항목·잘못된 선택 형식, 미리보기 이후 프로젝트 변경 등).

---

## 11. 알려진 한계

- **상태명 `할 일` 의존.** 트리거는 응답의 상태 **이름**(`SYNC_TRIGGER_STATUS`와 번역 전 이름 `Open`·`To Do`)으로 고른다.
  Jira 워크플로에서 상태 이름이 바뀌면 트리거가 0건이 된다 — 미리보기의 조회 건수(`triggerCount`)로 알아챌 수 있다.
- **Sustain/QA 판정이 요약 패턴 기반.** 에픽 레벨은 요약뿐이다(작업 레벨 QA는 이슈 타입·labels로도 판정).
  QA 패턴은 부분 일치라 `QA 자동화 도구 개발` 같은 에픽도 전체가 제외된다. Sustain 패턴은
  `Sustain 정책 개선`을 Sustain으로 보고, `서스테인`·`유지보수`는 놓친다.
- **에픽 없는 작업은 건너뜀.** 비-Sustain 작업에 에픽이 없으면 `no_epic`으로 보고만 한다.
- **조회 상한.** 검색당 500건(`MAX_SYNC_ISSUES`)을 넘는 이슈는 계획에 들어가지 않는다. 트리거는 최신 키부터 가져오므로 오래된 할 일 이슈가 빠진다. `truncated`로 알리지만 나머지는 처리되지 않는다.
- **기존 프로젝트는 UI에서 항상 강제 업데이트.** 기존 항목을 고르면 늘 `force=true`로 보낸다 — 추가만 하는 보수 갱신(§5)은 화면에서 선택할 수 없다.
- **이름 매칭은 정확 일치.** 정규화 후에도 표기가 조금 다르면 매칭되지 않아 새 프로젝트가 만들어진다.
  막으려면 **싱크업 전에** 기존 프로젝트에 이슈 링크(`/browse/KEY`)를 문서로 넣어 둔다(§4의 2).
  한 번 새 프로젝트가 생기면 다음부터는 그 프로젝트가 jira_key로 먼저 매칭되므로, 그 뒤에 문서를 넣어도 기존 프로젝트로 옮겨지지 않는다.
- **삭제 기록이 없다.** 싱크업이 만든 프로젝트·작업·문서를 지워도, Jira 티켓이 `할 일`인 동안은 다음 싱크업에서 다시 생긴다.
---

## 12. 규칙 변경 절차

1. **이 문서를 먼저 고친다** — §3 표의 규칙과 이유, 영향받는 §4~§7.
2. **픽스처·테스트** — `__fixtures__/project-sync/`에 사례를 추가하고, 해당 규칙 ID를 이름에 넣은 테스트를 `project-sync-plan.test.ts`에 추가·수정한다. 새 규칙이면 다음 번호(R11…)를 부여한다.
3. **구현** — `project-sync-plan.ts`를 고쳐 테스트를 통과시킨다. 적용 로직이 바뀌면 `project-sync.test.ts`도.
4. **검증** — `/project-sync` 스킬의 완료 조건을 `sync-verifier`로 판정한다.
