import { z } from 'zod'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { getAiReadOnlyDatabase } from '../db/database'
import { MEMO_WITH_CATEGORY_SELECT } from '../utils/memo-helpers'
import { applyProjectAutoStatus, type ProjectStatusFields } from '../utils/project-dates'
import { TODO_TAGS_SUBQUERY } from '../utils/todo-helpers'
import { getEventsInRange } from './google-calendar'
import { buildWriteTools, maskSecretVariable, TRUNCATION_MARKER } from './ai-write-tools'
import {
  getNotionDatabaseEntries,
  getNotionPageContent,
  isNotionConnected,
  searchNotion
} from './notion'
import { extractNotionPageId } from './notion-markdown'
import { sortReleaseNotes } from './release-note-sync'
import type { ReleaseNoteSummary } from './release-note-sync'
import { fetchUrlAsText } from './web-fetch'

// LinkWork 데이터 검색 도구.
//
// [가드레일] — docs/AI_GUARDRAILS.md 참고
// 1. 모든 도구는 읽기 전용 DB 커넥션(getAiReadOnlyDatabase)을 사용한다.
//    SQLite가 커넥션 레벨에서 쓰기를 차단하므로 INSERT/UPDATE/DELETE가 물리적으로 불가능하다.
// 2. 검색어/날짜 등 입력은 zod로 길이·형식을 제한한다 (SQL은 전부 바인딩 파라미터 사용).
// 3. secret 변수 값은 마스킹 후 반환한다.
// 추후 쓰기 도구를 도입할 때는 반드시 문서의 "쓰기 도구 도입 기준"을 따를 것.

const searchTerm = (desc: string): z.ZodOptional<z.ZodString> =>
  z.string().max(200).optional().describe(desc)
const dateArg = (desc: string): z.ZodString =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식').describe(desc)

// SDK MCP 도구의 전체 이름: mcp__<serverName>__<toolName>
export const LINKWORK_TOOL_NAMES = [
  'list_projects',
  'get_project',
  'list_todos',
  'get_todo',
  'search_memos',
  'get_memo',
  'list_documents',
  'list_variables',
  'get_activity_log',
  'get_calendar_events',
  // 릴리스 노트는 이미 동기화된 로컬 DB만 읽으므로(Jira 직접 호출 없음) 자동 허용
  'list_release_notes',
  'get_release_note',
  // Notion은 사용자 자신의 워크스페이스를 읽기 전용으로 조회하므로 자동 허용
  'search_notion',
  'get_notion_page'
].map((name) => `mcp__linkwork__${name}`)

// fetch_url은 의도적으로 LINKWORK_TOOL_NAMES(자동 허용)에 넣지 않는다.
// 도구 결과(메모 등)에 심긴 지시문이 임의 URL로 데이터를 실어 보내는 유출 경로가
// 될 수 있어, 사용자 메시지에 없는 호스트는 승인 카드를 거친다 (ai-agent.ts canUseTool).
export const FETCH_URL_TOOL_NAME = 'mcp__linkwork__fetch_url'

let serverPromise: Promise<McpSdkServerConfigWithInstance> | null = null

export function getLinkworkMcpServer(): Promise<McpSdkServerConfigWithInstance> {
  if (!serverPromise) serverPromise = buildServer()
  return serverPromise
}

function jsonResult(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] }
}

const NOTION_NOT_CONNECTED_MESSAGE =
  'Notion이 연동되어 있지 않습니다. AI 대화 화면의 "Notion 연동" 설정에서 통합 토큰을 등록하도록 사용자에게 안내하세요.'

function toErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message === 'NOTION_NOT_CONNECTED') return NOTION_NOT_CONNECTED_MESSAGE
  if (/timeout|timed?\s*out|aborted/i.test(message)) {
    return '요청 시간이 초과되었습니다. 잠시 후 다시 시도하거나 다른 URL을 사용해 주세요.'
  }
  return message
}

function truncate(text: string | null, max: number): string | null {
  if (text === null) return null
  return text.length > max ? text.slice(0, max) + TRUNCATION_MARKER : text
}

