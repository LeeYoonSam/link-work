# AI 대화 기능 — 아키텍처 및 구현 문서

LinkWork의 "AI 대화" 메뉴가 어떤 구조와 흐름으로 동작하는지 기술한다.
보안/가드레일 기준은 [AI_GUARDRAILS.md](./AI_GUARDRAILS.md) 참고.

## 1. 개요

- 사용자가 자연어로 질문하면 AI가 LinkWork의 실제 데이터(프로젝트/태스크/TODO/메모/
  문서/변수/활동로그/Google 캘린더)와 연결된 외부 지식(Notion, Atlassian(Jira),
  웹 페이지)을 도구로 조회해서 답하는 로컬 전용 채팅 기능.
- 응답은 마크다운으로 렌더링되며, `linkwork://` 링크를 통해 앱 내 화면 이동·문서 열기
  같은 액션을 수행할 수 있다.
- 채팅 목록/히스토리는 SQLite에 영속화되고, 채팅 재진입 시 AI 세션도 이어진다.

## 2. 기술 스펙

| 항목 | 값 |
|---|---|
| AI 실행 | `@anthropic-ai/claude-agent-sdk` (^0.3.170), Electron **main 프로세스**에서 실행 |
| 인증 | **Claude Code 구독 계정 OAuth 전용** — 시스템에 설치·로그인된 Claude Code의 인증을 그대로 사용 (구독 한도 소모, 별도 과금 없음). API 키/Bedrock/Vertex 등 과금 경로는 앱이 env에서 제거해 원천 차단 |
| 모델 | `claude-sonnet-5` (`ai-agent.ts`의 `AI_MODEL` 상수) |
| 턴 제한 | `maxTurns: 30` |
| 데이터 조회 | in-process MCP 서버 (`createSdkMcpServer` + `tool()`) — 별도 프로세스 없이 main 프로세스 안에서 도구 핸들러 실행 |
| 영속화 | better-sqlite3 (`ai_chats`, `ai_messages`, `ai_audit_log`) |
| UI | React 19 + zustand + react-markdown (기존 `MarkdownContent` 재사용) |

## 3. 아키텍처

```
┌─ Renderer (React) ─────────────────────────────────────────┐
│  AiChatView.tsx          채팅 리스트(접기 가능) + 대화 화면     │
│   ├─ MessageBubble       user/assistant 말풍선               │
│   ├─ MarkdownContent     마크다운 + linkwork:// 링크 처리      │
│   └─ aiChatStore.ts      zustand: 채팅/메시지/스트리밍 상태     │
└──────────────┬─────────────────────────────────────────────┘
               │ window.api.ai.*  (contextBridge)
┌─ Preload ────┴─────────────────────────────────────────────┐
│  ipcRenderer.invoke('ai:*')  /  ipcRenderer.on('ai:stream') │
└──────────────┬─────────────────────────────────────────────┘
               │ IPC
┌─ Main ───────┴─────────────────────────────────────────────┐
│  ai.ipc.ts        채팅 CRUD, 메시지 저장, 입력 검증, 전송 시작   │
│  ai-agent.ts      Agent SDK query() 실행/스트리밍/취소/세션     │
│   ├─ canUseTool   도구 화이트리스트 강제                       │
│   └─ ai-audit.ts  감사 로그 (ai_audit_log)                   │
│  ai-tools.ts      조회 도구 13종 (in-process MCP)             │
│   ├─ database.ts  getAiReadOnlyDatabase() ← 읽기 전용 커넥션   │
│   ├─ google-calendar.ts  getEventsInRange()                 │
│   ├─ notion.ts    Notion API (검색/페이지 읽기)                │
│   └─ web-fetch.ts fetch_url (SSRF 가드 + HTML→텍스트)         │
└──────────────┬─────────────────────────────────────────────┘
               │ spawn (Agent SDK 내부)
┌─ Claude Code CLI ──────────────────────────────────────────┐
│  /opt/homebrew/bin/claude 등에서 탐색 (findClaudeExecutable)  │
│  → 구독 OAuth로 Anthropic API 호출, MCP 도구 호출은            │
│    main 프로세스의 ai-tools 핸들러로 라우팅됨                   │
└────────────────────────────────────────────────────────────┘
```

