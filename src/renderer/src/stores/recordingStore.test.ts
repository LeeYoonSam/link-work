import { describe, it, expect, beforeEach } from 'vitest'
import { useRecordingStore } from './recordingStore'

// 재생 이동 예약(#13): 다른 화면이 예약하고 상세 화면이 회의를 열 때 소비한다.
describe('recordingStore pendingSeek', () => {
  beforeEach(() => {
    useRecordingStore.setState({ pendingSeek: null })
  })

  it('다른 회의 id로 소비하면 null을 돌려주고 예약을 남긴다', () => {
    useRecordingStore.getState().setPendingSeek({ meetingId: 3, ms: 65000 })
    expect(useRecordingStore.getState().consumePendingSeek(4)).toBeNull()
    expect(useRecordingStore.getState().pendingSeek).toEqual({ meetingId: 3, ms: 65000 })
  })

  it('같은 회의 id로 소비하면 ms를 돌려주고 비운다', () => {
    useRecordingStore.getState().setPendingSeek({ meetingId: 3, ms: 65000 })
    expect(useRecordingStore.getState().consumePendingSeek(3)).toBe(65000)
    expect(useRecordingStore.getState().pendingSeek).toBeNull()
    expect(useRecordingStore.getState().consumePendingSeek(3)).toBeNull()
  })

  it('예약이 없으면 null', () => {
    expect(useRecordingStore.getState().consumePendingSeek(1)).toBeNull()
  })
})
