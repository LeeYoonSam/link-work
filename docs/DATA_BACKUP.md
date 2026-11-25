# 데이터 백업 · 복원 (내보내기 / 가져오기)

> 새 PC로 옮기거나 데이터를 보관할 때 앱 데이터 중 **고른 항목(그룹)** 을 **zip 파일 하나**로 내보내고, 다른 기기에서 그 파일을 골라 **고른 항목만** 복원한다.
> 진입: 사이드바 하단 **"설정"** → **데이터** → [백업·복원 열기] → 모달.

## 1. 무엇이 어디에 있나

앱 데이터는 소스코드 폴더가 아니라 `app.getPath('userData')` = `~/Library/Application Support/LinkWork/`에 있다.

| 항목 | 백업 포함 | 그룹 | 비고 |
|---|---|---|---|
| `linkwork.db` (SQLite, WAL) — 프로젝트·작업(옛 데이터)·TODO·메모·문서·변수·회의(전사/화자/컷/요약/참석자)·용어집/구성원·구성원 목소리 표본·릴리스 노트·AI 대화·활동 로그·설정 | **포함** | 테이블마다 아래 그룹 표 | 기기 종속 시크릿만 제거(아래) |
| `recordings/` (`<id>.wav`, `<id>.channels.json`, `<id>.compaction.json`) | **포함** | `meetings` | DB는 파일명만 저장하므로 경로 독립 |
| `ai-attachments/` (AI 대화 이미지) | **포함** | `ai` | |
| `models/` (whisper·silero·sherpa, 1.4GB) | 제외 | — | 첫 실행 시 자동 다운로드 |
| `Cache`, `GPUCache`, `Cookies`, `Session Storage`, `Local Storage` … | 제외 | — | Electron 캐시. 렌더러의 localStorage(메모 화면 상태 등)도 여기라 백업되지 않는다 |
| `auth_tokens`(Google OAuth), `app_settings`의 `notion_token`·`jira_api_token`·`google_client_secret`·`bitbucket_api_token`. 모두 `safeStorage` 암호문이다 | **제외** | — | macOS 키체인 키로 암호화돼 다른 기기에서 복호화 불가 → 새 PC에서 다시 연결. 복원해도 **이 기기의 값은 유지**한다(§3 연동 묶음 규칙) |
| `app_settings`의 `mobile_server_token`(휴대폰 열람 페어링 토큰, `safeStorage` 암호문)·`mobile_server_enabled`(켜짐 여부) | **제외** | — | 기기 종속이다(`DEVICE_ONLY_SETTING_KEYS`). 백업 사본에서 지우고 복원해도 **이 기기의 값을 유지**한다 — 새 PC 로 복원했을 때 서버가 저절로 켜지지 않는다. 새 PC에서는 설정 > 모바일에서 다시 켜고 QR 을 새로 스캔한다([MOBILE_VIEW.md](MOBILE_VIEW.md)) |

### 1.1 백업 그룹

내보내기·복원은 아래 5개 그룹 단위로 고른다. 그룹 ID 와 순서는 고정이다: `work`, `meetings`, `library`, `ai`, `settings`.
화면에는 메뉴 이름으로 보인다. 정의는 `src/main/services/backup-groups.ts`(`GROUP_TABLES`, `GROUP_FILE_DIRS`, `classifySettingKey`), 화면 라벨은 `src/renderer/src/components/layout/backupGroups.ts`.

