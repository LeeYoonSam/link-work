import { beforeEach, describe, expect, it, vi } from 'vitest'

// 실제 Claude·DB·Electron 을 쓰지 않는다. 모듈 경계에서 대체한다.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/linkwork-test' } }))

// findClaudeExecutable 은 existsSync 로 후보 경로를 찾는다.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: () => true }
})

type QueryArgs = { prompt: string; options: Record<string, unknown> }
const queryMock = vi.fn<(args: QueryArgs) => AsyncIterable<unknown>>()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (args: QueryArgs) => queryMock(args) }))

const logActivityMock = vi.fn()
vi.mock('../utils/activity-logger', () => ({
  logActivity: (...args: unknown[]) => logActivityMock(...args)
}))

// 참석자·용어 블록만 비우고 buildMarksBlock 은 실제 구현을 쓴다.
vi.mock('./recognition-aids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./recognition-aids')>()
  return { ...actual, loadPromptContext: () => ({}), buildSummaryContextBlock: () => '' }
})

// SQL 문자열로 분기하는 가짜 DB. 실행한 쓰기 SQL 을 기록한다.
type MeetingRowFixture = { kind: string; title: string; summary_template?: string | null }
const meetingRow = { value: { kind: 'meeting', title: '주간 회의' } as MeetingRowFixture | undefined }
const marksRows = { value: [] as Array<{ at_ms: number; text: string }> }
const runs: string[] = []
const runArgs: unknown[][] = []
const fakeDb = {
  prepare: (sql: string) => ({
    get: () => (sql.includes('FROM meetings') ? meetingRow.value : undefined),
    all: () =>
      sql.includes('meeting_segments')
        ? [{ start_ms: 0, end_ms: 1000, text: '다음 주까지 보고서 작성', label: 'S1', display_name: '홍길동' }]
        : sql.includes('meeting_marks')
          ? marksRows.value
          : [],
    run: (...args: unknown[]) => {
      runs.push(sql)
      runArgs.push(args)
      return { changes: 1 }
    }
  })
}
vi.mock('../db/database', () => ({ getDatabase: () => fakeDb }))

import {
  MEETING_OUTPUT_KEYS,
  MEETING_SPEC,
  buildMeetingSpec,
  carryTodoIds,
  extractJson,
  fitTranscript,
  formatTranscriptLines,
  formatTranscriptLinesWithMs,
  runMeetingSummary
} from './meeting-summary'
import { MEETING_OUTPUT_KEYS as TEMPLATE_OUTPUT_KEYS, getTemplate } from './meeting-templates'
import { buildMarksBlock } from './recognition-aids'
import type { MeetingSummaryResult } from './meeting-types'

const VALID_MEETING_JSON = JSON.stringify({
  tldr: '요약',
  key_points: [],
  decisions: [],
  action_items: [{ text: '보고서 작성', assignee: '홍길동' }],
  next_steps: []
})

function textMessages(text: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text }] } }
    yield { type: 'result', subtype: 'success', result: text }
  })()
}

const send = vi.fn()

beforeEach(() => {
  queryMock.mockReset()
  logActivityMock.mockReset()
  send.mockReset()
  runs.length = 0
  runArgs.length = 0
  meetingRow.value = { kind: 'meeting', title: '주간 회의' }
  marksRows.value = []
})

