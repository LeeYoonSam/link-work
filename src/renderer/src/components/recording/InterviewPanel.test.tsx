import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import InterviewPanel from './InterviewPanel'
import type { MeetingSummary } from '../../types'

// 면접 기록 패널이 회의 요약 필드가 아니라 면접 4분류를 그리는지 고정한다.
// (요약 스키마를 종류별로 분기했기 때문에, 한쪽 필드만 채워진 데이터가 흔하다.)

const EMPTY: Omit<MeetingSummary, 'id' | 'meeting_id'> = {
  tldr: null,
  key_points: [],
  decisions: [],
  action_items: [],
  next_steps: [],
  qa_pairs: [],
  competencies: [],
  follow_ups: [],
  fact_checks: [],
  model: 'claude-sonnet-5',
  generated_at: '2026-07-22 10:00:00'
}

const INTERVIEW_SUMMARY: MeetingSummary = {
  id: 1,
  meeting_id: 42,
  ...EMPTY,
  tldr: '정산 파이프라인 경험과 협업 방식을 다뤘다.',
  qa_pairs: [
    {
      question: '가장 어려웠던 문제가 뭐였나요?',
      answer_summary: '배치가 6시간 걸리던 문제를 40분대로 줄였다고 답함.',
      start_ms: 82000,
      quote: '파티셔닝하고 증분 처리로 바꿨습니다.'
    },
    {
      // 타임스탬프를 못 얻은 항목 — 재생 버튼 없이도 렌더돼야 한다
      question: '팀 충돌은 어떻게 푸셨나요?',
      answer_summary: '프로토타입 벤치마크로 결정했다고 답함.',
      start_ms: null,
      quote: null
    }
  ],
  competencies: [{ topic: '성능 개선 경험', evidence: ['풀스캔을 파티셔닝으로 바꿨습니다'], note: '수치 미언급' }],
  follow_ups: ['트래픽 규모 정확한 수치 확인 필요'],
  fact_checks: ['5년차 경력 여부']
}

describe('InterviewPanel', () => {
  const html = renderToStaticMarkup(
    <InterviewPanel summary={INTERVIEW_SUMMARY} meetingId={42} onSeek={() => {}} />
  )

  it('개요·질문·답변·근거·확인항목을 모두 렌더한다', () => {
    expect(html).toContain('정산 파이프라인 경험과 협업 방식을 다뤘다.')
    expect(html).toContain('가장 어려웠던 문제가 뭐였나요?')
    expect(html).toContain('배치가 6시간 걸리던 문제를 40분대로 줄였다고 답함.')
    expect(html).toContain('파티셔닝하고 증분 처리로 바꿨습니다.')
    expect(html).toContain('성능 개선 경험')
    expect(html).toContain('트래픽 규모 정확한 수치 확인 필요')
    expect(html).toContain('5년차 경력 여부')
  })

  it('질문 수를 섹션 제목에 표시한다', () => {
    expect(html).toContain('질문 · 답변 (2)')
  })

  it('start_ms가 있는 질문에만 재생 시점 버튼을 붙인다', () => {
    // 82000ms → 1:22 (mm:ss)
    expect(html).toContain('1:22')
    // 재생 버튼은 타임스탬프가 있는 1건뿐
    expect(html.match(/이 질문 시점부터 듣기/g)).toHaveLength(1)
  })

  it('판정 도구가 아니라는 고지를 항상 노출한다', () => {
    expect(html).toContain('답변 확인용 보조 자료')
  })

  it('면접 4분류가 비어 있으면 정리 시작 화면을 보여준다', () => {
    const empty = renderToStaticMarkup(
      <InterviewPanel summary={{ id: 2, meeting_id: 43, ...EMPTY }} meetingId={43} />
    )
    expect(empty).toContain('면접 기록 정리')
    expect(empty).not.toContain('질문 · 답변')
  })

  it('회의 요약 필드만 채워진 데이터로는 면접 내용을 그리지 않는다', () => {
    const meetingOnly = renderToStaticMarkup(
      <InterviewPanel
        summary={{
          id: 3,
          meeting_id: 44,
          ...EMPTY,
          decisions: ['결정A'],
          next_steps: ['다음단계B'],
          action_items: [{ text: '액션C' }]
        }}
        meetingId={44}
      />
    )
    expect(meetingOnly).not.toContain('결정A')
    expect(meetingOnly).not.toContain('다음단계B')
    expect(meetingOnly).not.toContain('액션C')
    expect(meetingOnly).toContain('면접 기록 정리')
  })
})
