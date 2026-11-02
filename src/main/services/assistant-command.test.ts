import { describe, expect, it } from 'vitest'
import {
  buildCommandContext,
  COMMAND_CANDIDATE_LIMIT,
  COMMAND_OPS_MAX,
  CommandOpSchema,
  describeCommandOp,
  interpretCommandRule,
  interpretReplyRule,
  nextManualCandidateId,
  normalizeCommandOps,
  normalizeCommandText,
  toManualCandidate
} from './assistant-command'
import { scoreCandidate } from './assistant-score'
import type { CommandContext, CommandItemRef, CommandOp, PlanItem } from './assistant-types'
import { cand, deepFreeze, item, TODAY } from './__fixtures__/assistant/factories'

function ref(over: Partial<CommandItemRef> & Pick<CommandItemRef, 'itemId'>): CommandItemRef {
  return {
    candidateId: `todo:${over.itemId}`,
    title: `항목${over.itemId}`,
    status: 'planned',
    jiraKey: null,
    dueDate: null,
    rank: over.itemId,
    ...over
  }
}

function ctxOf(over: Partial<CommandContext> = {}): CommandContext {
  return {
    today: TODAY,
    scopeItemId: null,
    items: [
      ref({ itemId: 1, title: '결제 작업', status: 'planned', jiraKey: 'PROJ-12', candidateId: 'jira:PROJ-12' }),
      ref({ itemId: 2, title: 'API 문서', status: 'in_progress' }),
      ref({ itemId: 3, title: '로그인 버그', status: 'suggested', candidateId: 'jira:PROJ-30', jiraKey: 'PROJ-30' }),
      ref({ itemId: 4, title: '리팩토링', status: 'done' }),
      ref({ itemId: 5, title: '배포 점검', status: 'deferred' })
    ],
    candidates: [{ candidateId: 'todo:77', title: '견적서 검토', source: 'todo', jiraKey: null, dueDate: null }],
    briefingInstruction: null,
    ...over
  }
}

const opsOf = (raw: unknown[], ctx = ctxOf()): CommandOp[] => normalizeCommandOps(raw, ctx).ops.map((p) => p.op)

describe('interpretReplyRule G.5.1', () => {
  it('interpretReplyRule: 완료·done 은 done 이다', () => {
    expect(interpretReplyRule('완료')).toEqual({ status: 'done', note: null })
    expect(interpretReplyRule('  DONE! ')).toEqual({ status: 'done', note: null })
    expect(interpretReplyRule('완료~')).toEqual({ status: 'done', note: null })
  })

  it('interpretReplyRule: 미룸·나중에 는 deferred 다', () => {
    expect(interpretReplyRule('미룸')).toEqual({ status: 'deferred', note: null })
    expect(interpretReplyRule('나중에.')).toEqual({ status: 'deferred', note: null })
  })

  it('interpretReplyRule: 진행 중·진행중·in progress 는 note 없는 in_progress 다', () => {
    expect(interpretReplyRule('진행 중')).toEqual({ status: 'in_progress', note: null })
    expect(interpretReplyRule('  진행중! ')).toEqual({ status: 'in_progress', note: null })
    expect(interpretReplyRule('In   Progress.')).toEqual({ status: 'in_progress', note: null })
    expect(interpretReplyRule('진행 중인데 막힘')).toEqual({ status: 'in_progress', note: '진행 중인데 막힘' })
  })

  it('interpretReplyRule: 나머지는 in_progress 와 공백 정리한 note 다', () => {
    expect(interpretReplyRule('  절반   정도 했어 ')).toEqual({ status: 'in_progress', note: '절반 정도 했어' })
    expect(interpretReplyRule('   ')).toEqual({ status: 'in_progress', note: null })
  })
})

