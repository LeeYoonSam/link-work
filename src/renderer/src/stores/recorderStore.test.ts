import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// node 환경(jsdom 없음)이라 브라우저 미디어 API를 가짜로 대체한다.

class FakeTrack {
  stopped = false
  private listeners: Record<string, Array<() => void>> = {}
  stop(): void {
    this.stopped = true
  }
  addEventListener(type: string, fn: () => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  fire(type: string): void {
    this.listeners[type]?.forEach((fn) => fn())
  }
}

class FakeStream {
  constructor(public tracks: FakeTrack[] = [new FakeTrack()]) {}
  getTracks(): FakeTrack[] {
    return this.tracks
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks
  }
  getVideoTracks(): FakeTrack[] {
    return []
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported(): boolean {
    return true
  }
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  stopCalls = 0
  // false면 stop()을 불러도 onstop을 발화하지 않는다 (onstop 누락 상황 재현)
  autoFireStop = false

  constructor(
    public stream: unknown,
    public opts: unknown
  ) {
    FakeMediaRecorder.instances.push(this)
  }
  start(): void {
    this.state = 'recording'
  }
  pause(): void {
    this.state = 'paused'
  }
  resume(): void {
    this.state = 'recording'
  }
  stop(): void {
    this.stopCalls++
    if (this.state === 'inactive') return // 실제 MediaRecorder처럼 no-op
    this.state = 'inactive'
    if (this.autoFireStop) this.onstop?.()
  }
  // 테스트용 수동 발화
  emitData(text: string): void {
    this.ondataavailable?.({ data: new Blob([text]) })
  }
  emitUnexpectedStop(): void {
    this.state = 'inactive'
    this.onstop?.()
  }
  emitError(): void {
    this.onerror?.(new Error('boom'))
  }
}

class FakeNode {
  connect(): void {}
}

class FakeAudioContext {
  static closed = 0
  createMediaStreamSource(): FakeNode {
    return new FakeNode()
  }
  createAnalyser(): FakeNode & { fftSize: number; getFloatTimeDomainData: () => void } {
    return Object.assign(new FakeNode(), { fftSize: 0, getFloatTimeDomainData: () => {} })
  }
  createMediaStreamDestination(): FakeNode & { stream: FakeStream } {
    return Object.assign(new FakeNode(), { stream: new FakeStream() })
  }
  createChannelMerger(): FakeNode {
    return new FakeNode()
  }
  close(): Promise<void> {
    FakeAudioContext.closed++
    return Promise.resolve()
  }
}

let micStream: FakeStream
const getUserMedia = vi.fn()

type StoreModule = typeof import('./recorderStore')

async function loadStore(): Promise<StoreModule> {
  vi.resetModules()
  return import('./recorderStore')
}

function lastRecorder(): FakeMediaRecorder {
  return FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1]
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeMediaRecorder.instances = []
  FakeAudioContext.closed = 0
  micStream = new FakeStream()
  getUserMedia.mockReset()
  getUserMedia.mockImplementation(async () => micStream)

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('MediaStream', FakeStream)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia,
      getDisplayMedia: vi.fn(async () => new FakeStream())
    }
  })
  vi.stubGlobal('window', {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: number) => clearInterval(id)
  })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('performance', { now: () => Date.now() })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function startRecording(mod: StoreModule): Promise<FakeMediaRecorder> {
  const ok = await mod.useRecorderStore.getState().start({ source: 'mic', draftId: 7 })
  expect(ok).toBe(true)
  return lastRecorder()
}

