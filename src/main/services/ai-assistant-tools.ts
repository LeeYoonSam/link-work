// AI 채팅용 개인 비서 조회 도구 3개 (docs/ASSISTANT.md 부록 F.8).
//
// [가드레일] A31 — docs/AI_GUARDRAILS.md 8.6
// 1. DB 는 읽기 전용 커넥션(getAiReadOnlyDatabase)만 쓴다. 비서 테이블에 쓰지 않는다.
// 2. Jira·캘린더·헤드리스 AI 를 호출하지 않는다. 네트워크를 쓰지 않는다.
// 3. 입력은 zod 로 검증한다. SQL 은 바인딩 파라미터만 쓴다.
// 4. 외부 문자열은 자른다. 본문 4000자, 제목 300자, 목록 200건이다.
import { z } from 'zod'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { getAiReadOnlyDatabase } from '../db/database'
import { addDays, logicalDate } from './assistant-day'
import { buildRecovery, recoveryContextOf } from './assistant-recovery'
import { readRecoveryLocal } from './assistant-sources'
import { getLastPlanBefore, getPlanByDate, listPlanItems, readAssistantSettings } from './assistant-store'
import type { PlanItem } from './assistant-types'
import { parseJsonArray, type NoteActionItem } from './meeting-notes'

type SdkTool = typeof import('@anthropic-ai/claude-agent-sdk').tool

export const ASSISTANT_TOOL_NAMES = ['get_today_plan', 'get_recent_work', 'list_meeting_action_items'] as const

export const ASSISTANT_TEXT_MAX = 4000
export const ASSISTANT_TITLE_MAX = 300
export const ASSISTANT_LIST_MAX = 200
const TRUNCATION_MARKER = '…(생략)'

const RECENT_DAYS_DEFAULT = 3
const ACTION_DAYS_DEFAULT = 30

type ToolResult = { content: { type: 'text'; text: string }[] }

// ai-tools.ts 의 jsonResult 와 같은 모양이다. 순환 import 를 피하려고 이 파일에 둔다.
function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] }
}

function cut(text: string | null | undefined, max: number): string | null {
  if (text == null) return null
  return text.length > max ? text.slice(0, max) + TRUNCATION_MARKER : text
}

// 지금 시각의 논리 날짜. 설정의 하루 경계를 따른다.
function todayOf(db: ReturnType<typeof getAiReadOnlyDatabase>): string {
  return logicalDate(new Date(), readAssistantSettings(db).dayRollover)
}

function toItemView(i: PlanItem): Record<string, unknown> {
  return {
    id: i.id,
    candidate_id: i.candidate_id,
    title: cut(i.title, ASSISTANT_TITLE_MAX),
    source: i.source,
    link: cut(i.link, ASSISTANT_TITLE_MAX),
    jira_issue_key: i.jira_issue_key,
    due_date: i.due_date,
    rank: i.rank,
    status: i.status,
    status_note: cut(i.status_note, ASSISTANT_TITLE_MAX),
    urgent: i.urgent,
    first_planned_date: i.first_planned_date
  }
}

interface ActionItemRow {
  meeting_id: number
  meeting_title: string | null
  meeting_started_at: string | null
  project_id: number | null
  action_items: string | null
}

export interface MeetingActionItemView {
  meeting_id: number
  meeting_title: string | null
  meeting_started_at: string | null
  project_id: number | null
  index: number
  text: string | null
  assignee: string | null
  due: string | null
  todo_id: number | null
  todo_completed: boolean | null
}

