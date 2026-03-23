# LinkWork - WBS + 미팅 스케줄 관리 앱 구현 계획

## 요구사항 요약

업무용 프로젝트 관리(WBS) 및 구글 캘린더 연동 미팅 스케줄 관리 데스크톱 앱.
Electron 기반 UI, 로컬 알림 지원.

### 핵심 기능
1. **프로젝트 등록/관리**: 개발기간, QA기간(기본 +3일), 배포일자(QA종료 다음날) 입력, 작업 리스트(옵셔널) 등록 및 기간 지정
2. **스크린샷 기반 자동 등록**: 엑셀/스프레드시트 WBS 스크린샷을 Claude Vision API로 분석하여 프로젝트명, 일자, 작업 리스트 자동 추출 및 등록
3. **구글 캘린더 연동**: OAuth2로 일정 가져오기, 10분/5분/1분전 로컬 알림(Notification API)
4. **대시보드**: 진행중 프로젝트 경과율(%) + 긴박도 색상(초록/파랑/빨강), 금일 일정 표시

---

## 기술 스택

| 구분 | 기술 | 선정 이유 |
|------|------|-----------|
| Framework | Electron 33+ | 데스크톱 앱 요구사항, 로컬 알림 지원 |
| Frontend | React 18 + TypeScript | 컴포넌트 기반 UI, 타입 안전성 |
| Build Tool | Vite | 빠른 HMR, Electron 통합 용이 |
| Electron Build | electron-builder | macOS 빌드 지원 |
| Scaffolding | electron-vite | Electron + Vite + React 통합 보일러플레이트 |
| State | Zustand | 경량 상태관리, 보일러플레이트 최소 |
| Storage | SQLite (better-sqlite3) | 로컬 DB, 서버 불필요, 프로젝트/작업 CRUD |
| Calendar API | Google Calendar API v3 | 구글 캘린더 연동 요구사항 |
| OAuth | google-auth-library | Google OAuth2 인증 |
| UI Components | Tailwind CSS 4 + shadcn/ui | 빠른 스타일링, 일관된 디자인 시스템 |
| Date | date-fns | 날짜 계산(경과율, 기간 등) |
| Notification | Electron Notification API | 로컬 알림(10분/5분/1분전) |
| AI Vision | @anthropic-ai/sdk (Claude API) | 스크린샷 이미지 분석, 구조화된 JSON 추출 |

---

## 프로젝트 구조

```
LinkWork/
├── electron.vite.config.ts
├── package.json
├── tsconfig.json
├── README.md
├── resources/                    # 앱 아이콘 등 리소스
├── src/
│   ├── main/                     # Electron Main Process
│   │   ├── index.ts              # 앱 엔트리, BrowserWindow 생성
│   │   ├── db/
│   │   │   ├── database.ts       # SQLite 초기화, 마이그레이션
│   │   │   └── migrations/       # DB 스키마 버전 관리
│   │   ├── ipc/
│   │   │   ├── project.ipc.ts    # 프로젝트 CRUD IPC 핸들러
│   │   │   ├── task.ipc.ts       # 작업 CRUD IPC 핸들러
│   │   │   ├── calendar.ipc.ts   # 캘린더 IPC 핸들러
│   │   │   └── screenshot.ipc.ts # 스크린샷 분석 IPC 핸들러
│   │   ├── services/
│   │   │   ├── google-auth.ts    # Google OAuth2 인증
│   │   │   ├── google-calendar.ts# Google Calendar API 호출
│   │   │   ├── notification.ts   # 로컬 알림 스케줄링
│   │   │   └── screenshot-parser.ts  # Claude Vision API 스크린샷 분석
│   │   └── utils/
│   │       └── date.ts           # 날짜 유틸리티
│   ├── preload/
│   │   └── index.ts              # contextBridge API 노출
│   └── renderer/                 # React Frontend
│       ├── index.html
│       ├── main.tsx              # React 엔트리
│       ├── App.tsx               # 라우팅, 레이아웃
│       ├── components/
│       │   ├── layout/
│       │   │   ├── Sidebar.tsx   # 사이드바 네비게이션
│       │   │   └── Header.tsx    # 헤더
│       │   ├── dashboard/
│       │   │   ├── Dashboard.tsx         # 대시보드 메인
│       │   │   ├── ProjectProgress.tsx   # 프로젝트 진행률 카드
│       │   │   └── TodaySchedule.tsx     # 금일 일정 카드
│       │   ├── project/
│       │   │   ├── ProjectList.tsx       # 프로젝트 목록
│       │   │   ├── ProjectForm.tsx       # 프로젝트 등록/수정 폼
│       │   │   ├── ProjectDetail.tsx     # 프로젝트 상세
│       │   │   ├── TaskList.tsx          # 작업 리스트
│       │   │   └── ScreenshotImport.tsx  # 스크린샷 업로드 및 분석 결과 확인
│       │   └── calendar/
│       │       ├── CalendarView.tsx      # 캘린더 일정 표시
│       │       └── CalendarSettings.tsx  # 구글 연동 설정
│       ├── stores/
│       │   ├── projectStore.ts   # 프로젝트 상태
│       │   └── calendarStore.ts  # 캘린더 상태
│       ├── types/
│       │   └── index.ts          # 타입 정의
│       └── styles/
│           └── globals.css       # Tailwind 글로벌 스타일
```