| 그룹 ID | 화면 이름 (메뉴) | 테이블 | `app_settings` 키 | 파일 |
|---|---|---|---|---|
| `work` | 오늘·업무 (오늘, 프로젝트(릴리스 탭 포함), 할 일). `activity_log` 는 화면에 보이지 않지만 활동 기록으로 계속 쌓이고 이 그룹에 든다 | projects, tasks, todos, todo_tags, todo_tag_map, todo_history, release_notes, release_note_items, activity_log, daily_plans, plan_items, assistant_events, assistant_exclusions | `project_sync_created_keys` | 없음 |
| `meetings` | 회의 (녹음, 회의록, 용어집·구성원) | meetings, meeting_speakers, meeting_segments, meeting_cuts, meeting_summaries, meeting_attendees, meeting_members, stt_glossary, meeting_speaker_voices, member_voice_samples | 없음 | `recordings/` |
| `library` | 자료 (메모, 변수, 예전 문서 메뉴의 문서) | documents, memos, memo_categories, variables | 없음 | 없음 |
| `ai` | AI 대화 | ai_chats, ai_messages, ai_audit_log | 없음 | `ai-attachments/` |
| `settings` | 설정·연동 | (없음 — `app_settings` 를 키 단위로) | `assistant_*`, `ai_model`, `ai_model_labels`, `google_client_id`, `jira_site_url`, `jira_email`, `jira_token_expires_at`, `jira_account_name`, `jira_default_project_key`, `bitbucket_email`, 그리고 분류되지 않은 모든 키(기본값) | 없음 |
| (백업 제외) | — | auth_tokens, jira_board_issues, jira_board_sync, jira_epic_summaries | 시크릿 4개(위 표), `mobile_server_token`, `mobile_server_enabled` | models/, Electron 캐시 |

- `documents` 는 메뉴가 없는 옛 문서 테이블이다. 남은 데이터를 `library` 그룹으로 백업·복원한다. 화면 라벨의 "예전 문서 메뉴의 문서"가 이 테이블이다.
- 비서 테이블(`daily_plans`·`plan_items`·`assistant_events`·`assistant_exclusions`)은 업무와 같은 그룹이다. 옛 계획 항목(`plan_items.candidate_id`)이 `todo:<id>`(더 옛 행은 `task:<id>`)로 할 일을 가리키기 때문이다.
- `jira_board_issues`·`jira_board_sync` 는 프로젝트 보드의 Jira 캐시다(docs/PROJECT_BOARD.md §3). Jira 에서 다시 받을 수 있어 백업하지 않는다(`NON_GROUP_TABLES`, `CACHE_TABLES`).
- `jira_epic_summaries` 는 보드 캐시로 만든 에픽 AI 요약이다(docs/PROJECT_BOARD.md §5.1). 버튼으로 다시 만들 수 있어 보드 캐시와 같이 취급한다(`NON_GROUP_TABLES`, `CACHE_TABLES`).
  내보낼 때 사본에서 세 테이블의 행을 지운다(`stripCaches`). 복원은 이 기기의 캐시를 그대로 두되, 복원으로 Jira 계정이 바뀌면 함께 지운다(아래 연동 묶음 규칙). 캐시가 비면 다음 화면 진입 때 보드가 전체 동기화를 한다.
- `meeting_members`·`stt_glossary` 는 회의 그룹이다. `meeting_attendees` 가 `meeting_members` 를 FK 로 가리키고, 둘 다 회의 인식 보조다.
- `meeting_speaker_voices`(회의 화자 목소리)·`member_voice_samples`(구성원 목소리 표본)도 회의 그룹이다. `meeting_speakers`·`meeting_members`·`meetings` 를 FK 로 가리킨다. 목소리 임베딩(오디오 아님)이 **백업 파일에 포함된다** — 새 PC 에서도 목소리 자동 지정이 이어진다([MEETING_RECORDING.md](MEETING_RECORDING.md) §12).
- **새 테이블을 만들면 반드시 한 그룹(또는 백업 제외)에 넣는다.** 빠지면 테스트 G1 이 실패한다. 그룹을 추가·변경하면 `formatVersion` 을 올린다.

**그룹을 넘는 참조.** 기본 규칙은 **정체성 일치**다 — 참조 대상 행의 `id` 와 `created_at` 이 모두 같을 때만 같은 엔터티로 본다(id 만 같은 다른 기기의 행에 붙지 않게).

