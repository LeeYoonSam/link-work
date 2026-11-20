import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// node 환경(jsdom 없음)이라 브라우저 미디어 API를 가짜로 대체한다.

class FakeTrack {
  stopped = false
  constructor(public readyState: 'live' | 'ended' = 'live') {}
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
  constructor(
    public tracks: FakeTrack[] = [new FakeTrack()],
    public videoTracks: FakeTrack[] = []
  ) {}
  getTracks(): FakeTrack[] {
    return [...this.tracks, ...this.videoTracks]
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks
  }
  getVideoTracks(): FakeTrack[] {
    return this.videoTracks
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
const getDisplayMedia = vi.fn()

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
  getDisplayMedia.mockReset()
  getDisplayMedia.mockImplementation(async () => new FakeStream())

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('MediaStream', FakeStream)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia,
      getDisplayMedia
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

  it('getUserMedia는 noiseSuppression:false·echoCancellation:true·mono로 호출된다', async () => {
    const mod = await loadStore()
    await startRecording(mod)
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: false, channelCount: 1 }
    })
  })

  it('mic+system: live 시스템 트랙이면 스테레오로 녹음하고 비디오 트랙은 즉시 정지한다', async () => {
    const mod = await loadStore()
    const sysTrack = new FakeTrack('live')
    const videoTrack = new FakeTrack('live')
    getDisplayMedia.mockImplementationOnce(async () => new FakeStream([sysTrack], [videoTrack]))

    const ok = await mod.useRecorderStore.getState().start({ source: 'mic+system', draftId: 1 })
    expect(ok).toBe(true)
    expect(getDisplayMedia).toHaveBeenCalledWith({ audio: true, video: true })
    expect(videoTrack.stopped).toBe(true)
    expect(sysTrack.stopped).toBe(false)
    expect(mod.useRecorderStore.getState().error).toBeNull()

    // 정지 시 시스템 트랙도 정리된다
    lastRecorder().autoFireStop = true
    await mod.useRecorderStore.getState().stop()
    expect(sysTrack.stopped).toBe(true)
  })

  it('mic+system: 시스템 오디오 트랙이 처음부터 ended면 마이크만으로 녹음하고 권한 안내를 띄운다', async () => {
    const mod = await loadStore()
    const deadTrack = new FakeTrack('ended')
    getDisplayMedia.mockImplementationOnce(async () => new FakeStream([deadTrack]))

    const ok = await mod.useRecorderStore.getState().start({ source: 'mic+system', draftId: 2 })
    expect(ok).toBe(true)
    const s = mod.useRecorderStore.getState()
    expect(s.state).toBe('recording')
    expect(s.error).toBe(mod.SYSTEM_AUDIO_PERMISSION_ERROR)
    expect(deadTrack.stopped).toBe(true)
    expect(FakeMediaRecorder.instances).toHaveLength(1)
  })

  it('mic+system: 녹음 중 시스템 트랙이 끝나도 녹음은 유지되고 경고만 띄운다', async () => {
    const mod = await loadStore()
    const sysTrack = new FakeTrack('live')
    getDisplayMedia.mockImplementationOnce(async () => new FakeStream([sysTrack]))

    await mod.useRecorderStore.getState().start({ source: 'mic+system', draftId: 3 })
    await vi.advanceTimersByTimeAsync(1000)
    const before = mod.useRecorderStore.getState().elapsedMs

    sysTrack.readyState = 'ended'
    sysTrack.fire('ended')
    let s = mod.useRecorderStore.getState()
    expect(s.state).toBe('recording')
    expect(s.error).toBe(mod.SYSTEM_AUDIO_LOST_ERROR)
    expect(lastRecorder().state).toBe('recording')

    // 타이머는 계속 흐른다 (마이크 중단 처리와 달리 멈추지 않음)
    await vi.advanceTimersByTimeAsync(1000)
    s = mod.useRecorderStore.getState()
    expect(s.elapsedMs).toBeGreaterThan(before)
  })

  it('mic+system: reset 이후 늦게 온 시스템 트랙 ended는 무시한다', async () => {
    const mod = await loadStore()
    const sysTrack = new FakeTrack('live')
    getDisplayMedia.mockImplementationOnce(async () => new FakeStream([sysTrack]))

    await mod.useRecorderStore.getState().start({ source: 'mic+system', draftId: 4 })
    mod.useRecorderStore.getState().reset()
    sysTrack.fire('ended')
    expect(mod.useRecorderStore.getState().error).toBeNull()
  })
})
