# LinkWork

개인 업무와 회의 일정·기록을 한곳에서 관리하는 macOS 데스크톱 앱이다.
오늘 할 일·일정·Jira 티켓·배포 일정을 한 화면에서 읽고, 회의를 녹음해 로컬에서 전사·화자 분리한 뒤 Claude Code 로 요약한다.
데이터는 이 Mac 의 SQLite 파일에만 저장한다.

## 화면

사이드바 메뉴(`src/renderer/src/components/layout/navConfig.ts`)를 기준으로 한다.

| 그룹 | 메뉴 | 내용 |
|---|---|---|
| — | 오늘 | 오늘 대시보드. 신호·다음 배포·Jira 작업·할 일·일정·메모를 한 화면에 모은다 |
| — | AI 대화 | Claude Code 구독 로그인으로 앱 데이터(할 일·메모·일정·Jira 등)를 묻고 고친다 ([AI_CHAT_ARCHITECTURE.md](docs/AI_CHAT_ARCHITECTURE.md)) |
| 업무 | 프로젝트 | Jira 프로젝트 화면. 티켓·릴리스·문서 탭 ([PROJECT_BOARD.md](docs/PROJECT_BOARD.md), [RELEASE_NOTES.md](docs/RELEASE_NOTES.md)) |
| 업무 | 할 일 | 할 일과 태그. 오늘·예정·전체·완료 뷰, 한 줄 빠른 추가(`내일 3시 #태그 !높음` 인식) |
| 업무 | 캘린더 | Google 캘린더 주간 일정(읽기 전용) |
| 회의 | 녹음 | 회의·면접 녹음, 전사, 화자 분리, AI 요약, 액션아이템을 할 일로 등록 ([MEETING_RECORDING.md](docs/MEETING_RECORDING.md)) |
| 회의 | 회의록 | 요약이 끝난 회의를 문서처럼 검색·열람하고 Markdown 으로 내보낸다 |
| 자료 | 메모 | 카테고리·검색·3단 탐색 메모 |
| 자료 | 변수 | 자주 쓰는 값을 저장해 두고 복사한다 |
| (하단) | 설정 | 연동·AI·비서·회의 녹음·모바일·데이터 ([SETTINGS.md](docs/SETTINGS.md)) |

그 밖에 어느 화면에서든 Cmd+Shift+A 로 여는 할 일 빠른 추가, 메뉴 막대 트레이 패널(오늘 일정·할 일), 같은 Wi-Fi 의 휴대폰에서 오늘·할 일·메모를 보는 휴대폰 열람([MOBILE_VIEW.md](docs/MOBILE_VIEW.md))이 있다.

## 연동

설정 > 연동에서 연결한다. 자격 증명은 macOS `safeStorage` 로 암호화해 저장하고 백업에 넣지 않는다.

| 연동 | 쓰는 곳 | 필요한 것 |
|---|---|---|
| Google 캘린더 | 캘린더, 오늘 일정, 회의 알림·회의 전 브리핑 | Google Cloud OAuth 클라이언트(웹 애플리케이션, 리디렉션 URI `http://localhost:8945/callback`, 범위 `calendar.readonly`) |
| Jira | 프로젝트 화면(티켓·릴리스), 오늘의 Jira 작업 | 사이트 URL, 이메일, Atlassian API token |
| Bitbucket | AI 대화의 저장소·PR 읽기 | 이메일, Atlassian API token(`read:repository:bitbucket` 등) |
| Notion | AI 대화의 Notion 문서 읽기 | 내부 통합 토큰 |
| Claude Code | AI 대화, 회의 요약, 회의 전 브리핑 | 이 Mac 에 Claude Code 를 설치하고 구독 계정으로 로그인. 앱에 API 키를 넣지 않는다 |

## 개발 환경

준비물:
- macOS (Apple Silicon. `npm run deploy` 는 `dist/mac-arm64` 산출물을 쓴다)
- Node.js 22 와 npm
- 네이티브 모듈(`better-sqlite3`) 빌드용 Xcode Command Line Tools 와 `distutils` 가 있는 Python. 기본 Python 에 `distutils` 가 없으면 `PYTHON=/usr/bin/python3` 처럼 지정한다
- 회의 전사·화자 분리는 선택 의존성(`@fugood/whisper.node`, `sherpa-onnx-node`, `silero-vad-node`)을 쓴다. 설치되지 않으면 녹음·저장은 되고 전사는 폴백으로 동작한다. 모델은 첫 처리 때 내려받는다

