import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { KindFilter } from '../../stores/recordingStore'
import type { Meeting } from '../../types'

// 회의·면접을 한 목록에서 종류별로 갈라 보는 필터 동작을 고정한다.
//
// zustand v5는 서버 렌더(renderToStaticMarkup)에서 useSyncExternalStore의
// getServerSnapshot으로 **초기 상태**를 돌려준다. 따라서 setState로 상태를 주입해도
// 렌더에 반영되지 않아, 스토어 훅 자체를 모킹한다.
const state: { meetings: Meeting[]; kindFilter: KindFilter } = {
  meetings: [],
  kindFilter: 'all'
}

vi.mock('../../stores/recordingStore', () => ({
  useRecordingStore: () => ({
    ...state,
    current: null,
    processing: {},
    openMeeting: () => {}
  })
}))

const RecordingList = (await import('./RecordingList')).default

const meeting = (id: number, title: string, kind: Meeting['kind']): Meeting => ({
  id,
  title,
  kind,
  status: 'summarized',
  audio_path: `${id}.wav`,
  audio_mime: 'audio/wav',
  duration_ms: 60_000,
  language: 'ko',
  source: 'mic',
  expected_speakers: kind === 'interview' ? 2 : null,
  project_id: null,
  calendar_event_id: null,
  calendar_event_title: null,
  error: null,
  started_at: '2026-07-22 10:00:00',
  created_at: '2026-07-22 10:00:00',
  updated_at: '2026-07-22 10:00:00'
})

const MEETINGS: Meeting[] = [
  meeting(1, '스프린트 회고', 'meeting'),
  meeting(2, '백엔드 3차 면접', 'interview'),
  meeting(3, '주간 정기회의', 'meeting')
]

const render = (meetings: Meeting[], kindFilter: KindFilter): string => {
  state.meetings = meetings
  state.kindFilter = kindFilter
  return renderToStaticMarkup(<RecordingList />)
}

describe('RecordingList 종류 필터', () => {
  it('전체 필터는 회의와 면접을 모두 보여준다', () => {
    const html = render(MEETINGS, 'all')
    expect(html).toContain('스프린트 회고')
    expect(html).toContain('백엔드 3차 면접')
    expect(html).toContain('주간 정기회의')
  })

  it('회의 필터는 면접을 제외한다', () => {
    const html = render(MEETINGS, 'meeting')
    expect(html).toContain('스프린트 회고')
    expect(html).toContain('주간 정기회의')
    expect(html).not.toContain('백엔드 3차 면접')
  })

  it('면접 필터는 회의를 제외하고 면접 배지를 붙인다', () => {
    const html = render(MEETINGS, 'interview')
    expect(html).toContain('백엔드 3차 면접')
    expect(html).not.toContain('스프린트 회고')
    expect(html).toContain('면접')
  })

  it('필터에 걸려 비었을 때와 녹음이 아예 없을 때를 구분해 안내한다', () => {
    // 회의만 있는데 면접 탭 → 필터 때문이라고 알려준다
    const filtered = render([meeting(1, '회의만 있음', 'meeting')], 'interview')
    expect(filtered).toContain('면접 녹음이 없습니다')
    expect(filtered).toContain('전체 탭')

    // 녹음 자체가 없음 → 첫 녹음 안내
    const empty = render([], 'all')
    expect(empty).toContain('녹음된 항목이 없습니다')
    expect(empty).toContain('첫 녹음을 시작하세요')
  })
})
