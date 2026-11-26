// AI 대화 빈 화면의 추천 질문 8개를 로컬 DB 에서 만든다 (`ai:suggestions`).
//
// 가드레일 (docs/AI_GUARDRAILS.md 6.1절):
// 1. DB 는 호출부가 넘긴 읽기 전용 커넥션(getAiReadOnlyDatabase)만 읽는다. 네트워크·캘린더 호출은 없다.
// 2. 질문에 넣는 값(할 일·회의·메모 제목, Jira 요약, 릴리스 이름)은 신뢰할 수 없는 입력이다.
//    공백·줄바꿈을 한 칸으로 접고, 따옴표·백틱을 지우고, 30자로 자른다(sanitizeValue).
//    검색어로 쓰이는 값(회의 제목·메모 첫 줄·에픽 요약)은 말줄임 없이 40자로 자른다(keywordValue).
// 3. 모든 질문은 AI 가 가진 도구(할 일·메모·회의·릴리스 노트·캘린더 도구, Jira·Notion·Slack 커넥터)로 답할 수 있어야 한다.
//    `projects` 테이블처럼 도구가 없는 데이터만으로 답하는 질문, 사용자가 링크·이미지를 따로 줘야 하는 질문은 만들지 않는다.
// 4. 새 채팅은 자동 쓰기 모드라 질문은 조회·정리·제안까지만 요청한다. 쓰기 명령(WRITE_IMPERATIVE_RE)은 넣지 않는다.
// 5. 항상 정확히 8개를 돌려준다. 칸마다 데이터가 없거나 조회가 실패하면(테이블 없음 등) 그 칸의 일반 질문을 쓴다.
import type Database from 'better-sqlite3'

export type AiSuggestionCategory = 'todo' | 'meeting' | 'project' | 'release' | 'memo' | 'schedule'

export interface AiSuggestion {
  /** 칸 id + 후보 표지. 목록 안에서 유일 */
  id: string
  category: AiSuggestionCategory
  /** 카드에 보이는 문구 (한 줄, 60자 이하) */
  label: string
  /** 누르면 AI 에 보내는 질문 (한 줄, 300자 이하) */
  prompt: string
  /** 소개하는 기능의 짧은 이름 */
  feature?: string
}

export const AI_SUGGESTION_COUNT = 8
export const AI_SUGGESTION_VARIANT_MAX = 1000
const VALUE_MAX = 30
const KEYWORD_MAX = 40
const LABEL_MAX = 60
const PROMPT_MAX = 300
const ACTION_DAYS = 30
const CANDIDATE_ROWS = 3

/** IPC 로 받은 variant 를 검사한다. 0~1000 정수가 아니면 0 */
export function normalizeSuggestionVariant(variant: unknown): number {
  return typeof variant === 'number' &&
    Number.isInteger(variant) &&
    variant >= 0 &&
    variant <= AI_SUGGESTION_VARIANT_MAX
    ? variant
    : 0
}

/** 질문에 넣는 신뢰할 수 없는 값을 정리한다. 비면 null */
export function sanitizeValue(value: unknown, max = VALUE_MAX, ellipsis = true): string | null {
  if (typeof value !== 'string') return null
  const s = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/['"`‘’“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return null
  if (s.length <= max) return s
  return ellipsis ? `${s.slice(0, max - 1)}…` : s.slice(0, max).trim()
}

/**
 * 검색어로 쓰일 값(회의 제목, 메모 첫 줄, 에픽 요약). '…' 를 붙이면 LIKE 검색이 깨지므로
 * 말줄임 없이 자른다. 상한은 search_meetings 검색어 상한(40자)과 같다.
 */
export function keywordValue(value: unknown): string | null {
  return sanitizeValue(value, KEYWORD_MAX, false)
}

/** 대괄호·괄호 머리말('[Android/Sus] ' 등)을 걷어낸다 */
export function stripBracketPrefix(text: string): string {
  return text.replace(/^(?:\s*[[(【][^\])】]*[\])】])+\s*/, '').trim()
}

