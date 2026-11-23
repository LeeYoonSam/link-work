import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// 회의록 문서의 '할 일로 만들기' 버튼과 미리 채울 값을 고정한다.
// 클릭은 정적 렌더로 누를 수 없어 버튼이 부르는 openMeetingTodo 를 직접 부른다.
// zustand v5 는 서버 렌더에서 초기 상태를 돌려주므로 회의록 스토어 훅을 모킹한다(MeetingNoteList.test 와 같은 방식)

const detail = vi.hoisted(() => ({
  meeting: { id: 5, title: '주간 회의', kind: 'meeting', started_at: '2026-11-20 10:00:00', duration_ms: 60000 },
  summary: null,
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