| # | 참조 | 복원 때 처리 |
|---|---|---|
| X1 | `meetings.project_id` → projects | 정체성이 일치하면 유지, 아니면 NULL |
| X2 | `stt_glossary.project_id` → projects | 같음 |
| X3 | `documents.project_id` → projects | 같음 |
| X4 | `meeting_summaries.action_items[*].todo_id` → todos (JSON) | 일치하지 않으면 JSON 안의 `todo_id` 를 null |
| X5 | `plan_items.candidate_id` `action_item:<meetingId>:<i>` → meetings | 값은 바꾸지 않는다(NOT NULL·UNIQUE). `status='active'` 인 계획에서 일치하지 않는 건수를 경고로 알린다 |
| X6 | `activity_log.entity_id` | 처리하지 않는다(표시는 `entity_name` 을 쓴다) |
| X7 | AI 메시지 본문의 `linkwork://` 링크 | 처리하지 않는다(약한 링크) |
| X8 | `ai_chats.session_id`(~/.claude), `assistant_events.ref_id`(캘린더) | 외부 id — 지금과 같다 |

그룹 간 자동 포함은 없다. 남은 참조는 모두 끊기만 하면 되는 링크라, 화면에서 경고만 한다.

`bitbucket_email`은 평문이라 백업에 남는다.
앱은 Bitbucket 연결을 token 기준으로 판정한다.
그래서 복원 직후 Bitbucket 은 미연동으로 보인다. 사용자는 새 PC 에서 API token 만 다시 등록한다.

Claude Code 구독 OAuth(AI 요약·AI 대화)는 앱 데이터가 아니라 `~/.claude`에 있으므로 새 PC에 Claude Code를 설치·로그인해야 한다.

⚠️ 백업 파일에는 평문 설정(`google_client_id`, Jira 사이트·이메일 등)과 회의 전사·요약 전문과 구성원 목소리 임베딩이 들어 있다. (`google_client_secret`은 키체인 암호문으로 저장하므로 백업에서 빠진다.) 공유 드라이브·메신저 등 남이 볼 수 있는 곳에 두지 말고, 이전이 끝나면 삭제하는 것이 좋다.

## 2. 백업 파일 형식 (zip)

```
LinkWork-backup-YYYYMMDD-HHmmss.zip
  manifest.json        # 마지막 엔트리 — 존재 = 완전한 백업
  linkwork.db          # VACUUM INTO 스냅샷 → 시크릿 제거 → VACUUM(삭제 페이지 스크럽)
  recordings/          # userData/recordings 바로 아래 파일 전부 (.wav는 비압축 저장)
  ai-attachments/      # userData/ai-attachments 바로 아래 파일 전부
```

스트리밍(yazl 쓰기 / yauzl 읽기)이라 수 GB 녹음도 메모리에 올리지 않는다. 가져오기는 임시 폴더에 추출한 뒤 복원하며, `..`·절대경로 엔트리(zip slip)는 거부한다. 파일 하나라 AirDrop·USB로 옮기기 쉽고 일부만 복사되는 실수가 없다.

`manifest.json`(`BackupManifest`): `format:'linkwork-backup'`, `formatVersion`(현재 **2**), `appVersion`, `createdAt`, `platform`, `groups`(담긴 그룹 ID, 고정 순서·중복 없음·1개 이상), `db.tables`(그룹 필터 **뒤**의 테이블별 행 수 — 빠진 그룹은 0)·`db.bytes`, `files.recordings/attachments`(개수·바이트 — 빠진 그룹은 0), `excluded`(제거한 시크릿 목록).