/**
 * 추천 질문에 쓰면 안 되는 쓰기 명령 표현. 새 채팅은 자동 쓰기 모드라 한 번 누르면 바로 쓰기가 실행되므로
 * 추천 질문은 조회·정리·제안까지만 요청하고, 만들기·수정·삭제는 사용자가 결과를 본 뒤 직접 요청한다.
 */
export const WRITE_IMPERATIVE_RE =
  /(추가해|만들어|생성해|등록해|옮겨|바꿔|수정해|고쳐|삭제해|지워|저장해|완료 처리|다시 정리해|할 일로 쪼개)/

/** 한 줄로 접고 상한으로 자른다 (label·prompt 최종 보정) */
function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** 메모 본문의 첫 번째 비어 있지 않은 줄에서 마크다운 표지를 걷어낸다 */
export function memoFirstLine(content: unknown): string | null {
  if (typeof content !== 'string') return null
  for (const raw of content.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s*|[-*+]\s+|>\s*|\d+[.)]\s+)*/, '')
      .replace(/\[[ xX]?\]\s*/g, '')
      .replace(/[`*_~]/g, '')
    const v = keywordValue(line)
    if (v) return v
  }
  return null
}

const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

interface Candidate {
  /** id 접미사 (칸 안에서 유일) */
  key: string
  prompt: string
  label?: string
  feature?: string
}

interface SlotContext {
  db: Database.Database
  now: Date
  today: string
}

interface SlotDef {
  id: string
  category: AiSuggestionCategory
  feature?: string
  build: (ctx: SlotContext) => Candidate[]
  /** 데이터가 없을 때 쓰는 일반 질문. variant 로 돌아간다 */
  fallbacks: string[]
}

/** 값(행) × 문구(템플릿) 조합을 문구 우선으로 펼친다. variant 0, 1 … 이 서로 다른 행·문구를 고른다 */
function expand<T>(
  rows: T[],
  templates: Array<(row: T) => Omit<Candidate, 'key'>>,
  prefix = ''
): Candidate[] {
  const out: Candidate[] = []
  templates.forEach((t, ti) => {
    rows.forEach((r, ri) => {
      out.push({ ...t(r), key: `${prefix}t${ti}-r${ri}` })
    })
  })
  return out
}

// ── 1. 할 일 ──
function buildTodo({ db, today }: SlotContext): Candidate[] {
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN substr(due_date, 1, 10) < ? THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN substr(due_date, 1, 10) = ? THEN 1 ELSE 0 END) AS due_today
       FROM todos
       WHERE is_completed = 0 AND due_date IS NOT NULL AND due_date <> ''`
    )
    .get(today, today) as { overdue: number | null; due_today: number | null } | undefined
  const overdue = Number(counts?.overdue ?? 0)
  const dueToday = Number(counts?.due_today ?? 0)

  const out: Candidate[] = []
  if (overdue > 0 && dueToday > 0) {
    out.push({
      key: 'due',
      prompt: `기한 지난 할 일 ${overdue}개와 오늘 마감 할 일 ${dueToday}개를 우선순위별로 정리해줘`
    })
  } else if (overdue > 0) {
    out.push({ key: 'due', prompt: `기한 지난 할 일 ${overdue}개를 우선순위별로 정리하고 새 기한을 제안해줘` })
  } else if (dueToday > 0) {
    out.push({ key: 'due', prompt: `오늘 마감인 할 일 ${dueToday}개를 우선순위별로 정리해줘` })
  }

  const top = db
    .prepare(
      `SELECT title FROM todos
       WHERE is_completed = 0
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
                (due_date IS NULL OR due_date = ''), due_date, id DESC
       LIMIT ?`
    )
    .all(CANDIDATE_ROWS) as Array<{ title: unknown }>
  const titles = top.map((r) => sanitizeValue(r.title)).filter((t): t is string => t !== null)
  titles.forEach((title, i) => {
    out.push({
      key: `step-${i}`,
      prompt: `'${title}' 할 일을 끝내려면 어떤 순서로 하면 좋을지 단계별로 쪼개줘`,
      feature: '할 일 쪼개기'
    })
  })
  return out
}

