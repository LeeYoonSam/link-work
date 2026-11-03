// 명령 입력 해석·검증 (docs/ASSISTANT.md 부록 G). 순수 모듈이다 (A3·A14).
// - A35: 조작의 itemId·candidateId 는 ctx 집합 안의 값만 남긴다.
// - A40: unsupported 조작은 executable: false 다.
import { z } from 'zod'
import { rankCandidates } from './assistant-score'
import type {
  Candidate,
  CommandCandidateRef,
  CommandContext,
  CommandItemRef,
  CommandOp,
  CommandPreviewOp,
  PlanItem,
  PlanItemStatus
} from './assistant-types'

export const COMMAND_TEXT_MAX = 500
export const COMMAND_OPS_MAX = 10
export const COMMAND_TITLE_MAX = 120
export const COMMAND_INSTRUCTION_MAX = 200
export const COMMAND_CANDIDATE_LIMIT = 50

const NOTE_MAX = 200
const REASON_MAX = 200
const CANDIDATE_ID_MAX = 200
// 스키마의 원문 상한. 길이 규칙은 공백 정리 뒤 reconcile 에서 적용한다.
const RAW_TEXT_MAX = 2000

const itemIdSchema = z.number().int().positive()

export const CommandOpSchema: z.ZodType<CommandOp> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('set_status'),
    itemId: itemIdSchema,
    status: z.enum(['planned', 'in_progress', 'done', 'deferred', 'dropped']),
    note: z.string().max(RAW_TEXT_MAX).nullable().default(null)
  }),
  z.object({ kind: z.literal('focus'), itemId: itemIdSchema }),
  z.object({ kind: z.literal('accept_suggestion'), itemId: itemIdSchema }),
  z.object({ kind: z.literal('dismiss_suggestion'), itemId: itemIdSchema }),
  z.object({ kind: z.literal('add_candidate'), candidateId: z.string().min(1).max(CANDIDATE_ID_MAX) }),
  z.object({
    kind: z.literal('add_manual'),
    title: z.string().max(RAW_TEXT_MAX),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null)
  }),
  z.object({
    kind: z.literal('regenerate_briefing'),
    instruction: z.string().max(RAW_TEXT_MAX).nullable().default(null)
  }),
  z.object({ kind: z.literal('unsupported'), reason: z.string().max(RAW_TEXT_MAX) })
])

