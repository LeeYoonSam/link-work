# 데이터 백업 · 복원 (내보내기 / 가져오기)

> 새 PC로 옮기거나 데이터를 보관할 때 앱 데이터 전체를 **zip 파일 하나**로 내보내고, 다른 기기에서 그 파일을 골라 통째로 복원한다.
> 진입: 사이드바 하단 **"데이터 백업 · 복원"** → 모달.

## 1. 무엇이 어디에 있나

앱 데이터는 소스코드 폴더가 아니라 `app.getPath('userData')` = `~/Library/Application Support/LinkWork/`에 있다.

| 항목 | 백업 포함 | 비고 |
|---|---|---|
| `linkwork.db` (SQLite, WAL) — 프로젝트·작업·TODO·메모·문서·변수·회의(전사/화자/컷/요약/참석자)·용어집/구성원·릴리스 노트·AI 대화·활동 로그·설정 | **포함** | 기기 종속 시크릿만 제거(아래) |
| `recordings/` (`<id>.wav`, `<id>.channels.json`, `<id>.compaction.json`) | **포함** | DB는 파일명만 저장하므로 경로 독립 |
| `ai-attachments/` (AI 대화 이미지) | **포함** | |
| `models/` (whisper·silero·sherpa, 1.4GB) | 제외 | 첫 실행 시 자동 다운로드 |
| `Cache`, `GPUCache`, `Cookies`, `Session Storage` … | 제외 | Electron 캐시 |
| `auth_tokens`(Google OAuth), `app_settings`의 `notion_token`·`jira_api_token` 등 `safeStorage` 암호문 | **제외** | macOS 키체인 키로 암호화돼 다른 기기에서 복호화 불가 → 새 PC에서 다시 연결 |

Claude Code 구독 OAuth(AI 요약·AI 대화)는 앱 데이터가 아니라 `~/.claude`에 있으므로 새 PC에 Claude Code를 설치·로그인해야 한다.

⚠️ 백업 파일에는 평문 설정(`google_client_id`/`google_client_secret`, Jira 사이트·이메일 등)과 회의 전사·요약 전문이 들어 있다. 공유 드라이브·메신저 등 남이 볼 수 있는 곳에 두지 말고, 이전이 끝나면 삭제하는 것이 좋다.

## 2. 백업 파일 형식 (zip)

```
LinkWork-backup-YYYYMMDD-HHmmss.zip
  manifest.json        # 마지막 엔트리 — 존재 = 완전한 백업
  linkwork.db          # VACUUM INTO 스냅샷 → 시크릿 제거 → VACUUM(삭제 페이지 스크럽)
  recordings/          # userData/recordings 바로 아래 파일 전부 (.wav는 비압축 저장)
  ai-attachments/      # userData/ai-attachments 바로 아래 파일 전부
```

스트리밍(yazl 쓰기 / yauzl 읽기)이라 수 GB 녹음도 메모리에 올리지 않는다. 가져오기는 임시 폴더에 추출한 뒤 복원하며, `..`·절대경로 엔트리(zip slip)는 거부한다. 파일 하나라 AirDrop·USB로 옮기기 쉽고 일부만 복사되는 실수가 없다.

`manifest.json`(`BackupManifest`): `format:'linkwork-backup'`, `formatVersion`(현재 1), `appVersion`, `createdAt`, `platform`, `db.tables`(테이블별 행 수)·`db.bytes`, `files.recordings/attachments`(개수·바이트), `excluded`(제거한 시크릿 목록).

## 3. 동작

**내보내기** (`backup:export` → `backup-service.exportBackup`)
1. 저장 위치 선택(시스템 저장 다이얼로그) → `LinkWork-backup-<시각>.zip`
2. 라이브 DB에 `VACUUM INTO`(임시 파일, WAL 안전 일관 스냅샷) → 사본을 열어 `stripSecrets`(`SECRET_TABLES`, `SECRET_SETTING_KEYS`) → `VACUUM` → zip 엔트리로 기록
3. 녹음·첨부 파일을 스트리밍으로 zip에 추가(바이트 누적 진행률) → `manifest.json`을 마지막 엔트리로 기록
4. 실패 시 만들다 만 zip을 삭제하고 오류 표시

**가져오기** (`backup:pick` → `inspectBackup`, `backup:import` → `importBackup`) — 모드는 **전체 대체**
1. 백업 zip 선택 → manifest 검증(형식·버전: 현재보다 높은 `formatVersion`은 거부, `linkwork.db` 엔트리 필수) → 요약(행 수·파일 수·용량·경고) 표시
2. 확인 체크 후 "복원 후 재시작": zip을 임시 폴더에 추출 → 현재 `linkwork.db`를 `linkwork.db.bak-<시각>`으로 보관 → DB 닫기 → `-wal`/`-shm` 삭제 → 백업 DB 복사 → `recordings/`·`ai-attachments/` **덮어쓰기 복사**(현재 폴더의 다른 파일은 지우지 않음)
3. 앱 재시작(`app.relaunch`) → `initDatabase`가 구버전 백업이면 스키마 마이그레이션까지 수행
4. 진입 조건: 처리 중(`meetings.status='processing'`)이거나 녹음 중이면 거부

병합(merge) 모드는 지원하지 않는다(ID 충돌 해소가 필요해 별도 설계).

## 4. 계약

- 서비스: `src/main/services/backup-service.ts` — `BACKUP_FORMAT_VERSION`, `SECRET_TABLES`, `SECRET_SETTING_KEYS`, `validateManifest`, `planFileCopies`, `stripSecrets`, `exportBackup`, `inspectBackup`, `importBackup` (경로는 `BackupPaths {userDataDir, dbPath}`로 주입 가능 — 테스트는 임시 디렉터리 + node:sqlite shim)
- IPC: `backup:export` / `backup:pick` / `backup:import(path)` / 이벤트 `backup:progress` (`BackupProgress {phase:'db'|'files'|'done'|'error', progress, message?}`)
- 렌더러: `window.api.backup` (`BackupAPI`: `exportToFile` / `pickBackup` / `importBackup(path)` / `onProgress`), `stores/backupStore.ts`, `components/layout/BackupModal.tsx`, 사이드바 하단 버튼

## 5. 새 PC 이전 절차

1. 기존 PC: 앱에서 **내보내기** → 생성된 zip 파일을 외장 디스크/AirDrop 등으로 새 PC에 복사
2. 새 PC: 소스 clone → `npm install` → `npm run deploy` → 앱 실행(첫 실행 시 빈 DB 생성)
3. 앱에서 **가져오기** → 백업 zip 선택 → 확인 → 자동 재시작
4. Google 캘린더·Notion·Jira 다시 연결, Claude Code 로그인, 마이크/시스템 오디오 권한 허용
5. 회의 처리 시 음성 모델은 자동 다운로드(약 1.4GB)
