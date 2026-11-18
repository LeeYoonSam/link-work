import { describe, expect, it } from 'vitest'
import { buildCandidates, isExcludedCandidate, isUrgent } from './assistant-candidates'
import type { CandidateInput, JiraCandidateInput, TodoRow } from './assistant-types'
import { cand, deepFreeze, TODAY } from './__fixtures__/assistant/factories'

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
    issueType: '작업',
    parentKey: null,
    parentSummary: null,
    ...over
  }
}

function input(over: Partial<CandidateInput> = {}): CandidateInput {
  return { todos: [], jiraIssues: [], actionItems: [], ...over }
}

describe('buildCandidates 정규화', () => {
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
    expect(list[0]).toMatchObject({ id: 'todo:1', dueDate: '2026-11-03', dueTime: '14:30', priority: 'high', link: 'linkwork://todo/1' })
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
    expect(list[0]).toMatchObject({ id: 'action_item:7:0', priority: 'medium', dueDate: '2026-11-04', link: 'linkwork://note/7' })
    expect(list[1].dueDate).toBeNull()
  })

  it('jiraIssues 가 null 이면 빈 배열로 본다', () => {
    const list = buildCandidates(input({ jiraIssues: null, todos: [todo({ id: 1 })] }))
    expect(list.map((c) => c.id)).toEqual(['todo:1'])
  })

  it('결과는 id 오름차순이다', () => {
    const list = buildCandidates(
      input({
        todos: [todo({ id: 2 })],
        jiraIssues: [jira({ key: 'Z-1' })],
        actionItems: [{ meeting_id: 1, index: 0, text: '공유', due: null, meeting_title: '회의' }]
      })
    )
    expect(list.map((c) => c.id)).toEqual(['action_item:1:0', 'jira:Z-1', 'todo:2'])
  })
})

describe('A4 중복 제거', () => {
  it('A4: 같은 jiraKey 의 jira 는 첫 1건만 쓴다 (대소문자 무시)', () => {
    const list = buildCandidates(
      input({ jiraIssues: [jira({ key: 'P-7', summary: '처음' }), jira({ key: 'p-7', summary: '두 번째' })] })
    )
    expect(list.map((c) => [c.id, c.title])).toEqual([['jira:P-7', '처음']])
  })

  it('A14: 입력을 바꾸지 않고 같은 입력에 같은 결과를 낸다', () => {
    const inp = deepFreeze(
      input({ jiraIssues: [jira({ key: 'A-1' })], todos: [todo({ id: 1 })] })
    )
    expect(buildCandidates(inp)).toEqual(buildCandidates(inp))
  })
})

describe('A48: 후보 업무 유형·묶음 필드', () => {
  it('A48: jira 후보는 부모 키·부모 요약·분류를 채운다', () => {
    const list = buildCandidates(
      input({
        jiraIssues: [
          jira({ key: 'ica-8971', summary: '안드로이드 구매자 앱 v4.174.0 QA', parentKey: 'ica-8054', parentSummary: '안드로이드QA-2026' }),
          jira({ key: 'ICA-8054', summary: '안드로이드QA-2026', issueType: '에픽' }),
          jira({ key: 'ICA-8571', summary: '[코루틴] W2-2 홈', parentKey: 'ICA-9000', parentSummary: '[TRD] RxJava to Coroutine Phase2' })
        ]
      })
    )
    const byId = new Map(list.map((c) => [c.id, c]))
    expect(byId.get('jira:ICA-8971')).toMatchObject({
      parentKey: 'ICA-8054', groupName: '안드로이드QA-2026', workType: 'qa', workVersion: '4.174.0'
    })
    expect(byId.get('jira:ICA-8054')).toMatchObject({ parentKey: null, groupName: null, workType: 'qa', workVersion: null })
    expect(byId.get('jira:ICA-8571')).toMatchObject({ workType: 'trd', groupName: '[TRD] RxJava to Coroutine Phase2' })
  })

  it('A48: todo·action_item 은 etc 이고 묶음 필드가 비어 있다', () => {
    const list = buildCandidates(
      input({
        todos: [todo({ id: 1, title: '[TRD] 문서 v1.2.3' })],
        actionItems: [{ meeting_id: 3, index: 0, text: '174 버전 릴리스를 시작한다.', due: null, meeting_title: '회의' }]
      })
    )
    for (const c of list) {
      expect(c).toMatchObject({ parentKey: null, groupName: null, workType: 'etc', workVersion: null })
    }
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

describe('A58: isExcludedCandidate', () => {
  it('A58: candidate_id 가 같으면 true 다', () => {
    expect(isExcludedCandidate({ id: 'task:1', jiraKey: null }, [{ candidate_id: 'task:1', jira_key: null }])).toBe(true)
  })

  it('A58: 둘 다 Jira 키가 있고 같으면 대소문자와 무관하게 true 다', () => {
    expect(isExcludedCandidate({ id: 'task:12', jiraKey: 'ica-1' }, [{ candidate_id: 'jira:ICA-1', jira_key: 'ICA-1' }])).toBe(true)
  })

  it('A58: 한쪽이라도 Jira 키가 없고 id 가 다르면 false 다', () => {
    expect(isExcludedCandidate({ id: 'task:12', jiraKey: null }, [{ candidate_id: 'jira:ICA-1', jira_key: 'ICA-1' }])).toBe(false)
    expect(isExcludedCandidate({ id: 'task:12', jiraKey: 'ICA-1' }, [{ candidate_id: 'task:1', jira_key: null }])).toBe(false)
    expect(isExcludedCandidate({ id: 'task:12', jiraKey: 'ICA-1' }, [])).toBe(false)
  })
})