// ── 2. 최근 요약된 회의 ──
function buildMeeting({ db }: SlotContext): Candidate[] {
  const rows = db
    .prepare(
      `SELECT m.title AS title
       FROM meeting_summaries ms
       JOIN meetings m ON m.id = ms.meeting_id
       WHERE m.title IS NOT NULL AND m.title <> '' AND m.title <> '제목 없는 회의'
       ORDER BY m.started_at DESC, m.id DESC
       LIMIT ?`
    )
    .all(CANDIDATE_ROWS) as Array<{ title: unknown }>
  const titles = rows.map((r) => keywordValue(r.title)).filter((t): t is string => t !== null)
  return expand(titles, [
    (t) => ({ prompt: `'${t}' 회의의 결정사항과 액션아이템 정리해줘` }),
    (t) => ({ prompt: `'${t}' 회의에서 아직 결론 안 난 논의와 후속으로 할 일 알려줘` })
  ])
}

// ── 3. 할 일로 안 옮긴 회의 액션아이템 ──
function buildActionItems({ db, now }: SlotContext): Candidate[] {
  const sinceDate = new Date(now.getTime())
  sinceDate.setDate(sinceDate.getDate() - ACTION_DAYS)
  const since = `${localDate(sinceDate)} 00:00:00`
  const rows = db
    .prepare(
      `SELECT ms.action_items AS action_items
       FROM meeting_summaries ms
       JOIN meetings m ON m.id = ms.meeting_id
       WHERE ms.generated_at >= ?`
    )
    .all(since) as Array<{ action_items: unknown }>
  let pending = 0
  for (const r of rows) {
    const items = parseJson(r.action_items)
    if (!Array.isArray(items)) continue
    for (const a of items) {
      if (!isRecord(a) || typeof a.text !== 'string' || a.text.trim() === '') continue
      if (typeof a.todo_id === 'number') continue
      pending++
    }
  }
  if (pending === 0) return []
  return [
    {
      key: 'import',
      prompt: `최근 회의 액션아이템 중 할 일로 안 옮긴 ${pending}건을 회의별로 정리하고 할 일로 옮길 만한 것 골라줘`
    },
    {
      key: 'owner',
      prompt: `최근 회의 액션아이템 중 할 일로 안 옮긴 ${pending}건을 담당자·기한별로 정리하고 내 몫인 것 골라줘`
    }
  ]
}

interface BoardRow {
  key: string
  summary: string
  /** 말줄임 없이 자른 요약 (검색어용) */
  keyword: string | null
  level: unknown
  statusCategory: unknown
  inScope: unknown
  assigneeAccountId: unknown
  updated: string
  mine: boolean
}

function loadBoardIssues(db: Database.Database): BoardRow[] {
  const rows = db
    .prepare(
      `SELECT i.data AS data, s.my_account_id AS my_account_id
       FROM jira_board_issues i
       LEFT JOIN jira_board_sync s ON s.project_key = i.project_key
       ORDER BY i.updated DESC
       LIMIT 500`
    )
    .all() as Array<{ data: unknown; my_account_id: unknown }>
  const out: BoardRow[] = []
  for (const r of rows) {
    const d = parseJson(r.data)
    if (!isRecord(d)) continue
    if (typeof d.key !== 'string' || !JIRA_KEY_RE.test(d.key)) continue
    const summary = sanitizeValue(d.summary)
    if (!summary) continue
    const me = typeof r.my_account_id === 'string' && r.my_account_id !== '' ? r.my_account_id : null
    out.push({
      key: d.key,
      summary,
      keyword: keywordValue(stripBracketPrefix(typeof d.summary === 'string' ? d.summary.replace(/\s+/g, ' ') : '')),
      level: d.level,
      statusCategory: d.statusCategory,
      inScope: d.inScope,
      assigneeAccountId: d.assigneeAccountId,
      updated: typeof d.updated === 'string' ? d.updated : '',
      mine: me !== null && d.assigneeAccountId === me
    })
  }
  return out
}

