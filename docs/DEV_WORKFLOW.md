# 개발 워크플로 가이드

이 저장소에서 Claude Code로 개발·리뷰·문서화하는 방법을 설명한다. 규칙은 [DEV_GUIDELINES.md](DEV_GUIDELINES.md)에 있고, 이 문서는 그 규칙을 따르는 방법을 다룬다.

목차: 1. 작업 경로 고르기 · 2. 기본 흐름 · 3. reviewer 부르기 · 4. 내장 명령 · 5. Workflow 도구 · 6. Agent Teams(선택) · 7. 문서 동기화 · 8. 자주 겪는 함정 · 9. 개발 자산 목록

## 1. 작업 경로 고르기

| 작업 종류 | 경로 | 예 |
|-----------|------|----|
| 문구·상수·한 화면 수정 | 단독 | 기본 탭 변경 |
| IPC·스키마·프로세스 경계를 넘는 다파일 변경 | 단독 구현 + `reviewer` 1회 | IPC 채널 추가 |
| 독립 묶음 2개 이상·리서치·시안 경쟁·토론·전수 점검 | Workflow 도구("워크플로로 해줘") | 시안 3개 비교 |
| 경쟁 가설 디버깅처럼 팀원끼리 대화가 필요할 때(요청 시) | Agent Teams | 원인 가설 세 개를 동시에 검증 |

애매하면 단독으로 시작하고, 구현이 경계를 넘게 되면 reviewer를 붙인다.

## 2. 기본 흐름

1. 완료 조건을 정한다. CLAUDE.md 검증 명령 표에서 고르고, 코드를 바꾸면 `npm run check:docs` 종료 코드 0을 넣는다.
2. 큰 작업이면 플랜 모드로 계획하거나, 질문으로 요구를 확정한 뒤 짧은 스펙을 쓴다.
3. 구현한다. 버그면 재현 테스트를 먼저 쓴다. 중간 테스트는 필요한 만큼 자유롭게 돌린다.
4. 모든 편집이 끝난 뒤 최종 판정 명령을 한 번 실행한다. reviewer를 부르는 작업이면 메인 세션은 돌리지 않고 reviewer가 맡는다.
5. 해당하는 작업이면 reviewer를 부른다(3절).
6. 지적을 반영한다. 수정→검증은 최대 3회다.
7. 문서를 동기화한다(7절).
8. 보고한다. 완료 조건별 결과, 바꾼 파일, 문서 동기화 근거, 커밋·푸시·deploy 수행 여부를 적고 하지 않은 단계의 명령을 제안한다.

## 3. reviewer 부르기

reviewer는 `.claude/agents/reviewer.md`에 정의된 서브에이전트다. 대화 기록을 물려받지 않으므로 필요한 것을 프롬프트에 모두 담는다. 모델은 정의의 `model`을 그대로 쓴다.

```
목표: <이 변경으로 이루려는 것>
플랜 요지: <설계 결정과 바꾼 구조 3~5줄>
완료 조건 명령: npx vitest run / npm run typecheck / npm run build / npm run check:docs
이미 돌린 명령 결과: <명령별 종료 코드와 요지. 없으면 "없음">
git diff 범위: <예: main...HEAD 또는 작업 트리 전체>
특히 볼 곳: <IPC 계약, 마이그레이션, 경쟁 상태가 걱정되는 파일과 함수>
```

- reviewer는 `npm run deploy`, `npm run check:diar`, `npm run check:diar-mem`을 돌리지 않는다. 필요하면 메인 세션이 돌린다. /Applications 쓰기, 키체인 입력, 장시간 실녹음 실행이 따르기 때문이다.
- 돌아오는 형식은 완료 조건 표, 발견 목록(`파일:줄`·근거·확신도), 문서 대조 세 부분이다.
- 고치는 쪽은 메인 세션이다. 지적은 전부 받고, 고칠 것을 메인 세션이 고른다.
- 고친 뒤 reviewer를 다시 부르는 것도 반복 횟수(최대 3회)에 포함된다.

## 4. 내장 명령

- `/code-review`: 작은 변경용 diff 리뷰. reviewer를 붙일 정도가 아닌 변경에 쓴다.
- `/simplify`: 정리 전용. 재사용·단순화만 보고 버그는 보지 않는다.
- `/run`: 앱을 실행해 변경이 실제로 동작하는지 확인한다.
- 플랜 모드: 구현 전에 읽기만 하며 계획을 세운다. 큰 작업의 첫 단계로 쓴다.
- `/model`·`/effort`: 메인 세션 모델과 노력도를 정한다.
- `/reload-skills`: 스킬 파일을 고친 뒤 다시 읽어 들인다.
- `/memory`: 지금 로드된 지침 파일(CLAUDE.md와 import한 문서)을 확인한다.

