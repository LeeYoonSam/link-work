# LinkWork 프로젝트 지침

## 프로젝트 개요
LinkWork는 개인 업무와 회의 일정·기록을 관리하는 macOS 데스크톱 앱이다.
사이드바 메뉴: 오늘(대시보드), AI 대화, 프로젝트(Jira 티켓·릴리스·문서 탭), 할 일, 캘린더, 녹음, 회의록, 메모, 변수, 설정(`src/renderer/src/components/layout/navConfig.ts`). 휴대폰 브라우저로 같은 Wi-Fi 에서, 또는 Mac 과 휴대폰이 같은 Tailscale 계정에 연결돼 있으면 밖에서도 오늘·할 일·메모를 열람할 수 있다(`docs/MOBILE_VIEW.md`).
기술 스택: Electron + React 19 + TypeScript + electron-vite + Tailwind 4 + better-sqlite3 + zustand.
메인 프로세스(Node)와 렌더러(Web)가 분리되어 있어 타입체크·빌드도 두 영역으로 나뉜다.

## 검증 명령
작업 완료 판정은 아래 명령의 실행 결과로만 한다. 해당하는 것을 실행해 통과를 확인한다.

| 명령 | 용도 | 통과 기준 |
|------|------|-----------|
| `npx vitest run` | 단위 테스트 | 종료 코드 0, 실패 0건 |
| `npm run typecheck` | node+web 타입체크 | 에러 0건 |
| `npm run build` | 프로덕션 빌드 | 종료 코드 0 |
| `npm run deploy` | 빌드 후 `/Applications`에 반영 | 종료 코드 0 |
| `npm run check:docs` | 문서 검사: 문서의 저장소 경로·IPC 채널이 코드에 있는지, 문서 매핑 누락 | 종료 코드 0 |
| `npm run check:diar` | 화자분리 실측 회귀: 배포 앱의 Electron 런타임(`ELECTRON_RUN_AS_NODE=1`)으로 이 Mac의 실제 녹음을 분리해 화자 수·목소리 매칭을 판정(`scripts/diar-regress.mjs`). 화자분리를 바꾸면 실행 | 종료 코드 0 (2 = 녹음·DB·바이너리 없음) |
| `npm run check:diar-mem` | 화자분리 앱 워커 경로 메모리 상한: 회의 51을 앱과 같은 청크 워커 경로(`diarization-mem-probe`)로 돌려 프로세스 트리 최대 RSS 2,048MB 이하인지 판정(`scripts/diar-mem.mjs`). 빌드 후, 화자분리 워커를 바꾸면 실행 | 종료 코드 0 (2 = 녹음·DB·모델·out 빌드 없음) |
| `npm run check:docs -- --changed` | 바뀐 코드에 대응하는데 함께 바뀌지 않은 문서(확인 대상) 목록. `--json` 지원 | 판정용 아님(목록 확인) |

## 문서 동기화 정책
문서가 코드보다 뒤처지지 않게 한다. 코드·설정·의존성을 바꾼 작업은 끝내기 전에 아래를 따른다.

- **해당 문서 찾기**: 바꾼 파일을 [docs/docs-map.json](docs/docs-map.json)에 대어 대응 문서를 찾는다. `npm run check:docs -- --changed`가 목록을 뽑아 준다.
- **해당 문서만 고친다**: 찾은 문서를 현재 코드와 대조해 맞지 않는 서술을 고친다. 대응하지 않는 문서는 건드리지 않는다. 매핑에서 문서가 없는 구역(할 일·메모·변수 등)은 고칠 문서가 없다.
- **현재 상태만 쓴다**: 문서에 변경 이력·날짜별 경위·폐기된 계획을 쌓지 않는다. 기능을 지우면 그 서술도 같은 작업에서 지운다.
- **IPC 네임스페이스 삭제**: IPC 네임스페이스(`접두사:`)를 통째로 지우면 `docs/docs-map.json`의 `retiredIpcPrefixes`에 그 접두사를 더한다. 그래야 문서에 남은 그 접두사의 채널을 `check:docs`가 잡는다.
- **새 문서**: 만들면 `docs/docs-map.json`의 구역과 아래 "기존 문서" 목록에 함께 넣는다. 매핑이 필요 없는 문서는 `unmappedDocs`에 사유와 함께 적는다.
- **고칠 것이 없으면**: 최종 보고에 그 근거를 한 줄로 쓴다(예: "내부 구현만 바뀌어 PROJECT_BOARD.md 서술과 무관").
- **자동 확인**: `.claude/settings.json`의 Stop 훅(`scripts/docs-stop-hook.mjs`)이 턴 종료 시 확인 대상 문서와 `check:docs` 오류를 알리고 한 번 멈춰 세운다. 두 번째 종료 시도는 통과한다.
- **완료 조건**: 코드를 바꾸는 플랜은 `npm run check:docs` 종료 코드 0을 완료 조건에 넣는다.

