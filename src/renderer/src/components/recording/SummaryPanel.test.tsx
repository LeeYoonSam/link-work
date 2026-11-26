import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MeetingDetail, MeetingMark, MeetingSummary } from '../../types'

// 테스트마다 열려 있는 회의 상세(형식·메모)를 바꿔 끼운다
const storeState: { current: Pick<MeetingDetail, 'meeting' | 'marks'> | null } = { current: null }

// zustand v5는 서버 렌더에서 초기 상태를 돌려주므로 스토어 훅 자체를 모킹한다
// (notes/MeetingNoteList.test.tsx와 같은 방식).
vi.mock('../../stores/recordingStore', () => ({
  useRecordingStore: () => ({
    current: storeState.current,
    processing: {},
    summarizeMeeting: async () => {},
    actionItemToTodo: async () => {},
    refreshCurrent: async () => {},
    setSummaryTemplate: async () => true,
    addMark: async () => 1,
    updateMark: async () => true,
    deleteMark: async () => true
  })
}))
vi.mock('../../stores/meetingNotesStore', () => ({
  useMeetingNotesStore: Object.assign(() => ({}), { getState: () => ({ select: () => {} }) })
}))
vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: Object.assign(() => ({}), { getState: () => ({ setView: () => {} }) })
}))

const SummaryPanel = (await import('./SummaryPanel')).default

const summary: MeetingSummary = {
  id: 1,
  meeting_id: 7,
  tldr: '주간 회의 요약',
  keywords: [],
  topics: [],
  key_points: ['핵심 1'],
  decisions: [],
  action_items: [],
  open_questions: [],
  next_steps: [],
  qa_pairs: [],
  competencies: [],
  follow_ups: [],
  fact_checks: [],
  model: 'claude-opus-5-5',
  generated_at: '2026-10-23 10:00:00'
}

// 클릭 동작은 헤드리스 렌더로 검증할 수 없으므로 버튼 존재와 라벨만 확인한다.
describe('SummaryPanel 복사 버튼', () => {
  it('요약이 있고 처리 중이 아니면 내용 복사와 회의록으로 보기를 그린다', () => {
    const html = renderToStaticMarkup(<SummaryPanel summary={summary} meetingId={7} />)
    expect(html).toContain('내용 복사')
    expect(html).toContain('회의록으로 보기')
    // 내용 복사가 회의록으로 보기 왼쪽에 온다
    expect(html.indexOf('내용 복사')).toBeLessThan(html.indexOf('회의록으로 보기'))
  })

  it('요약이 없으면 내용 복사를 그리지 않는다', () => {
    const html = renderToStaticMarkup(<SummaryPanel summary={null} meetingId={7} />)
    expect(html).not.toContain('내용 복사')
    expect(html).toContain('AI 요약 생성')
  })
})

const newSummary: MeetingSummary = {
  ...summary,
  tldr: '배포 일정을 확정했다.',
  keywords: ['배포', '릴리스 노트'],
  topics: [
    { title: '배포 일정', start_ms: 65000, points: ['금요일 배포 제안', 'QA 일정 확인'] },
    { title: '기타 논의', start_ms: null, points: ['회식 장소'] }
  ],
  key_points: [],
  decisions: [{ text: '금요일에 배포한다', at_ms: 754000 }],
  action_items: [{ text: '릴리스 노트 작성', assignee: '김철수', due: null, at_ms: 125000 }],
  open_questions: [{ text: '핫픽스 브랜치를 누가 관리하나', at_ms: null }],
  next_steps: []
}

describe('SummaryPanel 새 요약 형식', () => {
  it('키워드 → TL;DR → 결정사항 → 액션아이템 → 미결 질문 → 주제별 요약 순으로 그린다', () => {
    const html = renderToStaticMarkup(<SummaryPanel summary={newSummary} meetingId={7} onSeek={() => {}} />)
    const order = ['키워드', 'TL;DR', '결정사항', '액션아이템', '미결 질문', '주제별 요약'].map((t) =>
      html.indexOf(`>${t}<`)
    )
    order.forEach((idx) => expect(idx).toBeGreaterThanOrEqual(0))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).toContain('배포')
    expect(html).toContain('릴리스 노트')
    expect(html).toContain('금요일에 배포한다')
    expect(html).toContain('핫픽스 브랜치를 누가 관리하나')
    expect(html).toContain('배포 일정')
    expect(html).toContain('QA 일정 확인')
    expect(html).not.toContain('>핵심 포인트<')
    expect(html).not.toContain('>다음 단계<')
  })

  it('시각이 있고 onSeek가 있으면 시각 버튼을 m:ss로 그린다', () => {
    const html = renderToStaticMarkup(<SummaryPanel summary={newSummary} meetingId={7} onSeek={() => {}} />)
    expect(html).toContain('title="이 시점부터 듣기"')
    // 주제 1:05, 결정 12:34, 액션 2:05 — 시각 null인 주제·미결 질문은 버튼 없음
    expect(html.match(/title="이 시점부터 듣기"/g)).toHaveLength(3)
    expect(html).toContain('1:05')
    expect(html).toContain('12:34')
    expect(html).toContain('2:05')
  })

  it('onSeek가 없으면 시각 버튼을 그리지 않는다', () => {
    const html = renderToStaticMarkup(<SummaryPanel summary={newSummary} meetingId={7} />)
    expect(html).not.toContain('이 시점부터 듣기')
    expect(html).not.toContain('12:34')
  })
})