describe('runMeetingSummary 활동 기록', () => {
  it('성공하면 status 를 summarized 로 바꾼 뒤 logActivity 를 1번 호출한다', async () => {
    queryMock.mockReturnValue(textMessages(VALID_MEETING_JSON))
    const result = await runMeetingSummary(7, send)

    expect(result).toEqual({ success: true })
    expect(logActivityMock).toHaveBeenCalledTimes(1)
    expect(logActivityMock).toHaveBeenCalledWith('meeting', 'update', 7, '주간 회의', '요약 생성')
    expect(runs.some((sql) => sql.includes("status = 'summarized'"))).toBe(true)
  })

  it('면접(kind=interview) 요약 성공도 같은 경로로 logActivity 를 호출한다', async () => {
    meetingRow.value = { kind: 'interview', title: '면접' }
    queryMock.mockReturnValue(textMessages(JSON.stringify({ overview: '개요' })))
    const result = await runMeetingSummary(9, send)

    expect(result).toEqual({ success: true })
    expect(logActivityMock).toHaveBeenCalledTimes(1)
    expect(logActivityMock.mock.calls[0].slice(0, 3)).toEqual(['meeting', 'update', 9])
  })

  it('SDK 오류면 logActivity 를 호출하지 않는다', async () => {
    queryMock.mockImplementation(() => {
      throw new Error('boom')
    })
    const result = await runMeetingSummary(7, send)

    expect(result.success).toBe(false)
    expect(logActivityMock).not.toHaveBeenCalled()
    expect(runs).toEqual([])
  })

  it('JSON 파싱 실패면 logActivity 를 호출하지 않는다', async () => {
    queryMock.mockReturnValue(textMessages('JSON 이 아닙니다'))
    const result = await runMeetingSummary(7, send)

    expect(result.success).toBe(false)
    expect(logActivityMock).not.toHaveBeenCalled()
    expect(runs).toEqual([])
  })
})

describe('runMeetingSummary SDK 옵션', () => {
  it('tools [] 와 allowedTools [] 로 내장 도구를 끈다', async () => {
    queryMock.mockReturnValue(textMessages(VALID_MEETING_JSON))
    await runMeetingSummary(7, send)

    const { options } = queryMock.mock.calls[0][0]
    expect(options.tools).toEqual([])
    expect(options.allowedTools).toEqual([])
    expect(options.mcpServers).toEqual({})
    expect(options.settingSources).toEqual([])
  })
})

const validate = (raw: unknown): MeetingSummaryResult => MEETING_SPEC.validate(raw) as MeetingSummaryResult

describe('MEETING_SPEC.validate — 새 요약 스키마', () => {
  it('주제·결정·액션아이템·미결 질문의 시각을 ms 로 환산한다', () => {
    const r = validate({
      tldr: ' 결론 ',
      keywords: ['결제', '환불'],
      topics: [
        { title: '결제 개편', start: '00:12', points: ['카드부터', ' '] },
        { title: '환불', start: '[12:34]', points: ['수수료 논의'] }
      ],
      decisions: [{ text: '카드 결제부터', at: '01:35' }],
      action_items: [{ text: '견적 요청', assignee: '이영희', due: '다음 주', at: '1:02:03' }],
      open_questions: [{ text: '수수료 부담 주체', at: null }]
    })
    expect(r).toEqual({
      tldr: '결론',
      keywords: ['결제', '환불'],
      topics: [
        { title: '결제 개편', start_ms: 12000, points: ['카드부터'] },
        { title: '환불', start_ms: 754000, points: ['수수료 논의'] }
      ],
      decisions: [{ text: '카드 결제부터', at_ms: 95000 }],
      action_items: [{ text: '견적 요청', assignee: '이영희', due: '다음 주', at_ms: 3723000 }],
      open_questions: [{ text: '수수료 부담 주체', at_ms: null }],
      key_points: [],
      next_steps: []
    })
  })

  it('decisions·open_questions 의 문자열 배열(구버전 형식)을 받는다', () => {
    const r = validate({ decisions: ['금요일 배포', ''], open_questions: ['남은 쟁점'] })
    expect(r.decisions).toEqual([{ text: '금요일 배포', at_ms: null }])
    expect(r.open_questions).toEqual([{ text: '남은 쟁점', at_ms: null }])
  })

  it('구형식(key_points·next_steps 만 있는 응답)도 통과하고 새 필드는 빈 배열이 된다', () => {
    const r = validate({ tldr: '요약', key_points: ['포인트'], next_steps: ['다음'] })
    expect(r.key_points).toEqual(['포인트'])
    expect(r.next_steps).toEqual(['다음'])
    expect(r.topics).toEqual([])
    expect(r.keywords).toEqual([])
    expect(r.open_questions).toEqual([])
    expect(r.decisions).toEqual([])
    expect(r.action_items).toEqual([])
  })

  it('키워드는 앞 # 을 떼고 중복을 지우며 10개까지만 남긴다', () => {
    const r = validate({
      keywords: ['#결제', '결제', ' 환불 ', '', '##QA', ...Array.from({ length: 12 }, (_, i) => `k${i}`)]
    })
    expect(r.keywords.slice(0, 3)).toEqual(['결제', '환불', 'QA'])
    expect(r.keywords).toHaveLength(10)
    expect(new Set(r.keywords).size).toBe(10)
  })

  it('주제는 시각이 모두 있으면 오름차순으로, 하나라도 없으면 받은 순서로 둔다', () => {
    const sorted = validate({
      topics: [
        { title: 'B', start: '05:00' },
        { title: 'A', start: '01:00' }
      ]
    })
    expect(sorted.topics.map((t) => t.title)).toEqual(['A', 'B'])
    const kept = validate({
      topics: [
        { title: 'B', start: '05:00' },
        { title: 'A', start: null }
      ]
    })
    expect(kept.topics.map((t) => t.title)).toEqual(['B', 'A'])
  })

  it('주제 12개·포인트 8개 상한, 제목·본문이 빈 항목은 버린다', () => {
    const r = validate({
      topics: [
        { title: ' ', points: ['x'] },
        ...Array.from({ length: 14 }, (_, i) => ({ title: `T${i}`, points: Array.from({ length: 10 }, (_, j) => `p${j}`) }))
      ],
      decisions: [{ text: '  ', at: '00:01' }],
      action_items: [{ text: '' }, { text: '할 일', assignee: ' ', due: '' }]
    })
    expect(r.topics).toHaveLength(12)
    expect(r.topics[0].title).toBe('T0')
    expect(r.topics[0].points).toHaveLength(8)
    expect(r.decisions).toEqual([])
    expect(r.action_items).toEqual([{ text: '할 일', assignee: null, due: null, at_ms: null }])
  })

  it('필수 필드가 없는 항목은 거부한다', () => {
    expect(() => validate({ topics: [{ points: ['p'] }] })).toThrow()
    expect(() => validate({ decisions: [{ at: '00:01' }] })).toThrow()
  })
})

