import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MeetingNoteItem } from '../../types'

// zustand v5는 서버 렌더에서 초기 상태를 돌려주므로 스토어 훅 자체를 모킹한다
// (recording/RecordingList.test.tsx와 같은 방식).
const state: { items: MeetingNoteItem[]; loading: boolean } = { items: [], loading: false }

vi.mock('../../stores/meetingNotesStore', () => ({
  useMeetingNotesStore: () => ({ ...state, selectedId: null, select: () => {} })
}))

const MeetingNoteList = (await import('./MeetingNoteList')).default

const note = (id: number, title: string, startedAt: string): MeetingNoteItem => ({
  id,
  title,
  kind: 'meeting',
  started_at: startedAt,
  duration_ms: 30 * 60_000,
  project_id: null,
  project_name: null,
  tldr: `${title} 요약`,
  key_point_count: 1,
  decision_count: 2,
  action_item_count: 3,
  open_action_count: 1,
  attendee_names: [],
  generated_at: startedAt
})

const render = (items: MeetingNoteItem[]): string => {
  state.items = items
  return renderToStaticMarkup(<MeetingNoteList />)
}

describe('MeetingNoteList', () => {
  it('started_at 순서를 유지한 채 월별 그룹 헤더 아래 묶는다', () => {
    const html = render([
      note(3, '10월 회고', '2026-10-05 10:00:00'),
      note(2, '10월 킥오프', '2026-10-01 10:00:00'),
      note(1, '9월 정기회의', '2026-09-20 10:00:00')
    ])
    expect(html.match(/2026년 10월/g)).toHaveLength(1)
    expect(html).toContain('2026년 9월')
    expect(html.indexOf('2026년 10월')).toBeLessThan(html.indexOf('10월 회고'))
    expect(html.indexOf('10월 킥오프')).toBeLessThan(html.indexOf('2026년 9월'))
    expect(html.indexOf('2026년 9월')).toBeLessThan(html.indexOf('9월 정기회의'))
    expect(html).toContain('결정 2')
    expect(html).toContain('미반영 1')
  })

  it('목록이 비면 안내 문구를 보여준다', () => {
    const html = render([])
    expect(html).toContain('요약 완료된 회의가 없습니다')
    expect(html).toContain('녹음 메뉴에서 녹음 후 AI 요약을 생성하세요')
  })
})