---

## DB 스키마

```sql
-- 프로젝트
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  dev_start_date TEXT NOT NULL,       -- ISO 8601
  dev_end_date TEXT NOT NULL,
  qa_start_date TEXT NOT NULL,
  qa_end_date TEXT NOT NULL,
  deploy_date TEXT NOT NULL,
  status TEXT DEFAULT 'active',       -- active | completed | cancelled
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 작업 (프로젝트에 종속)
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  status TEXT DEFAULT 'pending',      -- pending | in_progress | done
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- API 설정 (Claude API 키 등, safeStorage로 암호화)
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 구글 캘린더 인증 토큰
CREATE TABLE auth_tokens (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'google',
  access_token TEXT,
  refresh_token TEXT,
  expiry_date TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

---

## 구현 단계 (Implementation Steps)

### Phase 1: 프로젝트 초기 설정
1. `electron-vite` 로 Electron + React + TypeScript 프로젝트 스캐폴딩
   - `npm create @quick-start/electron LinkWork -- --template react-ts`
2. 의존성 설치: `better-sqlite3`, `zustand`, `date-fns`, `google-auth-library`, `googleapis`, `tailwindcss`, `@shadcn/ui`
3. Tailwind CSS + shadcn/ui 설정
4. 기본 레이아웃 컴포넌트 구성 (Sidebar, Header, App shell)

### Phase 2: DB 및 프로젝트 CRUD
5. `src/main/db/database.ts` — SQLite 초기화 및 스키마 생성
6. `src/main/ipc/project.ipc.ts` — 프로젝트 CRUD IPC 핸들러
   - `project:create` — 프로젝트 생성 (개발기간 입력 시 QA 기간 자동 계산: +3일, 배포일 자동 계산: QA종료+1일)
   - `project:list` — 프로젝트 목록 조회
   - `project:get` — 프로젝트 상세 조회
   - `project:update` — 프로젝트 수정
   - `project:delete` — 프로젝트 삭제
7. `src/main/ipc/task.ipc.ts` — 작업 CRUD IPC 핸들러
   - `task:create`, `task:list`, `task:update`, `task:delete`
8. `src/preload/index.ts` — contextBridge로 IPC API 노출
9. `src/renderer/types/index.ts` — TypeScript 타입 정의
10. `src/renderer/stores/projectStore.ts` — Zustand 프로젝트 스토어

### Phase 3: 프로젝트 UI
11. `ProjectList.tsx` — 프로젝트 목록 화면 (상태별 필터링)
12. `ProjectForm.tsx` — 프로젝트 등록/수정 폼
    - 개발 시작일/종료일 DatePicker
    - QA 기간 자동 계산 (개발 종료 다음날 ~ +3일), 수동 수정 가능
    - 배포일 자동 계산 (QA 종료 다음날), 수동 수정 가능
13. `ProjectDetail.tsx` — 프로젝트 상세 + 작업 리스트
14. `TaskList.tsx` — 드래그앤드롭 작업 목록, 작업별 기간 지정

### Phase 4: 스크린샷 기반 자동 등록
15. `src/main/services/screenshot-parser.ts` — Claude Vision API 연동
    - Anthropic SDK (`@anthropic-ai/sdk`) 초기화
    - 이미지를 base64로 인코딩하여 Claude API `messages.create`에 전송
    - 프롬프트: 엑셀/스프레드시트 이미지에서 프로젝트명, 작업명, 시작일, 종료일을 구조화된 JSON으로 추출
    - 응답 JSON 파싱 및 유효성 검증 (날짜 형식, 필수 필드 등)
    - 추출 결과 타입:
      ```typescript
      interface ParsedProject {
        name: string;
        devStartDate: string;
        devEndDate: string;
        tasks: { name: string; startDate?: string; endDate?: string }[];
      }
      ```
16. `src/main/ipc/screenshot.ipc.ts` — 스크린샷 분석 IPC 핸들러
    - `screenshot:analyze` — 이미지 파일 경로 또는 클립보드 이미지를 받아 분석
    - `screenshot:import` — 분석 결과 확인 후 프로젝트 + 작업 일괄 등록
17. `ScreenshotImport.tsx` — 스크린샷 업로드 UI
    - 드래그앤드롭 또는 파일 선택으로 이미지 업로드
    - 클립보드 붙여넣기 (Ctrl/Cmd+V) 지원
    - 분석 중 로딩 스피너 표시
    - 분석 결과 미리보기: 추출된 프로젝트명, 기간, 작업 리스트를 편집 가능한 폼으로 표시
    - 사용자 확인 후 등록 버튼으로 프로젝트 생성
18. `ProjectForm.tsx`에 "스크린샷으로 가져오기" 버튼 추가 — ScreenshotImport 모달 연결

### Phase 5: 구글 캘린더 연동
19. Google Cloud Console에서 OAuth2 Client ID 발급 가이드 작성 (README에 포함)
20. `src/main/services/google-auth.ts` — OAuth2 인증 플로우
    - Electron의 BrowserWindow로 Google 로그인 팝업
    - 토큰 저장/갱신 (`auth_tokens` 테이블)
21. `src/main/services/google-calendar.ts` — Calendar API v3 호출
    - 금일 일정 조회 (`events.list`)
    - 주기적 동기화 (5분 간격)
22. `src/main/ipc/calendar.ipc.ts` — 캘린더 IPC 핸들러
23. `src/renderer/stores/calendarStore.ts` — 캘린더 상태
24. `CalendarView.tsx` — 일정 목록 표시
25. `CalendarSettings.tsx` — 구글 계정 연동/해제 UI

### Phase 6: 로컬 알림
26. `src/main/services/notification.ts` — 알림 스케줄러
    - 일정 시작 10분전, 5분전, 1분전 Electron Notification 발송
    - `setInterval` 기반으로 1분마다 체크
    - 앱이 백그라운드에 있어도 알림 표시 (Tray 아이콘)

### Phase 7: 대시보드
27. `Dashboard.tsx` — 대시보드 메인 레이아웃
28. `ProjectProgress.tsx` — 진행중 프로젝트 카드
    - 경과율 계산: `(오늘 - 시작일) / (종료일 - 시작일) * 100`
    - 긴박도 색상 로직:
      - 초기(0-33%): 초록 `#22c55e`
      - 중기(34-66%): 파랑 `#3b82f6`
      - 말기(67-100%): 빨강 `#ef4444`
    - 프로그레스 바 + 퍼센트 표시