핵심 설계 포인트:

- **도구가 main 프로세스 안에서 실행됨** (in-process MCP). DB 접근에 별도 서버/프로세스가
  필요 없고, CLI는 도구 호출을 SDK로 위임한다.
- **모든 AI 코드는 main 프로세스에만 존재**. renderer는 IPC API와 스트림 이벤트만 안다.

## 4. 모듈 구성 (파일 맵)

| 파일 | 역할 |
|---|---|
| `src/main/services/ai-agent.ts` | 쿼리 실행 엔진. 시스템 프롬프트, 스트리밍 중계, 취소, 세션 resume, 진행상태 보관, 동시 실행 상한, 도구 게이트(canUseTool) |
| `src/main/services/ai-tools.ts` | LinkWork 조회 도구 + 외부 지식 도구(Notion/웹) 정의 (zod 스키마 + SQL) |
| `src/main/services/ai-write-tools.ts` | 쓰기 도구 10종 (생성 5종 `create_project`/`create_task`/`create_todo`/`create_memo`/`create_variable` + 수정 5종, HITL 승인 — 가드레일 문서 7절) |
| `src/main/services/ai-audit.ts` | 감사 로그 기록 헬퍼 |
| `src/main/services/notion.ts` | Notion 연동 (토큰 safeStorage 저장, 검색/페이지/DB 조회 API) |
| `src/main/services/notion-markdown.ts` | Notion 블록 → 마크다운 변환 (순수 함수, 단위 테스트) |
| `src/main/services/web-fetch.ts` | fetch_url용 웹 페이지 로드 + HTML→텍스트 (SSRF 가드, 단위 테스트) |
| `src/main/services/ai-attachments.ts` | 이미지 첨부 저장/검증/정리 (`userData/ai-attachments`) |
| `src/main/ipc/ai.ipc.ts` | IPC 핸들러 (`ai:*` 채널), 입력/첨부 검증, 제목 자동 설정, Notion 연동 IPC |
| `src/main/db/database.ts` | 테이블 스키마 + AI 전용 읽기 전용 커넥션 |
| `src/preload/index.ts` | `window.api.ai` 노출 |
| `src/renderer/src/stores/aiChatStore.ts` | 채팅 상태 관리 (zustand) |
| `src/renderer/src/components/ai/AiChatView.tsx` | 채팅 UI 전체 (이미지 첨부, Notion 연동 모달 포함) |
| `src/renderer/src/types/index.ts` | `AiChat`, `AiMessage`, `AiStreamEvent`, `AiAPI` 등 타입 |

## 5. 데이터 모델

```sql
ai_chats (                          -- 채팅(대화방)
  id, title,                        -- 제목: 첫 사용자 메시지 30자로 자동 설정
  session_id,                       -- Claude 세션 ID (resume용, 매 응답마다 갱신)
  created_at, updated_at
)
ai_messages (                       -- 메시지
  id, chat_id → ai_chats(CASCADE),
  role,                             -- 'user' | 'assistant'
  content,                          -- 마크다운 텍스트
  meta,                             -- JSON: 이미지 첨부 { attachments: [{ file, name, type }] }
  created_at
)
ai_audit_log (                      -- 감사 로그 (가드레일 문서 참고)
  id, chat_id, event, tool_name, input, detail, duration_ms, created_at
)
```

## 6. 메시지 전송 흐름 (시퀀스)