describe('MEETING_SPEC 프롬프트', () => {
  it('새 출력 키와 시각·화자 라벨 규칙을 담는다', () => {
    const p = MEETING_SPEC.systemPrompt
    for (const key of ['tldr', 'keywords', 'topics', 'decisions', 'action_items', 'open_questions']) {
      expect(p).toContain(key)
    }
    expect(p).toContain('기본 라벨')
    expect(p).toContain('"mm:ss"를 그대로 복사')
    expect(p).not.toContain('key_points')
    expect(p).not.toContain('next_steps')
  })

  it('buildPrompt 는 참고 정보가 있을 때만 앞에 붙인다', () => {
    expect(MEETING_SPEC.buildPrompt('T', '')).toBe('다음 회의 전사록을 분석해 JSON으로 요약하세요:\n\nT')
    expect(MEETING_SPEC.buildPrompt('T', '[참고 정보]')).toBe(
      '[참고 정보]\n\n다음 회의 전사록을 분석해 JSON으로 요약하세요:\n\nT'
    )
  })
})

describe('MEETING_SPEC.persist', () => {
  it('topics·open_questions·keywords 를 INSERT 와 ON CONFLICT 양쪽에 쓴다', () => {
    const calls: { sql: string; args: unknown[] }[] = []
    const db = {
      prepare: (sql: string) => ({
        run: (...args: unknown[]) => {
          calls.push({ sql, args })
          return { changes: 1 }
        }
      })
    }
    const parsed = validate({
      tldr: '요약',
      keywords: ['결제'],
      topics: [{ title: '주제', start: '00:10', points: ['p'] }],
      open_questions: [{ text: '쟁점', at: '00:20' }]
    })
    MEETING_SPEC.persist({ prepare: (sql: string) => ({ ...db.prepare(sql), get: () => undefined }) } as never, 3, parsed, 'm')
    const { sql, args } = calls[0]
    const [insertPart, updatePart] = sql.split('ON CONFLICT')
    for (const col of ['topics', 'open_questions', 'keywords']) {
      expect(insertPart).toContain(col)
      expect(updatePart).toContain(`${col} = excluded.${col}`)
    }
    expect(args).toContain(JSON.stringify(parsed.topics))
    expect(args).toContain(JSON.stringify(parsed.open_questions))
    expect(args).toContain(JSON.stringify(['결제']))
  })
})