29. `TodaySchedule.tsx` — 금일 구글 캘린더 일정 카드
    - 시간순 정렬, 현재 진행중인 일정 하이라이트

### Phase 8: README 및 마무리
30. `README.md` 작성
    - 프로젝트 소개, 주요 기능, 스크린샷 placeholder
    - 기술 스택 설명
    - 개발 환경 설정 가이드
    - Google Cloud Console OAuth2 설정 가이드
    - 빌드 및 실행 방법

---

## 수용 기준 (Acceptance Criteria)

### 프로젝트 관리
- [ ] 프로젝트 이름, 개발기간, QA기간, 배포일을 입력하여 프로젝트를 등록할 수 있다
- [ ] QA 시작일은 개발 종료일 다음날로, QA 기간은 기본 3일로 자동 설정된다
- [ ] 배포일은 QA 종료일 다음날로 자동 설정된다
- [ ] 자동 설정된 QA기간/배포일을 사용자가 수동으로 변경할 수 있다
- [ ] 프로젝트에 작업을 추가/수정/삭제할 수 있다
- [ ] 각 작업에 시작일과 종료일을 지정할 수 있다

### 스크린샷 자동 등록
- [ ] 엑셀/스프레드시트 스크린샷을 드래그앤드롭 또는 파일 선택으로 업로드할 수 있다
- [ ] 클립보드에서 Ctrl/Cmd+V로 스크린샷을 붙여넣을 수 있다
- [ ] Claude Vision API가 스크린샷에서 프로젝트명, 일자, 작업 리스트를 자동 추출한다
- [ ] 추출된 결과를 편집 가능한 폼으로 미리보기할 수 있다
- [ ] 사용자가 확인 후 프로젝트+작업을 일괄 등록할 수 있다
- [ ] API 키 미설정 시 설정 안내 메시지가 표시된다