// 반환 타입은 ai-write-tools.ts 와 같다. 스키마별 handler 타입이 달라 ReturnType<SdkTool>[] 로는 묶이지 않는다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildAssistantTools(tool: SdkTool): SdkMcpToolDefinition<any>[] {
  const getTodayPlan = tool(
    'get_today_plan',
    '비서의 오늘 계획을 조회한다. "오늘 뭐 해야 하지", "지금 남은 작업" 같은 질문에 쓴다. 브리핑과 맥락 복구 본문도 돌려준다.',
    {
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식')
        .optional()
        .describe('계획의 논리 날짜 (YYYY-MM-DD). 생략하면 오늘이다')
    },
    async (args) => {
      const db = getAiReadOnlyDatabase()
      const date = args.date ?? todayOf(db)
      const plan = getPlanByDate(db, date)
      if (!plan) {
        return jsonResult({
          date,
          plan: null,
          items: [],
          suggested: [],
          hint: '이 날짜의 계획이 없다. 오늘이면 오늘 화면에서 하루 시작을 누른다.'
        })
      }
      const all = listPlanItems(db, plan.id)
      const items = all.filter((i) => i.status !== 'suggested' && i.status !== 'dismissed')
      const suggested = all.filter((i) => i.status === 'suggested')
      return jsonResult({
        date,
        plan: {
          status: plan.status,
          started_at: plan.started_at,
          closed_at: plan.closed_at,
          wrapup_note: cut(plan.wrapup_note, ASSISTANT_TEXT_MAX),
          briefing_source: plan.briefing_source,
          briefing_text: cut(plan.briefing_text, ASSISTANT_TEXT_MAX),
          recovery_source: plan.recovery_source,
          recovery_text: cut(plan.recovery_text, ASSISTANT_TEXT_MAX)
        },
        items: items.slice(0, ASSISTANT_LIST_MAX).map(toItemView),
        suggested: suggested.slice(0, ASSISTANT_LIST_MAX).map((i) => ({
          id: i.id,
          candidate_id: i.candidate_id,
          title: cut(i.title, ASSISTANT_TITLE_MAX),
          due_date: i.due_date,
          urgent: i.urgent
        })),
        hint: '오늘 화면은 linkwork://view/today 다.'
      })
    }
  )

  const getRecentWork = tool(
    'get_recent_work',
    '최근 N일 동안 한 일을 정리한다. "주말 이후 어디까지 했더라", "이번 주 한 일" 같은 질문에 쓴다. Jira 는 보지 않는다.',
    {
      days: z
        .number()
        .int()
        .min(1)
        .max(14)
        .default(RECENT_DAYS_DEFAULT)
        .describe('최근 며칠을 볼지 (1~14, 기본 3)')
    },
    async (args) => {
      const db = getAiReadOnlyDatabase()
      const days = args.days ?? RECENT_DAYS_DEFAULT
      const today = todayOf(db)
      const lastPlan = getLastPlanBefore(db, today)
      const ctx = recoveryContextOf({ today, lastPlan, days })
      const lastItems = lastPlan ? listPlanItems(db, lastPlan.id) : []
      const local = readRecoveryLocal(db, ctx, lastItems)
      // Jira 는 부르지 않는다 (A31). jira 섹션은 결과에서 뺀다.
      const sections = buildRecovery({
        ctx,
        ...local,
        jira: null,
        jiraConnected: false,
        jiraTruncated: false,
        errors: []
      })
      return jsonResult({
        since: ctx.since,
        days,
        last_plan_date: lastPlan?.plan_date ?? null,
        sections: sections.filter((s) => s.key !== 'jira' && s.key !== 'errors'),
        hint: 'Jira 변경은 Atlassian 도구로 조회한다.'
      })
    }
  )

  const listMeetingActionItems = tool(
    'list_meeting_action_items',
    '회의 요약의 액션아이템을 조회한다. "지난 회의에서 하기로 한 것" 같은 질문에 쓴다.',
    {
      completed: z
        .boolean()
        .default(false)
        .describe('true 면 완료된 할 일로 옮겨진 항목만, false 면 아직 끝나지 않은 항목'),
      days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .default(ACTION_DAYS_DEFAULT)
        .describe('최근 며칠 안에 요약된 회의를 볼지 (1~90, 기본 30)')
    },
    async (args) => {
      const db = getAiReadOnlyDatabase()
      const completed = args.completed ?? false
      const days = args.days ?? ACTION_DAYS_DEFAULT
      const since = `${addDays(todayOf(db), -days)} 00:00:00`
      const rows = db
        .prepare(
          `SELECT m.id AS meeting_id, m.title AS meeting_title, m.started_at AS meeting_started_at,
                  m.project_id AS project_id, ms.action_items AS action_items
           FROM meeting_summaries ms
           JOIN meetings m ON m.id = ms.meeting_id
           WHERE ms.generated_at >= ?
           ORDER BY m.started_at DESC, m.id DESC`
        )
        .all(since) as ActionItemRow[]
      const todoStmt = db.prepare('SELECT is_completed FROM todos WHERE id = ?')

      const out: MeetingActionItemView[] = []
      for (const r of rows) {
        const items = parseJsonArray<NoteActionItem>(r.action_items)
        for (let index = 0; index < items.length; index++) {
          const a = items[index]
          if (!a || typeof a.text !== 'string' || a.text.trim() === '') continue
          const todoId = typeof a.todo_id === 'number' ? a.todo_id : null
          let todoCompleted: boolean | null = null
          if (todoId !== null) {
            const t = todoStmt.get(todoId) as { is_completed: number } | undefined
            todoCompleted = t ? t.is_completed === 1 : null
          }
          // false: todo 로 안 옮긴 항목과 미완료 todo. true: 완료 todo 만. 삭제된 todo 는 둘 다 아니다.
          const keep = completed ? todoCompleted === true : todoId === null || todoCompleted === false
          if (!keep) continue
          out.push({
            meeting_id: r.meeting_id,
            meeting_title: cut(r.meeting_title, ASSISTANT_TITLE_MAX),
            meeting_started_at: r.meeting_started_at,
            project_id: r.project_id,
            index,
            text: cut(a.text, ASSISTANT_TITLE_MAX),
            assignee: typeof a.assignee === 'string' ? cut(a.assignee, ASSISTANT_TITLE_MAX) : null,
            due: typeof a.due === 'string' ? cut(a.due, ASSISTANT_TITLE_MAX) : null,
            todo_id: todoId,
            todo_completed: todoCompleted
          })
          if (out.length >= ASSISTANT_LIST_MAX) return jsonResult(out)
        }
      }
      return jsonResult(out)
    }
  )

  return [getTodayPlan, getRecentWork, listMeetingActionItems]
}
