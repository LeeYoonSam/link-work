# LinkWork

WBS(Work Breakdown Structure) + 미팅 스케줄 관리를 위한 데스크톱 애플리케이션입니다.
프로젝트 일정을 체계적으로 관리하고, 구글 캘린더 연동으로 미팅 일정을 한눈에 확인할 수 있습니다.

## 주요 기능

### 프로젝트 관리
- 프로젝트 등록/수정/삭제
- 개발 기간, QA 기간(자동 계산: 개발 종료 +3일), 배포일(QA 종료 다음날) 관리
- QA 기간 및 배포일 수동 수정 가능
- 프로젝트별 작업(Task) 리스트 등록 및 기간 지정
- 작업 상태 관리 (Pending / In Progress / Done)

### 대시보드
- 진행중인 프로젝트 경과율(%) 실시간 표시
- 긴박도에 따른 색상 표시
  - 초기(0~33%): 초록
  - 중기(34~66%): 파랑
  - 말기(67~100%): 빨강
- 금일 구글 캘린더 일정 표시

### 구글 캘린더 연동
- Google OAuth2 인증으로 캘린더 연동
- 금일 일정 자동 조회 (5분 간격 동기화)
- 현재 진행중인 일정 하이라이트

### 로컬 알림
- 일정 시작 10분전, 5분전, 1분전 OS 알림 표시
- 중복 알림 방지
- 앱이 백그라운드에서도 동작

## 기술 스택

| 구분 | 기술 |
|------|------|
| Framework | Electron 33 |
| Frontend | React 19 + TypeScript |
| Build Tool | electron-vite + Vite 6 |
| State | Zustand 5 |
| Storage | SQLite (better-sqlite3) |
| Calendar | Google Calendar API v3 |
| Auth | google-auth-library |
| Styling | Tailwind CSS 4 |
| Date | date-fns |

## 설치 및 실행

### 사전 요구사항
- Node.js 18+
- npm 9+

### 설치

```bash
git clone <repository-url>
cd LinkWork
npm install
```

### 개발 모드 실행

```bash
npm run dev
```

### 프로덕션 빌드

```bash
npm run build          # 빌드만
npm run build:mac      # macOS DMG 생성
```

### 타입 체크

```bash
npm run typecheck
```

## Google Calendar 연동 설정

### 1. Google Cloud Console 설정

1. [Google Cloud Console](https://console.cloud.google.com)에 접속
2. 새 프로젝트 생성 또는 기존 프로젝트 선택
3. **API 및 서비스 > 라이브러리**에서 "Google Calendar API" 검색 후 활성화
4. **API 및 서비스 > 사용자 인증 정보**로 이동
5. **사용자 인증 정보 만들기 > OAuth 클라이언트 ID** 선택
6. 애플리케이션 유형: **웹 애플리케이션** 선택
7. **승인된 리디렉션 URI**에 `http://localhost:8945/callback` 추가
8. 생성된 **클라이언트 ID**와 **클라이언트 시크릿**을 메모

### 2. OAuth 동의 화면 설정

1. **API 및 서비스 > OAuth 동의 화면**으로 이동
2. User Type: **외부** 선택
3. 앱 이름, 사용자 지원 이메일 등 필수 정보 입력
4. 범위 추가: `https://www.googleapis.com/auth/calendar.readonly`
5. 테스트 사용자에 본인 Google 계정 추가

### 3. LinkWork 앱에서 연동

1. 앱 실행 후 사이드바에서 **Calendar** 클릭
2. **Step 1**: Client ID와 Client Secret 입력 후 Save
3. **Step 2**: "Connect Google Calendar" 클릭
4. Google 로그인 팝업에서 계정 선택 및 권한 허용
5. 연동 완료 후 금일 일정이 자동으로 표시됨

## 프로젝트 구조

```
src/
├── main/                          # Electron Main Process
│   ├── index.ts                   # 앱 엔트리
│   ├── db/database.ts             # SQLite 초기화
│   ├── ipc/
│   │   ├── project.ipc.ts         # 프로젝트 CRUD
│   │   ├── task.ipc.ts            # 작업 CRUD
│   │   └── calendar.ipc.ts        # 캘린더 API
│   ├── services/
│   │   ├── google-auth.ts         # OAuth2 인증
│   │   ├── google-calendar.ts     # Calendar API 호출
│   │   └── notification.ts        # 로컬 알림
│   └── utils/date.ts              # 날짜 유틸리티
├── preload/index.ts               # contextBridge API
└── renderer/src/                  # React Frontend
    ├── App.tsx                    # 라우팅
    ├── stores/
    │   ├── projectStore.ts        # 프로젝트 상태
    │   └── calendarStore.ts       # 캘린더 상태
    └── components/
        ├── layout/                # Sidebar, Header
        ├── dashboard/             # Dashboard, ProjectProgress, TodaySchedule
        ├── project/               # ProjectList, ProjectForm, ProjectDetail, TaskList
        └── calendar/              # CalendarView, CalendarSettings
```

## License

MIT
