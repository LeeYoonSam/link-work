---
name: project-sync
description: Jira 프로젝트 싱크업(Jira 할 일 이슈 → LinkWork 프로젝트·작업·문서 동기화)의 규칙이나 코드를 수정하거나 오동작을 조사할 때 사용한다. 트리거 — "싱크업", "프로젝트 싱크", "지라 동기화 규칙", "Sustain/QA 분류 수정", "싱크업이 프로젝트를 잘못 만들었다", "싱크업 매칭", project-sync 관련 파일 수정.
argument-hint: [변경 또는 조사 내용]
---

# project-sync — 싱크업 규칙·코드 작업 워크플로

프로젝트 싱크업의 규칙 변경, 버그 수정, 오동작 조사(`$ARGUMENTS`)를 아래 순서로 수행한다.
설계 판단이 들어가는 변경이면 CLAUDE.md 정책대로 `/team-dev`와 함께 쓰고, 이 스킬의 완료 조건을 플랜에 포함한다.

## 1. 기준 문서를 먼저 읽는다
`docs/PROJECT_SYNC.md`가 단일 기준이다. 특히 §3 규칙(R1~R10)과 이유, §5 덮어쓰지 않는 필드, §8 가드레일, §11 알려진 한계.
요청된 동작이 문서와 충돌하면 코드부터 고치지 말고 그 충돌을 먼저 사용자/리더에게 확인한다.

## 2. 변경 순서 — 문서 → 픽스처·테스트 → 구현
1. **문서**: `docs/PROJECT_SYNC.md`의 해당 규칙·이유를 고친다. 새 규칙이면 다음 ID(R11…)를 붙인다.
2. **픽스처·테스트**: `src/main/services/__fixtures__/project-sync/`에 재현 사례를 추가하고, 규칙 ID를 이름에 넣은 테스트를 `project-sync-plan.test.ts`에 추가·수정한다. 적용·DB 동작이면 `project-sync.test.ts`. 테스트가 **먼저 실패하는 것**을 확인한다.
3. **구현**: 분류·매칭·diff는 `project-sync-plan.ts`, ADF 해석은 `project-sync-adf.ts`(둘 다 순수 함수), 조회는 `jira.ts`, 적용은 `project-sync.ts`. 계획 로직을 `project-sync.ts`나 IPC에 넣지 않는다.

오동작 조사도 같다 — 증상을 픽스처로 재현하는 테스트를 먼저 만들고, 그 테스트가 어떤 규칙 ID에 해당하는지 정한 뒤 고친다.

## 3. 실 Jira 데이터 확인은 읽기 전용으로만
픽스처를 만들거나 실제 형태(이슈 타입, 상태 이름, labels, ADF, remotelink)를 확인해야 하면 **조회 도구만** 쓴다.
- 허용: JQL 검색, 이슈 조회, remote link 조회 (Atlassian MCP의 `searchJiraIssuesUsingJql`·`getJiraIssue`·`getJiraIssueRemoteIssueLinks`, 또는 `jira` 스킬의 조회 기능).
- 픽스처에는 형태만 옮기고, 실 계정 정보(이메일, accountId, 토큰)는 넣지 않는다.

## 4. 완료 조건 (기계 판정)
아래를 전부 실행해 확인한다. 하나라도 미충족이면 완료가 아니다. 판정은 `sync-verifier` 에이전트에 맡길 수 있다.

- [ ] `npx vitest run` 종료 코드 0, 실패 0건
- [ ] `npm run typecheck` 에러 0건
- [ ] `npm run build` 종료 코드 0
- [ ] `npx vitest run src/main/services/project-sync` 종료 코드 0
- [ ] 규칙 ID별 테스트 존재 — 아래가 `MISSING`을 출력하지 않음
      `for i in 1 2 3 4 5 6 7 8 9 10; do grep -qE "R$i([^0-9]|$)" src/main/services/project-sync-plan.test.ts || echo "MISSING R$i"; done`
      (R11 이상을 추가했다면 그 번호도 루프에 넣는다)
- [ ] Jira 쓰기 호출 없음 — `grep -n "method:" src/main/services/jira.ts` 결과가 전부 `'GET'`
- [ ] 계획 모듈 순수성 — `grep -nE "from '(electron|better-sqlite3|\.\./db)" src/main/services/project-sync-plan.ts src/main/services/project-sync-adf.ts` 0건
- [ ] 싱크업 경로 삭제 없음 — `grep -n "DELETE FROM" src/main/services/project-sync.ts src/main/services/project-sync-plan.ts src/main/ipc/project-sync.ipc.ts` 0건
- [ ] 문서 반영 — 규칙을 바꿨다면 `git diff --stat docs/PROJECT_SYNC.md`에 변경이 있음

## 5. 반복 한도
CLAUDE.md 검증 루프 정책과 같다.
- 구현 → 검증 → 수정 루프는 **최대 5회**.
- **같은 실패가 2회 연속**이면 접근을 바꾸거나 멈추고 보고한다.
- 중단 시 미충족 항목, 시도한 내용, 원인 분석을 보고한다.

## 6. 금지 사항
- **Jira 쓰기 금지** — `jira.ts`에 GET 외 메서드를 추가하지 않는다. 조사 중에도 이슈 생성·수정·상태 전환·댓글·워크로그·이슈 링크 생성 도구를 호출하지 않는다.
- **싱크업에서의 삭제 금지** — 프로젝트·작업·문서를 지우는 경로를 만들지 않는다 (R4).
- **덮어쓰기 범위 확대 금지** — 보수 경로(§5)를 완화하거나 강제 업데이트(R10)가 덮는 필드를 늘리는 것은 문서 변경 없이 하지 않는다. 덮어쓰기는 `force=true`(사용자 확인)일 때만이다.
- **사용자 실 DB에 쓰기 테스트 금지** — 적용 테스트는 `project-sync.test.ts`처럼 better-sqlite3를 `node:sqlite` 인메모리 shim으로 바꿔 실제 스키마로만 돌린다(`release-note-sync.test.ts` 패턴). 앱을 실행해 실데이터로 apply를 시험하지 않는다. 실 DB 확인이 필요하면 읽기 전용으로 조회만 한다.
