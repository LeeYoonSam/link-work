import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// 녹음 시작 화면은 녹음 종류 선택·요약 형식·동의 확인 없이 녹음 하나로 시작한다.
// 요약 형식은 요약할 때 내용으로 자동 선택한다.
// zustand v5는 서버 렌더에서 초기 상태를 돌려주므로 스토어 훅을 모킹한다.
vi.mock('../../stores/recorderSession', () => ({
  startSession: vi.fn(async () => {}),
  stopAndSave: vi.fn(async () => {}),
  retrySave: vi.fn(async () => {}),
  cancelSession: vi.fn(async () => {})
}))
vi.mock('../../stores/recorderStore', () => ({
  formatElapsed: () => '00:00',
  useRecorderStore: Object.assign(
    () => ({
      state: 'idle',
      elapsedMs: 0,
      level: 0,
      error: null,
      saving: false,
      saveError: null,
      draftId: null,
      pause: () => {},
      resume: () => {},
      setSaveError: () => {}
    }),
    { getState: () => ({ draftId: null, elapsedMs: 0, state: 'idle' }) }
  )
}))
vi.mock('../../stores/recognitionAidsStore', () => ({
  useRecognitionAidsStore: () => ({ members: [], fetchAll: async () => {} })
}))
vi.mock('../../stores/recordingStore', () => ({
  useRecordingStore: (sel: (st: { meetings: unknown[] }) => unknown) => sel({ meetings: [] })
}))

const { default: RecorderControls, shouldAskHeadcountOnStop, buildStartSessionInput } =
  await import('./RecorderControls')

// 종료 시 참석 인원 질문(#8): 참석 인원을 비워 두고 시작했을 때만 묻는다.
describe('shouldAskHeadcountOnStop', () => {
  const cases: Array<[Parameters<typeof shouldAskHeadcountOnStop>[0], boolean]> = [
    [{ speakersInput: '' }, true],
    [{ speakersInput: '   ' }, true],
    [{ speakersInput: '3' }, false]
  ]
  it.each(cases)('%j → %s', (input, expected) => {
    expect(shouldAskHeadcountOnStop(input)).toBe(expected)
  })
})

describe('RecorderControls 시작 화면', () => {
  it('종류 선택·요약 형식·동의 확인이 없다', () => {
    const html = renderToStaticMarkup(<RecorderControls onDone={() => {}} />)
    expect(html).toContain('녹음 시작')
    // 녹음 종류 토글(회의/…)이 없다
    expect(html).not.toContain('>회의<')
    expect(html).not.toContain('요약 형식')
    expect(html).not.toContain('동의')
  })

  // handleStart는 startSession(buildStartSessionInput(...))을 그대로 부른다. DOM 없이 도는 테스트라
  // 클릭 대신 그 입력을 만드는 함수를 고정한다.
  it('시작 입력에 kind·summary_template 키가 없다', () => {
    const input = buildStartSessionInput({
      source: 'mic',
      speakerCount: '3',
      attendeeIds: [1, 2],
      compactAudio: true
    })
    expect(input).toEqual({
      source: 'mic',
      expected_speakers: 3,
      attendee_ids: [1, 2],
      compact_audio: true
    })
    expect(Object.keys(input)).not.toContain('kind')
    expect(Object.keys(input)).not.toContain('summary_template')
    // 빈 참석 인원은 자동 추정(null)
    expect(
      buildStartSessionInput({ source: 'mic+system', speakerCount: ' ', attendeeIds: [], compactAudio: false })
        .expected_speakers
    ).toBeNull()
  })
})
