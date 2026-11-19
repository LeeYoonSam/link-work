import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TodayPayload, TodayResult } from '../types'

const { useAssistantStore } = await import('./assistantStore')

const payload = { events: [], settings: { llmEnabled: true } } as unknown as TodayPayload

const api = {
  assistant: {
    getToday: vi.fn(async (): Promise<TodayResult> => ({ success: true, today: payload })),
    regenerateMeetingBriefing: vi.fn(async (): Promise<TodayResult> => ({ success: true, today: payload })),
    onChanged: vi.fn(() => () => {})
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = { api }
  useAssistantStore.setState({ today: null, error: '', focus: null, meetingRegeneratingIds: [] })
})

describe('assistantStore (오늘 대시보드 개편 후)', () => {
  it('계획 조작 액션이 없다', () => {
    const s = useAssistantStore.getState() as unknown as Record<string, unknown>
    for (const k of [
      'startDay',
      'closeDay',
      'reopenDay',
      'saveWrapup',
      'skipWrapup',
      'refresh',
      'refreshBriefing',
      'generateRecovery',
      'loadCandidates',
      'addItem',
      'setItemStatus',
      'focusItem',
      'excludeItem',
      'interpretCommand',
      'applyCommand',
      'completeOrigin',
      // 쓰지 않아 지운 것 (2026-11-19)
      'saveSettings',
      'clearError',
      'subscribe',
      'loading'
    ]) {
      expect(s[k]).toBeUndefined()
    }
  })

  it('load 는 getToday 결과를 반영한다. 실패하면 error 를 둔다', async () => {
    await useAssistantStore.getState().load()
    expect(useAssistantStore.getState().today).toBe(payload)
    api.assistant.getToday.mockResolvedValueOnce({ success: false, error: 'DB 잠김' })
    await useAssistantStore.getState().load()
    expect(useAssistantStore.getState().error).toBe('DB 잠김')
  })

  it('regenerateMeetingBriefing 은 같은 행 중복 호출을 막고 끝나면 id 를 비운다', async () => {
    const first = useAssistantStore.getState().regenerateMeetingBriefing(7)
    expect(useAssistantStore.getState().meetingRegeneratingIds).toEqual([7])
    await useAssistantStore.getState().regenerateMeetingBriefing(7)
    await first
    expect(api.assistant.regenerateMeetingBriefing).toHaveBeenCalledTimes(1)
    expect(useAssistantStore.getState().meetingRegeneratingIds).toEqual([])
    expect(useAssistantStore.getState().today).toBe(payload)
  })

  it('regenerateMeetingBriefing 실패는 error 로 남긴다', async () => {
    api.assistant.regenerateMeetingBriefing.mockRejectedValueOnce(new Error('IPC 끊김'))
    await useAssistantStore.getState().regenerateMeetingBriefing(3)
    expect(useAssistantStore.getState().error).toBe('IPC 끊김')
    expect(useAssistantStore.getState().meetingRegeneratingIds).toEqual([])
  })

  it('setFocus', () => {
    useAssistantStore.getState().setFocus({ kind: 'meeting', id: '5' })
    expect(useAssistantStore.getState().focus).toEqual({ kind: 'meeting', id: '5' })
  })
})