**formatVersion 과 호환**
- `formatVersion: 1` — 그룹 개념 이전의 백업. 언제나 전체였으므로 `groups` 를 5개 전체로 정규화해 읽는다. 화면에는 "이전 형식(전체) 백업"으로 표시하고, 전체 복원과 일부 복원 모두 된다.
- `formatVersion: 2` — `groups` 가 없거나, 비었거나, 모르는 그룹 id 가 있으면 거부한다.
- 2보다 큰 버전은 거부한다(앱 업데이트 안내).
- 버전을 올린 이유: 구버전 앱(v1)은 복원 때 DB 파일을 통째로 바꾸므로, 부분 백업을 읽으면 고르지 않은 데이터가 사라진다. v2 백업은 구버전이 거부하므로 이 사고가 막힌다.
- 정책: **그룹을 추가하거나 바꾸면 `formatVersion` 을 반드시 올린다.**

**`linkwork_backup_refs`** — 부분 백업에서 참조 부모 그룹(projects·todos·meetings)을 뺐을 때, 사본 DB 에 `linkwork_backup_refs(tbl TEXT, id INTEGER, created_at TEXT, PRIMARY KEY(tbl,id))` 를 만들어 그 테이블의 `id`·`created_at` **만** 담는다(이름 등 내용은 없음). 복원 때 X1~X4 의 정체성 판정에 쓴다. 스키마 비교에서는 제외한다.

## 3. 동작

**화면** (`BackupModal`)
- 내보내기: 그룹 체크박스 5개(기본 전체 선택). 0개면 저장 버튼이 잠긴다. 각 그룹 옆에 현재 건수(대표 테이블: 오늘·업무=프로젝트·할 일, 회의=회의, 자료=문서·메모·변수, AI 대화=대화, 설정·연동=설정 키 수)와 파일 개수·용량(회의·AI 대화)을 `backup:stats` 로 받아 보여준다. 숫자를 못 받아도 내보내기는 된다.
- 복원: 파일에 든 그룹만 고를 수 있고 기본은 전부 선택. 파일에 없는 그룹은 비활성 + "이 백업에 없음". 그룹마다 "현재 N건 → 백업 M건"(현재는 stats, 백업은 `manifest.db.tables`). 설정·연동만은 "현재 설정 키 N개"로 현재 쪽만 보인다 — stats 는 settings 로 분류된 키만, `manifest.db.tables.app_settings` 는 app_settings 전체 행을 세서 비교하면 숫자가 어긋난다. 확인 체크는 `confirmKey(path, 정렬된 그룹)` 에 걸려, 다른 백업을 고르거나 그룹 선택을 바꾸면 저절로 풀린다. 버튼은 "선택 항목 복원 후 재시작".
- 경고: 선택한 항목은 **교체**(합치지 않음)·고르지 않은 항목은 그대로·보관 위치(`linkwork.db.bak-<시각>`, `recordings.bak-<시각>/`, `ai-attachments.bak-<시각>/`). 일부만 고르면 그룹 간 연결이 끊길 수 있다는 경고, 설정·연동을 고르면 연동 계정이 다르면 다시 연결해야 한다는 경고를 더한다.

**내보내기** (`backup:export(groups)` → `backup-service.exportBackup`)
1. 그룹 검증(빈 배열·모르는 id 는 거부) → 저장 위치 선택(시스템 저장 다이얼로그) → `LinkWork-backup-<시각>.zip`
2. 라이브 DB에 `VACUUM INTO`(임시 파일, WAL 안전 일관 스냅샷) → 사본을 연다.
3. 사본에서 **`PRAGMA foreign_keys=OFF` 를 먼저** 건다 — 켠 채로 projects 를 지우면 사본 안의 `meetings.project_id` 가 SET NULL 로 지워진다.
4. `stripSecrets`(`SECRET_TABLES`, `SECRET_SETTING_KEYS`) → `stripCaches`(`CACHE_TABLES`: 보드 캐시·에픽 AI 요약 행 삭제) → `filterSnapshotGroups`: 빠진 그룹의 테이블을 DELETE(스키마는 남김), 빠진 그룹의 `app_settings` 키 삭제, 필요하면 `linkwork_backup_refs` 채우기 → `VACUUM` → 행 수 집계 → zip 엔트리로 기록
5. 고른 그룹의 폴더(`recordings/`·`ai-attachments/`)만 스트리밍으로 zip에 추가(바이트 누적 진행률) → `manifest.json`을 마지막 엔트리로 기록
6. 실패 시 만들다 만 zip을 삭제하고 오류 표시