/** 앞뒤 공백을 지우고 연속 공백을 1칸으로 만든다. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 한 줄로 만들고 max 자로 자른다. */
function oneLine(text: string, max: number): string {
  const flat = squash(text)
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** 'YYYY-MM-DD' 가 실제 달력 날짜인지 본다. 예: 2026-02-30 은 거짓. */
function isCalendarDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

/** 공백을 모두 지우고 소문자로 만든다. 규칙 해석의 포함 검사용. */
function compact(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

/** 명령 원문을 공백 정리한다. 문자열이 아니거나 1~500자가 아니면 throw 한다. */
export function normalizeCommandText(text: unknown): string {
  if (typeof text !== 'string') throw new Error('명령은 문자열이어야 합니다.')
  const normalized = squash(text)
  if (normalized.length === 0) throw new Error('명령이 비어 있습니다.')
  if (normalized.length > COMMAND_TEXT_MAX) throw new Error(`명령은 ${COMMAND_TEXT_MAX}자 이하여야 합니다.`)
  return normalized
}

/** 체크인 답장 해석 (G.5.1, §12.1). MVP4 가 재사용하는 고정 인터페이스다. */
export function interpretReplyRule(text: string): { status: 'done' | 'deferred' | 'in_progress'; note: string | null } {
  const normalized = squash(text)
  const key = normalized.toLowerCase().replace(/[.!~]+$/, '').trim()
  if (key === '완료' || key === 'done') return { status: 'done', note: null }
  if (key === '미룸' || key === '나중에') return { status: 'deferred', note: null }
  // 체크인 안내 문구 '진행 중' 은 상태 키워드다. 메모로 쓰면 기존 메모를 덮는다.
  if (key === '진행 중' || key === '진행중' || key === 'in progress') return { status: 'in_progress', note: null }
  return { status: 'in_progress', note: normalized === '' ? null : normalized }
}

/** 해석 컨텍스트를 만든다 (G.3.2). 입력 배열을 바꾸지 않는다. */
export function buildCommandContext(input: {
  today: string
  items: PlanItem[]
  candidates: Candidate[]
  scopeItemId: number | null
  briefingInstruction: string | null
}): CommandContext {
  const { today, scopeItemId } = input
  const visible = input.items.filter((it) =>
    it.status !== 'dismissed' && (scopeItemId === null || it.id === scopeItemId)
  )
  const items: CommandItemRef[] = visible.map((it) => ({
    itemId: it.id,
    candidateId: it.candidate_id,
    title: oneLine(it.title, COMMAND_TITLE_MAX),
    status: it.status,
    jiraKey: it.jira_issue_key,
    dueDate: it.due_date,
    rank: it.rank
  }))

  let candidates: CommandCandidateRef[] = []
  if (scopeItemId === null) {
    // dismissed 항목도 계획 항목이다. 같은 후보를 다시 넣지 않는다.
    const planned = new Set(input.items.map((it) => it.candidate_id))
    candidates = rankCandidates(
      input.candidates.filter((c) => !planned.has(c.id)),
      today
    )
      .slice(0, COMMAND_CANDIDATE_LIMIT)
      .map(({ candidate: c }) => ({
        candidateId: c.id,
        title: oneLine(c.title, COMMAND_TITLE_MAX),
        source: c.source,
        jiraKey: c.jiraKey,
        dueDate: c.dueDate
      }))
  }

  return { today, scopeItemId, items, candidates, briefingInstruction: input.briefingInstruction }
}

const RULE_UNSUPPORTED_REASON =
  '규칙 해석은 항목 이름이나 Jira 키가 1개 있는 문장만 처리합니다. AI 해석을 켜거나 항목 버튼을 사용하세요.'
const JIRA_KEY_RE = /[A-Z][A-Z0-9]+-\d+/gi

type RuleVerb = 'focus' | 'dismiss' | 'add' | 'done' | 'deferred' | 'in_progress'
const VERB_TABLE: { verb: RuleVerb; words: string[] }[] = [
  { verb: 'focus', words: ['집중'] },
  { verb: 'dismiss', words: ['빼', '제외', '무시'] },
  { verb: 'add', words: ['추가', '넣어'] },
  { verb: 'done', words: ['끝', '완료', 'done'] },
  { verb: 'deferred', words: ['미룸', '미뤄', '미루', '나중에', '내일'] },
  { verb: 'in_progress', words: ['시작', '진행'] }
]

type RuleTarget =
  | { kind: 'item'; ref: CommandItemRef; matched: string }
  | { kind: 'candidate'; ref: CommandCandidateRef; matched: string }

function findRuleTargets(text: string, ctx: CommandContext): RuleTarget[] {
  // Jira 키는 대소문자를 가리지 않는다. 비교는 대문자로 한다.
  const keys = text.match(JIRA_KEY_RE)
  if (keys && keys.length > 0) {
    const keySet = new Set(keys.map((k) => k.toUpperCase()))
    const has = (key: string | null): key is string => key !== null && keySet.has(key.toUpperCase())
    const out: RuleTarget[] = []
    for (const ref of ctx.items) {
      if (has(ref.jiraKey)) out.push({ kind: 'item', ref, matched: compact(ref.jiraKey) })
    }
    for (const ref of ctx.candidates) {
      if (has(ref.jiraKey)) out.push({ kind: 'candidate', ref, matched: compact(ref.jiraKey) })
    }
    return out
  }
  const body = compact(text)
  const out: RuleTarget[] = []
  for (const ref of ctx.items) {
    const t = compact(ref.title)
    if (t.length >= 2 && body.includes(t)) out.push({ kind: 'item', ref, matched: t })
  }
  for (const ref of ctx.candidates) {
    const t = compact(ref.title)
    if (t.length >= 2 && body.includes(t)) out.push({ kind: 'candidate', ref, matched: t })
  }
  // 다른 대상의 일치 문자열에 완전히 포함되는 짧은 대상을 뺀다. 예: '배포' 와 '배포 준비 문서'.
  return out.filter((a) => !out.some((b) => b.matched.length > a.matched.length && b.matched.includes(a.matched)))
}

/** 대상 부분을 뺀 문장에서 표 순서대로 첫 동사를 찾는다. 제목 안의 단어를 동사로 오인하지 않는다. */
function findVerb(text: string, matched: string): RuleVerb | null {
  const rest = compact(text).replace(matched, ' ')
  for (const row of VERB_TABLE) {
    if (row.words.some((w) => rest.includes(w))) return row.verb
  }
  return null
}

/** 규칙 해석 (G.5.2). 결과는 normalizeCommandOps 입력이다. */
export function interpretCommandRule(text: string, ctx: CommandContext): unknown[] {
  if (ctx.scopeItemId !== null) {
    const reply = interpretReplyRule(text)
    return [{ kind: 'set_status', itemId: ctx.scopeItemId, status: reply.status, note: reply.note }]
  }

  const targets = findRuleTargets(text, ctx)
  if (targets.length !== 1) return [{ kind: 'unsupported', reason: RULE_UNSUPPORTED_REASON }]
  const target = targets[0]
  const verb = findVerb(text, target.matched)
  const title = target.ref.title
  if (verb === null) return [{ kind: 'unsupported', reason: `'${title}' 에 할 동작을 찾지 못했습니다.` }]

  if (target.kind === 'candidate') {
    if (verb === 'add') return [{ kind: 'add_candidate', candidateId: target.ref.candidateId }]
    return [{ kind: 'unsupported', reason: `'${title}' 은 오늘 계획에 없습니다. '추가' 로 먼저 계획에 넣으세요.` }]
  }

  const itemId = target.ref.itemId
  switch (verb) {
    case 'focus':
      return [{ kind: 'focus', itemId }]
    case 'dismiss':
      return [{ kind: 'dismiss_suggestion', itemId }]
    case 'add':
      return [{ kind: 'set_status', itemId, status: 'planned', note: null }]
    case 'done':
      return [{ kind: 'set_status', itemId, status: 'done', note: null }]
    case 'deferred':
      return [{ kind: 'set_status', itemId, status: 'deferred', note: null }]
    case 'in_progress':
      return [{ kind: 'set_status', itemId, status: 'in_progress', note: null }]
  }
}

const KEEP_SET_STATUS: ReadonlySet<PlanItemStatus> = new Set(['planned', 'in_progress', 'done', 'deferred', 'dropped'])
const FOCUSABLE: ReadonlySet<PlanItemStatus> = new Set(['planned', 'in_progress'])
const DROPPABLE: ReadonlySet<PlanItemStatus> = new Set(['planned', 'in_progress', 'deferred'])

/** 검증 표 (G.3.3) 를 적용한다. 뺄 조작이면 null. */
function reconcile(op: CommandOp, ctx: CommandContext, itemById: Map<number, CommandItemRef>): CommandOp | null {
  switch (op.kind) {
    case 'set_status': {
      const item = itemById.get(op.itemId)
      if (!item) return null
      const note = op.note === null ? null : oneLine(op.note, NOTE_MAX) || null
      if (KEEP_SET_STATUS.has(item.status)) return { ...op, note }
      if (item.status === 'suggested') {
        if (op.status === 'planned' || op.status === 'in_progress') return { kind: 'accept_suggestion', itemId: op.itemId }
        if (op.status === 'dropped') return { kind: 'dismiss_suggestion', itemId: op.itemId }
      }
      return null
    }
    case 'focus': {
      const item = itemById.get(op.itemId)
      return item && FOCUSABLE.has(item.status) ? op : null
    }
    case 'accept_suggestion': {
      const item = itemById.get(op.itemId)
      return item && item.status === 'suggested' ? op : null
    }
    case 'dismiss_suggestion': {
      const item = itemById.get(op.itemId)
      if (!item) return null
      if (item.status === 'suggested') return op
      if (DROPPABLE.has(item.status)) return { kind: 'set_status', itemId: op.itemId, status: 'dropped', note: null }
      return null
    }
    case 'add_candidate': {
      if (ctx.candidates.some((c) => c.candidateId === op.candidateId)) return op
      const item = ctx.items.find((it) => it.candidateId === op.candidateId)
      if (item && item.status === 'suggested') return { kind: 'accept_suggestion', itemId: item.itemId }
      return null
    }
    case 'add_manual': {
      const title = squash(op.title)
      if (title.length < 1 || title.length > COMMAND_TITLE_MAX) return null
      // 달력에 없는 날짜는 마감만 버리고 조작은 남긴다.
      const dueDate = op.dueDate !== null && isCalendarDate(op.dueDate) ? op.dueDate : null
      return { kind: 'add_manual', title, dueDate }
    }
    case 'regenerate_briefing': {
      if (op.instruction === null) return op
      const instruction = squash(op.instruction).slice(0, COMMAND_INSTRUCTION_MAX)
      return { kind: 'regenerate_briefing', instruction: instruction === '' ? null : instruction }
    }
    case 'unsupported':
      return { kind: 'unsupported', reason: oneLine(op.reason, REASON_MAX) }
  }
}

function targetKey(op: CommandOp): string {
  switch (op.kind) {
    case 'set_status':
    case 'focus':
    case 'accept_suggestion':
    case 'dismiss_suggestion':
      return `${op.kind}:${op.itemId}`
    case 'add_candidate':
      return `${op.kind}:${op.candidateId}`
    case 'add_manual':
      return `${op.kind}:${op.title}`
    case 'regenerate_briefing':
      return op.kind
    case 'unsupported':
      return `${op.kind}:${op.reason}`
  }
}

const SCOPE_BLOCKED: ReadonlySet<CommandOp['kind']> = new Set(['add_candidate', 'add_manual', 'regenerate_briefing'])

/**
 * 조작 목록을 검증하고 미리보기로 바꾼다 (G.3.3, A35·A40).
 * dropped 는 스키마 실패·검증 표·scope 규칙·개수 상한으로 뺀 수다. 중복 제거는 세지 않는다.
 */
export function normalizeCommandOps(raw: unknown[], ctx: CommandContext): { ops: CommandPreviewOp[]; dropped: number } {
  const list = Array.isArray(raw) ? raw : []
  const itemById = new Map(ctx.items.map((it) => [it.itemId, it]))
  const scope = ctx.scopeItemId
  const seen = new Set<string>()
  const kept: CommandOp[] = []
  let dropped = 0

  for (const entry of list) {
    const parsed = CommandOpSchema.safeParse(entry)
    if (!parsed.success) {
      dropped += 1
      continue
    }
    let op: CommandOp | null = parsed.data
    if (scope !== null && SCOPE_BLOCKED.has(op.kind)) op = null
    if (op) op = reconcile(op, ctx, itemById)
    if (op && scope !== null && 'itemId' in op && op.itemId !== scope) op = null
    if (!op) {
      dropped += 1
      continue
    }
    const key = targetKey(op)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(op)
  }

  if (kept.length > COMMAND_OPS_MAX) {
    dropped += kept.length - COMMAND_OPS_MAX
    kept.length = COMMAND_OPS_MAX
  }

  return {
    ops: kept.map((op) => ({ op, label: describeCommandOp(op, ctx), executable: op.kind !== 'unsupported' })),
    dropped
  }
}

function itemTitle(itemId: number, ctx: CommandContext): string {
  return ctx.items.find((it) => it.itemId === itemId)?.title ?? `항목 #${itemId}`
}

function candidateTitle(candidateId: string, ctx: CommandContext): string {
  return (
    ctx.candidates.find((c) => c.candidateId === candidateId)?.title ??
    ctx.items.find((it) => it.candidateId === candidateId)?.title ??
    `항목 #${candidateId}`
  )
}

const withNote = (base: string, note: string | null): string => (note ? `${base} · 메모: ${note}` : base)

/** 미리보기 문구 (G.11.2a). */
export function describeCommandOp(op: CommandOp, ctx: CommandContext): string {
  switch (op.kind) {
    case 'set_status': {
      const t = `'${itemTitle(op.itemId, ctx)}'`
      switch (op.status) {
        case 'done':
          return `${t} 완료`
        case 'deferred':
          return withNote(`${t} 미룸`, op.note)
        case 'in_progress':
          return withNote(`${t} 진행 중`, op.note)
        case 'planned':
          return `${t} 다시 계획에`
        case 'dropped':
          return `${t} 제외`
      }
      break
    }
    case 'focus':
      return `'${itemTitle(op.itemId, ctx)}' 지금 집중`
    case 'accept_suggestion':
      return `'${itemTitle(op.itemId, ctx)}' 계획에 추가 (새로 들어온 일)`
    case 'dismiss_suggestion':
      return `'${itemTitle(op.itemId, ctx)}' 제안 무시`
    case 'add_candidate':
      return `'${candidateTitle(op.candidateId, ctx)}' 계획에 추가`
    case 'add_manual':
      return op.dueDate ? `'${op.title}' 임시 항목으로 추가 · 마감 ${op.dueDate}` : `'${op.title}' 임시 항목으로 추가`
    case 'regenerate_briefing':
      return op.instruction ? `브리핑 다시 만들기 · 방침: ${op.instruction}` : '브리핑 다시 만들기'
    case 'unsupported':
      return `지원하지 않음: ${op.reason}`
  }
  return ''
}

/** 임시 항목의 점수·긴급 계산용 Candidate (G.6.1). */
export function toManualCandidate(title: string, dueDate: string | null, candidateId: string): Candidate {
  return {
    id: candidateId,
    source: 'manual',
    title,
    jiraKey: null,
    projectId: null,
    projectName: null,
    dueDate,
    dueTime: null,
    inProgress: false,
    priority: null,
    jiraPriority: null,
    lastTouchedAt: null,
    link: null,
    parentKey: null,
    groupName: null,
    workType: 'etc',
    workVersion: null
  }
}

/** 'manual:<plan_id>:<n>'. n 은 같은 계획의 기존 임시 항목 번호 최댓값 + 1 이다. */
export function nextManualCandidateId(planId: number, items: Pick<PlanItem, 'candidate_id'>[]): string {
  const prefix = `manual:${planId}:`
  let max = 0
  for (const it of items) {
    if (!it.candidate_id.startsWith(prefix)) continue
    const rest = it.candidate_id.slice(prefix.length)
    if (!/^\d+$/.test(rest)) continue
    max = Math.max(max, Number(rest))
  }
  return `${prefix}${max + 1}`
}
