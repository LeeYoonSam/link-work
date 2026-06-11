import { z } from 'zod'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { getAiReadOnlyDatabase } from '../db/database'
import { MEMO_WITH_CATEGORY_SELECT } from '../utils/memo-helpers'
import { applyProjectAutoStatus, type ProjectStatusFields } from '../utils/project-dates'
import { TODO_TAGS_SUBQUERY } from '../utils/todo-helpers'
import { getEventsInRange } from './google-calendar'
import { buildWriteTools, maskSecretVariable, TRUNCATION_MARKER } from './ai-write-tools'

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
  'get_calendar_events'
].map((name) => `mcp__linkwork__${name}`)

let serverPromise: Promise<McpSdkServerConfigWithInstance> | null = null

export function getLinkworkMcpServer(): Promise<McpSdkServerConfigWithInstance> {
  if (!serverPromise) serverPromise = buildServer()
  return serverPromise
}

function jsonResult(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] }
}

function truncate(text: string | null, max: number): string | null {
  if (text === null) return null
  return text.length > max ? text.slice(0, max) + TRUNCATION_MARKER : text
}

async function buildServer(): Promise<McpSdkServerConfigWithInstance> {
  // Agent SDK는 ESM 전용이라 CJS로 번들되는 main 프로세스에서 정적 import(require) 불가.
  // 동적 import는 rollup이 CJS 출력에서도 import()로 보존하므로 런타임 로드가 가능하다.
  const { tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk')

  const listProjects = tool(
  'list_projects',
  '프로젝트 목록을 조회한다. 각 프로젝트의 일정(개발/QA/배포), 상태, 태스크 진행 요약을 반환한다. status로 필터링 가능 (scheduled|development|qa|deploy|completed|cancelled). "진행중인 프로젝트"는 completed/cancelled가 아닌 프로젝트를 의미한다.',
  {
    status: z
      .enum(['scheduled', 'development', 'qa', 'deploy', 'completed', 'cancelled'])
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
    const rows = (
      db
        .prepare(
          `SELECT p.id, p.name, p.description, p.status, p.status_manual,
                  p.dev_start_date, p.dev_end_date, p.qa_start_date, p.qa_end_date,
                  p.deploy_date, p.deploy_version,
                  COUNT(t.id) AS task_count,
                  SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done_task_count
           FROM projects p
           LEFT JOIN tasks t ON t.project_id = p.id
           ${where}
           GROUP BY p.id
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
    const tasks = db
      .prepare('SELECT id, name, start_date, end_date, status FROM tasks WHERE project_id = ? ORDER BY sort_order, id')
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
      ...writeTools
    ]
  })
}