**가져오기** (`backup:pick` → `inspectBackup`, `backup:import(path, groups)` → `importBackup`) — 모드는 **선택 그룹 테이블 교체**

선택한 그룹은 현재 데이터를 백업 내용으로 **교체**한다(병합 아님). 선택하지 않은 그룹은 행을 지우거나 넣지 않고 파일도 바꾸지 않는다. 예외는 그룹 간 연결뿐이다: 교체된 그룹을 가리키던 연결(회의·문서·용어집의 프로젝트, 회의 액션아이템의 할 일)은 같은 엔터티로 확인되지 않으면 끊는다(§1.1 X1~X4). 고를 수 있는 그룹은 `manifest.groups` 의 부분집합이다.

- 현재 DB 파일이 없는 새 기기에서도 같은 경로를 탄다. 빈 스키마 DB 에 선택한 그룹만 넣으므로 고르지 않은 그룹은 들어오지 않는다.
- 내보내기와 복원은 동시에 하나만 실행한다. 진행 중이거나 재시작을 기다리는 동안 들어온 요청은 거부한다.
- 연동 계정 비교는 앞뒤 공백, 대소문자, 끝 슬래시를 무시한다. 다시 연결 경고는 실제로 지운 자격이 있을 때만 낸다.
- DB 커밋 뒤 파일 복사가 실패하면 DB 는 복원된 상태로 남는다. 덮어쓰기 전 원본은 `<dir>.bak-<시각>/` 에 있다.

1. 백업 zip 선택 → manifest 검증(형식·버전·groups, `linkwork.db` 엔트리 필수) → 요약(그룹·행 수·파일 수·용량·경고) 표시
2. 확인 체크 후 "선택 항목 복원 후 재시작". 아래 a~c 는 라이브 DB 를 닫기 **전**이라 실패해도 아무것도 바뀌지 않고 재시작하지 않는다.
   a. 요청 그룹이 비어 있지 않고 `manifest.groups` 의 부분집합인지 검증(아니면 거부, `.bak` 도 만들지 않음)
   b. 여유 공간 확인 → DB 와 **선택 그룹의 파일만** 임시 폴더에 추출(zip slip 거부)
   c. `prepareBackupDb`: 백업 DB 사본을 `applySchema()` 로 현재 스키마까지 올린다(오래된 백업의 빠진 컬럼은 여기서 해결). 그 뒤 라이브 스키마와 비교해 **모르는 테이블이나 컬럼이 있으면(더 새 앱의 백업) 거부**하고 앱 업데이트를 안내한다 — 테이블 단위 복원에서는 모르는 컬럼이 조용히 버려지기 때문이다.