describe('실측용 export (동작 고정)', () => {
  it('formatTranscriptLines 는 [mm:ss] 화자명: 발언 으로 직렬화하고 빈 발언을 뺀다', () => {
    expect(
      formatTranscriptLines([
        { start_ms: 65000, text: ' 안녕하세요 ', label: '화자 1', display_name: null },
        { start_ms: 70000, text: '  ', label: '화자 1', display_name: null },
        { start_ms: 4520000, text: '끝', label: null, display_name: '김철수' },
        { start_ms: 0, text: '라벨 없음', label: null, display_name: null }
      ])
    ).toEqual(['[01:05] 화자 1: 안녕하세요', '[75:20] 김철수: 끝', '[00:00] 화자: 라벨 없음'])
  })

  it('fitTranscript 는 한도 안이면 그대로 잇는다', () => {
    expect(fitTranscript(['a', 'b'])).toBe('a\nb')
  })

  it('extractJson 은 코드펜스와 앞뒤 잡음을 걷어낸다', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJson('결과: {"a":1} 끝')).toBe('{"a":1}')
  })
})


// ── 요약 형식(템플릿)·사용자 메모 (P1 #10, #11) ──

// 가짜 DB: 기존 요약 행(prev)을 get 으로 돌려주고 run 인자를 기록한다.
function persistDb(prev?: { action_items: string | null }): {
  db: never
  calls: { sql: string; args: unknown[] }[]
} {
  const calls: { sql: string; args: unknown[] }[] = []
  const db = {
    prepare: (sql: string) => ({
      get: () => (sql.includes('FROM meeting_summaries') ? prev : undefined),
      run: (...args: unknown[]) => {
        calls.push({ sql, args })
        return { changes: 1 }
      }
    })
  }
  return { db: db as never, calls }
}

describe('buildMeetingSpec', () => {
  it('기본 형식 프롬프트는 출력 키 블록을 그대로 담고, 출력 키는 meeting-templates 의 것을 다시 내보낸다', () => {
    expect(buildMeetingSpec(getTemplate('default')).systemPrompt).toContain(MEETING_OUTPUT_KEYS)
    expect(MEETING_OUTPUT_KEYS).toBe(TEMPLATE_OUTPUT_KEYS)
    expect(MEETING_SPEC.systemPrompt).toBe(buildMeetingSpec(getTemplate('default')).systemPrompt)
    expect(MEETING_SPEC.systemPrompt).not.toContain('[회의 형식]')
  })

  it('비기본 형식은 원칙 블록 뒤, 출력 키 앞에 [회의 형식] 블록을 넣는다', () => {
    const p = buildMeetingSpec(getTemplate('one_on_one')).systemPrompt
    const principles = p.indexOf('원칙\n')
    const block = p.indexOf('[회의 형식]')
    const keys = p.indexOf('출력 키\n')
    expect(principles).toBeGreaterThanOrEqual(0)
    expect(block).toBeGreaterThan(principles)
    expect(keys).toBeGreaterThan(block)
    expect(p).toContain('  - 이 회의 유형: 양쪽이 한 약속 모두')
    expect(p).toContain('\n\n[회의 형식]\n')
  })

  it('원칙 블록에 [사용자 메모] 지시를 담는다', () => {
    expect(MEETING_SPEC.systemPrompt).toContain(
      '[사용자 메모]는 사용자가 회의 중 중요하다고 표시한 지점입니다. 메모는 보통 발언보다 늦게 적히므로 각 메모 시각 앞 90초~뒤 10초의 전사를 먼저 보세요.'
    )
    expect(MEETING_SPEC.systemPrompt).toContain('시각은 메모 시각이 아니라 근거 전사 줄에서 복사하세요.')
  })

  it('persist 는 template_id 에 형식 id 를 INSERT·ON CONFLICT 양쪽으로 쓴다', () => {
    const parsed = validate({ tldr: '요약' })
    for (const id of ['default', 'standup'] as const) {
      const { db, calls } = persistDb()
      buildMeetingSpec(getTemplate(id)).persist(db, 3, parsed, 'm')
      const [insertPart, updatePart] = calls[0].sql.split('ON CONFLICT')
      expect(insertPart).toContain('template_id')
      expect(updatePart).toContain('template_id = excluded.template_id')
      expect(calls[0].args).toContain(id)
    }
  })

  it('persist 는 기존 행 action_items 의 todo_id 를 같은 문장의 새 항목으로 옮긴다', () => {
    const { db, calls } = persistDb({
      action_items: JSON.stringify([{ text: '보고서 작성!', todo_id: 41 }, { text: '다른 일', todo_id: null }])
    })
    const parsed = validate({ action_items: [{ text: '보고서 작성' }, { text: '새 일' }] })
    MEETING_SPEC.persist(db, 3, parsed, 'm')
    const saved = JSON.parse(calls[0].args[4] as string)
    expect(saved).toEqual([
      { text: '보고서 작성', assignee: null, due: null, at_ms: null, todo_id: 41 },
      { text: '새 일', assignee: null, due: null, at_ms: null }
    ])
  })
})