// ── 4. 진행 중인 Jira 티켓 ──
function buildJiraTicket({ db }: SlotContext): Candidate[] {
  const active = loadBoardIssues(db).filter((r) => r.statusCategory === 'indeterminate')
  active.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1
    return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0
  })
  const picked = active.slice(0, CANDIDATE_ROWS)
  return expand(picked, [
    (r) => ({ prompt: `${r.key} '${r.summary}' 티켓의 진행 상황과 남은 작업 정리해줘` }),
    (r) => ({
      prompt: `${r.key} '${r.summary}' 티켓 내용을 보고 오늘 할 수 있는 작업을 할 일 후보로 쪼개줘`,
      feature: 'Jira 커넥터 · 할 일 생성'
    })
  ])
}

// ── 5. 회의 간 검색 키워드 ──
function buildCrossMeeting({ db }: SlotContext): Candidate[] {
  let keywords: string[] = []
  try {
    keywords = loadBoardIssues(db)
      .filter((r) => r.level === 'epic' && r.inScope === true && r.statusCategory !== 'done')
      .map((r) => r.keyword)
      .filter((k): k is string => k !== null)
      .slice(0, CANDIDATE_ROWS)
  } catch {
    keywords = []
  }
  if (keywords.length === 0) {
    const rows = db
      .prepare(
        `SELECT title FROM meetings
         WHERE title IS NOT NULL AND title <> '' AND title <> '제목 없는 회의'
         ORDER BY started_at DESC, id DESC
         LIMIT ?`
      )
      .all(CANDIDATE_ROWS) as Array<{ title: unknown }>
    keywords = rows.map((r) => keywordValue(r.title)).filter((t): t is string => t !== null)
  }
  return expand(keywords, [
    (k) => ({ prompt: `지난 회의들에서 '${k}' 관련해 논의한 내용 모아줘` }),
    (k) => ({ prompt: `'${k}' 관련 회의 발언을 시간순으로 찾아 결정이 어떻게 바뀌었는지 정리해줘` })
  ])
}

// ── 6. 릴리스 노트 ──
function buildRelease({ db }: SlotContext): Candidate[] {
  const upcoming = db
    .prepare(
      `SELECT version_name FROM release_notes
       WHERE archived = 0 AND released = 0
       ORDER BY (release_date IS NULL OR release_date = ''), release_date ASC, id DESC
       LIMIT 2`
    )
    .all() as Array<{ version_name: unknown }>
  const released = db
    .prepare(
      `SELECT version_name FROM release_notes
       WHERE archived = 0 AND released = 1
       ORDER BY (release_date IS NULL OR release_date = ''), release_date DESC, id DESC
       LIMIT 2`
    )
    .all() as Array<{ version_name: unknown }>
  const up = upcoming.map((r) => sanitizeValue(r.version_name)).filter((v): v is string => v !== null)
  const done = released.map((r) => sanitizeValue(r.version_name)).filter((v): v is string => v !== null)
  return [
    ...expand(up, [
      (v) => ({ prompt: `${v} 릴리스에 포함된 이슈 중 아직 안 끝난 것 알려줘` }),
      (v) => ({ prompt: `${v} 릴리스에 포함된 이슈를 유형별로 묶어 릴리스 노트 초안 써줘` })
    ]),
    ...expand(done, [(v) => ({ prompt: `${v} 릴리스 노트 요약해줘` })], 'released-')
  ]
}

// ── 7. 메모 ──
function buildMemo({ db }: SlotContext): Candidate[] {
  const rows = db
    .prepare(
      `SELECT content FROM memos
       WHERE is_archived = 0
       ORDER BY is_important DESC, updated_at DESC, id DESC
       LIMIT 10`
    )
    .all() as Array<{ content: unknown }>
  const lines: string[] = []
  for (const r of rows) {
    const line = memoFirstLine(r.content)
    if (line && !lines.includes(line)) lines.push(line)
    if (lines.length >= CANDIDATE_ROWS) break
  }
  return expand(lines, [
    (l) => ({ prompt: `'${l}' 메모를 읽고 할 일 후보로 쪼개줘`, feature: '메모 → 할 일' }),
    (l) => ({ prompt: `'${l}' 메모를 깔끔하게 정리한 안을 보여줘` })
  ])
}