3. DB 를 닫고 `linkwork.db` 를 `linkwork.db.bak-<시각>` 으로 복사한다. 제자리에서 수정하므로 **`-wal`/`-shm` 은 지우지 않는다**(깨끗하게 닫으면 체크포인트되고, 지우면 남은 프레임을 잃을 수 있다).
4. `mergeBackupIntoLive`: 라이브 파일을 새 연결로 열고 `foreign_keys=OFF`(트랜잭션 밖) → 백업 사본을 `ATTACH ... AS bk` → `BEGIN IMMEDIATE` 한 트랜잭션에서
   - 교체 전 부모(projects/todos/meetings)의 `(id, created_at)` 를 TEMP 테이블에 담는다.
   - 선택 그룹의 각 테이블을 `DELETE` 후 공통 컬럼으로 `INSERT ... SELECT FROM bk.t`. `app_settings` 는 키 분류에 따라 행 단위로 바꾸고 연동 묶음 규칙(아래)을 적용한다.
   - `sqlite_sequence` 는 교체한 테이블마다 `max(라이브 seq, 백업 seq, max(id))` 로 둔다 — 새 id 가 남아 있는 옛 녹음 파일(`<id>.wav`)이나 옛 참조와 겹치지 않게.
   - X1~X4 를 정체성 규칙으로 정리한다(자식이 복원되고 부모가 라이브면 bk/refs 와 라이브를, 자식이 라이브고 부모가 복원되면 교체 전 TEMP 와 bk 를 비교). X5 는 건수만 센다.
   - `PRAGMA foreign_key_check` — 선택 그룹 테이블과 X1~X3 자식 테이블에 위반이 있으면 throw. 기존 데이터의 무관한 위반 때문에 복원이 실패하지 않도록 범위를 한정했다.
   - `COMMIT`. 예외가 나면 `ROLLBACK` 해 라이브 DB 는 원래대로 남고, `.bak` 경로를 안내한 뒤 재시작한다.
5. 커밋 뒤 선택 그룹의 파일을 복사한다. 같은 이름의 기존 파일은 먼저 `userData/<dir>.bak-<시각>/`(`recordings.bak-<시각>/`, `ai-attachments.bak-<시각>/`)로 rename 한다 — 같은 볼륨이라 빠르고 되돌릴 수 있다. 같은 폴더의 다른 파일은 지우지 않는다.
6. 앱 재시작(`app.relaunch`). 복원 결과에 경고(연동 재연결, 끊긴 계획 항목 등)가 1건 이상이면 `backup:import` 가 `restartPending: true` 를 돌려주고 자동 재시작하지 않는다 — 모달이 경고와 [확인 후 재시작]만 보여주고(닫기·다른 조작 불가), 버튼이 `backup.restart()` 로 재시작한다. 경고가 없으면 1초 뒤 자동 재시작한다.
7. 진입 조건: 처리 중(`meetings.status='processing'`)이거나 녹음 중이면 거부

**연동 묶음 규칙** (`CREDENTIAL_BUNDLES`) — 시크릿은 늘 백업에서 빠지므로, 복원 때 이 기기의 값을 묶음 단위로 판정한다.

| 묶음 | 식별 키 | 자격(이 기기 값) |
|---|---|---|
| jira | `jira_site_url`, `jira_email` | `jira_api_token`, `jira_token_expires_at`, `jira_account_name`, `jira_board_issues`·`jira_board_sync`·`jira_epic_summaries` 테이블(보드 캐시와 그 AI 요약. 계정마다 볼 수 있는 이슈가 다르다) |
| bitbucket | `bitbucket_email` | `bitbucket_api_token` |
| google | `google_client_id` | `google_client_secret`, `auth_tokens` 테이블 |
| notion | (없음) | `notion_token` — 늘 유지 |

- 백업에 식별 키가 없으면 그 묶음은 현재 값 그대로 둔다.
- 식별 키가 현재와 같으면 평문 키는 백업 값, 자격은 현재 값(= 같은 기기에서 복원하면 다시 연결할 필요 없음).
- 식별 키가 다르면 평문 키를 백업 값으로 바꾸고 현재 자격을 지운다 + "다시 연결" 경고.
- `jira_token_expires_at`·`jira_account_name` 은 평문이지만 현재 토큰을 설명하는 값이라 자격 쪽이다.

병합(merge) 모드는 지원하지 않는다(ID 충돌 해소가 필요해 별도 설계). 그룹 단위 복원도 병합이 아니라 **선택 그룹의 교체**다.

## 4. 계약