describe('carryTodoIds', () => {
  it('공백·문장부호·기호·대소문자 차이를 무시하고 todo_id 를 옮긴다', () => {
    const out = carryTodoIds([{ text: 'API 문서, 정리!', todo_id: 1 }], [{ text: 'api 문서 정리' }])
    expect(out).toEqual([{ text: 'api 문서 정리', todo_id: 1 }])
  })

  it('한 todo_id 는 한 번만 옮기고, 이미 todo_id 가 있는 항목은 그대로 둔다', () => {
    const out = carryTodoIds(
      [{ text: '배포', todo_id: 1 }],
      [{ text: '배포', todo_id: 9 }, { text: '배포' }, { text: '배포.' }]
    )
    expect(out).toEqual([{ text: '배포', todo_id: 9 }, { text: '배포', todo_id: 1 }, { text: '배포.' }])
  })

  it('정규화하면 빈 문자열인 항목은 매칭하지 않는다', () => {
    const out = carryTodoIds([{ text: '!!', todo_id: 1 }, { text: '', todo_id: 2 }], [{ text: '?' }, { text: '' }])
    expect(out).toEqual([{ text: '?' }, { text: '' }])
  })
})

describe('fitTranscript 고정 줄', () => {
  // 2,000줄 × 약 100자 = 약 200,000자 → 한도(80,000) 초과
  const lines = Array.from({ length: 2000 }, (_, i) => `[${i}] ${'가'.repeat(95)}`)
  const startMs = lines.map((_, i) => i * 1000)

  // 이전 구현(opts 없는 균등 샘플링)을 그대로 옮긴 기준값
  function legacy(ls: string[]): string {
    const full = ls.join('\n')
    if (full.length <= 80000) return full
    const avgLen = full.length / ls.length
    const targetLines = Math.max(1, Math.floor(80000 / avgLen))
    const step = ls.length / targetLines
    const sampled: string[] = []
    for (let i = 0; i < ls.length; i += step) sampled.push(ls[Math.floor(i)])
    return sampled.join('\n') + '\n\n(회의가 길어 시간 순서대로 균등 샘플링한 발췌본입니다 — 일부 발언은 생략됨)'
  }

  it('opts 가 없으면 이전 구현과 같은 결과다', () => {
    expect(fitTranscript(lines)).toBe(legacy(lines))
    expect(fitTranscript(['a', 'b'])).toBe(legacy(['a', 'b']))
  })

  it('keepRanges 에 시작하는 줄은 샘플링에서 빠지지 않고 원래 순서를 지킨다', () => {
    const out = fitTranscript(lines, { lineStartMs: startMs, keepRanges: [[1001_000, 1010_000]] })
    const kept = out.split('\n').filter((l) => l.startsWith('['))
    for (let i = 1001; i <= 1010; i++) expect(kept).toContain(lines[i])
    const idx = kept.map((l) => Number(l.slice(1, l.indexOf(']'))))
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
    expect(out.endsWith('일부 발언은 생략됨)')).toBe(true)
    expect(out.length).toBeLessThan(82000)
  })

  it('reserveChars 만큼 예산을 줄인다', () => {
    // 8줄 × 9,000자 + 줄바꿈 7 = 72,007자: 한도 안이지만 예산 70,000 을 넘는다
    const short = Array.from({ length: 8 }, () => 'x'.repeat(9000))
    expect(fitTranscript(short)).toBe(short.join('\n'))
    expect(fitTranscript(short, { reserveChars: 10000 })).not.toBe(short.join('\n'))
  })

  it('고정 줄 합이 예산을 넘으면 고정 없이 균등 샘플링으로 되돌아간다', () => {
    const out = fitTranscript(lines, { lineStartMs: startMs, keepRanges: [[0, 2_000_000]] })
    expect(out).toBe(legacy(lines))
  })
})

