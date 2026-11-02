import { describe, expect, it } from 'vitest'
import { buildCandidates, isUrgent } from './assistant-candidates'
import type { CandidateInput, JiraCandidateInput, TaskRow, TodoRow } from './assistant-types'
import { cand, deepFreeze, TODAY } from './__fixtures__/assistant/factories'

function task(over: Partial<TaskRow> & Pick<TaskRow, 'id'>): TaskRow {
  return {
    project_id: 10,
    project_name: '프로젝트A',
    project_priority: null,
    name: `작업${over.id}`,
    status: 'todo',
    end_date: null,
    jira_issue_key: null,
    ...over
  }
}

function todo(over: Partial<TodoRow> & Pick<TodoRow, 'id'>): TodoRow {
  return { title: `할일${over.id}`, priority: 'medium', due_date: null, updated_at: null, ...over }
}

function jira(over: Partial<JiraCandidateInput> & Pick<JiraCandidateInput, 'key'>): JiraCandidateInput {
  return {
    summary: `이슈 ${over.key}`,
    status: '진행 중',
    statusCategory: 'new',
    priority: null,
    duedate: null,
    updatedLocal: null,
    url: `https://jira.example/browse/${over.key}`,
    ...over
  }
}

function input(over: Partial<CandidateInput> = {}): CandidateInput {
  return { tasks: [], todos: [], jiraIssues: [], actionItems: [], taskTouchedAt: {}, ...over }
}

describe('buildCandidates 정규화', () => {
  it('task: 프로젝트 우선순위 매핑·링크·진행 여부·최근 변경 시각', () => {
    const [c] = buildCandidates(
      input({
        tasks: [task({ id: 3, project_priority: 'now', status: 'in_progress', end_date: '2026-11-05' })],
        taskTouchedAt: { 3: '2026-11-01 10:00:00' }
      })
    )
    expect(c).toMatchObject({
      id: 'task:3',
      source: 'task',
      priority: 'high',
      inProgress: true,
      dueDate: '2026-11-05',
      link: 'linkwork://project/10',
      projectName: '프로젝트A',
      lastTouchedAt: '2026-11-01 10:00:00'
    })
    const prio = (p: TaskRow['project_priority']): unknown =>
      buildCandidates(input({ tasks: [task({ id: 1, project_priority: p })] }))[0].priority
    expect(prio('next')).toBe('medium')
    expect(prio('later')).toBe('low')
    expect(prio(null)).toBeNull()
  })

  it('todo: due_date 를 날짜와 시각으로 나눈다', () => {
    const list = buildCandidates(
      input({
        todos: [
          todo({ id: 1, due_date: '2026-11-03 14:30', priority: 'high' }),
          todo({ id: 2, due_date: '2026-11-04' }),
          todo({ id: 3, priority: 'weird' })
        ]
      })
    )
    expect(list[0]).toMatchObject({ id: 'todo:1', dueDate: '2026-11-03', dueTime: '14:30', priority: 'high', link: 'linkwork://view/todos' })
    expect(list[1]).toMatchObject({ dueDate: '2026-11-04', dueTime: null })
    expect(list[2].priority).toBeNull()
  })

  it('jira: 우선순위 매핑과 indeterminate → 진행 중. 완료 이슈는 뺀다', () => {
    const list = buildCandidates(
      input({
        jiraIssues: [
          jira({ key: 'P-1', priority: 'Highest', statusCategory: 'indeterminate', updatedLocal: '2026-11-01 09:00:00' }),
          jira({ key: 'P-2', priority: 'Lowest' }),
          jira({ key: 'P-3', statusCategory: 'done' })
        ]
      })
    )
    expect(list.map((c) => c.id)).toEqual(['jira:P-1', 'jira:P-2'])
    expect(list[0]).toMatchObject({ priority: 'high', jiraPriority: 'Highest', inProgress: true, lastTouchedAt: '2026-11-01 09:00:00' })
    expect(list[1].priority).toBe('low')
  })

  it('action_item: id·medium 우선순위·날짜 형식 due 만 dueDate', () => {
    const list = buildCandidates(
      input({
        actionItems: [
          { meeting_id: 7, index: 0, text: '자료 공유', due: '2026-11-04', meeting_title: '주간' },
          { meeting_id: 7, index: 1, text: '검토', due: '다음 주', meeting_title: '주간' }
        ]
      })
    )
    expect(list[0]).toMatchObject({ id: 'action_item:7:0', priority: 'medium', dueDate: '2026-11-04', link: 'linkwork://view/notes' })
    expect(list[1].dueDate).toBeNull()
  })

  it('jiraIssues 가 null 이면 빈 배열로 본다', () => {
    const list = buildCandidates(input({ jiraIssues: null, todos: [todo({ id: 1 })] }))
    expect(list.map((c) => c.id)).toEqual(['todo:1'])
  })

  it('결과는 id 오름차순이다', () => {
    const list = buildCandidates(
      input({ todos: [todo({ id: 2 })], tasks: [task({ id: 5 })], jiraIssues: [jira({ key: 'Z-1' })] })
    )
    expect(list.map((c) => c.id)).toEqual(['jira:Z-1', 'task:5', 'todo:2'])
  })
})