## 에이전트팀 활용 정책
- **적극 활용 대상**: 코드 설계·구현이 포함된 작업은 규모(파일 수·줄 수)와 무관하게 에이전트팀(리더 + 팀원)으로 수행한다. 인터페이스 변경, 동작 설계, 다파일 구현, 리뷰가 필요한 작업이 모두 해당한다.
- **활성화 조건**: 에이전트팀은 실험적 기능이며 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`(settings.json `env` 또는 환경변수)일 때만 사용 가능하다.
- **폴백**: 위 환경변수가 없으면 서브에이전트(`Agent` 도구)로 planner·implementer·reviewer 역할을 동일하게 구성한다.
- **단독 수행 대상**: 설계 판단이 전혀 없는 기계적 수정만 직접 처리한다 — 오타·문구·상수 변경, 문서 수정 등. 경계 기준은 파일 수가 아니라 **설계 판단 유무**다. 애매하면 팀으로 간다.
- **팀 구성 규칙**: 팀 규모는 3–5명. 팀원별로 서로 다른 파일 세트를 소유해 편집 충돌을 막는다. 팀원은 리더의 대화 히스토리를 상속하지 않으므로 스폰 프롬프트에 작업 컨텍스트(플랜, 완료 조건, 소유 파일, 관련 배경)를 반드시 포함한다.

## 모델 선택 정책
- **설계·플랜·리서치**: Fable5 사용. 불가 시 Opus. 별칭 `best` 권장(Fable5 지원 시 Fable5, 아니면 최신 Opus로 자동 폴백).
- **코드 구현·리뷰**: Opus 사용. 불가 시 Sonnet.

## 검증 루프 정책
- **완료 조건은 플랜 단계에서 반드시 정의한다.** 각 조건은 명령 실행 결과로 기계적으로 판정 가능해야 한다.
  - 좋은 예: "`npx vitest run` 종료 코드 0", "`npm run typecheck` 에러 0건"
  - 금지: "동작이 자연스러움"처럼 주관적으로만 판정되는 조건
- **최대 반복 횟수 설정 필수**: 구현 → 검증 → 수정 루프는 최대 반복 횟수(기본 5회)를 반드시 설정한다.
- **초과 시**: 루프를 중단하고 미충족 항목, 시도한 내용, 원인 분석을 사용자에게 보고한다.
- **조기 중단**: 같은 실패가 2회 연속 반복되면 접근 방식을 바꾸거나 조기에 보고한다.

## 레퍼런스
- 에이전트팀 공식 사용법: [docs/references/claude-agent-teams.md](docs/references/claude-agent-teams.md)
- 팀 기반 개발 워크플로 스킬: `/team-dev [작업 설명]` — 플랜(완료 조건 정의) → 팀 구성 → 구현 → 검증 루프 → 종합 보고를 자동으로 수행한다.
- 팀원 정의: `.claude/agents/planner.md`, `.claude/agents/implementer.md`, `.claude/agents/reviewer.md`

## 기존 문서
코드 구역과 문서의 대응은 [docs/docs-map.json](docs/docs-map.json)에 있다.

- [docs/AI_CHAT_ARCHITECTURE.md](docs/AI_CHAT_ARCHITECTURE.md) — AI 채팅 아키텍처
- [docs/AI_GUARDRAILS.md](docs/AI_GUARDRAILS.md) — AI 가드레일 정책
- [docs/ASSISTANT.md](docs/ASSISTANT.md) — 개인 비서와 오늘 화면
- [docs/MEETING_RECORDING.md](docs/MEETING_RECORDING.md) — 회의 녹음/기록 파이프라인과 회의록 메뉴(요약된 회의 목록·검색·열람·Markdown 내보내기)
- [docs/DATA_BACKUP.md](docs/DATA_BACKUP.md) — 데이터 백업·복원(새 PC 이전) 형식과 절차
- [docs/PROJECT_BOARD.md](docs/PROJECT_BOARD.md) — 프로젝트 화면(티켓·릴리스·문서 탭): 티켓 수집·로컬 저장·증분 동기화·연결 문서 수집·IPC 계약·표시 규칙·가드레일
- [docs/RELEASE_NOTES.md](docs/RELEASE_NOTES.md) — 릴리스 노트(프로젝트 화면의 릴리스 탭): Jira 릴리스 동기화·변경분 동기화 규칙
- [docs/SETTINGS.md](docs/SETTINGS.md) — 통합 설정 화면 섹션·진입 경로·연동 카드 상태·토큰 팝업·`settings:verifyIntegration` IPC 계약
- [docs/ROADMAP.md](docs/ROADMAP.md) — 기능 로드맵: 아직 만들지 않은 기능 후보·근거 기반 점수·진행 순서. 완료한 항목은 지우고 해당 구역 문서로 옮긴다
- [docs/MOBILE_VIEW.md](docs/MOBILE_VIEW.md) — 휴대폰 열람: 메인 HTTP 서버·오늘 스냅샷 발행·모바일 화면 3개·보안 모델(토큰·쿠키·Host 검사)·HTTP/IPC 계약·포트
