import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  session: { defaultSession: { setDisplayMediaRequestHandler: vi.fn() } },
  desktopCapturer: { getSources: vi.fn() }
}))

import {
  GET_SOURCES_TIMEOUT_MS,
  registerSystemAudioLoopback,
  type SystemAudioLoopbackDeps
} from './system-audio-loopback'

type Handler = (request: unknown, callback: (streams: unknown) => void) => void

function setup(getSources: SystemAudioLoopbackDeps['desktopCapturer']['getSources']): {
  setHandler: ReturnType<typeof vi.fn>
  invoke: () => ReturnType<typeof vi.fn>
} {
  const setHandler = vi.fn()
  registerSystemAudioLoopback({
    session: { setDisplayMediaRequestHandler: setHandler },
    desktopCapturer: { getSources }
  } as unknown as SystemAudioLoopbackDeps)
  const invoke = (): ReturnType<typeof vi.fn> => {
    const handler = setHandler.mock.calls[0][0] as Handler
    const callback = vi.fn()
    handler({}, callback)
    return callback
  }
  return { setHandler, invoke }
}

const screen = { id: 'screen:1:0', name: 'Entire Screen' }

describe('registerSystemAudioLoopback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('getDisplayMedia 핸들러를 useSystemPicker:false로 등록한다', () => {
    const { setHandler } = setup(vi.fn(async () => []))
    expect(setHandler).toHaveBeenCalledTimes(1)
    expect(typeof setHandler.mock.calls[0][0]).toBe('function')
    expect(setHandler.mock.calls[0][1]).toEqual({ useSystemPicker: false })
  })

  it('화면 소스가 있으면 첫 소스와 audio:loopback으로 응답한다', async () => {
    const getSources = vi.fn(async () => [screen, { id: 'screen:2:0', name: 'Other' }])
    const { invoke } = setup(getSources as never)
    const callback = invoke()
    await vi.advanceTimersByTimeAsync(0)
    expect(getSources).toHaveBeenCalledWith({ types: ['screen'] })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ video: screen, audio: 'loopback' })
  })

  it('소스가 없으면 video 없이 응답해 요청을 거절한다', async () => {
    const { invoke } = setup(vi.fn(async () => []))
    const callback = invoke()
    await vi.advanceTimersByTimeAsync(0)
    expect(callback).toHaveBeenCalledWith({})
  })

  it('getSources가 실패하면 거절한다', async () => {
    const { invoke } = setup(vi.fn(async () => Promise.reject(new Error('denied'))))
    const callback = invoke()
    await vi.advanceTimersByTimeAsync(0)
    expect(callback).toHaveBeenCalledWith({})
  })

  it('getSources가 resolve되지 않으면 타임아웃 후 거절한다', async () => {
    const { invoke } = setup(vi.fn(() => new Promise<never>(() => {})))
    const callback = invoke()
    await vi.advanceTimersByTimeAsync(GET_SOURCES_TIMEOUT_MS - 1)
    expect(callback).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({})
  })

  it('deps 없이 호출하면 기본 세션에 등록한다', async () => {
    const electron = await import('electron')
    registerSystemAudioLoopback()
    expect(electron.session.defaultSession.setDisplayMediaRequestHandler).toHaveBeenCalledTimes(1)
  })
})