describe('formatTranscriptLinesWithMs · 메모 시각 표기', () => {
  it('formatTranscriptLines 와 같은 줄과 각 줄의 시작 시각을 돌려준다', () => {
    const segs = [
      { start_ms: 65000, text: ' 안녕 ', label: '화자 1', display_name: null },
      { start_ms: 70000, text: ' ', label: '화자 1', display_name: null },
      { start_ms: 4520999, text: '끝', label: null, display_name: '김철수' }
    ]
    const r = formatTranscriptLinesWithMs(segs)
    expect(r.lines).toEqual(formatTranscriptLines(segs))
    expect(r.startMs).toEqual([65000, 4520999])
  })

  it('buildMarksBlock 의 시각 표기는 전사 줄 표기와 같다', () => {
    for (const ms of [0, 999, 65000, 754_500, 4520999, 7_200_000]) {
      const transcript = formatTranscriptLines([{ start_ms: ms, text: 'x', label: 'A', display_name: null }])[0]
      const mark = buildMarksBlock([{ at_ms: ms, text: 'x' }]).split('\n')[1]
      expect(mark.slice(0, mark.indexOf(']') + 1)).toBe(transcript.slice(0, transcript.indexOf(']') + 1))
    }
  })
})

describe('runMeetingSummary 형식 선택·메모', () => {
  async function promptOf(): Promise<{ systemPrompt: string; prompt: string; templateArg: unknown }> {
    queryMock.mockReturnValue(textMessages(VALID_MEETING_JSON))
    await runMeetingSummary(7, send)
    const { prompt, options } = queryMock.mock.calls[0][0]
    const insertIdx = runs.findIndex((sql) => sql.includes('INSERT INTO meeting_summaries'))
    return { systemPrompt: options.systemPrompt as string, prompt, templateArg: runArgs[insertIdx]?.[10] }
  }

  it('summary_template 이 있으면 그 형식을 쓰고 template_id 로 남긴다', async () => {
    meetingRow.value = { kind: 'meeting', title: '주간 회의', summary_template: 'review' }
    const r = await promptOf()
    expect(r.systemPrompt).toContain('검토·회고 회의입니다.')
    expect(r.templateArg).toBe('review')
  })

  it('summary_template 이 없으면 제목으로 형식을 고른다', async () => {
    meetingRow.value = { kind: 'meeting', title: '데일리 스탠드업', summary_template: null }
    const r = await promptOf()
    expect(r.systemPrompt).toContain('스탠드업')
    expect(r.templateArg).toBe('standup')
  })

  it('명시 default 는 제목과 무관하게 기본 형식이다', async () => {
    meetingRow.value = { kind: 'meeting', title: '1:1 미팅', summary_template: 'default' }
    const r = await promptOf()
    expect(r.systemPrompt).not.toContain('[회의 형식]')
    expect(r.templateArg).toBe('default')
  })

  it('메모가 있으면 [사용자 메모] 블록을 전사록 앞에 붙인다', async () => {
    marksRows.value = [
      { at_ms: 5000, text: '중요' },
      { at_ms: 1000, text: '' }
    ]
    const r = await promptOf()
    expect(r.prompt.startsWith('[사용자 메모]\n[00:01] (북마크)\n[00:05] 중요\n\n다음 회의 전사록')).toBe(true)
  })

  it('면접도 같은 경로로 메모 블록을 붙인다', async () => {
    meetingRow.value = { kind: 'interview', title: '면접' }
    marksRows.value = [{ at_ms: 0, text: '질문 3' }]
    queryMock.mockReturnValue(textMessages(JSON.stringify({ overview: '개요' })))
    await runMeetingSummary(9, send)
    const { prompt } = queryMock.mock.calls[0][0]
    expect(prompt.startsWith('[사용자 메모]\n[00:00] 질문 3\n\n다음 면접 전사록')).toBe(true)
  })
})
