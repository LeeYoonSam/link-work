import { beforeEach, describe, expect, it, vi } from 'vitest'

// DB·비서 저장소·헤드리스 실행을 경계에서 대체한다.
const state = vi.hoisted(() => ({
  settings: { enabled: true, llmEnabled: true, llmModel: 'haiku' },
  headless: true,
  rows: new Map<string, { id: number; payload: string | null }>(),
  nextId: 1,
  llmCalls: 0,
  llmResult: null as unknown,
  llmDelay: null as Promise<void> | null
}))

vi.mock('../db/database', () => ({ getDatabase: () => ({}) }))
vi.mock('./assistant-store', () => ({
  readAssistantSettings: () => state.settings,
  findEventByKey: (_db: unknown, key: string) => {
    const r = state.rows.get(key)
    return r ? { id: r.id, event_key: key, payload: r.payload } : null
  },
  insertEvent: (_db: unknown, ev: { event_key: string; kind: string; status: string; payload: string }) => {
    if (state.rows.has(ev.event_key)) return null
    if (ev.kind !== 'today_briefing' || ev.status !== 'logged') throw new Error('bad event')
    const row = { id: state.nextId++, payload: ev.payload }
    state.rows.set(ev.event_key, row)
    return row
  },
  updateEventPayload: (_db: unknown, id: number, payload: string) => {
    for (const r of state.rows.values()) if (r.id === id) r.payload = payload
  }
}))
vi.mock('./assistant-service', () => ({ runLlmSerialized: <T,>(fn: () => Promise<T>) => fn() }))
vi.mock('./ai-headless', () => ({
  isHeadlessAvailable: () => state.headless,
  runHeadlessJson: async () => {
    state.llmCalls++
    if (state.llmDelay) await state.llmDelay
    return state.llmResult
  }
}))
vi.mock('./ai-model', () => ({ resolveAiModelId: (m: string) => `model-${m}` }))

import {
  getTodayBriefing,
  hashBriefingInput,
  parseBriefingInput,
  resetTodayBriefingStateForTest,
  ruleBriefing,
  TODAY_BRIEFING_SYSTEM_PROMPT,
  validateLlmBriefing,
  type TodayBriefingInput
} from './today-briefing'

function makeInput(over: Partial<TodayBriefingInput> = {}): TodayBriefingInput {
  return {
    date: '2026-11-19',
    ruleHeadline: '오늘 QA 시작, 배포 D-5예요.',
    signals: [
      { id: 'release_risk', kind: 'release_risk', severity: 'warn', text: 'QA 시작, 2건 미완', refs: ['issue:ICA-812'] },
      { id: 'meeting_soon', kind: 'meeting_soon', severity: 'info', text: '14:00 Tech weekly', refs: ['meeting:e1'] }
    ],
    facts: {
      meetingCount: 2,
      overdueCount: 0,
      dueTodayCount: 1,
      calendarConnected: true,
      jiraConnected: true,
      nextMeeting: { title: 'Tech weekly', start: '14:00' },
      release: {
        version: '4.177.0',
        date: '2026-11-24',
        dDay: 5,
        qaStart: '2026-11-19',
        linked: true,
        mine: { total: 5, done: 3, review: 1, progress: 1, todo: 0 }
      }
    },
    ...over
  }
}

const NOW = new Date(2026, 10, 19, 9, 0, 0)
const later = (min: number): Date => new Date(NOW.getTime() + min * 60_000)