describe('normalizeCommandText', () => {
  it('공백을 정리하고 1~500자가 아니면 throw 한다', () => {
    expect(normalizeCommandText('  a   b ')).toBe('a b')
    expect(() => normalizeCommandText('   ')).toThrow()
    expect(() => normalizeCommandText(12)).toThrow()
    expect(() => normalizeCommandText('가'.repeat(501))).toThrow()
    expect(normalizeCommandText('가'.repeat(500))).toHaveLength(500)
  })
})

describe('buildCommandContext G.3.2', () => {
  const items: PlanItem[] = [
    item({ id: 1, candidate_id: 'todo:1', title: '  결제\n작업  ' }),
    item({ id: 2, candidate_id: 'todo:2', status: 'dismissed' }),
    item({ id: 3, candidate_id: 'jira:P-3', source: 'jira', jira_issue_key: 'P-3', status: 'suggested', due_date: '2026-11-03' })
  ]

  it('dismissed 항목과 계획 항목의 후보를 빼고 제목을 한 줄로 만든다', () => {
    const candidates = [cand({ id: 'todo:1' }), cand({ id: 'todo:2' }), cand({ id: 'todo:9', title: 'x'.repeat(300) })]
    const ctx = buildCommandContext({ today: TODAY, items, candidates, scopeItemId: null, briefingInstruction: '배포 위주' })
    expect(ctx.items.map((r) => r.itemId)).toEqual([1, 3])
    expect(ctx.items[0].title).toBe('결제 작업')
    expect(ctx.items[1]).toMatchObject({ jiraKey: 'P-3', dueDate: '2026-11-03', status: 'suggested', candidateId: 'jira:P-3' })
    expect(ctx.candidates.map((c) => c.candidateId)).toEqual(['todo:9'])
    expect(ctx.candidates[0].title.length).toBe(120)
    expect(ctx.briefingInstruction).toBe('배포 위주')
  })

  it('후보는 rankCandidates 순서로 최대 50건이다', () => {
    const candidates = Array.from({ length: 60 }, (_, i) => cand({ id: `todo:${100 + i}`, dueDate: i === 59 ? TODAY : null }))
    const ctx = buildCommandContext({ today: TODAY, items: [], candidates, scopeItemId: null, briefingInstruction: null })
    expect(ctx.candidates).toHaveLength(COMMAND_CANDIDATE_LIMIT)
    expect(ctx.candidates[0].candidateId).toBe('todo:159')
  })

  it('scope 모드는 범위 항목 1건만 넣고 후보를 비운다', () => {
    const ctx = buildCommandContext({ today: TODAY, items, candidates: [cand({ id: 'todo:9' })], scopeItemId: 3, briefingInstruction: null })
    expect(ctx.items.map((r) => r.itemId)).toEqual([3])
    expect(ctx.candidates).toEqual([])
    expect(ctx.scopeItemId).toBe(3)
  })

  it('A14: 같은 입력에 같은 출력을 내고 입력을 바꾸지 않는다', () => {
    const input = deepFreeze({
      today: TODAY,
      items: [...items],
      candidates: [cand({ id: 'todo:9' }), cand({ id: 'todo:8', inProgress: true })],
      scopeItemId: null,
      briefingInstruction: null
    })
    expect(buildCommandContext(input)).toEqual(buildCommandContext(input))
  })
})