describe('A4 중복 제거', () => {
  it('A4: 같은 jiraKey 의 task 와 jira 는 후보 1개로 합친다', () => {
    const list = buildCandidates(
      input({
        tasks: [task({ id: 12, jira_issue_key: 'PROJ-1', project_priority: 'later', end_date: '2026-11-20' })],
        jiraIssues: [
          jira({ key: 'PROJ-1', priority: 'High', statusCategory: 'indeterminate', duedate: '2026-11-03', updatedLocal: '2026-11-02 08:00:00' })
        ]
      })
    )
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 'task:12',
      source: 'task',
      link: 'linkwork://project/10',
      projectId: 10,
      jiraKey: 'PROJ-1',
      inProgress: true,
      priority: 'high',
      dueDate: '2026-11-03',
      lastTouchedAt: '2026-11-02 08:00:00'
    })
  })

  it('A4: 같은 jiraKey 를 가진 task 가 여럿이면 id 가 가장 작은 task 1개만 남는다', () => {
    const list = buildCandidates(
      input({
        tasks: [task({ id: 9, jira_issue_key: 'P-7' }), task({ id: 4, jira_issue_key: 'p-7' })],
        jiraIssues: [jira({ key: 'P-7' }), jira({ key: 'P-7' })]
      })
    )
    expect(list.map((c) => c.id)).toEqual(['task:4'])
  })

  it('A4: jira 값이 null 이면 task 값을 쓴다', () => {
    const [c] = buildCandidates(
      input({
        tasks: [task({ id: 1, jira_issue_key: 'P-1', project_priority: 'now', end_date: '2026-11-09' })],
        jiraIssues: [jira({ key: 'P-1', priority: null, duedate: null })]
      })
    )
    expect(c).toMatchObject({ priority: 'high', dueDate: '2026-11-09' })
  })

  it('A14: 입력을 바꾸지 않고 같은 입력에 같은 결과를 낸다', () => {
    const inp = deepFreeze(
      input({ tasks: [task({ id: 2 }), task({ id: 1, jira_issue_key: 'A-1' })], jiraIssues: [jira({ key: 'A-1' })], todos: [todo({ id: 1 })] })
    )
    expect(buildCandidates(inp)).toEqual(buildCandidates(inp))
  })
})

describe('isUrgent', () => {
  it('마감 오늘·지남은 긴급이다', () => {
    expect(isUrgent(cand({ id: 'todo:1', dueDate: TODAY }), TODAY)).toBe(true)
    expect(isUrgent(cand({ id: 'todo:1', dueDate: '2026-10-30' }), TODAY)).toBe(true)
    expect(isUrgent(cand({ id: 'todo:1', dueDate: '2026-11-03' }), TODAY)).toBe(false)
  })
  it('Jira Highest 는 긴급이다. High 는 아니다', () => {
    expect(isUrgent(cand({ id: 'jira:P-1', jiraPriority: 'Highest' }), TODAY)).toBe(true)
    expect(isUrgent(cand({ id: 'jira:P-1', jiraPriority: 'High' }), TODAY)).toBe(false)
  })
})
