import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DailyPlan } from '../../types'
import BriefingCard, { briefingSummary } from './BriefingCard'

// 하루 브리핑 요약 (홈 2차 개편 V1·V2, 완료 조건 3).
// 예시 텍스트는 main 의 assistant-briefing.ts 가 만드는 형태를 따른다.
// 자동 클릭 검증은 불가하다. renderToStaticMarkup 으로 마크업을 본다

// renderRuleBriefing 형태: 산문 2문단 → '## 오늘 할 일 n건' + 표 → '## 챙길 것'
const RULE_BRIEFING = [
  '오늘은 회의가 2개 있어요. 오전에 1개, 오후에 1개예요.',
  '첫 집중 시간은 09:45 부터예요. 집중할 수 있는 시간은 모두 4시간 30분이에요.',
  '지금은 **PROJ-12 결제 API 리팩터링** 에 집중하시면 돼요.',
  '',
  '## 오늘 할 일 2건',
  '',
  '| 유형 | 묶음 | 작업 | 상태 | 마감 |',
  '|------|------|------|------|------|',
  '| 기능 | – | PROJ-12 결제 API 리팩터링 | 진행 중 | 11-04 |',
  '| 기타 | – | 문서 리뷰 | 예정 | 오늘 |',
  '',
  '## 챙길 것',
  '- 오늘 마감인 일이 1건 있어요: 문서 리뷰.'
].join('\n')

// briefingToMarkdown 형태: '## 오늘 방침' → LLM 인사 → 먼저 할 일 → 표
const LLM_BRIEFING = [
  '## 오늘 방침',
  '',
  '- 오전에는 QA 대응을 먼저 해요',
  '',
  '좋은 아침이에요. 오늘은 QA 1.4.0 이 진행 중이에요.',
  '',
  '**먼저 할 일**: PROJ-7 로그인 버그 — 배포 전에 막아야 해요',
  '',
  '## 오늘 할 일 1건',
  '',
  '| 유형 | 묶음 | 작업 | 상태 | 마감 |',
  '|------|------|------|------|------|',
  '| QA 1.4.0 | – | PROJ-7 로그인 버그 | 예정 | 오늘 |',
  ''
].join('\n')

// 예전 LLM 형식: 굵은 제목 줄 아래 표
const BOLD_HEADING_BRIEFING = [
  '오늘은 회의가 없어요.',
  '',
  '**오늘 할 일 5건**',
  '| 순위 | 할 일 |',
  '| --- | --- |',
  '| 1 | 결제 모듈 리팩토링 |',
  '',
  '집중 시간이 넉넉해요.'
].join('\n')

const plan = (over: Partial<DailyPlan> = {}): DailyPlan => ({
  id: 1,
  plan_date: '2026-11-02',
  status: 'active',
  started_at: '2026-11-02 09:40:00',
  closed_at: null,
  closed_by: null,
  source_snapshot: null,
  briefing_text: RULE_BRIEFING,
  briefing_source: 'rules',
  briefing_model: null,
  briefing_error: null,
  briefing_at: '2026-11-02 09:40:05',
  briefing_instruction: null,
  recovery_text: null,
  recovery_source: null,
  recovery_at: null,
  wrapup_note: null,
  wrapup_at: null,
  last_refresh_at: '2026-11-02 10:42:00',
  created_at: '2026-11-02 09:40:00',
  updated_at: '2026-11-02 09:40:00',
  ...over
})

const render = (p: DailyPlan, canRegenerate = false): string =>
  renderToStaticMarkup(
    <BriefingCard plan={p} canRegenerate={canRegenerate} busy={false} onRegenerate={() => undefined} />
  )