describe('SummaryPanel 구버전 요약', () => {
  const legacy: MeetingSummary = {
    ...summary,
    tldr: '예전 요약',
    key_points: ['핵심 A'],
    decisions: [{ text: '결정 B', at_ms: null }],
    action_items: [{ text: '액션 C', assignee: '이영희', due: '2026-11-30' }],
    next_steps: ['다음 D']
  }

  it('구버전 요약은 핵심 포인트·다음 단계를 그리고 주제별 요약·키워드·미결 질문은 그리지 않는다', () => {
    const html = renderToStaticMarkup(<SummaryPanel summary={legacy} meetingId={7} onSeek={() => {}} />)
    for (const t of ['예전 요약', '핵심 A', '결정 B', '액션 C', '이영희', '2026-11-30', '다음 D']) {
      expect(html).toContain(t)
    }
    expect(html).toContain('>핵심 포인트<')
    expect(html).toContain('>다음 단계<')
    expect(html).not.toContain('>주제별 요약<')
    expect(html).not.toContain('>키워드<')
    expect(html).not.toContain('>미결 질문<')
    expect(html).not.toContain('이 시점부터 듣기')
    // 액션아이템은 + TODO 흐름을 그대로 둔다
    expect(html).toContain('+ TODO')
    expect(html.indexOf('>핵심 포인트<')).toBeLessThan(html.indexOf('>결정사항<'))
    expect(html.indexOf('>액션아이템<')).toBeLessThan(html.indexOf('>다음 단계<'))
  })
})

describe('SummaryPanel 요약 형식·내 메모', () => {
  afterEach(() => {
    storeState.current = null
  })

  const mark = (id: number, at_ms: number, text: string): MeetingMark => ({
    id,
    meeting_id: 7,
    raw_ms: at_ms,
    at_ms,
    text,
    origin: 'live',
    created_at: '2026-10-23 10:00:00',
    updated_at: '2026-10-23 10:00:00'
  })
  const withMarks = (marks: MeetingMark[]): void => {
    storeState.current = {
      meeting: { id: 7, summary_template: null } as MeetingDetail['meeting'],
      marks
    }
  }

  it('template_id가 없거나 null이면 "형식: 기본"을 그리고 형식 드롭다운을 둔다', () => {
    expect(renderToStaticMarkup(<SummaryPanel summary={summary} meetingId={7} />)).toContain('형식: 기본')
    const html = renderToStaticMarkup(
      <SummaryPanel summary={{ ...summary, template_id: null }} meetingId={7} />
    )
    expect(html).toContain('형식: 기본')
    expect(html).toContain('형식 바꿔 다시 요약')
    expect(html).toContain('>자동<')
  })

  it('template_id의 이름을 배지에 그린다', () => {
    const html = renderToStaticMarkup(
      <SummaryPanel summary={{ ...summary, template_id: 'standup' }} meetingId={7} />
    )
    expect(html).toContain('형식: 스탠드업')
  })

  it('메모가 없으면 내 메모·범례·AI 표식을 그리지 않는다', () => {
    withMarks([])
    const html = renderToStaticMarkup(<SummaryPanel summary={newSummary} meetingId={7} onSeek={() => {}} />)
    expect(html).not.toContain('내 메모')
    expect(html).not.toContain('>AI<')
    expect(html).not.toContain('+ 메모 추가')
  })

  it('메모가 있으면 내 메모 섹션·북마크 칩·범례·AI 표식을 그리고 주제에 메모를 배정한다', () => {
    withMarks([mark(1, 70000, '배포 전에 QA 확인'), mark(2, 5000, '')])
    const html = renderToStaticMarkup(<SummaryPanel summary={newSummary} meetingId={7} onSeek={() => {}} />)
    expect(html).toContain('>내 메모<')
    expect(html).toContain('북마크')
    expect(html).toContain('내 메모 · AI 요약')
    expect(html).toContain('>AI<')
    expect(html).toContain('[01:10]')
    expect(html).toContain('[00:05]')
    expect(html).toContain('+ 메모 추가')
    // 내 메모는 키워드 아래, TL;DR 위
    expect(html.indexOf('>키워드<')).toBeLessThan(html.indexOf('>내 메모<'))
    expect(html.indexOf('>내 메모<')).toBeLessThan(html.indexOf('>TL;DR<'))
  })

  it('다른 회의의 메모는 그리지 않는다', () => {
    withMarks([mark(1, 70000, '다른 회의 메모')])
    const html = renderToStaticMarkup(<SummaryPanel summary={newSummary} meetingId={8} />)
    expect(html).not.toContain('다른 회의 메모')
  })
})