// 릴리스 노트 공통 SELECT — 목록/상세가 같은 필드를 보이도록 한 곳에 둔다.
// item_count는 항목 수만 필요한 목록에서도, 200건 상한 초과 판단이 필요한 상세에서도 쓰인다.
const RELEASE_NOTE_SELECT = `SELECT r.id,
          r.jira_project_key, r.jira_version_id, r.version_name, r.description,
          r.released, r.archived, r.release_date, r.start_date,
          r.last_synced_at, r.last_sync_error,
          (SELECT COUNT(*) FROM release_note_items i WHERE i.release_note_id = r.id) AS item_count
   FROM release_notes r`

// Jira에서 온 문자열(버전 설명·이슈 제목)은 신뢰할 수 없는 외부 입력이라 길이를 제한한다.
const RELEASE_NOTE_TEXT_MAX = 300
const RELEASE_NOTE_ITEM_LIMIT = 200

async function buildServer(): Promise<McpSdkServerConfigWithInstance> {
  // Agent SDK는 ESM 전용이라 CJS로 번들되는 main 프로세스에서 정적 import(require) 불가.
  // 동적 import는 rollup이 CJS 출력에서도 import()로 보존하므로 런타임 로드가 가능하다.
  const { tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk')

  const listProjects = tool(
  'list_projects',
  '프로젝트 목록을 조회한다. 각 프로젝트의 일정(개발/QA/배포), 상태, 태스크 진행 요약을 반환한다. status로 필터링 가능 (scheduled|development|qa_pending|qa|deploy_pending|deploy|completed|cancelled). qa_pending은 개발 종료 후 QA 시작 전까지의 QA대기, deploy_pending은 QA 종료 후 배포일 전까지의 배포대기 상태. "진행중인 프로젝트"는 completed/cancelled가 아닌 프로젝트를 의미한다.',
  {
    status: z
      .enum([
        'scheduled',
        'development',
        'qa_pending',
        'qa',
        'deploy_pending',
        'deploy',
        'completed',
        'cancelled'
      ])
      .optional()
      .describe('프로젝트 상태 필터'),
    search: searchTerm('프로젝트 이름 부분 검색어')
  },
  async (args) => {
    const db = getAiReadOnlyDatabase()
    // 상태는 자동 계산값(applyProjectAutoStatus)으로 표시되므로, 저장된 status로 SQL 필터하면
    // 메뉴와 결과가 달라진다. 검색만 SQL에서 거르고 상태 필터는 계산 후 JS에서 적용한다.
    const where = args.search ? 'WHERE p.name LIKE ?' : ''
    const params = args.search ? [`%${args.search}%`] : []
    // 진행률은 leaf(하위를 가지지 않은 작업)만 집계한다 — 하위가 있는 상위 작업은
    // 자체 status가 진행률에 잡히지 않도록 NOT EXISTS로 제외한다(1단계 계층 규약).
    const rows = (
      db
        .prepare(
          `SELECT p.id, p.name, p.description, p.status, p.status_manual,
                  p.dev_start_date, p.dev_end_date, p.qa_start_date, p.qa_end_date,
                  p.deploy_date, p.deploy_version,
                  (SELECT COUNT(*) FROM tasks t
                     WHERE t.project_id = p.id
                       AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)
                  ) AS task_count,
                  (SELECT COUNT(*) FROM tasks t
                     WHERE t.project_id = p.id AND t.status = 'done'
                       AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)
                  ) AS done_task_count
           FROM projects p
           ${where}
           ORDER BY p.dev_start_date DESC`
        )
        .all(...params) as ProjectStatusFields[]
    ).map(applyProjectAutoStatus)
    return jsonResult(args.status ? rows.filter((p) => p.status === args.status) : rows)
  }
)

const getProject = tool(
  'get_project',
  '프로젝트 하나의 상세 정보를 조회한다. 전체 태스크 목록과 연결된 문서 목록을 포함한다. query에 프로젝트 ID(숫자) 또는 이름(부분 일치)을 전달한다.',
  {
    query: z.string().max(200).describe('프로젝트 ID 또는 이름 검색어')
  },
  async (args) => {
    const db = getAiReadOnlyDatabase()
    const byId = /^\d+$/.test(args.query.trim())
    const project = byId
      ? db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(args.query.trim()))
      : db.prepare('SELECT * FROM projects WHERE name LIKE ? ORDER BY dev_start_date DESC').get(`%${args.query}%`)
    if (!project) {
      return jsonResult({ error: `'${args.query}'에 해당하는 프로젝트를 찾지 못했습니다.` })
    }
    const p = project as { id: number }
    // parent_task_id로 1단계 계층을 표현한다(NULL=최상위). 최상위→하위 순으로 이해되도록
    // 최상위 먼저, 각자의 sort_order 순으로 정렬한다.
    const tasks = db
      .prepare(
        `SELECT id, name, start_date, end_date, status, parent_task_id
         FROM tasks WHERE project_id = ?
         ORDER BY COALESCE(parent_task_id, id), parent_task_id IS NOT NULL, sort_order, id`
      )
      .all(p.id)
    const documents = db
      .prepare('SELECT id, name, url, type, description FROM documents WHERE project_id = ? ORDER BY sort_order, id')
      .all(p.id)
    return jsonResult({
      project: applyProjectAutoStatus(project as ProjectStatusFields & Record<string, unknown>),
      tasks,
      documents
    })
  }
)

const listTodos = tool(
  'list_todos',
  'TODO 목록을 조회한다. 태그 목록을 포함해 반환한다. completed로 완료/미완료 필터, search로 제목/노트 검색, tag로 태그명 필터가 가능하다.',
  {
    completed: z.boolean().optional().describe('true면 완료된 TODO만, false면 미완료만, 생략하면 전체'),
    search: searchTerm('제목/노트 부분 검색어'),
    tag: searchTerm('태그 이름 필터')
  },
  async (args) => {
    const db = getAiReadOnlyDatabase()
    const conditions: string[] = []
    const params: unknown[] = []
    if (args.completed !== undefined) {
      conditions.push('t.is_completed = ?')
      params.push(args.completed ? 1 : 0)
    }
    if (args.search) {
      conditions.push("(t.title LIKE ? OR IFNULL(t.notes, '') LIKE ?)")
      params.push(`%${args.search}%`, `%${args.search}%`)
    }
    if (args.tag) {
      conditions.push(
        't.id IN (SELECT m.todo_id FROM todo_tag_map m JOIN todo_tags g ON g.id = m.tag_id WHERE g.name LIKE ?)'
      )
      params.push(`%${args.tag}%`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = db
      .prepare(
        `SELECT t.id, t.title, t.priority, t.due_date, t.is_completed, t.completed_at, t.notes, t.created_at,
                ${TODO_TAGS_SUBQUERY}
         FROM todos t
         ${where}
         ORDER BY t.is_completed ASC,
           CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END,
           t.created_at ASC
         LIMIT 200`
      )
      .all(...params) as { notes: string | null }[]
    return jsonResult(rows.map((r) => ({ ...r, notes: truncate(r.notes, 300) })))
  }
)

// list_todos는 notes를 300자로 자르므로, TODO 수정(update_todo) 전 전문 확인용으로 사용.
// due_reminder/시각 포함 due_date를 함께 반환해 알람을 보존한 채 수정할 수 있게 한다.
const getTodo = tool(
  'get_todo',
  'TODO 하나의 상세 정보를 조회한다. 노트(notes) 전문, 태그, 알람 설정(due_reminder)을 포함한다. TODO를 수정하기 전에 현재 값을 확인할 때 사용한다. due_date에 시각(HH:mm)이 있고 due_reminder=1이면 알람이 설정된 것이다.',
  {
    todo_id: z.number().int().positive().describe('TODO id (list_todos로 확인)')
  },
  async (args) => {
    const db = getAiReadOnlyDatabase()
    const row = db
      .prepare(
        `SELECT t.id, t.title, t.priority, t.due_date, t.due_reminder, t.is_completed, t.completed_at,
                t.notes, t.created_at, t.updated_at,
                ${TODO_TAGS_SUBQUERY}
         FROM todos t WHERE t.id = ?`
      )
      .get(args.todo_id)
    if (!row) return jsonResult({ error: `TODO id=${args.todo_id}를 찾지 못했습니다.` })
    return jsonResult(row)
  }
)

const searchMemos = tool(
  'search_memos',
  '메모를 검색한다. query로 내용 검색, category로 카테고리명 필터, important_only로 중요 메모만 조회할 수 있다. 기본적으로 보관(아카이브)되지 않은 메모만 반환한다.',
  {
    query: searchTerm('메모 내용 부분 검색어'),
    category: searchTerm('카테고리 이름 필터'),
    important_only: z.boolean().optional().describe('true면 중요 표시된 메모만'),
    include_archived: z.boolean().optional().describe('true면 보관된 메모도 포함')
  },
  async (args) => {
    const db = getAiReadOnlyDatabase()
    const conditions: string[] = []
    const params: unknown[] = []
    if (!args.include_archived) conditions.push('m.is_archived = 0')
    if (args.query) {
      conditions.push('m.content LIKE ?')
      params.push(`%${args.query}%`)
    }
    if (args.category) {
      conditions.push('c.name LIKE ?')
      params.push(`%${args.category}%`)
    }
    if (args.important_only) conditions.push('m.is_important = 1')
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = db
      .prepare(
        `${MEMO_WITH_CATEGORY_SELECT}
         ${where}
         ORDER BY m.updated_at DESC
         LIMIT 100`
      )
      .all(...params) as { content: string }[]
    return jsonResult(rows.map((r) => ({ ...r, content: truncate(r.content, 1000) })))
  }
)

// search_memos는 content를 1000자로 자르므로, 메모 수정(update_memo) 전 전문 확인용으로 사용
const getMemo = tool(
  'get_memo',
  '메모 하나의 전체 내용을 조회한다. search_memos는 내용을 1000자로 자르므로, 메모를 수정하기 전에는 반드시 이 도구로 전문을 확인한다.',
  {
    memo_id: z.number().int().positive().describe('메모 id (search_memos로 확인)')
  },
  async (args) => {
    const db = getAiReadOnlyDatabase()
    const row = db
      .prepare(
        `${MEMO_WITH_CATEGORY_SELECT}
         WHERE m.id = ?`
      )
      .get(args.memo_id)
    if (!row) return jsonResult({ error: `메모 id=${args.memo_id}를 찾지 못했습니다.` })
    return jsonResult(row)
  }
)

const listDocuments = tool(
  'list_documents',
  '문서(링크/파일) 목록을 조회한다. 각 문서의 id, 이름, URL, 연결된 프로젝트명을 반환한다. search로 이름/설명 검색, project로 프로젝트명 필터가 가능하다.',
  {
    search: searchTerm('문서 이름/설명 부분 검색어'),
    project: searchTerm('프로젝트 이름 필터')
  },
  async (args) => {
    const db = getAiReadOnlyDatabase()
    const conditions: string[] = []
    const params: unknown[] = []
    if (args.search) {
      conditions.push("(d.name LIKE ? OR IFNULL(d.description, '') LIKE ?)")
      params.push(`%${args.search}%`, `%${args.search}%`)
    }
    if (args.project) {
      conditions.push('p.name LIKE ?')
      params.push(`%${args.project}%`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = db
      .prepare(
        `SELECT d.id, d.name, d.url, d.type, d.description, d.project_id, p.name AS project_name
         FROM documents d
         LEFT JOIN projects p ON p.id = d.project_id
         ${where}
         ORDER BY d.sort_order, d.id
         LIMIT 200`
      )
      .all(...params)
    return jsonResult(rows)
  }
)

const listVariables = tool(
  'list_variables',
  '변수(Variables) 목록을 조회한다. secret 타입 변수의 값은 마스킹되어 반환된다.',
  {
    search: searchTerm('변수 key/설명 부분 검색어')
  },
  async (args) => {
    const db = getAiReadOnlyDatabase()
    const conditions: string[] = []
    const params: unknown[] = []
    if (args.search) {
      conditions.push("(key LIKE ? OR IFNULL(description, '') LIKE ?)")
      params.push(`%${args.search}%`, `%${args.search}%`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = db
      .prepare(`SELECT id, key, value, description, view_type FROM variables ${where} ORDER BY sort_order, id`)
      .all(...params) as { value: string; view_type: string }[]
    return jsonResult(rows.map(maskSecretVariable))
  }
)

const getActivityLog = tool(
  'get_activity_log',
  '활동 로그를 조회한다. 프로젝트/태스크/문서/변수/메모의 생성·수정·삭제 이력으로, "이번주에 진행한 작업 정리" 같은 질문에 사용한다. 날짜는 YYYY-MM-DD 형식이며 created_at은 로컬 시간 기준으로 변환되어 반환된다.',
  {
    start_date: dateArg('조회 시작일 (YYYY-MM-DD, 포함)'),
    end_date: dateArg('조회 종료일 (YYYY-MM-DD, 포함)'),
    entity_type: z
      .enum(['project', 'task', 'document', 'variable', 'memo'])
      .optional()
      .describe('엔티티 종류 필터')
  },
  async (args) => {
    const db = getAiReadOnlyDatabase()
    const conditions = ["date(created_at, 'localtime') >= date(?)", "date(created_at, 'localtime') <= date(?)"]
    const params: unknown[] = [args.start_date, args.end_date]
    if (args.entity_type) {
      conditions.push('entity_type = ?')
      params.push(args.entity_type)
    }
    const rows = db
      .prepare(
        `SELECT entity_type, entity_id, entity_name, action,
                datetime(created_at, 'localtime') AS created_at
         FROM activity_log
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at ASC
         LIMIT 500`
      )
      .all(...params)
    return jsonResult(rows)
  }
)

  const getCalendarEvents = tool(
    'get_calendar_events',
    'Google 캘린더 일정(회의/미팅 등)을 조회한다. "오늘 일정", "이번주 회의" 같은 질문에 사용한다. 날짜는 YYYY-MM-DD 형식.',
    {
      start_date: dateArg('조회 시작일 (YYYY-MM-DD, 포함)'),
      end_date: dateArg('조회 종료일 (YYYY-MM-DD, 포함)')
    },
    async (args) => {
      const start = new Date(`${args.start_date}T00:00:00`)
      const end = new Date(`${args.end_date}T23:59:59.999`)
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return jsonResult({ error: '날짜 형식이 올바르지 않습니다. YYYY-MM-DD 형식을 사용하세요.' })
      }
      const events = await getEventsInRange(start, end)
      if (events === null) {
        return jsonResult({
          error:
            'Google 캘린더가 연동되어 있지 않습니다. Calendar 메뉴(linkwork://view/calendar)에서 연동할 수 있습니다.'
        })
      }
      return jsonResult(
        events.map((e) => ({
          summary: e.summary,
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          location: e.location,
          description: truncate(e.description ?? null, 200)
        }))
      )
    }
  )

  // ── 릴리스 노트 (Jira 동기화 결과) — docs/AI_GUARDRAILS.md 8.5절 ──
  // 조회 시점에 Jira를 호출하지 않고 이미 동기화된 로컬 DB만 읽는다. AI 대화가
  // 네트워크 지연이나 토큰 만료 상태에 끌려가지 않게 하기 위함이다.

  const listReleaseNotes = tool(
    'list_release_notes',
    'Jira 릴리스(버전)의 릴리스 노트 목록을 조회한다. 버전 이름, 출시 여부(released), 릴리스일, 포함된 이슈 수(item_count), 마지막 동기화 시각(last_synced_at)을 반환한다. "이번 배포에 뭐가 들어가나", "4.162.0 릴리스 내용" 같은 질문에 사용한다. version으로 버전 이름 부분 검색이 가능하다(예: "4.16"). 릴리스 노트는 Jira 릴리스를 그대로 옮긴 것이라 LinkWork 프로젝트와 연결돼 있지 않다 — 특정 프로젝트의 릴리스를 찾으려면 그 프로젝트의 배포 버전(deploy_version)을 먼저 확인해 version으로 넘긴다. 앱에 동기화된 로컬 데이터를 읽으므로 Jira를 직접 조회하지 않는다 — 내용이 최신인지는 last_synced_at으로 판단하고, 오래됐으면 앱에서 동기화하도록 안내한다.',
    {
      version: searchTerm('버전 이름 부분 검색어 (예: 4.16)')
    },
    async (args) => {
      const db = getAiReadOnlyDatabase()
      const filter = args.version?.trim()
      const where = filter ? 'WHERE r.version_name LIKE ?' : ''
      const params = filter ? [`%${filter}%`] : []
      // 정렬은 화면 목록과 같은 규칙(버전 번호 내림차순)을 쓴다 — 같은 질문에 화면과 AI가
      // 다른 순서로 답하면 안 된다. SQL로는 4.46.0과 4.166.0을 제대로 못 세우므로
      // 상한을 걸기 전에 JS로 정렬한다.
      const rows = sortReleaseNotes(
        db.prepare(`${RELEASE_NOTE_SELECT} ${where}`).all(...params) as ReleaseNoteSummary[]
      ).slice(0, RELEASE_NOTE_ITEM_LIMIT)
      return jsonResult(
        rows.map((r) => ({
          ...r,
          description: truncate(r.description, RELEASE_NOTE_TEXT_MAX),
          last_sync_error: truncate(r.last_sync_error, RELEASE_NOTE_TEXT_MAX)
        }))
      )
    }
  )

  const getReleaseNote = tool(
    'get_release_note',
    '릴리스 노트 하나의 상세 내용을 조회한다. 포함된 Jira 이슈의 키(issue_key)·유형(issue_type)·상태(status)·해결 여부(resolution)·제목(summary)과 상위 이슈 키(parent_key)를 Jira 순서대로 반환한다. query에 릴리스 노트 ID(숫자) 또는 버전 이름(부분 일치)을 전달한다. 이슈는 최대 200건까지 반환하며, 앱에 동기화된 로컬 데이터라 Jira를 직접 조회하지 않는다.',
    {
      query: z.string().max(200).describe('릴리스 노트 ID 또는 버전 이름 검색어')
    },
    async (args) => {
      const db = getAiReadOnlyDatabase()
      const q = args.query.trim()
      const byId = /^\d+$/.test(q)
      const note = (
        byId
          ? db.prepare(`${RELEASE_NOTE_SELECT} WHERE r.id = ?`).get(Number(q))
          : // 이름이 여럿 걸리면 가장 높은 버전을 고른다 — 화면 목록의 맨 위와 같은 것이어야 한다
            sortReleaseNotes(
              db
                .prepare(`${RELEASE_NOTE_SELECT} WHERE r.version_name LIKE ?`)
                .all(`%${q}%`) as ReleaseNoteSummary[]
            )[0]
      ) as
        | {
            id: number
            description: string | null
            last_synced_at: string | null
            last_sync_error: string | null
            item_count: number
          }
        | undefined
      if (!note) {
        return jsonResult({ error: `'${args.query}'에 해당하는 릴리스 노트를 찾지 못했습니다.` })
      }
      const items = db
        .prepare(
          `SELECT issue_key, issue_type, status, resolution, summary, parent_key
           FROM release_note_items
           WHERE release_note_id = ?
           ORDER BY sort_order, id
           LIMIT ${RELEASE_NOTE_ITEM_LIMIT}`
        )
        .all(note.id) as { summary: string }[]
      const hints: string[] = []
      if (note.item_count > RELEASE_NOTE_ITEM_LIMIT) {
        hints.push(
          `이슈가 ${note.item_count}건이라 앞의 ${RELEASE_NOTE_ITEM_LIMIT}건만 반환했습니다.`
        )
      }
      if (!note.last_synced_at) {
        hints.push(
          '아직 한 번도 동기화하지 않은 릴리스입니다. 프로젝트 상세의 릴리스 노트 카드에서 동기화해야 Jira 이슈가 채워집니다.'
        )
      }
      return jsonResult({
        ...note,
        description: truncate(note.description, RELEASE_NOTE_TEXT_MAX),
        last_sync_error: truncate(note.last_sync_error, RELEASE_NOTE_TEXT_MAX),
        items: items.map((i) => ({ ...i, summary: truncate(i.summary, RELEASE_NOTE_TEXT_MAX) })),
        ...(hints.length ? { hints } : {})
      })
    }
  )

  // ── 외부 지식 도구 (Notion / 웹 링크) — docs/AI_GUARDRAILS.md 8절 ──
  // 모두 읽기 전용(GET/검색)이며, 반환 내용은 신뢰할 수 없는 데이터로 취급된다
  // (시스템 프롬프트의 인젝션 방어 규칙 적용 대상).

  const searchNotionTool = tool(
    'search_notion',
    '연동된 Notion 워크스페이스에서 페이지/데이터베이스를 검색한다. 제목, ID, URL, 최근 수정 시각을 반환한다. 내용을 읽으려면 반환된 ID/URL로 get_notion_page를 호출한다.',
    {
      query: z.string().max(200).describe('검색어 (제목 기준)')
    },
    async (args) => {
      if (!isNotionConnected()) return jsonResult({ error: NOTION_NOT_CONNECTED_MESSAGE })
      try {
        const results = await searchNotion(args.query)
        if (results.length === 0) {
          return jsonResult({
            results: [],
            hint: '검색 결과가 없습니다. 통합(integration)에 공유된 페이지만 검색됩니다.'
          })
        }
        return jsonResult({ results })
      } catch (err) {
        return jsonResult({ error: toErrorMessage(err) })
      }
    }
  )

  const getNotionPageTool = tool(
    'get_notion_page',
    'Notion 페이지의 전체 내용을 마크다운으로 읽는다. page에 Notion URL(notion.so/notion.site) 또는 32자리 페이지 ID를 전달한다. 데이터베이스 ID를 전달하면 항목 목록(제목/ID)을 반환한다. 사용자가 Notion 링크를 주거나 Notion 문서 내용을 물으면 이 도구를 사용한다.',
    {
      page: z.string().max(500).describe('Notion 페이지 URL 또는 페이지 ID')
    },
    async (args) => {
      if (!isNotionConnected()) return jsonResult({ error: NOTION_NOT_CONNECTED_MESSAGE })
      try {
        const page = await getNotionPageContent(args.page)
        return jsonResult({
          ...page,
          ...(page.truncated ? { notice: `내용이 길어 앞부분만 반환되었습니다${TRUNCATION_MARKER}` } : {})
        })
      } catch (err) {
        // 페이지가 아니라 데이터베이스인 경우 항목 목록으로 폴백
        const message = toErrorMessage(err)
        const id = extractNotionPageId(args.page)
        if (id && /database|400/i.test(message)) {
          try {
            const entries = await getNotionDatabaseEntries(id)
            return jsonResult({
              type: 'database',
              entries,
              hint: '데이터베이스입니다. 개별 항목은 entries의 id로 get_notion_page를 호출하세요.'
            })
          } catch {
            // 폴백 실패 시 원래 오류 반환
          }
        }
        return jsonResult({ error: message })
      }
    }
  )

  const fetchUrlTool = tool(
    'fetch_url',
    '웹 페이지(URL)의 내용을 텍스트로 읽는다. 사용자가 링크를 공유하거나 특정 웹 문서의 내용을 물을 때 사용한다. http/https만 지원하며, Notion URL은 자동으로 Notion API로 읽는다. JS 렌더링이 필요한 페이지는 본문이 비어 있을 수 있다.',
    {
      url: z.string().max(2000).describe('읽을 웹 페이지의 전체 URL')
    },
    async (args) => {
      try {
        // Notion 링크는 API/커넥터로 읽어야 한다 — notion.so는 로그인 없이는 빈 페이지
        if (extractNotionPageId(args.url)) {
          if (isNotionConnected()) {
            const page = await getNotionPageContent(args.url)
            return jsonResult(page)
          }
          return jsonResult({
            error:
              'Notion 페이지는 fetch_url로 읽을 수 없습니다. mcp__claude_ai_Notion__notion-fetch 도구를 사용하세요 (없으면 ToolSearch로 로드). 그 도구도 없으면 Notion 연동이 필요하다고 안내하세요.'
          })
        }
        const page = await fetchUrlAsText(args.url)
        return jsonResult({
          ...page,
          ...(page.truncated ? { notice: `내용이 길어 앞부분만 반환되었습니다${TRUNCATION_MARKER}` } : {})
        })
      } catch (err) {
        return jsonResult({ error: toErrorMessage(err) })
      }
    }
  )

  // 쓰기 도구는 서버에 항상 등록하되, 실행 게이트(opt-in + 사용자 승인)는
  // ai-agent.ts의 canUseTool에서 강제한다 — docs/AI_GUARDRAILS.md 7절
  const writeTools = await buildWriteTools()

  return createSdkMcpServer({
    name: 'linkwork',
    version: '1.0.0',
    tools: [
      listProjects,
      getProject,
      listTodos,
      getTodo,
      searchMemos,
      getMemo,
      listDocuments,
      listVariables,
      getActivityLog,
      getCalendarEvents,
      listReleaseNotes,
      getReleaseNote,
      searchNotionTool,
      getNotionPageTool,
      fetchUrlTool,
      ...writeTools
    ]
  })
}