describe('recorderStore', () => {
  it('start 성공 시 true를 반환하고 recording 상태가 된다', async () => {
    const mod = await loadStore()
    await startRecording(mod)
    const s = mod.useRecorderStore.getState()
    expect(s.state).toBe('recording')
    expect(s.draftId).toBe(7)
  })

  it('정상 stop: onstop이 오면 청크로 resolve하고 stopped·lastResult가 세팅된다', async () => {
    const mod = await loadStore()
    const rec = await startRecording(mod)
    rec.autoFireStop = true
    rec.emitData('ab')
    rec.emitData('cd')

    const result = await mod.useRecorderStore.getState().stop()
    expect(await result.blob.text()).toBe('abcd')
    expect(result.mime).toBe('audio/webm;codecs=opus')
    const s = mod.useRecorderStore.getState()
    expect(s.state).toBe('stopped')
    expect(s.lastResult).toBe(result)
    expect(micStream.tracks[0].stopped).toBe(true)
  })

  it('[S3] 이미 inactive인 녹음기에서 stop()은 onstop 없이 즉시 resolve한다', async () => {
    const mod = await loadStore()
    const rec = await startRecording(mod)
    rec.emitData('xy')
    rec.state = 'inactive' // 핸들러 없이 멈춘 상태

    const result = await mod.useRecorderStore.getState().stop()
    expect(await result.blob.text()).toBe('xy')
    expect(mod.useRecorderStore.getState().state).toBe('stopped')
  })

  it('[S4] onstop이 오지 않으면 STOP_TIMEOUT_MS 후 지금까지의 청크로 resolve한다', async () => {
    const mod = await loadStore()
    const rec = await startRecording(mod)
    rec.emitData('zz')

    let settled = false
    const p = mod.useRecorderStore
      .getState()
      .stop()
      .then((r) => {
        settled = true
        return r
      })
    expect(rec.stopCalls).toBe(1)

    await vi.advanceTimersByTimeAsync(mod.STOP_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(await (await p).blob.text()).toBe('zz')
    expect(mod.useRecorderStore.getState().state).toBe('stopped')
  })

  it('[S5] 요청 없는 onstop 후 error가 세팅되고 state는 유지되며, 이후 stop()은 보존된 청크로 resolve한다', async () => {
    const mod = await loadStore()
    const rec = await startRecording(mod)
    rec.emitData('keep')
    rec.emitUnexpectedStop()

    let s = mod.useRecorderStore.getState()
    expect(s.error).toBe(mod.UNEXPECTED_STOP_ERROR)
    expect(s.state).toBe('recording')

    const result = await s.stop()
    expect(await result.blob.text()).toBe('keep')
    s = mod.useRecorderStore.getState()
    expect(s.state).toBe('stopped')
    expect(s.lastResult).toBe(result)
  })

  it('[S5] onerror·마이크 트랙 ended도 error 안내를 세팅하고 state를 유지한다', async () => {
    const mod = await loadStore()
    const rec = await startRecording(mod)
    rec.emitError()
    expect(mod.useRecorderStore.getState().error).toBe(mod.UNEXPECTED_STOP_ERROR)
    expect(mod.useRecorderStore.getState().state).toBe('recording')

    mod.useRecorderStore.setState({ error: null })
    micStream.tracks[0].fire('ended')
    expect(mod.useRecorderStore.getState().error).toBe(mod.UNEXPECTED_STOP_ERROR)
    expect(mod.useRecorderStore.getState().state).toBe('recording')
  })

  it('[S6] getUserMedia 실패 시 start()는 false를 반환하고 idle·error 상태가 된다', async () => {
    const mod = await loadStore()
    getUserMedia.mockRejectedValueOnce(new Error('Permission denied'))

    const ok = await mod.useRecorderStore.getState().start({ source: 'mic', draftId: 3 })
    expect(ok).toBe(false)
    const s = mod.useRecorderStore.getState()
    expect(s.state).toBe('idle')
    expect(s.draftId).toBeNull()
    expect(s.error).toContain('Permission denied')
    expect(FakeMediaRecorder.instances).toHaveLength(0)
  })

  it('stop() 중복 호출은 같은 Promise를 반환한다', async () => {
    const mod = await loadStore()
    await startRecording(mod)
    const a = mod.useRecorderStore.getState().stop()
    const b = mod.useRecorderStore.getState().stop()
    expect(a).toBe(b)
    expect(lastRecorder().stopCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(mod.STOP_TIMEOUT_MS)
    await a
  })

  it('녹음기가 없으면 stop()은 reject한다', async () => {
    const mod = await loadStore()
    await expect(mod.useRecorderStore.getState().stop()).rejects.toThrow()
  })

  it('reset: 핸들러를 분리하고 녹음 중인 녹음기를 stop하며 상태를 초기화한다', async () => {
    const mod = await loadStore()
    const rec = await startRecording(mod)
    rec.emitData('x')

    mod.useRecorderStore.getState().reset()
    expect(rec.stopCalls).toBe(1)
    expect(rec.onstop).toBeNull()
    expect(rec.ondataavailable).toBeNull()
    expect(rec.onerror).toBeNull()
    const s = mod.useRecorderStore.getState()
    expect(s.state).toBe('idle')
    expect(s.lastResult).toBeNull()
    expect(s.draftId).toBeNull()
    expect(micStream.tracks[0].stopped).toBe(true)
  })

  it('reset: pending stop은 거부되어 기다리는 쪽이 멈추지 않는다', async () => {
    const mod = await loadStore()
    await startRecording(mod)
    const p = mod.useRecorderStore.getState().stop()
    mod.useRecorderStore.getState().reset()
    await expect(p).rejects.toThrow('녹음이 취소되었습니다.')
    // 타임아웃이 남아 있어도 이후 상태를 건드리지 않는다
    await vi.advanceTimersByTimeAsync(mod.STOP_TIMEOUT_MS)
    expect(mod.useRecorderStore.getState().state).toBe('idle')
  })

  it('stopped 이후 reset하면 lastResult가 비워지고 이미 inactive인 녹음기는 다시 stop하지 않는다', async () => {
    const mod = await loadStore()
    const rec = await startRecording(mod)
    rec.autoFireStop = true
    await mod.useRecorderStore.getState().stop()
    expect(mod.useRecorderStore.getState().lastResult).not.toBeNull()

    mod.useRecorderStore.getState().reset()
    expect(rec.stopCalls).toBe(1)
    expect(mod.useRecorderStore.getState().lastResult).toBeNull()
  })
})