## 5. Workflow 도구

- Claude Code 내장 기능이다. 스크립트로 여러 서브에이전트를 병렬·순차로 돌리고 결과만 메인 대화로 돌려준다. 이 저장소는 별도 스킬 없이 이 도구를 직접 쓴다.
- 사용자가 "워크플로로 해줘"처럼 요청할 때 실행한다. 요청이 없으면 Claude는 필요해 보일 때 제안만 한다.
- 여러 에이전트가 동시에 돌기 때문에 토큰 사용량이 크다. 독립 묶음이 여럿이거나 탐색 폭이 넓을 때만 쓴다.
- 코드를 쓰는 단계는 파일 세트가 겹치지 않게 나누고, 검증 명령은 모든 편집이 끝난 뒤 한 에이전트가 한 번 돌린다. 리뷰 단계는 `reviewer` 에이전트(`agentType: 'reviewer'`)를 쓸 수 있다.
- 진행 상황은 `/workflows`로 본다. 도구가 없으면 `/config`에서 Dynamic workflows를 켠다.

## 6. Agent Teams(선택)

- 실험 기능이라 기본으로 꺼 두었다. 켜 두면 일반 서브에이전트까지 팀원으로 바뀌기 때문이다.
- 켤 때는 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude`로 그 세션에서만 켠다.
- 팀원은 리더의 대화를 물려받지 않는다. 스폰 프롬프트에 플랜, 완료 조건, 맡을 파일을 담는다.
- 같은 파일을 두 팀원이 고치지 않게 파일을 나눈다.
- 공식 문서: https://code.claude.com/docs/en/agent-teams

## 7. 문서 동기화

- `npm run check:docs -- --changed`가 바뀐 코드에 대응하는데 함께 바뀌지 않은 문서를 보여 준다.
- Stop 훅(`scripts/docs-stop-hook.mjs`)은 턴 종료 시 확인 대상 문서와 `check:docs` 오류를 알리고 한 번 멈춰 세운다. 두 번째 종료는 통과한다.
- 새 문서는 `docs/docs-map.json`의 구역과 CLAUDE.md '기존 문서' 목록에 함께 등록한다. 매핑이 필요 없는 문서는 `unmappedDocs`에 사유와 함께 적는다.
- 세부 규칙은 CLAUDE.md의 문서 동기화 정책을 따른다.

## 8. 자주 겪는 함정

- 워크트리 사본 테스트 중복: `.claude/worktrees` 아래 사본의 테스트는 `vitest.config.ts`의 exclude로 수집에서 빠진다.
- deploy 후 키체인 팝업: 사용자 입력이 필요하다. 막히면 보고에 남기고 사용자에게 맡긴다.
- 기존 실패 테스트: '무관'으로 넘기지 않는다. 고치지 못하면 완료로 보고하지 않고 알린다.
- Stop 훅 알림: 같은 세션에서 같은 내용은 한 번만 멈춰 세운다. 목록이 바뀌거나 새 세션이면 다시 뜬다. 뜨면 해당 문서를 코드와 대조하고, 고칠 것이 없으면 근거를 보고에 적는다.

## 9. 개발 자산 목록

| 자산 | 역할 |
|------|------|
| `.claude/settings.json` | Stop 훅 등록 |
| `.claude/agents/reviewer.md` | 경계를 넘는 변경의 분리 리뷰 서브에이전트 |
| `scripts/check-docs.mjs` | 문서 경로·IPC 채널·매핑 검사(`npm run check:docs`) |
| `scripts/docs-stop-hook.mjs` | 턴 종료 시 문서 동기화 확인 |
| `docs/docs-map.json` | 코드 구역과 문서의 대응 |
| `docs/DEV_GUIDELINES.md` | 확정 개발 규칙(CLAUDE.md가 import) |

공식 문서:

- 스킬: https://code.claude.com/docs/en/skills
- 서브에이전트: https://code.claude.com/docs/en/sub-agents
- 훅: https://code.claude.com/docs/en/hooks
- 메모리(CLAUDE.md·import): https://code.claude.com/docs/en/memory
- 워크플로: https://code.claude.com/docs/en/workflows
- 로컬 코드 리뷰: https://code.claude.com/docs/en/code-review-local
- 모범 사례: https://code.claude.com/docs/en/best-practices
