# LinkWork 프로젝트 지침

## 프로젝트 개요
LinkWork는 WBS(작업 분해 구조)와 회의 일정을 관리하는 macOS 데스크톱 앱이다.
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
- [docs/AI_CHAT_ARCHITECTURE.md](docs/AI_CHAT_ARCHITECTURE.md) — AI 채팅 아키텍처
- [docs/AI_GUARDRAILS.md](docs/AI_GUARDRAILS.md) — AI 가드레일 정책
- [docs/MEETING_RECORDING.md](docs/MEETING_RECORDING.md) — 회의 녹음/기록 파이프라인
