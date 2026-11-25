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

vi.mock('./recognition-aids', () => ({
  loadPromptContext: () => ({}),
  buildSummaryContextBlock: () => ''
}))

// SQL 문자열로 분기하는 가짜 DB. 실행한 쓰기 SQL 을 기록한다.
const meetingRow = { value: { kind: 'meeting', title: '주간 회의' } as { kind: string; title: string } | undefined }
const runs: string[] = []
const fakeDb = {
  prepare: (sql: string) => ({
    get: () => (sql.includes('FROM meetings') ? meetingRow.value : undefined),
    all: () =>
      sql.includes('meeting_segments')
        ? [{ start_ms: 0, end_ms: 1000, text: '다음 주까지 보고서 작성', label: 'S1', display_name: '홍길동' }]
        : [],
    run: () => {
      runs.push(sql)
      return { changes: 1 }
    }
  })
}
vi.mock('../db/database', () => ({ getDatabase: () => fakeDb }))

import {
  MEETING_SPEC,
  extractJson,
  fitTranscript,
  formatTranscriptLines,
  runMeetingSummary
} from './meeting-summary'
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
  meetingRow.value = { kind: 'meeting', title: '주간 회의' }
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
    MEETING_SPEC.persist(db as never, 3, parsed, 'm')
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
