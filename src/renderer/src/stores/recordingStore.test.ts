import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useRecordingStore } from './recordingStore'
import type { Meeting } from '../types'

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

// F4: 요약이 기본·자동 제목을 요약 제목으로 바꿀 수 있으므로 요약 뒤 목록과 상세를 다시 읽는다.
describe('recordingStore summarizeMeeting', () => {
  const renamed = { id: 9, title: '결제 모듈 배포 점검', title_auto: 1 } as Meeting
  let api: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    api = {
      summarize: vi.fn(async () => ({ success: true })),
      list: vi.fn(async () => [renamed]),
      get: vi.fn(async () => ({ meeting: renamed }))
    }
    vi.stubGlobal('window', { api: { recording: api } })
    useRecordingStore.setState({
      meetings: [{ id: 9, title: '제목 없는 회의', title_auto: 1 } as Meeting],
      current: { meeting: { id: 9 } } as never
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    useRecordingStore.setState({ meetings: [], current: null })
  })

  it('요약이 끝나면 목록(recording.list)과 열린 상세를 다시 읽는다', async () => {
    await useRecordingStore.getState().summarizeMeeting(9)
    expect(api.summarize).toHaveBeenCalledWith(9)
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(api.get).toHaveBeenCalledWith(9)
    expect(useRecordingStore.getState().meetings[0].title).toBe('결제 모듈 배포 점검')
  })

  it('요약이 실패해도 목록을 다시 읽는다', async () => {
    api.summarize.mockResolvedValueOnce({ success: false, error: 'x' })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await useRecordingStore.getState().summarizeMeeting(9)
    expect(api.list).toHaveBeenCalledTimes(1)
    api.summarize.mockRejectedValueOnce(new Error('boom'))
    await useRecordingStore.getState().summarizeMeeting(9)
    expect(api.list).toHaveBeenCalledTimes(2)
    err.mockRestore()
  })
})