// ── 8. 시간대별 일정 ──
function buildSchedule({ now }: SlotContext): Candidate[] {
  const day = now.getDay()
  const hour = now.getHours()
  let prompts: Array<[string, string]>
  if (day === 5 || day === 6 || day === 0) {
    prompts = [
      ['retro', '이번 주 완료한 할 일과 회의를 묶어 주간 회고 써줘'],
      ['next-week', '다음 주 일정과 마감 할 일을 묶어 다음 주 계획 세워줘']
    ]
  } else if (hour < 12) {
    prompts = [
      ['plan', '오늘 일정과 마감 할 일을 묶어 하루 계획 세워줘'],
      ['prep', '오늘 회의 일정 알려주고 회의 전에 챙길 할 일과 메모 찾아줘']
    ]
  } else if (hour >= 17) {
    prompts = [
      ['tomorrow', '내일 일정 알려주고 준비할 것 정리해줘'],
      ['wrap', '오늘 완료한 할 일과 회의를 묶어 하루 마무리 정리해줘']
    ]
  } else {
    prompts = [
      ['week', '이번 주 남은 일정 알려줘'],
      ['afternoon', '오늘 남은 일정 사이 빈 시간에 할 만한 할 일 골라줘']
    ]
  }
  return prompts.map(([key, prompt]) => ({ key, prompt }))
}

const SLOTS: SlotDef[] = [
  {
    id: 'todo',
    category: 'todo',
    feature: '할 일 정리',
    build: buildTodo,
    fallbacks: ['끝나지 않은 할 일을 우선순위별로 보여줘', '이번 주 마감인 할 일 알려줘']
  },
  {
    id: 'meeting',
    category: 'meeting',
    feature: '회의 요약',
    build: buildMeeting,
    fallbacks: ['최근 회의 액션아이템을 회의별로 묶어 보여줘', '최근 2주 회의 액션아이템을 담당자별로 정리해줘']
  },
  {
    id: 'action',
    category: 'meeting',
    feature: '할 일 자동 생성',
    build: buildActionItems,
    fallbacks: ['끝나지 않은 회의 액션아이템 정리해줘', '지난 회의에서 하기로 한 것 중 아직 안 끝난 것 알려줘']
  },
  {
    id: 'jira',
    category: 'project',
    feature: 'Jira 커넥터',
    build: buildJiraTicket,
    fallbacks: ['나에게 할당된 진행 중인 Jira 티켓 보여줘', '이번 주에 업데이트된 내 Jira 티켓 정리해줘']
  },
  {
    id: 'search',
    category: 'project',
    feature: '회의 간 검색',
    build: buildCrossMeeting,
    fallbacks: [
      "지난 회의들에서 '배포' 관련해 논의한 내용 모아줘",
      "지난 회의들에서 '일정'이나 '마감' 얘기가 나온 부분 찾아줘"
    ]
  },
  {
    id: 'release',
    category: 'release',
    feature: '릴리스 노트',
    build: buildRelease,
    fallbacks: ['최근 릴리스 노트 목록 보여줘', '다가오는 릴리스 일정 알려줘']
  },
  {
    id: 'memo',
    category: 'memo',
    feature: '메모 정리',
    build: buildMemo,
    fallbacks: ['중요 표시한 메모 요약해줘', '최근 메모 중 할 일로 만들 만한 것 찾아줘']
  },
  {
    id: 'schedule',
    category: 'schedule',
    feature: '캘린더 연동',
    build: buildSchedule,
    fallbacks: ['오늘 일정 알려줘', '이번 주 남은 일정 알려줘']
  }
]

/** 칸 결과가 겹칠 때 채우는 여분 일반 질문 */
export const AI_SUGGESTION_EXTRA_POOL: Array<{ category: AiSuggestionCategory; prompt: string; feature?: string }> = [
  { category: 'todo', prompt: '오늘 완료한 할 일 알려줘' },
  { category: 'memo', prompt: '이번 주에 쓴 메모를 주제별로 묶어줘', feature: '메모 정리' },
  { category: 'meeting', prompt: '최근 회의 액션아이템 중 완료된 것 보여줘', feature: '회의 요약' },
  { category: 'release', prompt: '아직 배포 안 된 릴리스와 날짜 알려줘', feature: '릴리스 노트' },
  { category: 'schedule', prompt: '내일 일정 알려줘', feature: '캘린더 연동' },
  { category: 'todo', prompt: '기한 없는 할 일 중 오래된 것 정리해줘' },
  { category: 'project', prompt: '이번 주에 상태가 바뀐 내 Jira 티켓 알려줘', feature: 'Jira 커넥터' },
  { category: 'meeting', prompt: "지난 회의들에서 '리스크' 관련 논의 찾아줘", feature: '회의 간 검색' }
]