```bash
npm install            # postinstall 이 electron-builder install-app-deps 로 네이티브 모듈을 Electron 용으로 빌드한다
npm run dev            # 개발 모드 (electron-vite dev)
npx vitest run         # 단위 테스트
npm run typecheck      # node(main·preload) + web(renderer) 타입체크
npm run build          # 프로덕션 번들 (out/)
npm run deploy         # 빌드 → 앱 패키징(--dir) → ad-hoc 서명 → /Applications/LinkWork.app 에 반영
```

그 밖의 스크립트: `npm run build:unpack`(패키징만, `dist/`), `npm run build:mac`(DMG), `npm run preview`(빌드 결과 미리보기), `npm run typecheck:node`, `npm run typecheck:web`, `npm run check:docs`(문서가 가리키는 경로·IPC 채널 검사), `npm run check:diar`(이 Mac의 실제 녹음으로 화자 분리 실측 회귀, docs/MEETING_RECORDING.md §5-3).

앱 데이터는 `~/Library/Application Support/` 아래 앱 폴더(`linkwork.db`, `recordings/`, `ai-attachments/`, `models/`)에 있다. 새 PC 로 옮길 때는 설정 > 데이터의 백업·복원을 쓴다([DATA_BACKUP.md](docs/DATA_BACKUP.md)).

## 기술 스택

Electron 43, React 19, TypeScript, electron-vite, Tailwind CSS 4, zustand, better-sqlite3, Claude Agent SDK, googleapis, date-fns, zod, vitest.

## 폴더 구조

```
src/
├── main/                  # Electron 메인 프로세스 (Node)
│   ├── index.ts           # 앱 진입점: 창·트레이·IPC 등록·휴대폰 열람 서버
│   ├── db/                # SQLite 초기화(database.ts)와 스키마·마이그레이션(schema.ts)
│   ├── ipc/               # 기능별 IPC 핸들러 (*.ipc.ts)
│   ├── services/          # 기능 로직: AI(ai-*), 비서(assistant-*), Jira·Bitbucket·Notion, 백업, 회의 녹음
│   │   ├── stt/ vad/ diarization/   # 회의 전사·침묵 검출·화자 분리 어댑터
│   │   └── mobile/        # 휴대폰 열람 HTTP 서버
│   └── utils/
├── preload/index.ts       # contextBridge 로 window.api 노출
└── renderer/
    ├── index.html         # 데스크톱 창(메인 창·트레이 패널)
    ├── mobile.html        # 휴대폰 열람 화면 진입점
    └── src/
        ├── App.tsx, main.tsx
        ├── components/    # 화면별 컴포넌트 (today, ai, project, release, todo, calendar, recording, notes, memo, variable, settings, layout, ui …)
        ├── stores/        # zustand 스토어
        ├── mobile/        # 휴대폰 열람 화면
        ├── types/         # IPC·도메인 타입
        └── utils/
resources/                 # 앱 아이콘(icon.icns), 트레이 아이콘
scripts/eval/              # 회의 파이프라인 평가 도구(Python, scripts/eval/README.md)
docs/                      # 설계·계약 문서
```

## 문서

| 문서 | 내용 |
|---|---|
| [docs/ASSISTANT.md](docs/ASSISTANT.md) | 개인 비서·오늘 대시보드 |
| [docs/AI_CHAT_ARCHITECTURE.md](docs/AI_CHAT_ARCHITECTURE.md) | AI 대화 아키텍처 |
| [docs/AI_GUARDRAILS.md](docs/AI_GUARDRAILS.md) | AI 가드레일 정책 |
| [docs/PROJECT_BOARD.md](docs/PROJECT_BOARD.md) | 프로젝트 화면(티켓·릴리스·문서 탭) |
| [docs/RELEASE_NOTES.md](docs/RELEASE_NOTES.md) | 릴리스 노트(릴리스 탭) |
| [docs/MEETING_RECORDING.md](docs/MEETING_RECORDING.md) | 회의 녹음 파이프라인과 회의록 메뉴 |
| [docs/SETTINGS.md](docs/SETTINGS.md) | 설정 화면·연동 |
| [docs/MOBILE_VIEW.md](docs/MOBILE_VIEW.md) | 휴대폰 열람 |
| [docs/DATA_BACKUP.md](docs/DATA_BACKUP.md) | 데이터 백업·복원(새 PC 이전) |

개발 규칙과 검증 명령은 [CLAUDE.md](CLAUDE.md)에 있다.