describe('normalizeCommandOps G.3.3', () => {
  it('A35: 없는 itemId 의 조작을 빼고 dropped 에 센다', () => {
    const res = normalizeCommandOps(
      [
        { kind: 'set_status', itemId: 99, status: 'done', note: null },
        { kind: 'focus', itemId: 98 },
        { kind: 'set_status', itemId: 1, status: 'done', note: null }
      ],
      ctxOf()
    )
    expect(res.ops.map((p) => p.op)).toEqual([{ kind: 'set_status', itemId: 1, status: 'done', note: null }])
    expect(res.dropped).toBe(2)
  })

  it('A35: 없는 candidateId 의 add_candidate 를 뺀다', () => {
    const res = normalizeCommandOps(
      [
        { kind: 'add_candidate', candidateId: 'todo:404' },
        { kind: 'add_candidate', candidateId: 'todo:77' }
      ],
      ctxOf()
    )
    expect(res.ops.map((p) => p.op)).toEqual([{ kind: 'add_candidate', candidateId: 'todo:77' }])
    expect(res.dropped).toBe(1)
  })

  it('A35: scope 모드는 범위 밖 itemId 와 add_*·regenerate_briefing 을 뺀다', () => {
    const ctx = ctxOf({ scopeItemId: 2, candidates: [] })
    const res = normalizeCommandOps(
      [
        { kind: 'set_status', itemId: 1, status: 'done', note: null },
        { kind: 'add_candidate', candidateId: 'todo:77' },
        { kind: 'add_manual', title: '견적서', dueDate: null },
        { kind: 'regenerate_briefing', instruction: null },
        { kind: 'set_status', itemId: 2, status: 'done', note: null },
        { kind: 'focus', itemId: 2 }
      ],
      ctx
    )
    expect(res.ops.map((p) => p.op)).toEqual([
      { kind: 'set_status', itemId: 2, status: 'done', note: null },
      { kind: 'focus', itemId: 2 }
    ])
    expect(res.dropped).toBe(4)
  })

  it('A35: 대상 상태가 맞지 않으면 표대로 바꾸거나 뺀다', () => {
    // 3 = suggested, 4 = done, 5 = deferred, 1 = planned
    expect(opsOf([{ kind: 'set_status', itemId: 3, status: 'planned', note: null }])).toEqual([{ kind: 'accept_suggestion', itemId: 3 }])
    expect(opsOf([{ kind: 'set_status', itemId: 3, status: 'in_progress', note: 'x' }])).toEqual([{ kind: 'accept_suggestion', itemId: 3 }])
    expect(opsOf([{ kind: 'set_status', itemId: 3, status: 'dropped', note: null }])).toEqual([{ kind: 'dismiss_suggestion', itemId: 3 }])
    expect(opsOf([{ kind: 'set_status', itemId: 3, status: 'done', note: null }])).toEqual([])
    expect(opsOf([{ kind: 'set_status', itemId: 3, status: 'deferred', note: null }])).toEqual([])
    expect(opsOf([{ kind: 'focus', itemId: 4 }])).toEqual([])
    expect(opsOf([{ kind: 'focus', itemId: 5 }])).toEqual([])
    expect(opsOf([{ kind: 'focus', itemId: 2 }])).toEqual([{ kind: 'focus', itemId: 2 }])
    expect(opsOf([{ kind: 'accept_suggestion', itemId: 1 }])).toEqual([])
    expect(opsOf([{ kind: 'dismiss_suggestion', itemId: 1 }])).toEqual([{ kind: 'set_status', itemId: 1, status: 'dropped', note: null }])
    expect(opsOf([{ kind: 'dismiss_suggestion', itemId: 5 }])).toEqual([{ kind: 'set_status', itemId: 5, status: 'dropped', note: null }])
    expect(opsOf([{ kind: 'dismiss_suggestion', itemId: 4 }])).toEqual([])
    expect(opsOf([{ kind: 'dismiss_suggestion', itemId: 3 }])).toEqual([{ kind: 'dismiss_suggestion', itemId: 3 }])
    expect(opsOf([{ kind: 'add_candidate', candidateId: 'jira:PROJ-30' }])).toEqual([{ kind: 'accept_suggestion', itemId: 3 }])
    expect(opsOf([{ kind: 'add_candidate', candidateId: 'jira:PROJ-12' }])).toEqual([])
  })

  it('스키마에 맞지 않는 조작을 뺀다', () => {
    const res = normalizeCommandOps(
      [
        { kind: 'set_status', itemId: '1', status: 'done', note: null },
        { kind: 'set_status', itemId: 1, status: 'suggested', note: null },
        { kind: 'add_manual', title: '견적', dueDate: '11/03' },
        { kind: 'add_manual', title: 'x'.repeat(121), dueDate: null },
        { kind: 'unknown' },
        null,
        'text'
      ],
      ctxOf()
    )
    expect(res.ops).toEqual([])
    expect(res.dropped).toBe(7)
  })

  it('add_manual·regenerate_briefing·note 의 공백을 정리하고 길이를 지킨다', () => {
    expect(
      opsOf([
        { kind: 'add_manual', title: '  견적서   보내기 ', dueDate: '2026-11-03' },
        { kind: 'add_manual', title: '    ', dueDate: null },
        { kind: 'regenerate_briefing', instruction: '  배포   준비 위주 ' },
        { kind: 'set_status', itemId: 2, status: 'in_progress', note: '  절반  ' }
      ])
    ).toEqual([
      { kind: 'add_manual', title: '견적서 보내기', dueDate: '2026-11-03' },
      { kind: 'regenerate_briefing', instruction: '배포 준비 위주' },
      { kind: 'set_status', itemId: 2, status: 'in_progress', note: '절반' }
    ])
    expect(opsOf([{ kind: 'regenerate_briefing', instruction: null }])).toEqual([{ kind: 'regenerate_briefing', instruction: null }])
    expect(opsOf([{ kind: 'regenerate_briefing' }])).toEqual([{ kind: 'regenerate_briefing', instruction: null }])
  })

  it('regenerate_briefing.instruction 이 200자를 넘으면 공백 정리 뒤 200자로 자른다', () => {
    const res = normalizeCommandOps([{ kind: 'regenerate_briefing', instruction: `  ${'가'.repeat(250)}  ` }], ctxOf())
    expect(res.dropped).toBe(0)
    expect(res.ops[0].op).toEqual({ kind: 'regenerate_briefing', instruction: '가'.repeat(200) })
  })

  it('길이 검사는 공백 정리 뒤에 한다. title·note·reason', () => {
    const spaced = `${'가'.repeat(60)}${' '.repeat(80)}${'나'.repeat(59)}`
    expect(opsOf([{ kind: 'add_manual', title: spaced, dueDate: null }])).toEqual([
      { kind: 'add_manual', title: `${'가'.repeat(60)} ${'나'.repeat(59)}`, dueDate: null }
    ])
    expect(opsOf([{ kind: 'add_manual', title: '가'.repeat(121), dueDate: null }])).toEqual([])
    const note = opsOf([{ kind: 'set_status', itemId: 2, status: 'in_progress', note: `${'a '.repeat(150)}` }])[0]
    expect(note).toMatchObject({ kind: 'set_status', itemId: 2 })
    expect((note as { note: string }).note.length).toBeLessThanOrEqual(200)
    const reason = opsOf([{ kind: 'unsupported', reason: `캘린더에서   바꿔 주세요. ${'x'.repeat(300)}` }])[0]
    expect((reason as { reason: string }).reason.startsWith('캘린더에서 바꿔 주세요.')).toBe(true)
    expect((reason as { reason: string }).reason.length).toBe(200)
  })

  it('add_manual.dueDate 가 달력에 없는 날짜면 null 로 바꾸고 조작은 남긴다', () => {
    expect(
      opsOf([
        { kind: 'add_manual', title: '견적서', dueDate: '2026-13-45' },
        { kind: 'add_manual', title: '보고서', dueDate: '2026-02-30' },
        { kind: 'add_manual', title: '발표', dueDate: '2028-02-29' }
      ])
    ).toEqual([
      { kind: 'add_manual', title: '견적서', dueDate: null },
      { kind: 'add_manual', title: '보고서', dueDate: null },
      { kind: 'add_manual', title: '발표', dueDate: '2028-02-29' }
    ])
  })

  it('같은 kind 와 같은 대상의 중복은 첫 번째만 남긴다', () => {
    const res = normalizeCommandOps(
      [
        { kind: 'set_status', itemId: 1, status: 'done', note: null },
        { kind: 'set_status', itemId: 1, status: 'deferred', note: null },
        { kind: 'focus', itemId: 1 },
        // 변환 뒤 accept_suggestion 3 이 겹친다
        { kind: 'accept_suggestion', itemId: 3 },
        { kind: 'add_candidate', candidateId: 'jira:PROJ-30' }
      ],
      ctxOf()
    )
    expect(res.ops.map((p) => p.op)).toEqual([
      { kind: 'set_status', itemId: 1, status: 'done', note: null },
      { kind: 'focus', itemId: 1 },
      { kind: 'accept_suggestion', itemId: 3 }
    ])
    expect(res.dropped).toBe(0)
  })

  it('조작은 최대 10개다. 11번째부터 dropped 에 더한다', () => {
    const raw = Array.from({ length: 13 }, (_, i) => ({ kind: 'add_manual', title: `작업 ${i}`, dueDate: null }))
    const res = normalizeCommandOps(raw, ctxOf())
    expect(res.ops).toHaveLength(COMMAND_OPS_MAX)
    expect(res.dropped).toBe(3)
  })

  it('A40: unsupported 는 executable: false 이고 나머지는 true 다', () => {
    const res = normalizeCommandOps(
      [
        { kind: 'unsupported', reason: '캘린더에서 바꿔 주세요.' },
        { kind: 'set_status', itemId: 1, status: 'done', note: null }
      ],
      ctxOf()
    )
    expect(res.ops).toEqual([
      { op: { kind: 'unsupported', reason: '캘린더에서 바꿔 주세요.' }, label: '지원하지 않음: 캘린더에서 바꿔 주세요.', executable: false },
      { op: { kind: 'set_status', itemId: 1, status: 'done', note: null }, label: "'결제 작업' 완료", executable: true }
    ])
  })

  it('A40: scope 모드에서도 unsupported 는 남고 실행 불가다', () => {
    const res = normalizeCommandOps([{ kind: 'unsupported', reason: 'Jira 에서 바꿔 주세요.' }], ctxOf({ scopeItemId: 1 }))
    expect(res.ops.map((p) => p.executable)).toEqual([false])
  })

  it('A14: 같은 입력에 같은 출력을 내고 입력 배열을 바꾸지 않는다', () => {
    const raw = deepFreeze([
      { kind: 'set_status', itemId: 3, status: 'planned', note: null },
      { kind: 'dismiss_suggestion', itemId: 1 },
      { kind: 'add_manual', title: '  견적서 ', dueDate: null }
    ])
    const ctx = deepFreeze(ctxOf())
    expect(normalizeCommandOps(raw, ctx)).toEqual(normalizeCommandOps(raw, ctx))
  })
})