```
사용자 입력 (Enter)
  → aiChatStore.sendMessage()
      1. user 메시지 낙관적 추가 + isStreaming=true
      2. invoke('ai:send', chatId, text, attachments?)   ← 이미지는 ArrayBuffer로 전달
  → ai.ipc.ts 'ai:send'
      3. 검증: 빈 메시지 / 4,000자 초과 / 첨부(개수·크기·타입) / 채팅당 1쿼리 / 전체 동시 3쿼리
      4. 첨부 이미지를 userData/ai-attachments에 저장 → user 메시지 DB 저장
         (meta에 첨부 목록 JSON), 첫 메시지면 채팅 제목 자동 설정
      4-1. 첨부가 있으면 프롬프트에 "[첨부 이미지]" 경로 목록을 덧붙임
           → AI가 Read 도구로 이미지를 직접 확인 (Read는 첨부 디렉토리만 허용)
      5. runAiQuery() 시작 (await 안 함 — 즉시 { started: true } 반환)
  → ai-agent.ts runAiQuery()
      6. 감사 query_start 기록, AbortController 등록
      7. SDK query() 실행:
         systemPrompt(오늘 날짜/규칙/링크 형식) + resume(session_id)
         + mcpServers(linkwork) + allowedTools/disallowedTools/canUseTool
      8. 메시지 루프에서 webContents.send('ai:stream', ...) 으로 중계
         - stream_event(text_delta) → { event:'text', delta }
         - assistant(tool_use)      → { event:'tool', label } + 감사 tool_call
         - result                   → session_id 저장, assistant 메시지 DB 저장
                                      → { event:'done', message } + 감사 query_done
      9. resume 실패 시 새 세션으로 1회 재시도. 취소 시 부분 응답 저장
  → aiChatStore.handleStreamEvent()
      10. delta 누적 표시 → done에서 저장된 메시지로 교체, 리스트 갱신
```

### 스트리밍 프로토콜 (`ai:stream` 이벤트)

| event | payload | 의미 |
|---|---|---|
| `start` | — | 쿼리 시작 |
| `text` | `delta` | 응답 텍스트 조각 (renderer에서 누적) |
| `tool` | `name`, `label` | 도구 사용 중 ("프로젝트 목록 조회 중…" 표시) |
| `done` | `message?`, `cancelled?` | 완료. message는 DB에 저장된 assistant 행 |
| `error` | `error` | 실패 (사용자에게 표시) |

다른 채팅을 보다가 돌아와도 진행 상태가 복원된다: main이 채팅별로 누적 텍스트와
도구 상태를 보관하고(`ActiveQuery`), `openChat` 시 `ai:progress`로 조회해 복원.

## 7. 세션 관리 (멀티턴 컨텍스트)

- Claude Code의 세션 resume 기능 사용: 매 응답의 `result.session_id`를 `ai_chats`에
  저장하고, 다음 질문에서 `resume: sessionId`로 이어가 **이전 대화 맥락 유지**.
- 세션 파일은 cwd 기준으로 저장되므로 `cwd`를 `app.getPath('userData')`로 고정해
  resume 안정성 확보.
- 세션 파일이 삭제/만료돼 resume이 실패하면 새 세션으로 1회 자동 재시도
  (이 경우 이전 맥락은 사라지지만 동작은 유지).

## 8. 조회 도구

모두 읽기 전용이며 전체 이름은 `mcp__linkwork__<이름>`. LinkWork 데이터 도구는
읽기 전용 DB 커넥션을 사용한다.

### 8.1 LinkWork 데이터 (10종)

| 도구 | 용도 |
|---|---|
| `list_projects` | 프로젝트 목록 + 태스크 진행 요약 (status/이름 필터) |
| `get_project` | 프로젝트 상세 + 전체 태스크 + 연결 문서 (ID 또는 이름) |
| `list_todos` | TODO 목록 + 태그 (완료/검색/태그 필터, notes 300자 truncate) |
| `get_todo` | TODO 상세 (notes 전문 + 알람 설정 — 수정 전 확인용) |
| `search_memos` | 메모 검색 (내용/카테고리/중요/보관 필터, 1000자 truncate) |
| `get_memo` | 메모 전문 조회 (수정 전 확인용) |
| `list_documents` | 문서 목록 + 프로젝트명 (검색/프로젝트 필터) |
| `list_variables` | 변수 목록 (secret 값은 마스킹) |
| `get_activity_log` | 기간별 활동 이력 — "이번주 작업 정리" 용 |
| `get_calendar_events` | Google 캘린더 일정 (기간 지정, 미연동 시 안내 반환) |