### 구글 캘린더
- [ ] Google OAuth2로 로그인하여 캘린더를 연동할 수 있다
- [ ] 연동된 캘린더의 금일 일정이 표시된다
- [ ] 일정 시작 10분전, 5분전, 1분전에 OS 로컬 알림이 표시된다
- [ ] 앱이 트레이에 최소화되어 있어도 알림이 동작한다

### 대시보드
- [ ] 진행중인 모든 프로젝트가 경과율(%)과 함께 표시된다
- [ ] 경과율에 따라 초록(0-33%)/파랑(34-66%)/빨강(67-100%) 색상이 적용된다
- [ ] 금일 구글 캘린더 일정이 시간순으로 표시된다

### 일반
- [ ] Electron 앱으로 macOS에서 정상 실행된다
- [ ] README.md에 프로젝트 설명, 기술 스택, 설정 가이드, 사용법이 포함된다

---

## 리스크 및 완화 방안

| 리스크 | 영향 | 완화 방안 |
|--------|------|-----------|
| Google OAuth2 설정 복잡 | 사용자가 초기 설정에 어려움 | README에 상세 스크린샷 포함 가이드 작성 |
| better-sqlite3 네이티브 모듈 빌드 | Electron에서 네이티브 모듈 호환성 | electron-rebuild 사용, postinstall 스크립트 설정 |
| Electron Notification macOS 권한 | 알림이 표시되지 않을 수 있음 | 앱 최초 실행 시 알림 권한 요청 안내 |
| Google Calendar API 할당량 | 빈번한 API 호출 시 제한 | 5분 간격 동기화 + 로컬 캐싱 |
| Claude API 키 관리 | 사용자가 API 키를 안전하게 저장해야 함 | Electron safeStorage API로 암호화 저장, 설정 화면에서 관리 |
| 스크린샷 분석 정확도 | 복잡한 엑셀 레이아웃에서 오추출 가능 | 추출 결과를 편집 가능한 폼으로 미리보기 후 확인, 프롬프트 최적화 |
| Claude API 비용 | 이미지 분석 시 토큰 비용 발생 | 사용자에게 API 호출 건수/비용 안내 |

---

## 검증 단계 (Verification Steps)

1. `npm run dev`로 앱 실행 후 프로젝트 CRUD 테스트
2. 개발기간 입력 시 QA기간/배포일 자동 계산 검증
3. 작업 추가/수정/삭제 동작 확인
4. 엑셀 WBS 스크린샷 업로드 후 프로젝트명/일자/작업 자동 추출 확인
5. 추출 결과 미리보기 편집 후 프로젝트 일괄 등록 확인
6. 클립보드 붙여넣기(Cmd+V)로 스크린샷 분석 동작 확인
7. Google 계정 연동 후 캘린더 일정 로딩 확인
8. 일정 알림 타이밍(10분/5분/1분전) 검증
9. 대시보드에서 프로젝트 경과율 및 색상 표시 확인
10. `npm run build`로 macOS 앱 빌드 성공 확인
