import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PlanItem, TodayPayload, TodayResult } from '../types'

// 원본 완료는 할 일만 한다. 기존 행에 남은 task 출처는 원본을 건드리지 않는다.
// 열린 화면 갱신은 이 테스트의 관심사가 아니라 잘라낸다.
vi.mock('./dataSync', () => ({ refreshEntity: async () => {} }))

const { useAssistantStore } = await import('./assistantStore')

const item = (over: Partial<PlanItem>): PlanItem =>
  ({
    id: 1,
    plan_id: 1,
    candidate_id: 'task:7',
    source: 'task',
    title: '작업',
    link: null,
    jira_issue_key: null,
    project_id: 29,
    ...over
  }) as PlanItem

const api = {
  todo: { complete: vi.fn(async () => ({})) },
  assistant: {
    skipWrapup: vi.fn(async (): Promise<TodayResult> => ({ success: false, error: '' }))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = { api }
})

describe('원본 완료', () => {
  it('task 출처 항목은 원본을 완료하지 않는다', async () => {
    const ok = await useAssistantStore.getState().completeOrigin(item({ jira_issue_key: 'ICA-9047' }))
    expect(ok).toBe(false)
    expect(api.todo.complete).not.toHaveBeenCalled()
  })

  it('할 일 원본은 Jira 키와 무관하게 완료한다', async () => {
    const ok = await useAssistantStore
      .getState()
      .completeOrigin(item({ source: 'todo', candidate_id: 'todo:3', jira_issue_key: 'ICA-1' }))
    expect(ok).toBe(true)
    expect(api.todo.complete).toHaveBeenCalledWith(3)
  })
})

// 어제 메모 건너뛰기는 DB 에 기록한다. 칸은 누르는 즉시 숨긴다
describe('어제 메모 건너뛰기', () => {
  const payload = { plan: null, missingWrapupDate: null } as unknown as TodayPayload

  beforeEach(() => {
    useAssistantStore.setState({ today: null, skippedWrapupDate: null, error: '', busy: false })
  })

  it('skipWrapup 은 그 날짜로 IPC 를 부르고 응답의 today 를 반영한다', async () => {
    api.assistant.skipWrapup.mockResolvedValueOnce({ success: true, today: payload })
    const pending = useAssistantStore.getState().skipWrapup('2026-11-17')
    // 응답 전에 칸을 숨긴다
    expect(useAssistantStore.getState().skippedWrapupDate).toBe('2026-11-17')
    await pending
    expect(api.assistant.skipWrapup).toHaveBeenCalledWith('2026-11-17')
    expect(useAssistantStore.getState().today).toBe(payload)
    expect(useAssistantStore.getState().error).toBe('')
  })

  it('기록에 실패하면 error 를 두고 칸은 숨긴 채로 둔다', async () => {
    api.assistant.skipWrapup.mockResolvedValueOnce({ success: false, error: 'DB 잠김' })
    await useAssistantStore.getState().skipWrapup('2026-11-17')
    expect(useAssistantStore.getState().error).toBe('DB 잠김')
    expect(useAssistantStore.getState().skippedWrapupDate).toBe('2026-11-17')
    expect(useAssistantStore.getState().today).toBeNull()
  })

  it('IPC 가 예외를 던져도 error 를 두고 칸은 숨긴 채로 둔다', async () => {
    api.assistant.skipWrapup.mockRejectedValueOnce(new Error('IPC 끊김'))
    await useAssistantStore.getState().skipWrapup('2026-11-17')
    expect(useAssistantStore.getState().error).toBe('IPC 끊김')
    expect(useAssistantStore.getState().skippedWrapupDate).toBe('2026-11-17')
  })
})
