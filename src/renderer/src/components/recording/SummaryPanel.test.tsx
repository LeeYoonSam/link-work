import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MeetingSummary } from '../../types'

// zustand v5는 서버 렌더에서 초기 상태를 돌려주므로 스토어 훅 자체를 모킹한다
// (notes/MeetingNoteList.test.tsx와 같은 방식).
vi.mock('../../stores/recordingStore', () => ({
  useRecordingStore: () => ({
    processing: {},
    summarizeMeeting: async () => {},
    actionItemToTodo: async () => {},
    refreshCurrent: async () => {}
  })
}))
vi.mock('../../stores/meetingNotesStore', () => ({
  useMeetingNotesStore: Object.assign(() => ({}), { getState: () => ({ select: () => {} }) })
}))
vi.mock('../../stores/projectStore', () => ({
  useProjectStore: Object.assign(() => ({}), { getState: () => ({ setView: () => {} }) })
}))

const SummaryPanel = (await import('./SummaryPanel')).default

const summary: MeetingSummary = {
  id: 1,
  meeting_id: 7,
  tldr: '주간 회의 요약',
  key_points: ['핵심 1'],
  decisions: [],
  action_items: [],
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