beforeEach(() => {
  state.settings = { enabled: true, llmEnabled: true, llmModel: 'haiku' }
  state.headless = true
  state.rows = new Map()
  state.nextId = 1
  state.llmCalls = 0
  state.llmDelay = null
  state.llmResult = {
    ok: true,
    value: {
      headline: 'QA 가 시작됐어요.',
      signals: [
        { id: 'meeting_soon', text: '14:00 Tech weekly 회의' },
        { id: 'release_risk', text: 'QA 전 2건이 남았어요' }
      ]
    }
  }
  resetTodayBriefingStateForTest()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('입력 검증', () => {
  it('정상 입력은 통과한다', () => {
    expect(parseBriefingInput(makeInput()).date).toBe('2026-11-19')
  })

  it('형식 불일치·상한 초과·중복 id 는 throw 한다', () => {
    expect(() => parseBriefingInput({ ...makeInput(), date: '11/19' })).toThrow()
    expect(() => parseBriefingInput(null)).toThrow()
    const many = Array.from({ length: 11 }, (_, i) => ({
      id: `s${i}`,
      kind: 'overdue',
      severity: 'warn',
      text: 'x',
      refs: []
    }))
    expect(() => parseBriefingInput({ ...makeInput(), signals: many })).toThrow()
    expect(() => parseBriefingInput({ ...makeInput(), ruleHeadline: 'a'.repeat(201) })).toThrow()
    const s = makeInput().signals[0]
    expect(() => parseBriefingInput({ ...makeInput(), signals: [s, s] })).toThrow()
    expect(() =>
      parseBriefingInput({ ...makeInput(), facts: { ...makeInput().facts, nextMeeting: { title: 'a', start: '40분 뒤' } } })
    ).toThrow()
  })
})

describe('연결 여부 (calendarConnected·jiraConnected)', () => {
  it('옛 입력에 두 필드가 없으면 true 로 본다', () => {
    const { calendarConnected: _c, jiraConnected: _j, ...oldFacts } = makeInput().facts
    const parsed = parseBriefingInput({ ...makeInput(), facts: oldFacts })
    expect(parsed.facts.calendarConnected).toBe(true)
    expect(parsed.facts.jiraConnected).toBe(true)
    expect(hashBriefingInput({ ...makeInput(), facts: oldFacts } as TodayBriefingInput)).toBe(hashBriefingInput(makeInput()))
  })

  it('불리언이 아니면 throw 한다', () => {
    expect(() =>
      parseBriefingInput({ ...makeInput(), facts: { ...makeInput().facts, jiraConnected: 'no' } })
    ).toThrow()
  })

  it('프롬프트에 미연결이면 없다고 단정하지 말라는 규칙이 있다', () => {
    expect(TODAY_BRIEFING_SYSTEM_PROMPT).toMatch(/calendarConnected 가 false 면 회의·일정이 없다고 말하지 않는다/)
    expect(TODAY_BRIEFING_SYSTEM_PROMPT).toMatch(/jiraConnected 가 false 면 Jira 작업·마감·배포 작업이 없다고 말하지 않는다/)
  })

  it('둘 다 미연결이고 신호가 0건이면 LLM 을 부르지 않고 rules 다', async () => {
    const input = makeInput({
      signals: [],
      facts: { ...makeInput().facts, calendarConnected: false, jiraConnected: false }
    })
    const r = await getTodayBriefing(input, true, NOW)
    expect(r.briefing).toMatchObject({ source: 'rules', error: null, headline: input.ruleHeadline })
    expect(r.retryAfterMs).toBeUndefined()
    expect(state.llmCalls).toBe(0)
  })

  it('하나만 미연결이거나 신호가 있으면 LLM 을 부른다', async () => {
    const calOff = makeInput({ signals: [], facts: { ...makeInput().facts, calendarConnected: false } })
    expect((await getTodayBriefing(calOff, true, NOW)).briefing.source).toBe('llm')
    const bothOffWithSignal = makeInput({
      facts: { ...makeInput().facts, calendarConnected: false, jiraConnected: false }
    })
    expect((await getTodayBriefing(bothOffWithSignal, true, NOW)).briefing.source).toBe('llm')
    expect(state.llmCalls).toBe(2)
  })
})

describe('hashBriefingInput', () => {
  it('같은 입력이면 현재 시각과 무관하게 같은 해시다', async () => {
    const h = hashBriefingInput(makeInput())
    expect(hashBriefingInput(makeInput())).toBe(h)
    const { briefing: a } = await getTodayBriefing(makeInput(), false, NOW)
    state.rows.clear()
    resetTodayBriefingStateForTest()
    const { briefing: b } = await getTodayBriefing(makeInput(), false, later(45))
    expect(a.inputHash).toBe(h)
    expect(b.inputHash).toBe(h)
  })

  it('키 순서가 달라도 같은 해시이고, 내용이 바뀌면 다르다', () => {
    const i = makeInput()
    const reordered = { facts: i.facts, signals: i.signals, ruleHeadline: i.ruleHeadline, date: i.date }
    expect(hashBriefingInput(reordered as TodayBriefingInput)).toBe(hashBriefingInput(i))
    expect(hashBriefingInput(makeInput({ ruleHeadline: '다름' }))).not.toBe(hashBriefingInput(i))
  })
})

describe('validateLlmBriefing', () => {
  const input = makeInput()

  it('모르는 id 와 중복 id 는 버린다', () => {
    const v = validateLlmBriefing(input, {
      headline: '좋아요',
      signals: [
        { id: 'ghost', text: '새 신호' },
        { id: 'release_risk', text: 'A' },
        { id: 'release_risk', text: 'B' },
        { id: 'meeting_soon', text: 'C' }
      ]
    })
    expect(v.signals).toEqual([
      { id: 'release_risk', text: 'A' },
      { id: 'meeting_soon', text: 'C' }
    ])
  })

  it('빠진 id 는 규칙 문구로 뒤에 붙인다', () => {
    const v = validateLlmBriefing(input, { headline: '좋아요', signals: [{ id: 'meeting_soon', text: 'C' }] })
    expect(v.signals).toEqual([
      { id: 'meeting_soon', text: 'C' },
      { id: 'release_risk', text: 'QA 시작, 2건 미완' }
    ])
  })

  it('headline 이 비었거나 80자를 넘으면 ruleHeadline 이다', () => {
    expect(validateLlmBriefing(input, { headline: '  ', signals: [] }).headline).toBe(input.ruleHeadline)
    expect(validateLlmBriefing(input, { headline: '가'.repeat(81), signals: [] }).headline).toBe(input.ruleHeadline)
    expect(validateLlmBriefing(input, { headline: '가'.repeat(80), signals: [] }).headline).toBe('가'.repeat(80))
  })

  it('신호 문구가 비었거나 60자를 넘으면 규칙 문구다', () => {
    const v = validateLlmBriefing(input, {
      headline: 'h',
      signals: [
        { id: 'release_risk', text: '' },
        { id: 'meeting_soon', text: '나'.repeat(61) }
      ]
    })
    expect(v.signals.map((s) => s.text)).toEqual(['QA 시작, 2건 미완', '14:00 Tech weekly'])
  })

  it('결과 id 는 입력 id 의 순열이다', () => {
    const v = validateLlmBriefing(input, { headline: 'h', signals: [] })
    expect(v.signals.map((s) => s.id).sort()).toEqual(input.signals.map((s) => s.id).sort())
  })
})

describe('프롬프트', () => {
  it('상대 시간·새 사실·새 id 금지와 해요체를 지시한다', () => {
    expect(TODAY_BRIEFING_SYSTEM_PROMPT).toMatch(/상대 시간/)
    expect(TODAY_BRIEFING_SYSTEM_PROMPT).toMatch(/새 신호 id/)
    expect(TODAY_BRIEFING_SYSTEM_PROMPT).toMatch(/없는 사실/)
    expect(TODAY_BRIEFING_SYSTEM_PROMPT).toMatch(/해요체/)
  })
})

describe('getTodayBriefing', () => {
  it('LLM 결과를 검증해 llm 으로 돌려주고 저장한다', async () => {
    const { briefing: b, retryAfterMs } = await getTodayBriefing(makeInput(), false, NOW)
    expect(retryAfterMs).toBeUndefined()
    expect(b).toMatchObject({
      date: '2026-11-19',
      headline: 'QA 가 시작됐어요.',
      source: 'llm',
      model: 'model-haiku',
      error: null
    })
    expect(b.signals.map((s) => s.id)).toEqual(['meeting_soon', 'release_risk'])
    const saved = JSON.parse(state.rows.get('today_briefing:2026-11-19')!.payload!)
    expect(saved.inputHash).toBe(b.inputHash)
  })

  it('비서 꺼짐·LLM 꺼짐·헤드리스 없음이면 rules(error null)이고 LLM 을 부르지 않는다', async () => {
    state.settings = { ...state.settings, enabled: false }
    expect((await getTodayBriefing(makeInput(), false, NOW)).briefing).toMatchObject({ source: 'rules', error: null, model: null })
    state.settings = { ...state.settings, enabled: true, llmEnabled: false }
    expect((await getTodayBriefing(makeInput(), true, NOW)).briefing.source).toBe('rules')
    state.settings = { ...state.settings, llmEnabled: true }
    state.headless = false
    const b = await getTodayBriefing(makeInput(), true, NOW)
    expect(b).toEqual({ briefing: ruleBriefing(makeInput(), { now: NOW }) })
    expect(state.llmCalls).toBe(0)
  })

  it('LLM 실패면 rules + error 다', async () => {
    state.llmResult = { ok: false, error: '시간 초과' }
    const { briefing: b } = await getTodayBriefing(makeInput(), false, NOW)
    expect(b).toMatchObject({ source: 'rules', error: '시간 초과', headline: makeInput().ruleHeadline })
    expect(b.signals).toEqual([
      { id: 'release_risk', text: 'QA 시작, 2건 미완' },
      { id: 'meeting_soon', text: '14:00 Tech weekly' }
    ])
  })

  it('같은 해시로 다시 부르면 저장본을 돌려주고 LLM 을 부르지 않는다', async () => {
    const a = await getTodayBriefing(makeInput(), false, NOW)
    const b = await getTodayBriefing(makeInput(), false, later(30))
    expect(b).toEqual(a)
    expect(b.retryAfterMs).toBeUndefined()
    expect(state.llmCalls).toBe(1)
  })

  it('입력이 바뀌어도 10분 안에는 LLM 을 다시 부르지 않고 rules + retryAfterMs 이며, 10분 뒤나 force 면 부른다', async () => {
    await getTodayBriefing(makeInput(), false, NOW)
    const changed = makeInput({ ruleHeadline: '바뀐 헤드라인이에요.' })
    const throttled = await getTodayBriefing(changed, false, later(4))
    expect(throttled.briefing).toMatchObject({ source: 'rules', headline: '바뀐 헤드라인이에요.', error: null })
    expect(throttled.retryAfterMs).toBe(6 * 60_000)
    expect(state.llmCalls).toBe(1)

    await getTodayBriefing(changed, true, later(6))
    expect(state.llmCalls).toBe(2)

    const changed2 = makeInput({ ruleHeadline: '또 바뀌었어요.' })
    const after = await getTodayBriefing(changed2, false, later(17))
    expect(after.retryAfterMs).toBeUndefined()
    expect(state.llmCalls).toBe(3)
  })

  it('10분 제한으로 돌려준 rules 는 저장하지 않아 저장된 llm 결과를 덮지 않는다', async () => {
    const first = await getTodayBriefing(makeInput(), false, NOW)
    const before = state.rows.get('today_briefing:2026-11-19')!.payload
    await getTodayBriefing(makeInput({ ruleHeadline: '바뀐 헤드라인이에요.' }), false, later(2))
    expect(state.rows.get('today_briefing:2026-11-19')!.payload).toBe(before)
    // 원래 입력으로 돌아오면 저장된 llm 결과를 그대로 쓴다
    const back = await getTodayBriefing(makeInput(), false, later(3))
    expect(back).toEqual(first)
    expect(state.llmCalls).toBe(1)
  })

  it('제한 중 같은 해시의 저장본(rules·실패)이 있으면 그것과 retryAfterMs 를 준다', async () => {
    state.llmResult = { ok: false, error: '시간 초과' }
    await getTodayBriefing(makeInput(), false, NOW)
    const r = await getTodayBriefing(makeInput(), false, later(1))
    expect(r.briefing).toMatchObject({ source: 'rules', error: '시간 초과' })
    expect(r.retryAfterMs).toBe(9 * 60_000)
    expect(state.llmCalls).toBe(1)
  })

  it('force 면 같은 해시여도 LLM 을 다시 부른다', async () => {
    await getTodayBriefing(makeInput(), false, NOW)
    await getTodayBriefing(makeInput(), true, later(1))
    expect(state.llmCalls).toBe(2)
  })

  it('같은 입력의 호출이 진행 중이면 promise 를 공유한다', async () => {
    let release!: () => void
    state.llmDelay = new Promise<void>((r) => (release = r))
    const p1 = getTodayBriefing(makeInput(), false, NOW)
    const p2 = getTodayBriefing(makeInput(), true, NOW)
    release()
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toEqual(b)
    expect(state.llmCalls).toBe(1)
  })

  it('신호 0건이면 headline 만 다듬는다', async () => {
    state.llmResult = { ok: true, value: { headline: '조용한 하루예요.', signals: [{ id: 'x', text: 'y' }] } }
    const { briefing: b } = await getTodayBriefing(makeInput({ signals: [] }), false, NOW)
    expect(b).toMatchObject({ source: 'llm', headline: '조용한 하루예요.', signals: [] })
  })

  it('입력 형식이 틀리면 throw 한다', async () => {
    await expect(getTodayBriefing({ date: 'bad' }, false, NOW)).rejects.toThrow()
  })
})
