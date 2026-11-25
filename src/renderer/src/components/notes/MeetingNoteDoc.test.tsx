import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// 회의록 문서의 '할 일로 만들기' 버튼과 미리 채울 값을 고정한다.
// 클릭은 정적 렌더로 누를 수 없어 버튼이 부르는 openMeetingTodo 를 직접 부른다.
// zustand v5 는 서버 렌더에서 초기 상태를 돌려주므로 회의록 스토어 훅을 모킹한다(MeetingNoteList.test 와 같은 방식)

const detail = vi.hoisted(() => ({
  meeting: { id: 5, title: '주간 회의', kind: 'meeting', started_at: '2026-11-20 10:00:00', duration_ms: 60000 },
  summary: null as unknown,
  speakers: [],
  segments: [],
  attendees: []
}))
vi.mock('../../stores/meetingNotesStore', () => ({
  useMeetingNotesStore: () => ({ detail, selectedId: 5 })
}))

const { default: MeetingNoteDoc, openMeetingTodo } = await import('./MeetingNoteDoc')
const { useQuickAddStore } = await import('../../stores/quickAddStore')

afterEach(() => {
  useQuickAddStore.getState().close()
})

describe('MeetingNoteDoc 할 일로 만들기', () => {
  it('행동 버튼 줄에 버튼을 그린다', () => {
    const html = renderToStaticMarkup(<MeetingNoteDoc />)
    expect(html).toContain('>할 일로 만들기</button>')
    expect(html.indexOf('녹음에서 열기')).toBeLessThan(html.indexOf('할 일로 만들기'))
  })

  it('누르면 "회의 제목 후속" 과 회의록 링크로 빠른 추가를 연다', () => {
    openMeetingTodo({ id: 5, title: '주간 회의' })
    expect(useQuickAddStore.getState()).toMatchObject({
      isOpen: true,
      initialText: '주간 회의 후속',
      sourceLink: 'linkwork://note/5'
    })
  })
})

const BASE = {
  id: 1,
  meeting_id: 5,
  tldr: null,
  keywords: [],
  topics: [],
  key_points: [],
  decisions: [],
  action_items: [],
  open_questions: [],
  next_steps: [],
  qa_pairs: [],
  competencies: [],
  follow_ups: [],
  fact_checks: [],
  model: null,
  generated_at: '2026-11-20 11:00:00'
}

describe('MeetingNoteDoc 요약 섹션', () => {
  afterEach(() => {
    detail.summary = null
  })

  it('새 요약은 키워드 → TL;DR → 결정사항 → 액션아이템 → 미결 질문 → 주제별 요약 순으로 그리고 시각을 mm:ss로 붙인다', () => {
    detail.summary = {
      ...BASE,
      tldr: '배포 일정을 확정했다.',
      keywords: ['배포', 'QA'],
      topics: [{ title: '배포 일정', start_ms: 65000, points: ['금요일 배포 제안'] }],
      decisions: [{ text: '금요일에 배포한다', at_ms: 754000 }],
      action_items: [{ text: '릴리스 노트 작성', assignee: '김철수', due: null, at_ms: 125000 }],
      open_questions: [{ text: '핫픽스 담당', at_ms: null }]
    }
    const html = renderToStaticMarkup(<MeetingNoteDoc />)
    const order = ['키워드', 'TL;DR', '결정사항', '액션아이템', '미결 질문', '주제별 요약'].map((t) =>
      html.indexOf(`>${t}</h2>`)
    )
    order.forEach((idx) => expect(idx).toBeGreaterThanOrEqual(0))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).toContain('배포 · QA')
    expect(html).toContain('금요일에 배포한다')
    expect(html).toContain('12:34')
    expect(html).toContain('02:05')
    expect(html).toContain('01:05')
    expect(html).toContain('금요일 배포 제안')
    expect(html).not.toContain('>핵심 포인트</h2>')
    expect(html).not.toContain('>다음 단계</h2>')
  })

  it('구버전 요약은 핵심 포인트·다음 단계를 그리고 주제별 요약은 그리지 않는다', () => {
    detail.summary = {
      ...BASE,
      tldr: '예전 요약',
      key_points: ['핵심 A'],
      decisions: [{ text: '결정 B', at_ms: null }],
      action_items: [{ text: '액션 C', assignee: '이영희', due: '2026-11-30', todo_id: 3 }],
      next_steps: ['다음 D']
    }
    const html = renderToStaticMarkup(<MeetingNoteDoc />)
    for (const t of ['예전 요약', '핵심 A', '결정 B', '액션 C', '이영희 · 2026-11-30', '다음 D', '☑']) {
      expect(html).toContain(t)
    }
    expect(html).not.toContain('>주제별 요약</h2>')
    expect(html).not.toContain('>키워드</h2>')
    expect(html).not.toContain('>미결 질문</h2>')
    expect(html.indexOf('>핵심 포인트</h2>')).toBeLessThan(html.indexOf('>결정사항</h2>'))
    expect(html.indexOf('>액션아이템</h2>')).toBeLessThan(html.indexOf('>다음 단계</h2>'))
  })
})
