import { describe, expect, it, vi } from 'vitest'

// ai-agent.ts·meeting-summary.ts 는 electron 과 DB 모듈을 top-level 에서 import 한다.
// 프롬프트 문자열만 검사하므로, Electron 런타임 없이 돌도록 두 모듈을 모듈 경계에서 막는다.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../db/database', () => ({
  getDatabase: () => {
    throw new Error('테스트에서 DB 를 쓰지 않는다')
  },
  getAiReadOnlyDatabase: () => {
    throw new Error('테스트에서 DB 를 쓰지 않는다')
  }
}))

// 비서 프롬프트 검사용이다. 헤드리스 실행을 모듈 경계에서 막는다.
vi.mock('./ai-headless', () => ({ runHeadlessJson: vi.fn() }))

import { buildSystemPrompt } from './ai-agent'
import { BRIEFING_SYSTEM_PROMPT, MEETING_SYSTEM_PROMPT, RECOVERY_SYSTEM_PROMPT } from './assistant-briefing'
import { INTERVIEW_SPEC } from './interview-summary'
import { MEETING_SPEC } from './meeting-summary'
import {
  ASSISTANT_SPEECH_JSON_NOTE,
  ASSISTANT_SPEECH_RULES,
  WRITING_STYLE_JSON_NOTE,
  WRITING_STYLE_RULES
} from './writing-style'

const JSON_ONLY_LAST_LINE = '코드펜스 없이 순수 JSON만 출력하세요.'

describe('WRITING_STYLE_RULES', () => {
  it('ASD-STE100 핵심 규칙을 포함한다', () => {
    for (const phrase of ['ASD-STE100', '한 문장에 한 가지', '이중 부정', '아라비아 숫자']) {
      expect(WRITING_STYLE_RULES).toContain(phrase)
    }
  })
})

// JSON 요약 프롬프트는 "순수 JSON만 출력" 문장이 마지막에 있어야 파싱이 안정적이다.
describe.each([
  ['INTERVIEW_SPEC', INTERVIEW_SPEC.systemPrompt],
  ['MEETING_SPEC', MEETING_SPEC.systemPrompt]
])('%s.systemPrompt', (_name, prompt) => {
  it('공통 글쓰기 규칙과 JSON 보조 안내를 포함한다', () => {
    expect(prompt).toContain(WRITING_STYLE_RULES)
    expect(prompt).toContain(WRITING_STYLE_JSON_NOTE)
  })

  it('"순수 JSON만 출력" 문장으로 끝난다', () => {
    expect(prompt.trim().endsWith(JSON_ONLY_LAST_LINE)).toBe(true)
  })
})

describe('INTERVIEW_SPEC.systemPrompt 평가 금지 유지', () => {
  it('평가 금지 규칙이 글쓰기 규칙보다 앞에 남아 있다', () => {
    const prompt = INTERVIEW_SPEC.systemPrompt
    const banIdx = prompt.indexOf('합격/불합격 의견')
    expect(banIdx).toBeGreaterThan(-1)
    expect(banIdx).toBeLessThan(prompt.indexOf(WRITING_STYLE_RULES))
  })

  // 글쓰기 규칙이 원문 인용을 명령형·능동태로 바꿔 쓰지 않게 한다.
  it('인용 필드 3개를 글쓰기 규칙 적용 대상에서 제외한다', () => {
    expect(INTERVIEW_SPEC.systemPrompt).toContain(
      'question, quote, evidence 는 발언 원문을 유지하는 필드다. 이 3개 필드에는 글쓰기 규칙을 적용하지 않는다.'
    )
  })
})

describe('buildSystemPrompt', () => {
  it.each([
    ['ask', false, false],
    ['readonly', true, true],
    ['plan', false, true]
  ] as const)(
    'writeMode=%s, notion=%s, bitbucket=%s 결과가 공통 글쓰기 규칙을 포함한다',
    (mode, notion, bitbucket) => {
      expect(buildSystemPrompt(mode, notion, bitbucket)).toContain(WRITING_STYLE_RULES)
    }
  )
})

// ── 비서 말투 규칙 (부록 J.7) ──

describe('ASSISTANT_SPEECH_RULES', () => {
  it('A52: 해요체·권유 형태·금지 문구·데이터 밖 사실 금지를 포함한다', () => {
    for (const phrase of [
      '## 비서 말투 규칙',
      '해요체로 쓴다.',
      '"~하시면 돼요", "~해 주세요"',
      '"!" 를 쓰지 않는다.',
      '아라비아 숫자',
      '[데이터] 에 없는 사실·숫자·이름을 만들지 않는다.'
    ]) {
      expect(ASSISTANT_SPEECH_RULES).toContain(phrase)
    }
    expect(ASSISTANT_SPEECH_JSON_NOTE).toContain('위 말투 규칙')
  })

  it('A52: 비서 프롬프트 3개는 말투 규칙을 쓰고 글쓰기 규칙을 쓰지 않는다', () => {
    for (const prompt of [BRIEFING_SYSTEM_PROMPT, RECOVERY_SYSTEM_PROMPT, MEETING_SYSTEM_PROMPT]) {
      expect(prompt).toContain(ASSISTANT_SPEECH_RULES)
      expect(prompt).toContain(ASSISTANT_SPEECH_JSON_NOTE)
      expect(prompt).not.toContain(WRITING_STYLE_RULES)
    }
  })

  it('A52: 기존 글쓰기 규칙은 말투 규칙과 섞이지 않는다', () => {
    expect(WRITING_STYLE_RULES).not.toContain('해요체')
    expect(ASSISTANT_SPEECH_RULES).not.toContain('ASD-STE100')
  })
})