describe('describeCommandOp G.11.2a', () => {
  const ctx = ctxOf()
  const cases: [CommandOp, string][] = [
    [{ kind: 'set_status', itemId: 1, status: 'done', note: null }, "'결제 작업' 완료"],
    [{ kind: 'set_status', itemId: 1, status: 'deferred', note: '내일 오전' }, "'결제 작업' 미룸 · 메모: 내일 오전"],
    [{ kind: 'set_status', itemId: 2, status: 'in_progress', note: null }, "'API 문서' 진행 중"],
    [{ kind: 'set_status', itemId: 2, status: 'in_progress', note: '절반' }, "'API 문서' 진행 중 · 메모: 절반"],
    [{ kind: 'set_status', itemId: 4, status: 'planned', note: null }, "'리팩토링' 다시 계획에"],
    [{ kind: 'set_status', itemId: 1, status: 'dropped', note: null }, "'결제 작업' 제외"],
    [{ kind: 'focus', itemId: 2 }, "'API 문서' 지금 집중"],
    [{ kind: 'accept_suggestion', itemId: 3 }, "'로그인 버그' 계획에 추가 (새로 들어온 일)"],
    [{ kind: 'dismiss_suggestion', itemId: 3 }, "'로그인 버그' 제안 무시"],
    [{ kind: 'add_candidate', candidateId: 'todo:77' }, "'견적서 검토' 계획에 추가"],
    [{ kind: 'add_manual', title: '견적서 보내기', dueDate: null }, "'견적서 보내기' 임시 항목으로 추가"],
    [{ kind: 'add_manual', title: '견적서 보내기', dueDate: '2026-11-03' }, "'견적서 보내기' 임시 항목으로 추가 · 마감 2026-11-03"],
    [{ kind: 'regenerate_briefing', instruction: '배포 위주' }, '브리핑 다시 만들기 · 방침: 배포 위주'],
    [{ kind: 'regenerate_briefing', instruction: null }, '브리핑 다시 만들기'],
    [{ kind: 'unsupported', reason: '캘린더에서 바꿔 주세요.' }, '지원하지 않음: 캘린더에서 바꿔 주세요.'],
    [{ kind: 'focus', itemId: 404 }, "'항목 #404' 지금 집중"],
    [{ kind: 'add_candidate', candidateId: 'todo:404' }, "'항목 #todo:404' 계획에 추가"]
  ]
  it.each(cases)('%j → %s', (op, label) => {
    expect(describeCommandOp(op, ctx)).toBe(label)
  })
})

