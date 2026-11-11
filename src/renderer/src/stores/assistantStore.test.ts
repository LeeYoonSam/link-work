import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PlanItem, Task } from '../types'

// 원본 완료가 Jira 연결 작업의 상태를 바꾸지 않는지 고정한다 (PROJECT_SYNC R12).
// 열린 화면 갱신은 이 테스트의 관심사가 아니라 잘라낸다.
vi.mock('./dataSync', () => ({ refreshEntity: async () => {} }))

const { useAssistantStore, isJiraLinkedTask, isJiraLinkedTaskItem } = await import('./assistantStore')

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

const taskRow = (id: number, key: string | null): Task => ({
  id,
  project_id: 29,
  parent_task_id: null,
  name: `작업 ${id}`,
  start_date: null,
  end_date: null,
  status: 'in_progress',
  sort_order: id,
  jira_issue_key: key,
  created_at: ''
})

const api = {
  task: { update: vi.fn(async () => taskRow(7, null)), list: vi.fn(async (): Promise<Task[]> => []) },
  todo: { complete: vi.fn(async () => ({})) }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = { api }
})

describe('R12 원본 완료 잠금', () => {
  it('R12 계획 항목에 Jira 키가 있는 작업은 원본을 완료하지 않는다', async () => {
    const ok = await useAssistantStore.getState().completeOrigin(item({ jira_issue_key: 'ICA-9047' }))
    expect(ok).toBe(false)
    expect(api.task.update).not.toHaveBeenCalled()
    expect(api.task.list).not.toHaveBeenCalled()
  })

  it('R12 계획 항목에 키가 없으면 작업 목록을 조회해 연결 작업이면 완료하지 않는다', async () => {
    api.task.list.mockResolvedValueOnce([taskRow(7, 'ICA-9047'), taskRow(8, null)])
    const ok = await useAssistantStore.getState().completeOrigin(item({}))
    expect(api.task.list).toHaveBeenCalledWith(29)
    expect(ok).toBe(false)
    expect(api.task.update).not.toHaveBeenCalled()
  })

  it('R12 수동 작업은 기존처럼 원본을 완료한다', async () => {
    api.task.list.mockResolvedValueOnce([taskRow(7, null)])
    const ok = await useAssistantStore.getState().completeOrigin(item({}))
    expect(ok).toBe(true)
    expect(api.task.update).toHaveBeenCalledWith(7, { status: 'done' })
  })

  it('R12 판단할 수 없으면 기존처럼 원본 완료를 호출한다', async () => {
    api.task.list.mockRejectedValueOnce(new Error('IPC 끊김'))
    expect(await useAssistantStore.getState().completeOrigin(item({}))).toBe(true)
    expect(api.task.update).toHaveBeenCalledWith(7, { status: 'done' })

    vi.clearAllMocks()
    expect(await useAssistantStore.getState().completeOrigin(item({ project_id: null }))).toBe(true)
    expect(api.task.list).not.toHaveBeenCalled()
    expect(api.task.update).toHaveBeenCalledWith(7, { status: 'done' })
  })

  it('R12 할 일 원본은 Jira 키와 무관하게 완료한다', async () => {
    const ok = await useAssistantStore
      .getState()
      .completeOrigin(item({ source: 'todo', candidate_id: 'todo:3', jira_issue_key: 'ICA-1' }))
    expect(ok).toBe(true)
    expect(api.todo.complete).toHaveBeenCalledWith(3)
  })

  it('R12 isJiraLinkedTaskItem 은 task 출처이면서 키가 있을 때만 참이다', () => {
    expect(isJiraLinkedTaskItem({ source: 'task', jira_issue_key: 'ICA-1' })).toBe(true)
    expect(isJiraLinkedTaskItem({ source: 'task', jira_issue_key: null })).toBe(false)
    expect(isJiraLinkedTaskItem({ source: 'todo', jira_issue_key: 'ICA-1' })).toBe(false)
  })

  it('R12 isJiraLinkedTask 는 목록에 없는 작업을 연결 작업으로 보지 않는다', async () => {
    const list = vi.fn(async () => [taskRow(8, 'ICA-2')])
    expect(await isJiraLinkedTask(item({}), 7, list)).toBe(false)
  })
})