function toSuggestion(
  slot: SlotDef,
  key: string,
  prompt: string,
  feature?: string,
  label?: string
): AiSuggestion {
  const p = oneLine(prompt, PROMPT_MAX)
  const f = feature ?? slot.feature
  return {
    id: `${slot.id}:${key}`,
    category: slot.category,
    label: oneLine(label ?? p, LABEL_MAX),
    prompt: p,
    ...(f ? { feature: f } : {})
  }
}

function fallbackFor(slot: SlotDef, variant: number): AiSuggestion {
  const i = variant % slot.fallbacks.length
  return toSuggestion(slot, `fallback-${i}`, slot.fallbacks[i])
}

/** 칸마다 일반 질문만 쓴 8개 (DB 를 못 읽을 때) */
export function fallbackSuggestions(variant = 0): AiSuggestion[] {
  const v = normalizeSuggestionVariant(variant)
  return SLOTS.map((slot) => fallbackFor(slot, v))
}

export const FALLBACK_SUGGESTIONS: readonly AiSuggestion[] = Object.freeze(fallbackSuggestions(0))

/**
 * 추천 질문 8개를 만든다. db·now 가 같으면 결과도 같다.
 * variant 를 바꾸면 칸마다 다른 행·문구를 고른다("다른 추천").
 */
export function buildAiSuggestions(
  db: Database.Database,
  opts: { now: Date; variant?: number }
): AiSuggestion[] {
  const variant = normalizeSuggestionVariant(opts.variant ?? 0)
  const ctx: SlotContext = { db, now: opts.now, today: localDate(opts.now) }
  const out: AiSuggestion[] = []
  const seen = new Set<string>()
  let extraCursor = variant

  for (const slot of SLOTS) {
    let candidates: Candidate[] = []
    try {
      candidates = slot.build(ctx)
    } catch {
      // 테이블 없음·컬럼 차이 등: 이 칸만 일반 질문으로 대신한다
      candidates = []
    }
    // 넣은 값(제목 등)에 쓰기 명령이 들어 있으면 그 후보는 쓰지 않는다
    candidates = candidates.filter((c) => !WRITE_IMPERATIVE_RE.test(c.prompt))

    const tries: AiSuggestion[] = []
    if (candidates.length > 0) {
      const c = candidates[variant % candidates.length]
      tries.push(toSuggestion(slot, c.key, c.prompt, c.feature, c.label))
      // 고른 후보가 다른 칸과 겹치면 같은 칸의 다음 후보부터 시도한다
      for (let k = 1; k < candidates.length; k++) {
        const n = candidates[(variant + k) % candidates.length]
        tries.push(toSuggestion(slot, n.key, n.prompt, n.feature, n.label))
      }
    }
    for (let k = 0; k < slot.fallbacks.length; k++) {
      tries.push(fallbackFor(slot, variant + k))
    }

    let chosen = tries.find((s) => !seen.has(s.prompt))
    if (!chosen) {
      for (let k = 0; k < AI_SUGGESTION_EXTRA_POOL.length; k++) {
        const idx = (extraCursor + k) % AI_SUGGESTION_EXTRA_POOL.length
        const e = AI_SUGGESTION_EXTRA_POOL[idx]
        if (seen.has(e.prompt)) continue
        extraCursor = idx + 1
        chosen = {
          id: `extra:${idx}`,
          category: e.category,
          label: oneLine(e.prompt, LABEL_MAX),
          prompt: e.prompt,
          ...(e.feature ? { feature: e.feature } : {})
        }
        break
      }
    }
    // 여분까지 모두 겹치는 일은 없지만, 개수 보장을 위해 칸 일반 질문으로 채운다
    if (!chosen) chosen = fallbackFor(slot, variant)
    seen.add(chosen.prompt)
    out.push(chosen)
  }
  return out
}
