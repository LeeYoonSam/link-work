import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecorderCommand } from '../types'

// 녹음기(MediaRecorder 래퍼)와 회의 스토어(IPC)는 목으로 대체한다.
// recorderSession은 두 스토어의 getState()만 쓰므로 실제 zustand 스토어에 목 함수를 넣는다.
vi.mock('./recorderStore', async () => {
  const { create } = await import('zustand')
  return { useRecorderStore: create<Record<string, unknown>>(() => ({})) }
})
vi.mock('./recordingStore', async () => {
  const { create } = await import('zustand')
  return { useRecordingStore: create<Record<string, unknown>>(() => ({})) }
})

import type { StoreApi } from 'zustand'
import { useRecorderStore as realRecorderStore } from './recorderStore'
import { useRecordingStore as realRecordingStore } from './recordingStore'
import {
  cancelSession,
  installRecorderBridge,
  retrySave,
  startSession,
  stopAndSave
} from './recorderSession'

// 목 스토어는 필요한 필드만 갖는다 — 실제 스토어 타입 대신 느슨한 타입으로 다룬다
type LooseStore = StoreApi<Record<string, unknown>>
const useRecorderStore = realRecorderStore as unknown as LooseStore
const useRecordingStore = realRecordingStore as unknown as LooseStore

type Result = { blob: Blob; durationMs: number; mime: string }

const RESULT: Result = { blob: new Blob(['a']), durationMs: 1000, mime: 'audio/webm' }

const INPUT = {
  source: 'mic' as const,
  kind: 'meeting' as const,
  expected_speakers: null,
  attendee_ids: [],
  compact_audio: true
}

// 목 스토어 상태를 테스트 사이에 다시 만든다
function setupStores(): {
  recorder: Record<string, ReturnType<typeof vi.fn>>
  recording: Record<string, ReturnType<typeof vi.fn>>
} {
  const setRec = (patch: Record<string, unknown>): void => useRecorderStore.setState(patch)
  const recorder = {
    start: vi.fn(async (opts: { draftId: number }) => {
      setRec({ state: 'recording', draftId: opts.draftId })
      return true
    }),
    stop: vi.fn(async () => {
      setRec({ state: 'stopped', lastResult: RESULT })
      return RESULT
    }),
    reset: vi.fn(() =>
      setRec({
        state: 'idle',
        draftId: null,
        lastResult: null,
        saving: false,
        saveError: null,
        error: null
      })
    ),
    setSaving: vi.fn((saving: boolean) => setRec({ saving })),
    setSaveError: vi.fn((saveError: string | null) => setRec({ saveError }))
  }
  useRecorderStore.setState(
    {
      state: 'idle',
      draftId: null,
      lastResult: null,
      saving: false,
      saveError: null,
      error: null,
      ...recorder
    },
    true
  )

  const recording = {
    createDraft: vi.fn(async () => 42),
    saveRecording: vi.fn(async () => {}),
    processAndSummarize: vi.fn(async () => {}),
    discardDraft: vi.fn(async () => {})
  }
  useRecordingStore.setState(recording, true)
  return { recorder, recording }
}

function stubBridge(): {
  reportState: ReturnType<typeof vi.fn>
  commandDone: ReturnType<typeof vi.fn>
  emit: (cmd: RecorderCommand) => void
  off: ReturnType<typeof vi.fn>
} {
  let handler: ((cmd: RecorderCommand) => void) | null = null
  const off = vi.fn()
  const bridge = {
    reportState: vi.fn(),
    commandDone: vi.fn(),
    onCommand: vi.fn((h: (cmd: RecorderCommand) => void) => {
      handler = h
      return off
    })
  }
  vi.stubGlobal('window', { api: { recorder: bridge } })
  return {
    reportState: bridge.reportState,
    commandDone: bridge.commandDone,
    emit: (cmd) => handler?.(cmd),
    off
  }
}