### 8.2 외부 지식 (Notion / Atlassian(Jira) / 웹 링크)

| 도구 | 용도 | 게이트 |
|---|---|---|
| `search_notion` | 연동된 Notion 워크스페이스 검색 (제목/ID/URL) | 자동 허용 (사용자 소유 데이터) |
| `get_notion_page` | Notion 페이지 내용을 마크다운으로 읽기 (URL 또는 ID, DB면 항목 목록) | 자동 허용 |
| Atlassian(Jira) 커넥터 6종 | Jira 티켓·프로젝트·JQL 검색 + Atlassian 통합 검색/리소스 본문 읽기 (claude.ai 커넥터, `mcp__claude_ai_Atlassian_Rovo__…`) | 자동 허용 (읽기 전용, 커넥터 연결 필요) |
| `fetch_url` | 일반 웹 페이지를 텍스트로 읽기 (Notion URL은 API로 위임) | **조건부 승인 카드** — 사용자 메시지에 없는 호스트는 HITL |

- **Notion 연동 (2가지 경로)**:
  1. **claude.ai Notion 커넥터 (기본, 제로 설정)** — 구독 계정에 커넥터가 연결돼
     있으면 SDK 쿼리에 자동 로드된다. 앱은 읽기 도구 2종
     (`mcp__claude_ai_Notion__notion-search`/`notion-fetch`)만 화이트리스트에 허용
     (가드레일 문서 8.1절). 도구는 ToolSearch 뒤에 지연 로드되므로
     `HARNESS_ALLOWED_TOOLS`의 ToolSearch 허용이 전제 조건.
  2. **internal integration 토큰 (대안)** — 채팅 리스트 하단의 "Notion 연동" 버튼 →
     토큰 등록 (main이 `/users/me`로 검증 후 safeStorage 암호화하여 `app_settings`에
     저장). 블록 트리는 깊이 3 / 500블록 / 15,000자 상한으로 수집한다 (`notion.ts`).
     토큰 등록 시 시스템 프롬프트가 이 경로를 우선 지시한다.
- **Atlassian(Jira) 연동 (claude.ai 커넥터)**: 구독 계정에 Atlassian 커넥터가 연결돼
  있으면 SDK 쿼리에 계정 레벨로 자동 로드된다 (Notion 커넥터와 동일한 메커니즘). 앱은
  읽기 전용 6종(`CLAUDE_AI_ATLASSIAN_READ_TOOLS` —
  `getAccessibleAtlassianResources`/`getVisibleJiraProjects`/`getJiraIssue`/
  `searchJiraIssuesUsingJql`/`search`/`fetch`)만 화이트리스트에 허용하고, 쓰기 도구
  (create/edit/comment/transition 등)는 catch-all 거부한다 (가드레일 문서 8.2절).
  도구는 ToolSearch 뒤에 지연 로드되므로 `HARNESS_ALLOWED_TOOLS`의 ToolSearch 허용이
  전제 조건. 앱이 연결 여부를 감지할 수 없어 시스템 프롬프트는 "도구가 있으면 사용,
  없으면 claude.ai에서 커넥터 연결 안내"로 서술한다.
- **fetch_url**: http/https만, 로컬호스트/사설망 차단, 리다이렉트 5회(매 단계 재검증),
  2MB/15초/12,000자 상한 (`web-fetch.ts`). 승인 게이트의 근거는 가드레일 문서 8절.

### 8.3 이미지 첨부

