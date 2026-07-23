# Claude Code Agent Teams 레퍼런스

> **최종 업데이트: 2026-07-23** · 이 문서는 Anthropic 공식 문서 기반 요약입니다. 원문은 하단 [출처](#출처) 참고.

## 개요

Agent Teams(에이전트팀)는 Claude Code의 실험적 기능으로, 하나의 **리더** 세션이 여러 **팀원** 에이전트를 스폰해 작업을 병렬로 진행하는 협업 구조입니다.

- **리더**: 작업을 분할·할당하고, 진행 상황을 체크하고, 결과를 종합합니다.
- **팀원**: 각자 독립된 컨텍스트 윈도우를 가지며, 리더를 거치지 않고 팀원끼리 직접 메시지를 주고받을 수 있습니다. 공유 태스크 리스트로 작업을 조율합니다.
- **관련 도구**: `Agent`(팀원 스폰, 모델 오버라이드 가능), `SendMessage`, `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate`. v2.1.178 이후 `TeamCreate`/`TeamDelete` 도구는 삭제되었고 팀 생성·정리는 자동 처리됩니다.

### 활성화 방법

```bash
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

환경변수로 지정하거나 settings.json의 `env`에 넣습니다.

## Agent Teams vs Subagents

| 항목 | Subagents | Agent Teams |
|------|-----------|-------------|
| 컨텍스트 | 독립, 결과만 리더에 반환 | 독립, 완전 자율 |
| 통신 | 리더에게 결과 보고만 | 팀원 간 직접 메시지 |
| 조율 | 리더가 전부 관리 | 공유 태스크 리스트, 자체 조율 |
| 적합한 작업 | 결과만 중요한 집중 작업(리서치, 리뷰) | 토론·협업이 필요한 복잡 작업 |
| 토큰 비용 | 낮음 | 높음(팀원별 별도 인스턴스) |

### 선택 기준

- **Subagents**: 결과물만 받으면 되는 단발성 작업(리서치, 코드 리뷰, 검색)에 적합. 토큰 비용이 낮습니다.
- **Agent Teams**: 팀원 간 토론·조율이 필요한 복잡 작업에 적합. 팀원마다 별도 인스턴스가 돌기 때문에 토큰 비용이 높으므로, 병렬화 이득이 조율 오버헤드와 비용을 초과할 때만 사용합니다.

## 팀원 스폰과 모델 지정

- 팀원 스폰 시 자연어로 모델을 지정할 수 있습니다.
- 기본값: 팀원은 리더의 모델을 상속하지 않습니다. `/config`의 "Default teammate model"에서 기본 팀원 모델을 설정할 수 있습니다.
- 팀원은 리더의 effort 레벨을 상속합니다(v2.1.186+).

### model 별칭 표

| 별칭 | 의미 |
|------|------|
| `best` | Fable 5 지원 시 Fable 5, 아니면 최신 Opus로 폴백 |
| `fable` | Fable 5 |
| `opus` | 최신 Opus |
| `sonnet` | 최신 Sonnet |
| `haiku` | 최신 Haiku |
| `sonnet[1m]` | Sonnet 1M 컨텍스트 |
| `opus[1m]` | Opus 1M 컨텍스트 |
| `opusplan` | 플랜 단계 = Opus, 실행 단계 = Sonnet |
| `inherit` | 부모(호출자) 모델 상속 — 기본값 |
| 전체 모델 ID | `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5` 등 직접 지정 |

### 모델 해석 우선순위 (서브에이전트)

1. `CLAUDE_CODE_SUBAGENT_MODEL` 환경변수
2. 호출 시 `model` 파라미터
3. 에이전트 정의 frontmatter의 `model`
4. 리더/주 세션 모델

## `.claude/agents/*.md` frontmatter 필드 레퍼런스

| 필드 | 필수 | 설명 |
|------|------|------|
| `name` | 필수 | 소문자·하이픈으로 구성된 에이전트 이름 |
| `description` | 필수 | 이 에이전트를 언제 사용하는지 설명 |
| `tools` | 선택 | 허용 도구 목록 |
| `disallowedTools` | 선택 | 금지 도구 목록 |
| `model` | 선택 | 사용할 모델(위 별칭 표 참고) |
| `permissionMode` | 선택 | 권한 모드 |
| `maxTurns` | 선택 | 최대 턴 수 |
| `skills` | 선택 | 미리 로드할 스킬 |
| `mcpServers` | 선택 | 사용할 MCP 서버 |
| `hooks` | 선택 | 훅 설정 |
| `memory` | 선택 | `user` \| `project` \| `local` |
| `background` | 선택 | 백그라운드 실행 여부 |
| `effort` | 선택 | `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| `isolation` | 선택 | `worktree` — 격리된 git worktree에서 작업 |
| `color` | 선택 | 표시 색상 |
| `initialPrompt` | 선택 | 초기 프롬프트 |

**로딩 우선순위**: 관리자 배포 > CLI `--agents` > 프로젝트 `.claude/agents/` > 사용자 `~/.claude/agents/` > 플러그인. 이름이 충돌하면 높은 우선순위가 승리합니다.

## `.claude/skills/*/SKILL.md` frontmatter 필드 레퍼런스

| 필드 | 설명 |
|------|------|
| `name` | 스킬 이름(디렉토리명이 기본값) |
| `description` | 스킬 설명(권장) |
| `when_to_use` | 사용 시점 안내 |
| `argument-hint` | 인자 힌트 |
| `arguments` | 인자 정의 |
| `disable-model-invocation` | 모델의 자동 호출 비활성화 |
| `user-invocable` | 사용자 직접 호출 가능 여부 |
| `allowed-tools` | 허용 도구 |
| `disallowed-tools` | 금지 도구 |
| `model` | 사용할 모델 |
| `effort` | effort 레벨 |
| `context: fork` | 포크된 컨텍스트에서 실행 |
| `agent` | 실행할 에이전트 지정 |
| `hooks` | 훅 설정 |
| `paths` | 경로 스코프 |
| `shell` | 셸 설정 |

### 치환 변수

| 변수 | 의미 |
|------|------|
| `$ARGUMENTS` | 전달된 인자 전체 |
| `$N` | N번째 인자 |
| `${CLAUDE_SKILL_DIR}` | 스킬 디렉토리 경로 |
| `${CLAUDE_PROJECT_DIR}` | 프로젝트 디렉토리 경로 |
| `${CLAUDE_SESSION_ID}` | 세션 ID |
| `${CLAUDE_EFFORT}` | 현재 effort 레벨 |

참고: CLAUDE.md는 `~/.claude/CLAUDE.md`(전역), `./CLAUDE.md` 또는 `./.claude/CLAUDE.md`(프로젝트, git 체크인), `./.claude/CLAUDE.local.md`(개인, gitignore) 위치에서 모든 범위가 병합되어 자동 로드됩니다.

## 베스트 프랙티스

- **팀 규모**: 3–5명 권장. 팀원당 태스크 5–6개.
- **작업 단위**: 자체 완결 단위(함수, 테스트 파일, 코드 리뷰 하나)로 나눕니다. 너무 작게 쪼개면 조율 오버헤드가 병렬화 이점을 초과합니다.
- **병렬화에 적합한 작업**: 다관점 리서치·리뷰, 새 모듈의 부분 분담, 경쟁 가설 디버깅, 크로스 레이어 작업(FE/BE/테스트 분담).
- **병렬화에 부적합한 작업**: 순차 의존 작업, 같은 파일을 편집하는 작업, 상호 의존성이 높은 작업.
- **파일 충돌 방지**: 팀원별로 서로 다른 파일 세트를 소유하게 분담합니다.
- **스폰 프롬프트에 컨텍스트 포함**: 팀원은 리더의 대화 히스토리를 상속하지 않으므로, 스폰 프롬프트에 작업 세부사항을 반드시 포함해야 합니다. 단, CLAUDE.md·MCP·스킬은 팀원에게도 자동 로드됩니다.
- **리더의 역할**: 진행 상황 체크인, 잘못된 접근 리디렉트, 결과 종합.

## 디스플레이 모드(`teammateMode`)와 알려진 제약사항

### teammateMode

settings.json의 `"teammateMode"` 또는 `claude --teammate-mode`로 설정합니다.

| 값 | 설명 |
|----|------|
| `in-process` | 기본값. 리더 세션 안에서 표시 |
| `split-panes` | 분할 창 표시(tmux 또는 iTerm2 필요) |
| `auto` | 자동 선택 |
| `tmux` | tmux 강제 |
| `iterm2` | iTerm2 강제 |

### 알려진 제약사항

- 세션당 팀은 1개. 팀원은 자신의 팀원을 스폰할 수 없습니다(리더만 팀을 관리).
- in-process 팀원과는 `/resume`·`/rewind`가 지원되지 않습니다.
- 팀원이 태스크 완료 표시에 실패하면 종속 태스크가 차단됩니다.
- split-panes는 VS Code 터미널·Windows Terminal·Ghostty를 지원하지 않습니다.
- 리더는 고정이며 팀원을 리더로 승격할 수 없습니다.
- 팀원은 스폰 시점의 리더 권한 모드를 상속합니다.

> 참고: Agent SDK의 teammates 생성 API, 팀 간 메시지의 내부 JSON 형식은 공식 문서에서 확인되지 않아 이 문서에서 다루지 않습니다.

## LinkWork 적용 가이드

이 프로젝트에서 에이전트팀을 사용할 때는 아래 정책을 따릅니다. 정책 원문은 [`../../CLAUDE.md`](../../CLAUDE.md)에, 팀 기반 개발 워크플로는 [`../../.claude/skills/team-dev/SKILL.md`](../../.claude/skills/team-dev/SKILL.md)에, 팀원 정의는 [`../../.claude/agents/`](../../.claude/agents/)에 있습니다.

### 모델 선택 정책

| 작업 유형 | 1순위 모델 | 폴백 |
|-----------|-----------|------|
| 설계·플랜·리서치 | Fable 5 (`fable`) | Opus (`opus`) |
| 구현·리뷰 | Opus (`opus`) | Sonnet (`sonnet`) |

에이전트팀 적용 방법:

- `.claude/agents/`의 팀원 정의 frontmatter `model` 필드에 위 정책에 맞는 별칭을 지정합니다. 예: planner(설계·플랜)는 `fable`, implementer·reviewer(구현·리뷰)는 `opus`.
- 설계·플랜·리서치 팀원에는 `best` 별칭을 활용할 수 있습니다 — Fable 5를 지원하면 Fable 5, 아니면 최신 Opus로 자동 폴백되어 정책의 폴백 규칙과 일치합니다.
- 스폰 시 `model` 파라미터로 오버라이드하는 경우에도 같은 정책을 따릅니다(모델 해석 우선순위상 호출 파라미터가 frontmatter보다 우선).

### 검증 루프 정책

- **기계 판정 가능한 완료 조건 필수**: 플랜 단계에서 완료 조건을 명령 실행 결과로 판정 가능하게 작성합니다. LinkWork의 검증 명령: `npx vitest run`, `npm run typecheck`, `npm run build`.
- **루프 최대 반복 가드**: 검증 → 수정 → 재검증 루프에 최대 반복 횟수를 반드시 두어 무한루프를 방지합니다. 한도 도달 시 미충족 항목과 사유를 보고하고 중단합니다.

에이전트팀 적용 방법:

- 리더는 플랜 단계에서 각 팀원의 태스크마다 검증 명령 기반 완료 조건을 정의한 뒤 스폰합니다.
- 팀원은 리더 히스토리를 상속하지 않으므로, 완료 조건과 검증 명령을 스폰 프롬프트에 명시적으로 포함합니다.
- 리뷰어 팀원이 완료 조건을 기계적으로 판정하고, 미충족 시 구현 팀원에게 수정을 요청하는 루프를 돌리되 최대 반복 가드를 지킵니다.

## 출처

모든 내용은 아래 Anthropic 공식 문서를 기반으로 합니다.

- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/agents
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/best-practices
- https://code.claude.com/docs/en/settings
- https://code.claude.com/docs/en/model-config
