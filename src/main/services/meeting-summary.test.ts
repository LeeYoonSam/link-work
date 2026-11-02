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

import { runMeetingSummary } from './meeting-summary'

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
