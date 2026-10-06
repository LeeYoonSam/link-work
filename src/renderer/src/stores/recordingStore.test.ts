import { describe, expect, it, vi } from 'vitest'
import { useRecordingStore } from './recordingStore'

describe('recordingStore.processAndSummarize', () => {
  // main 가드는 command-done을 받자마자 창을 닫고 'recording' 행을 정리한다.
  // 그 전에 status='processing'이 되도록 process IPC는 첫 await 전에 동기로 나가야 한다.
  it('[S10] process IPC를 호출 즉시(동기 구간에서) 보낸다', () => {
    const process = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('window', { api: { recording: { process } } })

    void useRecordingStore.getState().processAndSummarize(7)
    expect(process).toHaveBeenCalledWith(7)
    vi.unstubAllGlobals()
  })
})