- 입력창의 이미지 버튼/클립보드 붙여넣기/드래그&드롭으로 첨부 (최대 4장,
  장당 8MB, PNG/JPEG/WebP/GIF — renderer와 main 양쪽에서 검증).
- 파일은 `userData/ai-attachments/<chatId>-<ts>-<i>.<ext>`에 저장되고,
  프롬프트에 경로가 추가되어 AI가 내장 `Read` 도구로 이미지를 직접 본다.
  `canUseTool`이 Read를 **첨부 디렉토리 안의 파일로만 제한**한다.
- renderer 표시는 `linkwork-media://attachment/<파일명>` 프로토콜 라우트 사용
  (`main/index.ts` — 오디오와 같은 프로토콜의 별도 host).
- 채팅 삭제 시 해당 채팅의 첨부 파일도 함께 삭제된다 (`removeChatAttachments`).

## 9. `linkwork://` 링크 스킴 (앱 내 액션)

시스템 프롬프트가 AI에게 아래 형식으로 링크를 생성하도록 지시하고,
renderer의 `MarkdownContent`가 클릭을 가로채 처리한다
(react-markdown의 기본 URL sanitize에서 `linkwork://`만 예외 처리).

| 링크 | 동작 (AiChatView.handleInternalLink) |
|---|---|
| `linkwork://project/{id}` | 프로젝트 상세 화면으로 이동 |
| `linkwork://document/{id}` | 해당 문서 URL을 바로 열기 (없으면 Documents 메뉴로) |
| `linkwork://view/{name}` | 메뉴 이동 (dashboard/projects/todos/…) |
| 일반 `https://` | 외부 브라우저로 열기 (기존 동작) |

## 10. 빌드/패키징 주의사항

- **ESM 전용 SDK**: Agent SDK는 ESM-only인데 main 프로세스는 CJS로 번들된다.
  반드시 **dynamic `import()`로 lazy 로드**해야 한다 (`loadSdk()`, `buildServer()`).
  정적 import를 쓰면 `require()`로 변환되어 앱 로드 시 `ERR_REQUIRE_ESM`으로 죽는다.
- **claude 실행 파일 탐색**: 패키징된 GUI 앱은 셸 PATH가 없으므로
  `findClaudeExecutable()`이 `/opt/homebrew/bin/claude` 등 알려진 절대경로를 탐색해
  `pathToClaudeCodeExecutable`로 전달한다. 못 찾으면 SDK 기본 동작(번들 CLI + node).
- **asarUnpack**: `package.json` build 설정에 SDK 패키지를 unpack 지정
  (spawn 대상 파일이 asar 안에 있으면 실행 불가).
- **settingSources: []**: 사용자의 전역 Claude Code 설정/훅이 앱 쿼리에 개입하지
  않도록 격리.
- **과금 경로 차단**: `sanitizedEnv()`가 `ANTHROPIC_API_KEY` 등 과금 유발 환경변수를
  SDK에 전달하지 않는다 — 구독 OAuth만 사용 ([가드레일 문서](./AI_GUARDRAILS.md) 참고).

## 11. 확장 가이드

- **조회 도구 추가**: `ai-tools.ts`의 `buildServer()`에 `tool()` 정의 → tools 배열과
  파일 상단 `LINKWORK_TOOL_NAMES` 목록에 추가 → 필요 시 `ai-agent.ts`의
  `TOOL_LABELS`에 한국어 라벨 추가.
- **데이터 추가/수정/삭제 도구**: [AI_GUARDRAILS.md의 "쓰기 도구 도입 기준"](./AI_GUARDRAILS.md#7-쓰기-도구-도입-기준-향후)을
  반드시 따를 것 (HITL 승인, 소프트 삭제, 일괄 변경 금지, 채팅별 쓰기 모드 등).
- **모델/턴 수 변경**: `ai-agent.ts`의 `AI_MODEL`, `MAX_TURNS` 상수.
- **시스템 프롬프트(답변 포맷) 조정**: `ai-agent.ts`의 `buildSystemPrompt()`.