describe('briefingSummary (V2)', () => {
  it('규칙 브리핑: 앞 산문은 남고 표 줄과 오늘 할 일 절이 없다', () => {
    const s = briefingSummary(RULE_BRIEFING)
    expect(s).toContain('오늘은 회의가 2개 있어요. 오전에 1개, 오후에 1개예요.')
    expect(s).toContain('집중할 수 있는 시간은 모두 4시간 30분이에요.')
    // 굵게 기호는 지우고 글자만 남긴다
    expect(s).toContain('지금은 PROJ-12 결제 API 리팩터링 에 집중하시면 돼요.')
    expect(s).not.toContain('|')
    expect(s).not.toContain('오늘 할 일')
    expect(s).not.toContain('문서 리뷰 | 예정')
    expect(s).not.toContain('유형')
    expect(s).not.toContain('#')
    expect(s).not.toContain('**')
    // 할 일 절 뒤의 다른 절은 남는다. 제목 글자가 문단 첫 줄이고 목록 기호는 '· ' 다
    expect(s).toContain('챙길 것\n· 오늘 마감인 일이 1건 있어요: 문서 리뷰.')
  })

  it('규칙 브리핑: 문단은 빈 줄 1개로 나뉜다', () => {
    const s = briefingSummary(RULE_BRIEFING)
    expect(s.split('\n\n')).toEqual([
      [
        '오늘은 회의가 2개 있어요. 오전에 1개, 오후에 1개예요.',
        '첫 집중 시간은 09:45 부터예요. 집중할 수 있는 시간은 모두 4시간 30분이에요.',
        '지금은 PROJ-12 결제 API 리팩터링 에 집중하시면 돼요.'
      ].join('\n'),
      '챙길 것\n· 오늘 마감인 일이 1건 있어요: 문서 리뷰.'
    ])
  })

  it('오늘 방침 절: 방침 산문은 남고 표·할 일 절은 없다', () => {
    const s = briefingSummary(LLM_BRIEFING)
    expect(s.split('\n\n')).toEqual([
      '오늘 방침\n· 오전에는 QA 대응을 먼저 해요',
      '좋은 아침이에요. 오늘은 QA 1.4.0 이 진행 중이에요.',
      '먼저 할 일: PROJ-7 로그인 버그 — 배포 전에 막아야 해요'
    ])
    expect(s).not.toContain('#')
    expect(s).not.toContain('|')
    expect(s).not.toContain('오늘 할 일')
  })

  it("굵은 제목 줄 '**오늘 할 일 5건**' 절도 다음 제목 전까지 뺀다", () => {
    const s = briefingSummary(BOLD_HEADING_BRIEFING)
    expect(s).toBe('오늘은 회의가 없어요.')
    expect(s).not.toContain('결제 모듈 리팩토링')
  })

  it('빈 입력과 표·할 일 절뿐인 입력은 빈 문자열이다', () => {
    expect(briefingSummary('')).toBe('')
    expect(briefingSummary('\n\n')).toBe('')
    expect(briefingSummary('## 오늘 할 일\n\n계획 항목이 없어요.\n')).toBe('')
    expect(briefingSummary('| a | b |\n| --- | --- |')).toBe('')
  })

  it('이스케이프·링크를 글자로 풀고 본문 없는 제목은 버린다', () => {
    expect(briefingSummary('\\- 외부 문장\\*')).toBe('- 외부 문장*')
    expect(briefingSummary('[PROJ-1](linkwork://project/3) 부터 해요')).toBe('PROJ-1 부터 해요')
    expect(briefingSummary('인사\n\n## 챙길 것\n')).toBe('인사')
  })
})

describe('BriefingCard 요약 블록 (V1)', () => {
  it('요약 문단만 보인다. 표·할 일 절·전체 보기가 없다', () => {
    const html = render(plan(), true)
    expect(html).toContain('id="today-briefing"')
    expect(html).toContain('>브리핑<')
    expect(html).toContain('규칙 브리핑')
    expect(html).toContain('09:40')
    expect(html).toContain('다시 생성')
    expect(html).toContain('text-base text-gray-700')
    expect(html).toContain('오늘은 회의가 2개 있어요.')
    expect(html).not.toContain('<table')
    expect(html).not.toContain('문서 리뷰 | 예정')
    expect(html).not.toContain('11-04')
    expect(html).not.toContain('전체 보기')
    expect(html).not.toContain('aria-expanded')
  })

  it('Card 래퍼가 없다. DayHeader 안에 들어간다', () => {
    const html = render(plan())
    expect(html.startsWith('<div id="today-briefing">')).toBe(true)
    expect(html).not.toContain('bg-white border border-gray-200 rounded-lg')
  })

  it('다시 생성: 다시 만들 수 없고 오류도 없으면 숨기고, 오류가 있으면 사유와 함께 보인다', () => {
    expect(render(plan())).not.toContain('다시 생성')
    const html = render(plan({ briefing_error: 'Claude Code 로그인이 필요합니다.' }))
    expect(html).toContain('다시 생성')
    expect(html).toContain('Claude Code 로그인이 필요합니다.')
  })

  it('요약이 빈 문자열이면 아무것도 그리지 않는다', () => {
    expect(render(plan({ briefing_text: null }))).toBe('')
    expect(render(plan({ briefing_text: '## 오늘 할 일\n\n| a | b |' }))).toBe('')
  })
})
