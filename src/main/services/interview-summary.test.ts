import { describe, it, expect } from 'vitest'
import { INTERVIEW_SPEC } from './interview-summary'
import type { InterviewSummaryResult } from './meeting-types'

// AI가 돌려주는 "mm:ss" 표기를 재생 위치(ms)로 환산하는 경로를 고정한다.
// 이 변환이 깨지면 면접 기록의 "이 질문부터 듣기" 버튼이 조용히 사라진다.
const validate = (raw: unknown): InterviewSummaryResult =>
  INTERVIEW_SPEC.validate(raw) as InterviewSummaryResult

describe('INTERVIEW_SPEC.validate', () => {
  it('mm:ss 타임스탬프를 ms로 환산한다', () => {
    const r = validate({
      overview: '개요',
      qa_pairs: [
        { question: 'Q1', answer_summary: 'A1', at: '00:03' },
        { question: 'Q2', answer_summary: 'A2', at: '01:22' },
        // 1시간을 넘는 면접은 분이 60을 넘어간다 (전사 직렬화의 formatTime과 동일 규약)
        { question: 'Q3', answer_summary: 'A3', at: '75:20' }
      ]
    })
    expect(r.qa_pairs.map((q) => q.start_ms)).toEqual([3000, 82000, 4520000])
  })

  it('타임스탬프가 없거나 형식이 어긋나면 null로 둔다', () => {
    const r = validate({
      qa_pairs: [
        { question: 'Q1', answer_summary: '', at: null },
        { question: 'Q2', answer_summary: '' },
        { question: 'Q3', answer_summary: '', at: '3분 12초' },
        { question: 'Q4', answer_summary: '', at: '00:75' }
      ]
    })
    expect(r.qa_pairs.map((q) => q.start_ms)).toEqual([null, null, null, null])
  })

  it('누락된 배열 키를 빈 배열로 채운다', () => {
    const r = validate({ overview: '개요만 있음' })
    expect(r).toEqual({
      overview: '개요만 있음',
      qa_pairs: [],
      competencies: [],
      follow_ups: [],
      fact_checks: []
    })
  })

  it('nullish 선택 필드를 null로 정규화한다', () => {
    const r = validate({
      qa_pairs: [{ question: 'Q', answer_summary: 'A' }],
      competencies: [{ topic: 'T', evidence: ['근거'] }]
    })
    expect(r.qa_pairs[0].quote).toBeNull()
    expect(r.competencies[0].note).toBeNull()
  })

  it('필수 필드가 없는 응답은 거부한다', () => {
    // question 없는 qa_pair → zod가 throw → 호출측이 "파싱 실패"로 처리
    expect(() => validate({ qa_pairs: [{ answer_summary: 'A' }] })).toThrow()
  })
})
