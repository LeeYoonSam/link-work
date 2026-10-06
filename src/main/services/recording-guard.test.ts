import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RecordingGuard,
  closeChoiceToAction,
  forceChoiceToAction,
  quitChoiceToAction,
  type RecorderCommandPayload
} from './recording-guard'

describe('[S11] RecordingGuard', () => {
  let n = 0
  const genId = (): string => `req-${++n}`

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('[S11] recorder:state 보고로 active/draftId를 보관한다', () => {
    const guard = new RecordingGuard(genId)
    expect(guard.isActive()).toBe(false)
    guard.setState({ active: true, draftId: 7 })
    expect(guard.isActive()).toBe(true)
    expect(guard.draftId()).toBe(7)
    guard.setState({ active: false, draftId: null })
    expect(guard.isActive()).toBe(false)
    guard.setState(null)
    expect(guard.isActive()).toBe(false)
  })

  it('[S11] requestStopAndSave는 stop-and-save를 보내고 command-done으로 resolve한다', async () => {
    const guard = new RecordingGuard(genId)
    const sent: RecorderCommandPayload[] = []
    const p = guard.requestStopAndSave((cmd) => sent.push(cmd), true)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'stop-and-save', process: true })

    // 다른 requestId는 무시
    guard.handleCommandDone({ requestId: 'other', success: true })
    guard.handleCommandDone({ requestId: sent[0].requestId, success: true })
    await expect(p).resolves.toEqual({ success: true })
  })

  it('[S11] 렌더러가 실패를 보고하면 error와 함께 success:false', async () => {
    const guard = new RecordingGuard(genId)
    let id = ''
    const p = guard.requestStopAndSave((cmd) => (id = cmd.requestId), false)
    guard.handleCommandDone({ requestId: id, success: false, error: '저장 실패' })
    await expect(p).resolves.toEqual({ success: false, error: '저장 실패' })
  })

  it('[S11] 응답이 없으면 타임아웃 후 success:false, 늦은 응답은 무시', async () => {
    const guard = new RecordingGuard(genId)
    let id = ''
    const p = guard.requestStopAndSave((cmd) => (id = cmd.requestId), true, 1000)
    vi.advanceTimersByTime(1000)
    await expect(p).resolves.toEqual({ success: false, error: 'timeout' })
    expect(() => guard.handleCommandDone({ requestId: id, success: true })).not.toThrow()
  })

  it('[S11] 전송이 throw하면 즉시 success:false', async () => {
    const guard = new RecordingGuard(genId)
    const p = guard.requestStopAndSave(() => {
      throw new Error('destroyed')
    }, true)
    await expect(p).resolves.toEqual({ success: false, error: 'destroyed' })
  })

  it('[S11] reset은 상태를 비우고 대기 중 요청을 실패로 끝낸다', async () => {
    const guard = new RecordingGuard(genId)
    guard.setState({ active: true, draftId: 3 })
    const p = guard.requestStopAndSave(() => {}, true)
    guard.reset()
    expect(guard.isActive()).toBe(false)
    expect(guard.draftId()).toBeNull()
    await expect(p).resolves.toEqual({ success: false, error: 'renderer-gone' })
  })

  it('[S11] 다이얼로그 선택지 → 동작 매핑', () => {
    expect(closeChoiceToAction(0)).toBe('hide')
    expect(closeChoiceToAction(1)).toBe('save-and-close')
    expect(closeChoiceToAction(2)).toBe('cancel')
    expect(closeChoiceToAction(-1)).toBe('cancel')
    expect(quitChoiceToAction(0)).toBe('save-and-quit')
    expect(quitChoiceToAction(1)).toBe('cancel')
    expect(forceChoiceToAction(0)).toBe('force')
    expect(forceChoiceToAction(1)).toBe('cancel')
  })
})
