import { describe, expect, it } from 'vitest'
import {
  buildMeetingNoteMarkdown,
  countActionItems,
  escapeLike,
  formatClock,
  type NoteDetail,
  type NoteSummary
} from './meeting-notes'

const emptySummary: NoteSummary = {
  tldr: null,
  key_points: [],
  decisions: [],
  action_items: [],
  next_steps: [],
  qa_pairs: [],
  competencies: [],
  follow_ups: [],
  fact_checks: []
}

const base: Omit<NoteDetail, 'meeting' | 'summary'> = {
  speakers: [
    { id: 1, label: 'SPEAKER_00', display_name: '김철수' },
    { id: 2, label: 'SPEAKER_01', display_name: null }
  ],
  segments: [
    { start_ms: 5000, speaker_id: 1, text: '시작합니다' },
    { start_ms: 65000, speaker_id: 2, text: '네 좋습니다' }
  ],
  attendees: [{ name: '김철수' }, { name: '이영희' }]
}

describe('buildMeetingNoteMarkdown — 회의', () => {
  const md = buildMeetingNoteMarkdown({
    ...base,
    projectName: '결제 개편',
    meeting: { title: '주간 회의', kind: 'meeting', started_at: '2026-10-01 10:00:00', duration_ms: 1800000 },
    summary: {
      ...emptySummary,
      tldr: '배포 일정 확정',
      key_points: ['QA 완료'],
      decisions: ['금요일 배포'],
      action_items: [
        { text: '릴리즈 노트 작성', assignee: '김철수', due: '2026-10-03' },
        { text: '공지', todo_id: 7 }
      ]
    }
  })

  it('제목·메타·섹션을 만든다', () => {
    expect(md.startsWith('# 주간 회의\n')).toBe(true)
    expect(md).toContain('참석자: 김철수, 이영희')
    expect(md).toContain('프로젝트: 결제 개편')
    expect(md).toContain('길이: 30분')
    for (const h of ['## TL;DR', '## 핵심 포인트', '## 결정사항', '## 액션아이템', '## 전사']) {
      expect(md).toContain(h)
    }
  })

  it('액션아이템 체크박스는 todo_id 유무로 갈린다', () => {
    expect(md).toContain('- [ ] 릴리즈 노트 작성 (담당: 김철수, 기한: 2026-10-03)')
    expect(md).toContain('- [x] 공지')
  })

  it('빈 섹션과 면접 섹션은 생략한다', () => {
    expect(md).not.toContain('## 다음 단계')
    expect(md).not.toContain('## 질문과 답변')
  })

  it('전사는 시간과 화자명을 붙인다', () => {
    expect(md).toContain('[00:05] **김철수**: 시작합니다')
    expect(md).toContain('[01:05] **SPEAKER_01**: 네 좋습니다')
  })
})

describe('buildMeetingNoteMarkdown — 면접', () => {
  const md = buildMeetingNoteMarkdown({
    ...base,
    meeting: { title: '백엔드 면접', kind: 'interview', started_at: '2026-10-02 14:00:00', duration_ms: 3600000 },
    summary: {
      ...emptySummary,
      tldr: '경력 5년 지원자',
      qa_pairs: [
        { question: '최근 프로젝트는?', answer_summary: '결제 시스템 개발', start_ms: 90000, quote: '제가 리드했습니다' }
      ],
      competencies: [{ topic: '문제 해결', evidence: ['장애 대응 경험'], note: null }],
      fact_checks: ['재직 기간 확인']
    }
  })

  it('면접 섹션을 만들고 빈 섹션은 생략한다', () => {
    expect(md).toContain('## 면접 개요')
    expect(md).toContain('### Q1. 최근 프로젝트는? [01:30]')
    expect(md).toContain('> 제가 리드했습니다')
    expect(md).toContain('## 역량별 근거')
    expect(md).toContain('  - 장애 대응 경험')
    expect(md).toContain('## 확인 필요')
    expect(md).toContain('종류: 면접')
    expect(md).toContain('길이: 1시간 0분')
    expect(md).not.toContain('## 후속 질문')
    expect(md).not.toContain('## TL;DR')
    expect(md).not.toContain('## 액션아이템')
    expect(md).not.toContain('프로젝트:')
  })
})

describe('헬퍼', () => {
  it('요약이 없으면 전사만 남는다', () => {
    const md = buildMeetingNoteMarkdown({
      ...base,
      segments: [],
      attendees: [],
      meeting: { title: 'x', kind: 'meeting', started_at: 't', duration_ms: 0 },
      summary: null
    })
    expect(md).not.toContain('##')
    expect(md).not.toContain('참석자')
  })

  it('countActionItems', () => {
    expect(countActionItems(JSON.stringify([{ text: 'a' }, { text: 'b', todo_id: 3 }]))).toEqual({ total: 2, open: 1 })
    expect(countActionItems(null)).toEqual({ total: 0, open: 0 })
    expect(countActionItems('not json')).toEqual({ total: 0, open: 0 })
  })

  it('escapeLike', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b')
  })

  it('formatClock', () => {
    expect(formatClock(3725000)).toBe('1:02:05')
  })
})