- 스키마: `src/main/db/schema.ts` — `applySchema(db)`(DDL·마이그레이션 전부, electron 무관). `initDatabase` 와 복원 전 백업 사본 준비가 같은 함수를 쓴다.
- 그룹: `src/main/services/backup-groups.ts` — `BackupGroupId`, `BACKUP_GROUP_IDS`, `GROUP_TABLES`, `GROUP_FILE_DIRS`, `classifySettingKey(key): 'work'|'settings'|'secret'`, `isBackupGroupId`, `normalizeGroups`, `CROSS_GROUP_REFS`, `CREDENTIAL_BUNDLES`, `BACKUP_REFS_TABLE`, `SECRET_TABLES`, `SECRET_SETTING_KEYS`
- DB 병합: `src/main/services/backup-restore-db.ts` — `prepareBackupDb(backupDbPath, liveDbPath)`, `filterSnapshotGroups(copy, groups)`, `mergeBackupIntoLive(liveDbPath, backupDbPath, groups) → { warnings, nulledRefs }`
- 서비스: `src/main/services/backup-service.ts` — `BACKUP_FORMAT_VERSION`(=2), `validateManifest`(v1 → 전체 그룹), `planFileCopies`, `stripSecrets`, `stripCaches`, `exportBackup(zipPath, {groups?})`, `inspectBackup`, `importBackup(zipPath, {groups?}) → { restoredDbBackupPath, groups, warnings }`, `collectGroupStats(db, userDataDir)` (경로는 `BackupPaths {userDataDir, dbPath}`로 주입 가능 — 테스트는 임시 디렉터리 + node:sqlite shim)
- IPC: `backup:stats` → `{success, groups?: BackupGroupStat[], error?}` / `backup:export(groups)` / `backup:pick` / `backup:import(path, groups)` → `{success, groups?, warnings?, restartPending?, error?}` / `backup:restart`(restartPending 뒤 수동 재시작) / 이벤트 `backup:progress` (`BackupProgress {phase:'db'|'files'|'done'|'error', progress, message?}`). groups 가 비었거나 모르는 id 면 `{success:false, error}`.
  - `BackupGroupStat { id, tables: Record<string, number>, files: {count, bytes} }` — settings 는 `tables.app_settings` 에 settings 로 분류되는 키 수.
- 렌더러: `window.api.backup` (`BackupAPI`: `stats` / `exportToFile(groups)` / `pickBackup` / `importBackup(path, groups)` / `restart` / `onProgress`), `stores/backupStore.ts`, `components/layout/backupGroups.ts`(라벨·대표 테이블, `confirmKey`, `canExport`), `components/layout/BackupModal.tsx`, 설정 > 데이터(`components/settings/sections/DataSection.tsx`)

## 5. 새 PC 이전 절차

1. 기존 PC: 앱에서 **내보내기** → 생성된 zip 파일을 외장 디스크/AirDrop 등으로 새 PC에 복사
2. 새 PC: 소스 clone → `npm install` → `npm run deploy` → 앱 실행(첫 실행 시 빈 DB 생성)
3. 앱에서 **가져오기** → 백업 zip 선택 → 복원할 항목 확인(새 PC 는 보통 전체) → 확인 → 재시작(경고가 없으면 자동, 있으면 경고를 읽고 [확인 후 재시작])
4. 설정 > 연동에서 Google 캘린더·Jira·Bitbucket·Notion 을 다시 연결하고, Claude Code 로그인, 마이크/시스템 오디오 권한을 허용한다([SETTINGS.md](SETTINGS.md))
   - Google 캘린더: client secret 이 백업에서 빠지므로 카드가 "설정 필요"로 보인다. [연결]을 눌러 Google Cloud 콘솔의 OAuth Client ID·Secret 을 다시 입력한 뒤 로그인한다.
   - 휴대폰 열람을 쓰면 설정 > 모바일에서 다시 켜고 QR 을 새로 스캔한다.
5. 회의 처리 시 음성 모델은 자동 다운로드(약 1.4GB)