describe('interpretCommandRule G.5.2', () => {
  const ctx = ctxOf()
  const rule = (text: string, c = ctx): CommandOp[] => normalizeCommandOps(interpretCommandRule(text, c), c).ops.map((p) => p.op)

  it('scope 모드는 interpretReplyRule 결과로 set_status 1건을 만든다', () => {
    const scoped = ctxOf({ scopeItemId: 2, items: [ref({ itemId: 2, title: 'API 문서', status: 'in_progress' })], candidates: [] })
    expect(interpretCommandRule('완료', scoped)).toEqual([{ kind: 'set_status', itemId: 2, status: 'done', note: null }])
    expect(interpretCommandRule('반쯤 했어', scoped)).toEqual([{ kind: 'set_status', itemId: 2, status: 'in_progress', note: '반쯤 했어' }])
  })

  it('Jira 키로 대상을 찾는다', () => {
    expect(rule('PROJ-12 끝났어')).toEqual([{ kind: 'set_status', itemId: 1, status: 'done', note: null }])
  })

  it('제목을 공백 제거·소문자로 찾는다', () => {
    expect(rule('api문서는 내일 할게')).toEqual([{ kind: 'set_status', itemId: 2, status: 'deferred', note: null }])
    expect(rule('오후엔 결제 작업에 집중할래')).toEqual([{ kind: 'focus', itemId: 1 }])
    expect(rule('API 문서 시작')).toEqual([{ kind: 'set_status', itemId: 2, status: 'in_progress', note: null }])
  })

  it('동사 표대로 suggested·후보를 다룬다', () => {
    expect(rule('로그인 버그 넣어줘')).toEqual([{ kind: 'accept_suggestion', itemId: 3 }])
    expect(rule('로그인 버그는 빼')).toEqual([{ kind: 'dismiss_suggestion', itemId: 3 }])
    expect(rule('결제 작업 제외해')).toEqual([{ kind: 'set_status', itemId: 1, status: 'dropped', note: null }])
    expect(rule('견적서 검토도 오늘 추가')).toEqual([{ kind: 'add_candidate', candidateId: 'todo:77' }])
  })

  it('제목 안의 단어는 동사로 보지 않는다', () => {
    const c = ctxOf({ items: [ref({ itemId: 8, title: '집중 점검 완료 보고' })], candidates: [] })
    expect(rule('집중 점검 완료 보고 내일', c)).toEqual([{ kind: 'set_status', itemId: 8, status: 'deferred', note: null }])
  })

  it('소문자 Jira 키도 인식한다', () => {
    expect(rule('proj-12 끝났어')).toEqual([{ kind: 'set_status', itemId: 1, status: 'done', note: null }])
    expect(rule('Proj-30 넣어줘')).toEqual([{ kind: 'accept_suggestion', itemId: 3 }])
  })

  it('다른 대상의 제목에 완전히 포함되는 짧은 대상은 뺀다', () => {
    const c = ctxOf({
      items: [ref({ itemId: 11, title: '배포' }), ref({ itemId: 12, title: '배포 준비 문서' })],
      candidates: []
    })
    expect(rule('배포 준비 문서 완료', c)).toEqual([{ kind: 'set_status', itemId: 12, status: 'done', note: null }])
    expect(rule('배포 완료', c)).toEqual([{ kind: 'set_status', itemId: 11, status: 'done', note: null }])
  })

  it('대상이 0개이거나 2개 이상이면 unsupported 다', () => {
    const none = interpretCommandRule('3시 회의 취소됐어', ctx)
    expect(none).toEqual([{ kind: 'unsupported', reason: expect.stringContaining('규칙 해석은') }])
    const two = interpretCommandRule('결제 작업 API 문서 완료', ctx)
    expect(two).toEqual(none)
  })

  it('동사를 찾지 못하면 unsupported 다', () => {
    expect(interpretCommandRule('결제 작업 어때', ctx)).toEqual([
      { kind: 'unsupported', reason: "'결제 작업' 에 할 동작을 찾지 못했습니다." }
    ])
  })

  it('규칙 해석은 add_manual·regenerate_briefing 을 만들지 않는다', () => {
    const texts = ['견적서 보내기 추가', '오늘은 배포 준비 위주로 브리핑 다시', 'PROJ-12 끝']
    for (const t of texts) {
      const kinds = (interpretCommandRule(t, ctx) as { kind: string }[]).map((o) => o.kind)
      expect(kinds).not.toContain('add_manual')
      expect(kinds).not.toContain('regenerate_briefing')
    }
  })

  it('A14: 규칙 해석은 같은 입력에 같은 출력을 낸다', () => {
    const frozen = deepFreeze(ctxOf())
    expect(interpretCommandRule('PROJ-12 끝났어', frozen)).toEqual(interpretCommandRule('PROJ-12 끝났어', frozen))
  })
})

