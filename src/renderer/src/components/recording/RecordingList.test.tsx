import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Meeting } from '../../types'

// 녹음 목록은 종류 구분 없이 전체를 그린다.
//
// zustand v5는 서버 렌더(renderToStaticMarkup)에서 useSyncExternalStore의
// getServerSnapshot으로 **초기 상태**를 돌려준다. 따라서 setState로 상태를 주입해도
// 렌더에 반영되지 않아, 스토어 훅 자체를 모킹한다.
const state: { meetings: Meeting[] } = {
  meetings: []
}

vi.mock('../../stores/recordingStore', () => ({
  useRecordingStore: () => ({
    ...state,
    current: null,
    processing: {},
    openMeeting: () => {}
  })
}))

const { default: RecordingList, MeetingCard } = await import('./RecordingList')
const { FOCUS_RING_CLASS } = await import('../../hooks/useFocusFlash')

const meeting = (id: number, title: string): Meeting => ({
  id,
  title,
  status: 'summarized',
  audio_path: `${id}.wav`,
  audio_mime: 'audio/wav',
  duration_ms: 60_000,
  language: 'ko',
  source: 'mic',
  expected_speakers: null,
  project_id: null,
  calendar_event_id: null,
  calendar_event_title: null,
  error: null,
  compact_audio: 1,
  audio_compacted: 0,
  original_duration_ms: null,
  pipeline_version: 2,
  started_at: '2026-07-22 10:00:00',
  created_at: '2026-07-22 10:00:00',
  updated_at: '2026-07-22 10:00:00'
})

const MEETINGS: Meeting[] = [
  meeting(1, '스프린트 회고'),
  meeting(2, '백엔드 채용 논의'),
  meeting(3, '주간 정기회의')
]

const render = (meetings: Meeting[]): string => {
  state.meetings = meetings
  return renderToStaticMarkup(<RecordingList />)
}

describe('RecordingList 전체 목록', () => {
  it('모든 녹음을 그린다', () => {
    const html = render(MEETINGS)
    expect(html).toContain('스프린트 회고')
    expect(html).toContain('백엔드 채용 논의')
    expect(html).toContain('주간 정기회의')
  })

  it('녹음이 없으면 첫 녹음을 안내한다', () => {
    const empty = render([])
    expect(empty).toContain('녹음이 없습니다')
    expect(empty).toContain('첫 녹음을 시작하세요')
  })
})

describe('RecordingList 링크 포커스', () => {
  it('카드 루트에 recording-{id} DOM id 를 붙인다', () => {
    const html = render(MEETINGS)
    expect(html).toContain('id="recording-3"')
    expect(html).toContain('id="recording-1"')
  })

  it('highlighted 카드에만 강조 ring 을 붙인다', () => {
    const on = renderToStaticMarkup(<MeetingCard meeting={MEETINGS[2]} highlighted />)
    expect(on).toContain('id="recording-3"')
    expect(on).toContain(FOCUS_RING_CLASS)
    const off = renderToStaticMarkup(<MeetingCard meeting={MEETINGS[2]} />)
    expect(off).not.toContain('ring-blue-400')
  })
})