// 백그라운드 promise 체인이 끝날 때까지 기다린다
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('recorderSession', () => {
  let stores: ReturnType<typeof setupStores>

  beforeEach(() => {
    vi.unstubAllGlobals()
    stores = setupStores()
  })

  it('[S7] 녹음 시작 실패 시 draft 행을 지우고 녹음기 에러로 throw한다', async () => {
    stores.recorder.start.mockImplementation(async () => {
      useRecorderStore.setState({ state: 'idle', draftId: null, error: '녹음을 시작할 수 없습니다: 권한 거부' })
      return false
    })

    await expect(startSession(INPUT)).rejects.toThrow('권한 거부')
    expect(stores.recording.createDraft).toHaveBeenCalledTimes(1)
    expect(stores.recording.discardDraft).toHaveBeenCalledWith(42)
  })

  it('[S7] 녹음 시작 성공 시 draft 행을 지우지 않는다', async () => {
    await startSession(INPUT)
    expect(stores.recorder.start).toHaveBeenCalledWith({ source: 'mic', draftId: 42 })
    expect(stores.recording.discardDraft).not.toHaveBeenCalled()
  })

  it('[S12] startSession 중복 호출 시 createDraft 1회', async () => {
    // 권한 팝업이 떠 있는 동안처럼 start가 늦게 끝나는 상황
    let finishStart: (ok: boolean) => void = () => {}
    stores.recorder.start.mockImplementation(
      () => new Promise<boolean>((resolve) => (finishStart = resolve))
    )

    const first = startSession(INPUT)
    const second = startSession(INPUT)
    expect(second).toBe(first)
    await Promise.resolve()
    await Promise.resolve()
    finishStart(true)
    await Promise.all([first, second])
    expect(stores.recording.createDraft).toHaveBeenCalledTimes(1)
    expect(stores.recorder.start).toHaveBeenCalledTimes(1)

    // 끝난 뒤에는 다시 시작할 수 있다
    stores.recorder.start.mockResolvedValue(true)
    await startSession(INPUT)
    expect(stores.recording.createDraft).toHaveBeenCalledTimes(2)
  })

  it('[S12] 시작 실패(start false) 후에는 가드가 풀려 다시 시작할 수 있다', async () => {
    stores.recorder.start.mockImplementationOnce(async () => {
      useRecorderStore.setState({ state: 'idle', draftId: null, error: '권한 거부' })
      return false
    })

    await expect(startSession(INPUT)).rejects.toThrow('권한 거부')
    await startSession(INPUT)
    expect(stores.recording.createDraft).toHaveBeenCalledTimes(2)
    expect(stores.recorder.start).toHaveBeenCalledTimes(2)
    expect(useRecorderStore.getState().state).toBe('recording')
  })

  it('[S8] cancelSession은 녹음기를 reset하고 draft 행을 지운다', async () => {
    useRecorderStore.setState({ state: 'recording', draftId: 7 })

    await cancelSession()
    expect(stores.recorder.reset).toHaveBeenCalledTimes(1)
    expect(stores.recording.discardDraft).toHaveBeenCalledWith(7)
    expect(useRecorderStore.getState().state).toBe('idle')
  })

  it('stopAndSave 성공 시 reset하고 처리는 기다리지 않고 시작한다', async () => {
    useRecorderStore.setState({ state: 'recording', draftId: 7 })
    // 처리가 끝나지 않아도 stopAndSave는 resolve해야 한다
    stores.recording.processAndSummarize.mockImplementation(() => new Promise(() => {}))

    await stopAndSave()
    expect(stores.recording.saveRecording).toHaveBeenCalledWith(7, RESULT.blob, 1000, 'audio/webm')
    expect(stores.recorder.reset).toHaveBeenCalledTimes(1)
    expect(stores.recording.processAndSummarize).toHaveBeenCalledWith(7)
  })

  it('stopAndSave는 재진입해도 한 번만 저장하고, process:false면 처리를 건너뛴다', async () => {
    useRecorderStore.setState({ state: 'recording', draftId: 7 })

    await Promise.all([stopAndSave({ process: false }), stopAndSave({ process: false })])
    expect(stores.recorder.stop).toHaveBeenCalledTimes(1)
    expect(stores.recording.saveRecording).toHaveBeenCalledTimes(1)
    expect(stores.recording.processAndSummarize).not.toHaveBeenCalled()
  })

  it('[S9] 저장 실패 시 stopped·lastResult를 유지하고, retrySave 성공 시 reset한다', async () => {
    useRecorderStore.setState({ state: 'recording', draftId: 7 })
    stores.recording.saveRecording.mockRejectedValueOnce(new Error('디스크 오류'))

    await expect(stopAndSave()).rejects.toThrow('디스크 오류')
    let s = useRecorderStore.getState()
    expect(s.state).toBe('stopped')
    expect(s.lastResult).toBe(RESULT)
    expect(s.saveError).toBe('디스크 오류')
    expect(s.saving).toBe(false)
    expect(stores.recorder.reset).not.toHaveBeenCalled()

    await retrySave()
    // 이미 멈춘 녹음은 다시 stop하지 않고 보존된 결과로 저장한다
    expect(stores.recorder.stop).toHaveBeenCalledTimes(1)
    expect(stores.recording.saveRecording).toHaveBeenCalledTimes(2)
    expect(stores.recorder.reset).toHaveBeenCalledTimes(1)
    expect(stores.recording.processAndSummarize).toHaveBeenCalledWith(7)
    s = useRecorderStore.getState()
    expect(s.state).toBe('idle')
  })

  it('[S10] bridge: stop-and-save 명령 → stopAndSave 후 commandDone(success)', async () => {
    const bridge = stubBridge()
    const uninstall = installRecorderBridge()
    useRecorderStore.setState({ state: 'recording', draftId: 7 })

    bridge.emit({ type: 'stop-and-save', requestId: 'r1', process: false })
    await flush()

    expect(stores.recording.saveRecording).toHaveBeenCalledTimes(1)
    expect(stores.recording.processAndSummarize).not.toHaveBeenCalled()
    expect(bridge.commandDone).toHaveBeenCalledWith({ requestId: 'r1', success: true })
    uninstall()
    expect(bridge.off).toHaveBeenCalledTimes(1)
  })

  it('[S8] 종료 대기 중 cancelSession이 끼어들면 에러 없이 조용히 끝난다', async () => {
    useRecorderStore.setState({ state: 'recording', draftId: 7 })
    const pending: { reject?: (e: Error) => void } = {}
    stores.recorder.stop.mockImplementation(
      () => new Promise<Result>((_, reject) => (pending.reject = reject))
    )
    // 실제 reset처럼 진행 중인 stop을 reject한다
    stores.recorder.reset.mockImplementation(() => {
      useRecorderStore.setState({ state: 'idle', draftId: null, lastResult: null, saving: false })
      pending.reject?.(new Error('녹음이 취소되었습니다.'))
    })

    const saving = stopAndSave()
    await cancelSession()
    await expect(saving).resolves.toBeUndefined()
    expect(useRecorderStore.getState().saveError).toBeNull()
    expect(stores.recording.saveRecording).not.toHaveBeenCalled()
    expect(stores.recording.discardDraft).toHaveBeenCalledWith(7)
  })

  it('[S10] bridge: process 요청은 commandDone보다 먼저 시작된다', async () => {
    const bridge = stubBridge()
    const uninstall = installRecorderBridge()
    const order: string[] = []
    stores.recording.processAndSummarize.mockImplementation(async () => {
      order.push('process')
    })
    bridge.commandDone.mockImplementation(() => order.push('done'))
    useRecorderStore.setState({ state: 'recording', draftId: 7 })

    bridge.emit({ type: 'stop-and-save', requestId: 'r2', process: true })
    await flush()
    expect(order).toEqual(['process', 'done'])
    uninstall()
  })

  it('[S10] bridge: 녹음이 없으면 저장 없이 바로 success, 저장 실패면 success:false', async () => {
    const bridge = stubBridge()
    const uninstall = installRecorderBridge()

    bridge.emit({ type: 'stop-and-save', requestId: 'idle', process: true })
    await flush()
    expect(bridge.commandDone).toHaveBeenCalledWith({ requestId: 'idle', success: true })
    expect(stores.recording.saveRecording).not.toHaveBeenCalled()

    useRecorderStore.setState({ state: 'recording', draftId: 7 })
    stores.recording.saveRecording.mockRejectedValueOnce(new Error('디스크 오류'))
    bridge.emit({ type: 'stop-and-save', requestId: 'fail', process: true })
    await flush()
    expect(bridge.commandDone).toHaveBeenCalledWith({
      requestId: 'fail',
      success: false,
      error: '디스크 오류'
    })
    uninstall()
  })

  it('[S10] bridge: active/draftId가 바뀔 때만 reportState한다', () => {
    const bridge = stubBridge()
    const uninstall = installRecorderBridge()
    // 설치 시 현재 상태를 1회 보고
    expect(bridge.reportState).toHaveBeenLastCalledWith({ active: false, draftId: null })

    useRecorderStore.setState({ state: 'recording', draftId: 7 })
    useRecorderStore.setState({ state: 'paused' }) // active 유지 → 보고 안 함
    useRecorderStore.setState({ saving: true }) // 무관한 필드 → 보고 안 함
    useRecorderStore.setState({ state: 'idle', draftId: null })

    expect(bridge.reportState.mock.calls.map((c) => c[0])).toEqual([
      { active: false, draftId: null },
      { active: true, draftId: 7 },
      { active: false, draftId: null }
    ])

    uninstall()
    useRecorderStore.setState({ state: 'recording', draftId: 8 })
    expect(bridge.reportState).toHaveBeenCalledTimes(3)
  })
})