describe('임시 항목 헬퍼 G.6.1', () => {
  it('toManualCandidate 는 manual 출처의 중립 Candidate 다', () => {
    const c = toManualCandidate('견적서', '2026-11-03', 'manual:1:1')
    expect(c).toMatchObject({ id: 'manual:1:1', source: 'manual', inProgress: false, priority: null, jiraPriority: null, lastTouchedAt: null })
    expect(scoreCandidate(c, TODAY)).toBe(70)
  })

  it('nextManualCandidateId 는 같은 계획의 최댓값 + 1 이다', () => {
    expect(nextManualCandidateId(7, [])).toBe('manual:7:1')
    expect(
      nextManualCandidateId(7, [
        { candidate_id: 'manual:7:1' },
        { candidate_id: 'manual:7:4' },
        { candidate_id: 'manual:8:9' },
        { candidate_id: 'todo:7' },
        { candidate_id: 'manual:7:x' }
      ])
    ).toBe('manual:7:5')
  })
})

describe('CommandOpSchema', () => {
  it('note·dueDate·instruction 이 없으면 null 로 채운다', () => {
    expect(CommandOpSchema.parse({ kind: 'set_status', itemId: 1, status: 'done' })).toEqual({ kind: 'set_status', itemId: 1, status: 'done', note: null })
    expect(CommandOpSchema.safeParse({ kind: 'focus', itemId: 0 }).success).toBe(false)
    expect(CommandOpSchema.safeParse({ kind: 'unsupported', reason: 'x'.repeat(2001) }).success).toBe(false)
  })
})
